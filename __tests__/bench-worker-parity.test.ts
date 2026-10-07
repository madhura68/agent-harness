import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { runTaskBench, type BenchResult } from '../src/bench/task-bench.js'
import type { ToolRegistry } from '../src/types.js'
import type { TaskConfig } from '../src/worker/config.js'
import type { ControlChannel, StatusOutcome, StatusUpdate } from '../src/worker/control.js'
import { ContainerUncertainError, runTaskJob } from '../src/worker/task-impl.js'
import type { WorkerDeps } from '../src/worker/worker.js'
import { benchCaseFor, benchTaskConfigFor } from './fakes/bench-case.js'
import { benchTmp, cleanupBenchFixtures, createBenchRepo, disposeBenchRepo, fixtureGit, type BenchRepo } from './fakes/bench-repo.js'
import { fakeDocker, type DockerStep, type FakeDockerOptions } from './fakes/fake-docker.js'
import { completion, startFakeModelServer, type FakeTurn } from './fakes/fake-model-server.js'
import { taskPayload } from './fakes/task-payload.js'
import { testModelClients, testWorkerConfig } from './fakes/worker-config.js'
import { readTrace } from './helpers.js'

// src/bench/task-bench.ts holds a deliberate copy of the verify gate and the container handling of runTaskJob (src/worker/task-impl.ts):
// the worker may change by two exports and an option only, so the bench cannot share the code. A copy drifts without anyone noticing, and
// a bench that measures another gate than the worker measures nothing. So this file runs the REAL runTaskJob and the REAL runTaskBench
// through the same scripted model and the same fake docker, and compares what each of them did. When the gate text, the way red runs are
// counted, or the handling of a container that cannot be stopped changes in one of them and not in the other, a test here fails.
//
// One difference is deliberate, and its test says so instead of comparing: a verify container that cannot run at all. The worker counts it
// as a red verify; the bench ends the run as a benchfout at the first one (spec §4.1: a container that failed outside the model).

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
const servers: Fake[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  cleanupBenchFixtures()
})
afterAll(() => disposeBenchRepo())

const MODEL = 'qwen3.8-test'
const FAST = { killGraceMs: 20, cleanupTimeoutMs: 500, pollIntervalMs: 10 }

const say = (text: string): FakeTurn => ({ body: completion({ content: text }) })
const runTests = (): FakeTurn => ({ body: completion({ toolCalls: [{ id: 'rt', name: 'run_tests', arguments: '{}' }] }) })
const red = (n: number): DockerStep => ({ code: 1, out: `FAIL run ${n}` })

type Scenario = {
  /** What the model says, in the order of its requests. */
  script: FakeTurn[]
  docker: FakeDockerOptions
  maxVerifyRepairs?: number
  /** The verify container timeout, in fractions of a second (the schema wants whole seconds). */
  verifyTimeoutSeconds?: number
}

/** What a run did, as far as the gate and the containers go; the two runs of a scenario must show the same. */
function observe(runDir: string, fake: Fake, docker: ReturnType<typeof fakeDocker>) {
  const events = readTrace(runDir)
  const { ts: _ts, ...runEnd } = events.find((e) => e.type === 'run_end') ?? { ts: '', type: 'geen run_end' }
  return {
    // What the model was told after the two prompts: its own answers, the tool results, the retry messages of the gate. The prompts
    // differ on purpose (the bench has no doc tools), so they are left out.
    conversation: fake.requests.map((r) => {
      const [system, user, ...rest] = r.body.messages
      expect([system.role, user.role]).toEqual(['system', 'user'])
      return rest
    }),
    maxTokens: fake.requests.map((r) => r.body.max_tokens),
    // Which containers started, in order, with which script.
    started: docker.runs.map((r) => [r.purpose, r.script]),
    containerEvents: events.filter((e) => e.type === 'container').map((e) => [e.kind, e.source, e.n, e.exitCode, e.timedOut]),
    gate: events.filter((e) => e.type === 'after_answer').map((e) => e.outcome),
    runEnd,
  }
}

/** A registry without any tool: the worker offers its doc tools through one, and this test has none. */
const noDocTools = (): ToolRegistry => ({
  snapshot: { entries: [], hash: 'geen' },
  toOpenAiTools: () => [],
  execute: async () => ({ ok: false, errorCode: 'UNKNOWN_TOOL', content: 'geen doc-tools in deze test', truncated: false }),
  close: async () => undefined,
})

async function viaWorker(s: Scenario, task: TaskConfig, repo: BenchRepo) {
  const fake = await startFakeModelServer(s.script)
  servers.push(fake)
  const docker = fakeDocker(s.docker)
  const out = benchTmp('worker-out')
  const worktree = benchTmp('worker-tree')
  await fixtureGit(worktree, ['init', '-q']) // the worker's own commit step runs git here, in a repo of its own
  const updateStatus = vi.fn(async (_jobId: string, _update: StatusUpdate): Promise<StatusOutcome> => ({ ok: true }))
  const control: ControlChannel = {
    waitForJob: async () => ({ type: 'stopped' }),
    heartbeat: async () => true,
    updateStatus,
    updateTaskStatus: async () => ({ ok: true }),
    verifyTaskAgainstPlan: async () => ({ ok: true, result: 'aligned' }),
    log: async () => ({ ok: true }),
  }
  const config = testWorkerConfig({}, fake.baseUrl)
  config.task = task
  const deps: WorkerDeps = {
    control,
    registryView: async () => noDocTools(),
    modelClients: testModelClients(config),
    config,
    out,
    once: true,
    signal: new AbortController().signal,
    log: () => undefined,
    taskDeps: { spawn: docker.spawn, ...FAST },
  }
  const claim = { type: 'job' as const, jobId: 'job1', kind: 'TASK_IMPLEMENTATION', payload: taskPayload({ worktree, repoUrl: repo.url }) }
  let outcome: string
  try {
    outcome = await runTaskJob(deps, claim, { containersClean: async () => true })
  } catch (err) {
    if (!(err instanceof ContainerUncertainError)) throw err
    outcome = `uncertain (${err.outcome})`
  }
  const failed = updateStatus.mock.calls.map((c) => c[1]).filter((u) => u.status === 'failed')
  return { outcome, failedWith: failed.at(-1)?.error, observed: observe(join(out, readdirSync(out)[0]), fake, docker) }
}

async function viaBench(s: Scenario, task: TaskConfig, repo: BenchRepo) {
  const fake = await startFakeModelServer(s.script)
  servers.push(fake)
  const docker = fakeDocker(s.docker)
  const out = benchTmp('bench-out')
  const result: BenchResult = await runTaskBench({
    case: benchCaseFor(repo),
    model: { baseUrl: fake.baseUrl, name: MODEL },
    label: 'parity',
    task,
    out,
    retryTransient: false,
    deps: { containerDeps: { spawn: docker.spawn, ...FAST } },
  })
  return { result, observed: observe(join(out, result.runId), fake, docker) }
}

/** The same scenario through the worker and through the bench, on one task config (so one recipe, one set of limits). */
async function bothWays(s: Scenario) {
  const repo = await createBenchRepo()
  const task = benchTaskConfigFor(repo, s.maxVerifyRepairs === undefined ? {} : { maxVerifyRepairs: s.maxVerifyRepairs })
  if (s.verifyTimeoutSeconds !== undefined) task.verifyTimeoutSeconds = s.verifyTimeoutSeconds
  const worker = await viaWorker(s, task, repo)
  const bench = await viaBench(s, task, repo)
  return { worker, bench }
}

describe('the gate of the bench is the gate of the worker', () => {
  it.each([1, 2, 3, 4])(
    'with maxVerifyRepairs %i and every verify red: same retry messages, same number of gate runs, same end',
    async (repairs) => {
      const { worker, bench } = await bothWays({
        script: Array.from({ length: repairs }, (_, i) => say(`antwoord ${i + 1}`)),
        docker: { verify: Array.from({ length: repairs }, (_, i) => red(i + 1)) },
        maxVerifyRepairs: repairs,
      })

      expect(bench.observed).toEqual(worker.observed)

      // The premise: this is the scenario that was meant, so that two empty observations cannot agree by accident.
      const o = worker.observed
      expect(o.gate).toEqual([...Array<string>(repairs - 1).fill('retry'), 'fail'])
      expect(o.started.filter(([purpose]) => purpose === 'verify')).toHaveLength(repairs) // the number of gate runs
      expect(o.conversation).toHaveLength(repairs)
      if (repairs > 1) {
        expect(o.conversation.at(-1)?.at(-1)).toEqual({ role: 'user', content: `Verify faalt (poging ${repairs - 1} van ${repairs}): exitcode 1\nFAIL run ${repairs - 1}` })
      }
      const message = `verify ${repairs}× rood: exitcode 1\nFAIL run ${repairs}`
      expect(o.runEnd).toEqual({ type: 'run_end', status: 'failed', error: { code: 'VERIFY_FAILED', message } })

      // And the end as each of them reports it: the worker fails the job with that message, the bench calls the run verify_rood.
      expect(worker.outcome).toBe('failed')
      expect(worker.failedWith).toContain(message)
      expect(bench.result).toMatchObject({ status: 'verify_rood', gate: { reds: repairs }, error: { code: 'VERIFY_FAILED', message } })
    },
  )

  it('with a red verify and then a green one: same retry message, and the second answer is accepted', async () => {
    const { worker, bench } = await bothWays({ script: [say('eerste'), say('tweede')], docker: { verify: [red(1), { out: 'alles groen' }] } })
    expect(bench.observed).toEqual(worker.observed)
    expect(worker.observed.gate).toEqual(['retry', 'accept'])
    expect(worker.observed.conversation[1].at(-1)).toEqual({ role: 'user', content: 'Verify faalt (poging 1 van 3): exitcode 1\nFAIL run 1' })
    expect(worker.observed.runEnd).toEqual({ type: 'run_end', status: 'completed' })
    expect(bench.result.runStatus).toBe('completed')
  })

  // The intended divergence. Up to the first verify that cannot run the two do the same; then the worker goes on (it counts a red verify,
  // sends the reason to the model as a retry message, and ends on VERIFY_FAILED after maxVerifyRepairs of them) and the bench stops.
  it('with a verify that cannot run, the one intended divergence: the worker ends on VERIFY_FAILED after three, the bench on a benchfout at the first', async () => {
    const cannotRun: DockerStep = { code: null, errorMessage: 'spawn docker ENOENT' } // what a missing docker binary looks like
    const reason = 'docker-proces eindigde zonder exitcode: spawn docker ENOENT'
    const { worker, bench } = await bothWays({ script: [say('eerste'), say('tweede'), say('derde')], docker: { verify: [cannotRun, cannotRun, cannotRun] } })

    // the worker: three red verifies, the reason in the retry message of the first
    expect(worker.observed.started.filter(([purpose]) => purpose === 'verify')).toHaveLength(3)
    expect(worker.observed.conversation[1].at(-1)).toEqual({ role: 'user', content: `Verify faalt (poging 1 van 3): ${reason}\n` })
    expect(worker.observed.gate).toEqual(['retry', 'retry', 'fail'])
    expect(worker.observed.runEnd).toEqual({ type: 'run_end', status: 'failed', error: { code: 'VERIFY_FAILED', message: `verify 3× rood: ${reason}\n` } })
    expect(worker.outcome).toBe('failed')

    // the bench: the first one ends the run, which it aborts itself, and the result says benchfout with the cause
    expect(bench.result).toMatchObject({ status: 'benchfout', benchError: `verify-container: ${reason}`, gate: { reds: 0 } })
    expect(bench.observed.started.filter(([purpose]) => purpose === 'verify')).toHaveLength(1)
    expect(bench.observed.gate).toEqual([])
    expect(bench.observed.conversation).toHaveLength(1) // the model was asked once
    expect(bench.observed.runEnd).toEqual({ type: 'run_end', status: 'failed', error: { code: 'HARNESS_ERROR', message: 'aborted' } })

    // …and up to that point the two are the same: the first request, the prepare and the first verify, with the same results
    expect(bench.observed.conversation[0]).toEqual(worker.observed.conversation[0])
    expect(bench.observed.maxTokens[0]).toEqual(worker.observed.maxTokens[0])
    expect(bench.observed.started).toEqual(worker.observed.started.slice(0, 2))
    expect(bench.observed.containerEvents).toEqual(worker.observed.containerEvents.slice(0, 2))
  })

  it('with a verify that runs into its timeout: the same "timeout" in the retry message, and the container is cleaned up', async () => {
    const { worker, bench } = await bothWays({
      script: [say('eerste'), say('tweede')],
      docker: { verify: [{ hang: true }, {}] },
      verifyTimeoutSeconds: 0.2, // the green verify after the hanging one runs under it too
    })
    expect(bench.observed).toEqual(worker.observed)
    expect(worker.observed.conversation[1].at(-1)).toEqual({ role: 'user', content: 'Verify faalt (poging 1 van 3): timeout\n' })
    expect(worker.observed.containerEvents[1]).toEqual(['verify', 'gate', 2, null, true])
  })

  it('with a container that cannot be proven stopped: the same stop, and no container after it', async () => {
    const { worker, bench } = await bothWays({
      script: [runTests(), say('nooit gevraagd')],
      docker: { verify: [{ hang: true }], killCode: 1 }, // the kill fails, so the cleanup ends 'uncertain'
      verifyTimeoutSeconds: 0.05,
    })
    expect(bench.observed).toEqual(worker.observed)

    const o = worker.observed
    expect(o.started.map(([purpose]) => purpose)).toEqual(['prepare', 'verify']) // nothing started after the verify that hung
    expect(o.conversation).toHaveLength(1) // and the model was not asked again
    expect(o.runEnd).toMatchObject({ status: 'failed', error: { code: 'HARNESS_ERROR', message: 'aborted' } })
    expect(worker.outcome).toBe('uncertain (failed)')
    expect(bench.result.status).toBe('benchfout')
    expect(bench.result.benchError).toMatch(/niet aantoonbaar gestopt$/)
  })
})
