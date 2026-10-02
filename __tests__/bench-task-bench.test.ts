import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BenchCase } from '../src/bench/case.js'
import { evaluateHidden, hiddenCheckScript } from '../src/bench/hidden-check.js'
import { createContainerRunner, mapStatus, runTaskBench, type BenchDeps, type BenchResult } from '../src/bench/task-bench.js'
import { BENCH_SYSTEM_PROMPT, benchTaskPrompt } from '../src/bench/task-prompt.js'
import { assertAdminUnchanged, capturePatch, restoreForHiddenCheck } from '../src/bench/workspace.js'
import type { Manifest } from '../src/manifest.js'
import type { ModelClient } from '../src/model-client.js'
import type { RunDeps } from '../src/run.js'
import { openTrace, type RunResult } from '../src/trace.js'
import type { RunStatus } from '../src/types.js'
import { buildScript } from '../src/worker/containers.js'
import type { TaskConfig } from '../src/worker/config.js'
import { benchCaseFor, benchTaskConfigFor } from './fakes/bench-case.js'
import { benchTmp, cleanupBenchFixtures, createBenchRepo, disposeBenchRepo, type BenchRepo } from './fakes/bench-repo.js'
import { fakeDocker, type DockerStep, type FakeDockerOptions } from './fakes/fake-docker.js'
import { completion, startFakeModelServer, type FakeTurn } from './fakes/fake-model-server.js'
import { allFiles, bodyWithKeyAt, DUMMY_KEY, leakedFragments, makeFifo, readTrace } from './helpers.js'

// Spies that call through. The first shows what runManifest was given; the others show which host-git steps ran, and in which order.
const runsSeen: Array<{ manifest: Manifest; deps: RunDeps }> = []
vi.mock('../src/run.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/run.js')>()
  return {
    ...actual,
    runManifest: vi.fn((manifest: Manifest, deps: RunDeps) => {
      runsSeen.push({ manifest, deps })
      return actual.runManifest(manifest, deps)
    }),
  }
})
vi.mock('../src/bench/workspace.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/bench/workspace.js')>()
  return {
    ...actual,
    assertAdminUnchanged: vi.fn(actual.assertAdminUnchanged),
    capturePatch: vi.fn(actual.capturePatch),
    restoreForHiddenCheck: vi.fn(actual.restoreForHiddenCheck),
  }
})

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let model: Fake | undefined

beforeEach(() => {
  runsSeen.length = 0
  vi.clearAllMocks()
})
afterEach(async () => {
  await model?.close()
  model = undefined
  cleanupBenchFixtures()
})
afterAll(() => disposeBenchRepo())

// ---- what the fake model says ----

/** The model asks for a tool. */
const call = (name: string, args: Record<string, unknown> = {}, id = 'c1'): FakeTurn => ({
  body: completion({ toolCalls: [{ id, name, arguments: JSON.stringify(args) }] }),
})
/** The model answers without a tool call. */
const say = (text = 'klaar'): FakeTurn => ({ body: completion({ content: text }) })
/** The model writes src/z.ts, which is all it takes to leave a patch. */
const writeZ = (): FakeTurn => call('write_file', { path: 'src/z.ts', content: 'export const z = 3\n' }, 'wz')
const overloaded: FakeTurn = { status: 503, body: { error: { message: 'overloaded' } } }

// ---- what the fake containers do ----

/** What vitest's JSON reporter writes for the hidden test file; `statuses` are the results of its tests. */
const report = (work: string, statuses: string[]) => ({
  testResults: [{ name: join(work, '__tests__/b.test.ts'), assertionResults: statuses.map((status) => ({ status })) }],
})
function writeReport(work: string, content: unknown): void {
  mkdirSync(join(work, '.task-bench'), { recursive: true })
  writeFileSync(join(work, '.task-bench/hidden.json'), JSON.stringify(content))
}
const hiddenPasses: DockerStep = { effect: ({ work }) => writeReport(work, report(work, ['passed'])) }
const hiddenFails: DockerStep = { code: 1, effect: ({ work }) => writeReport(work, report(work, ['failed'])) }
const RED: DockerStep = { code: 1, out: 'FAIL a.test.ts' }

// ---- the bench under test ----

type Setup = {
  script?: FakeTurn[]
  docker?: FakeDockerOptions
  case?: Partial<BenchCase>
  task?: Record<string, unknown>
  /** Applied to the parsed task config, for what the schema cannot say: a container timeout in fractions of a second. */
  tune?: (task: TaskConfig) => void
  retryTransient?: boolean
  apiKey?: string
  signal?: AbortSignal
  deps?: Omit<BenchDeps, 'containerDeps'>
}

/** Everything for one run, with the run itself still to be started: a test that stops it from outside needs the time in between. */
async function start(s: Setup = {}) {
  const repo = await createBenchRepo()
  const fake = await startFakeModelServer(s.script ?? [])
  model = fake
  const task = benchTaskConfigFor(repo, s.task)
  s.tune?.(task)
  const docker = fakeDocker(s.docker)
  const out = benchTmp('out')
  const benchCase = benchCaseFor(repo, s.case)
  const run = () =>
    runTaskBench({
      case: benchCase,
      model: { baseUrl: fake.baseUrl, name: 'qwen3.8-test' },
      label: 'test',
      task,
      out,
      apiKey: s.apiKey,
      retryTransient: s.retryTransient ?? false,
      signal: s.signal,
      deps: { containerDeps: { spawn: docker.spawn, killGraceMs: 20, cleanupTimeoutMs: 500, pollIntervalMs: 10 }, ...s.deps },
    })
  return { repo, model: fake, task, docker, out, benchCase, run }
}

/** One run to the end; `saved` is bench-result.json as it lies on disk. */
async function bench(s: Setup = {}) {
  const t = await start(s)
  const result = await t.run()
  const runDir = join(t.out, result.runId)
  const saved = JSON.parse(readFileSync(join(runDir, 'bench-result.json'), 'utf8')) as BenchResult
  return { ...t, result, runDir, saved }
}

const outcomesOfGate = (runDir: string) => readTrace(runDir).filter((e) => e.type === 'after_answer').map((e) => e.outcome)
const hex8Of = (result: BenchResult) => result.runId.slice(-8)
const fileText = (runDir: string, name: string) => readFileSync(join(runDir, name), 'utf8')
/** Everything the run wrote except the clone: the clone holds the repository, not the run. */
const runText = (runDir: string) =>
  allFiles(runDir)
    .filter((f) => !f.startsWith(join(runDir, 'ws') + sep))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')

describe('runTaskBench — the loop is the worker loop', () => {
  it('gives runManifest the bench prompts, the six task tools and the task limits', async () => {
    const t = await bench({ script: [say()] })
    expect(runsSeen).toHaveLength(1)
    const { manifest, deps } = runsSeen[0]
    expect(manifest).toMatchObject({ id: t.result.runId, profile: 'tools', system: BENCH_SYSTEM_PROMPT, prompt: benchTaskPrompt(t.benchCase) })
    expect(manifest.tools?.allow).toEqual(['list_files', 'read_file', 'write_file', 'edit_file', 'search', 'run_tests'])
    expect(manifest.limits).toEqual(t.task.limits)
    expect(manifest.model).toEqual({ baseUrl: t.model.baseUrl, name: 'qwen3.8-test' })
    expect(typeof deps.afterAnswer).toBe('function') // the gate
    expect(deps.signal).toBeInstanceOf(AbortSignal)
  })

  it('offers the model exactly the six task tools and no doc tool, and sends it exactly the two prompts', async () => {
    const t = await bench({ script: [say()] })
    const sorted = ['edit_file', 'list_files', 'read_file', 'run_tests', 'search', 'write_file']
    expect(readTrace(t.runDir).find((e) => e.type === 'tool_snapshot')).toMatchObject({ names: sorted })
    const request = t.model.requests[0].body
    expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name).sort()).toEqual(sorted)
    expect(request.messages).toEqual([
      { role: 'system', content: BENCH_SYSTEM_PROMPT },
      { role: 'user', content: benchTaskPrompt(t.benchCase) },
    ])
    expect(JSON.stringify(request)).not.toContain('product_doc') // search_, get_, list_ and related_product_docs
  })
})

describe('runTaskBench — the gate', () => {
  it('accepts a green verify, with the recipe verify command in its own container', async () => {
    const t = await bench({ script: [say()], docker: { verify: [{ out: 'alles goed' }] } })
    expect(outcomesOfGate(t.runDir)).toEqual(['accept'])
    expect(t.result).toMatchObject({ runStatus: 'completed', gate: { reds: 0, lastTail: 'exitcode 0\nalles goed' } })
    expect(t.docker.runs.map((r) => [r.name, r.purpose, r.script])).toEqual([
      [`harness-${hex8Of(t.result)}-prepare-1`, 'prepare', buildScript(['npm ci'])],
      [`harness-${hex8Of(t.result)}-verify-2`, 'verify', buildScript(['npm test'])],
    ])
  })

  it('sends a red verify back to the model as "Verify faalt (poging 1 van 3): …" and goes on', async () => {
    const t = await bench({ script: [say('klaar 1'), say('klaar 2')], docker: { verify: [RED, {}] } })
    expect(t.model.requests[1].body.messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'klaar 1' },
      { role: 'user', content: 'Verify faalt (poging 1 van 3): exitcode 1\nFAIL a.test.ts' },
    ])
    expect(outcomesOfGate(t.runDir)).toEqual(['retry', 'accept'])
    expect(t.result.gate.reds).toBe(1)
  })

  it('ends on the third red verify with VERIFY_FAILED, which is verify_rood, and then runs no hidden check', async () => {
    const t = await bench({ script: [say(), say(), say()], docker: { verify: [RED, RED, { code: 1, out: 'FAIL c.test.ts' }] } })
    expect(t.model.requests[2].body.messages.at(-1)).toEqual({ role: 'user', content: 'Verify faalt (poging 2 van 3): exitcode 1\nFAIL a.test.ts' })
    expect(outcomesOfGate(t.runDir)).toEqual(['retry', 'retry', 'fail'])
    expect(t.result).toMatchObject({
      status: 'verify_rood',
      runStatus: 'failed',
      error: { code: 'VERIFY_FAILED', message: 'verify 3× rood: exitcode 1\nFAIL c.test.ts' },
      gate: { reds: 3, lastTail: 'exitcode 1\nFAIL c.test.ts' },
    })
    expect(t.model.requests).toHaveLength(3)
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify', 'verify', 'verify'])
    expect(restoreForHiddenCheck).not.toHaveBeenCalled()
  })

  it('takes the number of attempts from maxVerifyRepairs of the task config', async () => {
    const t = await bench({ script: [say()], task: { maxVerifyRepairs: 1 }, docker: { verify: [RED] } })
    expect(t.result).toMatchObject({ status: 'verify_rood', error: { code: 'VERIFY_FAILED', message: 'verify 1× rood: exitcode 1\nFAIL a.test.ts' } })
    expect(outcomesOfGate(t.runDir)).toEqual(['fail'])
  })
})

describe('runTaskBench — statuses', () => {
  const solve = [writeZ(), say()]

  it('is geen_wijzigingen when the run completes with an empty patch, and then runs no hidden check', async () => {
    const t = await bench({ script: [say()] })
    expect(t.result).toMatchObject({ status: 'geen_wijzigingen', runStatus: 'completed', patchBytes: 0, providers: [], retries: [] })
    expect(t.result.hidden).toBeUndefined()
    expect(fileText(t.runDir, 'patch.diff')).toBe('')
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify'])
    expect(restoreForHiddenCheck).not.toHaveBeenCalled()
  })

  it('is geslaagd when the hidden check passes, after the tests of the ref are back, the dependencies are installed again, and in a verify container of its own', async () => {
    const seen: { tests?: boolean; work?: boolean } = {}
    const hidden: DockerStep = {
      onStart: ({ work }) => {
        seen.tests = existsSync(join(work, '__tests__/b.test.ts')) // only the ref has it
        seen.work = existsSync(join(work, 'src/z.ts')) // the model's own work stays
      },
      effect: hiddenPasses.effect,
    }
    const t = await bench({ script: solve, docker: { hidden: [hidden] } })

    expect(t.result).toMatchObject({ status: 'geslaagd', runStatus: 'completed', hidden: { pass: true } })
    expect(seen).toEqual({ tests: true, work: true })
    const patch = fileText(t.runDir, 'patch.diff')
    expect(patch).toContain('+++ b/src/z.ts')
    expect(patch).not.toContain('b.test.ts') // the hidden test arrives after the patch is taken
    expect(t.result.patchBytes).toBe(Buffer.byteLength(patch))

    const last = t.docker.runs.at(-1)
    expect(last).toMatchObject({ purpose: 'hidden', script: buildScript([hiddenCheckScript(['__tests__/b.test.ts'])]) })
    expect(last?.name).toBe(`harness-${hex8Of(t.result)}-verify-4`)
    // between the gate and the hidden check: the prepare of the recipe once more, as a container of its own
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify', 'prepare', 'hidden'])
    expect(t.docker.runs[2]).toMatchObject({ name: `harness-${hex8Of(t.result)}-prepare-3`, script: buildScript(['npm ci']) })
    const containerEvents = readTrace(t.runDir).filter((e) => e.type === 'container')
    expect(containerEvents.map((e) => [e.kind, e.source, e.n])).toEqual([
      ['prepare', 'prepare', 1],
      ['verify', 'gate', 2],
      ['prepare', 'reinstall', 3],
      ['verify', 'hidden_check', 4],
    ])
    expect(t.result.hidden).toEqual(
      evaluateHidden({ exitCode: 0, json: report(last?.work ?? '', ['passed']), work: last?.work ?? '', files: ['__tests__/b.test.ts'] }),
    )
    expect(JSON.parse(fileText(t.runDir, 'hidden-vitest.json'))).toEqual(report(last?.work ?? '', ['passed'])) // the report is kept
  })

  it('is verborgen_tests_rood when the hidden check fails', async () => {
    const t = await bench({ script: solve, docker: { hidden: [hiddenFails] } })
    expect(t.result).toMatchObject({ status: 'verborgen_tests_rood', runStatus: 'completed', hidden: { pass: false } })
    expect(t.result.hidden?.reason).toContain('1 falende test(s) in __tests__/b.test.ts')
  })

  it('is limiet when the turns run out, and keeps the patch', async () => {
    const t = await bench({ script: [writeZ()], task: { limits: { maxTurns: 1, maxOutputTokens: 20000, maxWallSeconds: 60, maxToolErrors: 3 } } })
    expect(t.result).toMatchObject({ status: 'limiet', runStatus: 'budget_exceeded' })
    expect(fileText(t.runDir, 'patch.diff')).toContain('+++ b/src/z.ts')
    expect(restoreForHiddenCheck).not.toHaveBeenCalled()
  })

  it('is limiet when the model makes too many tool errors', async () => {
    const t = await bench({
      script: [call('read_file', { path: 'bestaat-niet.txt' })],
      task: { limits: { maxTurns: 10, maxOutputTokens: 20000, maxWallSeconds: 60, maxToolErrors: 0 } },
    })
    expect(t.result).toMatchObject({ status: 'limiet', runStatus: 'failed', error: { code: 'TOO_MANY_TOOL_ERRORS' } })
  })

  it('is benchfout with a benchError when there is no recipe for the repository, before anything is cloned or started', async () => {
    const t = await bench({ task: { recipes: [{ repoUrl: 'https://example.invalid/other', prepare: [], verify: 'npm test' }] } })
    expect(t.result).toMatchObject({ status: 'benchfout', runStatus: 'not_run', usage: { source: 'missing', turns: 0 } })
    expect(t.result.benchError).toBe(`geen recept voor ${t.benchCase.repo_url}`)
    expect(existsSync(join(t.runDir, 'ws'))).toBe(false)
    expect(t.docker.runs).toHaveLength(0)
    expect(t.model.requests).toHaveLength(0)
  })

  it('is benchfout with a benchError when the clone cannot be made', async () => {
    const t = await bench({ case: { base_commit: 'f'.repeat(40) } })
    expect(t.result).toMatchObject({ status: 'benchfout', runStatus: 'not_run' })
    expect(t.result.benchError).toMatch(/^werkruimte aanmaken mislukt: /)
    expect(t.docker.runs).toHaveLength(0)
    expect(t.model.requests).toHaveLength(0)
  })

  it('is benchfout with the output tail when the prepare is red, before the model is called', async () => {
    const t = await bench({ docker: { prepare: [{ code: 1, out: 'npm ERR! ECONNRESET' }] } })
    expect(t.result.status).toBe('benchfout')
    expect(t.result.benchError).toBe('prepare faalde: exitcode 1\nnpm ERR! ECONNRESET')
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare'])
    expect(t.model.requests).toHaveLength(0)
  })

  it('runs no prepare container when the recipe has no prepare commands', async () => {
    const repo = await createBenchRepo()
    const t = await bench({ script: [say()], task: { recipes: [{ repoUrl: repo.url, prepare: [], verify: 'npm test' }] } })
    expect(t.result.status).toBe('geen_wijzigingen')
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['verify'])
  })

  it('is benchfout when the model run ends on MODEL_ERROR', async () => {
    const t = await bench({ script: [{ status: 400, body: { error: { message: 'kapot' } } }] })
    expect(t.result).toMatchObject({ status: 'benchfout', runStatus: 'failed', error: { code: 'MODEL_ERROR' } })
    expect(t.result.benchError).toBeUndefined() // the run itself ended so; the bench did not fail on its own
  })

  it('is benchfout when the model run ends on HARNESS_ERROR, and builds the client from the model spec and the key', async () => {
    const createClient = vi.fn((): ModelClient => ({
      complete: () => Promise.reject(new TypeError('onverwacht')),
    }))
    const t = await bench({ apiKey: DUMMY_KEY, deps: { createClient } })
    expect(t.result).toMatchObject({ status: 'benchfout', runStatus: 'failed', error: { code: 'HARNESS_ERROR', message: 'onverwacht' } })
    expect(createClient).toHaveBeenCalledWith({ baseUrl: t.model.baseUrl, name: 'qwen3.8-test', apiKey: DUMMY_KEY })
  })

  it('stops with benchfout when a container is not provably stopped, and starts no container after it', async () => {
    const t = await bench({
      script: [call('run_tests'), say()],
      docker: { verify: [{ hang: true }], killCode: 1 }, // the kill fails, so the cleanup ends 'uncertain'
      tune: (task) => {
        task.verifyTimeoutSeconds = 0.05
      },
    })
    expect(t.result.status).toBe('benchfout')
    expect(t.result.benchError).toBe(`container harness-${hex8Of(t.result)}-verify-2 niet aantoonbaar gestopt`)
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify'])
    expect(t.model.requests).toHaveLength(1) // the run stopped at the container, it did not ask the model again
    expect(capturePatch).not.toHaveBeenCalled() // no host git while a container may still be running
    expect(restoreForHiddenCheck).not.toHaveBeenCalled()
    expect(existsSync(join(t.runDir, 'patch.diff'))).toBe(false)
  })

  // runManifest drops a gate that is aborted at once, while its container is still being killed. The outcome of that kill decides
  // whether host git may run, so the bench has to wait for it, also when it was the run's own deadline that aborted the gate.
  it('waits for a gate container that is still being killed when the deadline hits, and runs no host git if it was not provably stopped', async () => {
    const t = await bench({
      script: [say()],
      task: { limits: { maxTurns: 10, maxOutputTokens: 20000, maxWallSeconds: 1, maxToolErrors: 3 } },
      docker: { verify: [{ hang: true }], killCode: 1, killDelayMs: 250 },
    })
    expect(t.result).toMatchObject({ status: 'benchfout', runStatus: 'timed_out' })
    expect(t.result.benchError).toBe(`container harness-${hex8Of(t.result)}-verify-2 niet aantoonbaar gestopt`)
    expect(capturePatch).not.toHaveBeenCalled()
    expect(restoreForHiddenCheck).not.toHaveBeenCalled()
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify'])
  })

  it('is benchfout when the container of the hidden check fails to run', async () => {
    const t = await bench({ script: solve, docker: { hidden: [{ code: null }] } })
    expect(t.result.status).toBe('benchfout')
    expect(t.result.benchError).toBe('verborgen toets: docker-proces eindigde zonder exitcode')
    expect(t.result.runStatus).toBe('completed')
    expect(t.result.hidden).toBeUndefined()
    expect(existsSync(join(t.runDir, 'hidden-vitest.json'))).toBe(false)
  })
})

describe('mapStatus', () => {
  const runOf = (status: RunStatus, code?: string): RunResult => ({
    runId: 'x',
    status,
    ...(code ? { error: { code, message: 'm' } } : {}),
    model: { name: 'm', baseUrl: 'http://x' },
    usage: { source: 'missing', inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0, toolErrors: 0 },
    durationMs: 1,
  })
  const passed = { pass: true, reason: 'ok', files: [] }
  const failed = { pass: false, reason: 'nee', files: [] }

  it.each([
    ['a benchError, whatever else there is', { benchError: 'x', run: runOf('completed'), hidden: passed }, 'benchfout'],
    ['no run at all', {}, 'benchfout'],
    ['failed MODEL_ERROR', { run: runOf('failed', 'MODEL_ERROR') }, 'benchfout'],
    ['failed HARNESS_ERROR', { run: runOf('failed', 'HARNESS_ERROR') }, 'benchfout'],
    ['failed TOOL_NOT_AVAILABLE', { run: runOf('failed', 'TOOL_NOT_AVAILABLE') }, 'benchfout'],
    ['failed with an end code nobody knows', { run: runOf('failed', 'UNKNOWN_TOOL') }, 'benchfout'],
    ['failed without any error', { run: runOf('failed') }, 'benchfout'],
    ['budget_exceeded', { run: runOf('budget_exceeded') }, 'limiet'],
    ['budget_exceeded with CONTEXT_EXHAUSTED', { run: runOf('budget_exceeded', 'CONTEXT_EXHAUSTED') }, 'limiet'],
    ['timed_out', { run: runOf('timed_out') }, 'limiet'],
    ['failed TOO_MANY_TOOL_ERRORS', { run: runOf('failed', 'TOO_MANY_TOOL_ERRORS') }, 'limiet'],
    ['failed VERIFY_FAILED', { run: runOf('failed', 'VERIFY_FAILED') }, 'verify_rood'],
    ['completed with an empty patch', { run: runOf('completed'), patchEmpty: true }, 'geen_wijzigingen'],
    ['completed with an empty patch and a hidden verdict', { run: runOf('completed'), patchEmpty: true, hidden: passed }, 'geen_wijzigingen'],
    ['completed, but the hidden container failed', { run: runOf('completed'), patchEmpty: false, hidden: passed, hiddenRunnerError: true }, 'benchfout'],
    ['completed with a patch and no hidden verdict', { run: runOf('completed'), patchEmpty: false }, 'benchfout'],
    ['completed with a passing hidden check', { run: runOf('completed'), patchEmpty: false, hidden: passed }, 'geslaagd'],
    ['completed with a failing hidden check', { run: runOf('completed'), patchEmpty: false, hidden: failed }, 'verborgen_tests_rood'],
  ] as const)('%s is %s', (_what, input, expected) => {
    expect(mapStatus(input)).toBe(expected)
  })
})

describe('createContainerRunner', () => {
  const fast = { killGraceMs: 20, cleanupTimeoutMs: 500, pollIntervalMs: 10 }
  const make = (docker: ReturnType<typeof fakeDocker>, abort: () => void = () => undefined) => {
    const task = benchTaskConfigFor({ url: 'file:///unused' } as BenchRepo)
    task.verifyTimeoutSeconds = 0.05
    const trace = openTrace(benchTmp('runner-trace'), 'run')
    return { trace, runner: createContainerRunner({ id: 'abcd1234', task, trace, abort, deps: { spawn: docker.spawn, ...fast } }) }
  }
  const go = (worktree: string, kind: 'prepare' | 'verify', signal = new AbortController().signal) => ({
    worktree,
    kind,
    source: kind === 'prepare' ? ('prepare' as const) : ('gate' as const),
    script: 'npm test',
    signal,
  })

  it('numbers the containers over every work tree it is used for, and records each one in the trace', async () => {
    const docker = fakeDocker({ prepare: [{ out: 'eerste' }], verify: [{ code: 1, out: 'tweede' }] })
    const { runner, trace } = make(docker)
    expect(await runner.run(go('/w1', 'prepare'))).toMatchObject({ exitCode: 0, output: 'eerste' })
    expect(await runner.run(go('/w2', 'verify'))).toMatchObject({ exitCode: 1, output: 'tweede' })
    expect(docker.runs.map((r) => [r.name, r.work])).toEqual([['harness-abcd1234-prepare-1', '/w1'], ['harness-abcd1234-verify-2', '/w2']])
    expect(readFileSync(join(trace.dir, 'containers/1.txt'), 'utf8')).toBe('eerste')
    expect(readFileSync(join(trace.dir, 'containers/2.txt'), 'utf8')).toBe('tweede')
    expect(readTrace(trace.dir).map((e) => [e.type, e.kind, e.source, e.n, e.exitCode])).toEqual([
      ['container', 'prepare', 'prepare', 1, 0],
      ['container', 'verify', 'gate', 2, 1],
    ])
  })

  it('remembers a container that was not provably stopped, aborts the run, and refuses every container after it', async () => {
    const docker = fakeDocker({ verify: [{ hang: true }], killCode: 1 })
    const abort = vi.fn()
    const { runner } = make(docker, abort)
    expect(runner.uncertain()).toBeUndefined()

    expect(await runner.run(go('/w', 'verify'))).toMatchObject({ timedOut: true, cleanup: 'uncertain' })
    expect(runner.uncertain()).toBe('harness-abcd1234-verify-1')
    expect(abort).toHaveBeenCalledTimes(1)

    expect(await runner.run(go('/w', 'prepare'))).toEqual({
      exitCode: null,
      output: '',
      timedOut: false,
      runnerError: 'container harness-abcd1234-verify-1 niet aantoonbaar gestopt',
    })
    expect(docker.runs).toHaveLength(1) // the second never reached docker
  })

  it('settle aborts a container that is still running and returns only when its cleanup is done', async () => {
    const docker = fakeDocker({ verify: [{ hang: true }], killDelayMs: 100 })
    const stop = new AbortController()
    const abort = vi.fn(() => stop.abort())
    const { runner } = make(docker, abort)
    const running = runner.run(go('/w', 'verify', stop.signal))
    await vi.waitFor(() => expect(docker.runs).toHaveLength(1))

    let settled = false
    const settling = runner.settle().then(() => {
      settled = true
    })
    expect(abort).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false) // the kill takes 100 ms
    await settling
    expect(docker.kills()).toEqual(['harness-abcd1234-verify-1'])
    expect(await running).toMatchObject({ cleanup: 'stopped', runnerError: 'afgebroken' })
    expect(runner.uncertain()).toBeUndefined()
  })

  it('settle has nothing to do, and aborts nothing, when no container is running', async () => {
    const abort = vi.fn()
    const { runner } = make(fakeDocker(), abort)
    await runner.run(go('/w', 'prepare'))
    await runner.settle()
    expect(abort).not.toHaveBeenCalled()
  })
})

describe('runTaskBench — transient model failures', () => {
  it('retries a 503 when retryTransient is on, and records the retry in the result and in the trace', async () => {
    const waits: number[] = []
    const t = await bench({
      retryTransient: true,
      script: [overloaded, say()],
      deps: {
        sleep: async (ms) => {
          waits.push(ms)
        },
      },
    })
    expect(t.result.runStatus).toBe('completed')
    expect(t.result.retries).toEqual([{ attempt: 1, kind: 'http', status: 503 }])
    expect(waits).toEqual([2000])
    expect(t.model.requests).toHaveLength(2)
    expect(readTrace(t.runDir).filter((e) => e.type === 'model_retry')).toEqual([
      expect.objectContaining({ type: 'model_retry', attempt: 1, kind: 'http', status: 503 }),
    ])
  })

  it('ends the same run on MODEL_ERROR, a benchfout, when retryTransient is off', async () => {
    const t = await bench({ retryTransient: false, script: [overloaded, say()] })
    expect(t.result).toMatchObject({ status: 'benchfout', runStatus: 'failed', error: { code: 'MODEL_ERROR' }, retries: [] })
    expect(t.result.error?.message).toContain('model HTTP 503')
    expect(t.model.requests).toHaveLength(1)
    expect(readTrace(t.runDir).some((e) => e.type === 'model_retry')).toBe(false)
  })
})

// What OpenRouter documents for a provider that fails after the answer has begun: HTTP 200, no top-level error, and the error inside
// the choice (finish_reason "error"). The model client turns that finish reason into 'other'. It is a provider failure, not an answer:
// scored as one, it would run the gate on an untouched tree and end the run as geen_wijzigingen, a verdict on a model that never answered.
describe('runTaskBench — a provider error inside a 200', () => {
  const providerError = (cost = 0.0004): FakeTurn => ({
    body: {
      id: 'gen-1',
      object: 'chat.completion',
      model: 'fake-model',
      choices: [{ index: 0, error: { code: 502, message: 'Provider disconnected unexpectedly' }, message: { role: 'assistant', content: '' }, finish_reason: 'error' }],
      usage: { prompt_tokens: 100, completion_tokens: 0, cost },
    },
  })
  /** A turn of the model that costs `cost`. */
  const paid = (turn: FakeTurn, cost: number): FakeTurn => ({ body: { ...(turn.body as object), usage: { prompt_tokens: 10, completion_tokens: 5, cost } } })
  const noWait = { sleep: async () => undefined }

  it('retries it, runs the gate on the answer that follows and not on the error, and counts what the dropped answer cost', async () => {
    const t = await bench({
      retryTransient: true,
      script: [providerError(0.0004), paid(writeZ(), 0.001), paid(say(), 0.0005)],
      docker: { hidden: [hiddenPasses] },
      deps: noWait,
    })
    expect(t.result).toMatchObject({ status: 'geslaagd', runStatus: 'completed' })
    expect(t.result.retries).toStrictEqual([{ attempt: 1, kind: 'finish_other', costUsd: 0.0004 }])
    expect(t.model.requests).toHaveLength(3)
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify', 'prepare', 'hidden']) // one gate run: for the answer, not for the error
    expect(outcomesOfGate(t.runDir)).toEqual(['accept'])
    expect(readTrace(t.runDir).filter((e) => e.type === 'model_retry')).toEqual([
      expect.objectContaining({ type: 'model_retry', attempt: 1, kind: 'finish_other', costUsd: 0.0004 }),
    ])
    // the loop saw 0.001 + 0.0005; the dropped answer was paid for as well, and the ledger reads this file
    expect(t.result.usage.costUsd).toBeCloseTo(0.0019, 10)
    expect(t.saved.usage.costUsd).toBeCloseTo(0.0019, 10)
  })

  it('ends four of them in a row as a benchfout on MODEL_ERROR, with all four counted and no gate run', async () => {
    const t = await bench({ retryTransient: true, script: [providerError(), providerError(), providerError(), providerError(), say()], deps: noWait })
    expect(t.result).toMatchObject({ status: 'benchfout', runStatus: 'failed', error: { code: 'MODEL_ERROR' }, patchBytes: 0 })
    expect(t.result.error?.message).toContain('finish_reason other')
    expect(t.result.benchError).toBeUndefined() // the run itself ended so; the bench did not fail on its own
    expect(t.result.retries.map((r) => [r.attempt, r.kind])).toEqual([[1, 'finish_other'], [2, 'finish_other'], [3, 'finish_other']])
    expect(t.model.requests).toHaveLength(4)
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare']) // no gate: there was no answer
    expect(t.result.usage.costUsd).toBeCloseTo(4 * 0.0004, 10) // three in the records, the last on the error
    expect(t.saved.usage.costUsd).toBeCloseTo(4 * 0.0004, 10)
  })

  // "Possibly with partial output": a tool call that was cut off with the error would otherwise be run, with arguments that are not whole.
  it('drops the partial output with it: a tool call that came with the error is not executed', async () => {
    const partial: FakeTurn = {
      body: {
        id: 'gen-1',
        object: 'chat.completion',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            error: { code: 502, message: 'Provider disconnected unexpectedly' },
            message: {
              role: 'assistant',
              content: 'Ik schrijf het bestand',
              tool_calls: [{ id: 'cut', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/z.ts","content":"export const z' } }],
            },
            finish_reason: 'error',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 12, cost: 0.0004 },
      },
    }
    const t = await bench({ retryTransient: true, script: [partial, say()], deps: noWait })
    expect(t.result.retries).toStrictEqual([{ attempt: 1, kind: 'finish_other', costUsd: 0.0004 }])
    expect(readTrace(t.runDir).some((e) => e.type === 'tool_call')).toBe(false) // never offered to the tools
    expect(t.result.usage.toolCalls).toBe(0)
    expect(t.model.requests[1].body.messages.some((m: { role: string }) => m.role === 'tool')).toBe(false) // and the retry does not mention it
  })

  it('counts the cost once when the stop comes during the wait before the retry', async () => {
    const stop = new AbortController()
    let waiting!: () => void
    const inWait = new Promise<void>((resolve) => (waiting = resolve))
    const t = await start({
      signal: stop.signal,
      retryTransient: true,
      script: [providerError(0.0004)],
      deps: {
        // like the real wait: it ends with an error when the signal fires
        sleep: (_ms, signal) =>
          new Promise<void>((_resolve, reject) => {
            waiting()
            signal.addEventListener('abort', () => reject(new Error('afgebroken')), { once: true })
          }),
      },
    })
    const running = t.run()
    await inWait
    stop.abort()
    const result = await running
    expect(result).toMatchObject({ status: 'benchfout', benchError: 'afgebroken' })
    expect(result.retries).toStrictEqual([{ attempt: 1, kind: 'finish_other', costUsd: 0.0004 }])
    expect(result.usage.costUsd).toBeCloseTo(0.0004, 10) // in the record, and not a second time from the error
    expect(t.model.requests).toHaveLength(1)
  })

  it('leaves the local route alone: without retryTransient the answer goes to the loop as before', async () => {
    const t = await bench({ retryTransient: false, script: [providerError(), say()] })
    expect(t.result).toMatchObject({ status: 'geen_wijzigingen', runStatus: 'completed', retries: [] })
    expect(t.model.requests).toHaveLength(1)
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify']) // the loop took it for an answer and ran the gate
    expect(t.result.usage.costUsd).toBeCloseTo(0.0004, 10) // counted by the loop itself
  })
})

describe('runTaskBench — what the result says about the responses', () => {
  const turn = (body: Record<string, unknown>, usage: Record<string, number>, provider: string): FakeTurn => ({ body: { ...body, usage, provider } })

  it('lists the provider of every response in order, and sums tokens and cost', async () => {
    const t = await bench({
      script: [
        turn(completion({ toolCalls: [{ id: 'a', name: 'list_files', arguments: '{}' }] }), { prompt_tokens: 100, completion_tokens: 20, cost: 0.002 }, 'DeepInfra'),
        turn(completion({ toolCalls: [{ id: 'b', name: 'list_files', arguments: '{}' }] }), { prompt_tokens: 150, completion_tokens: 10, cost: 0.001 }, 'DeepInfra'),
        turn(completion({ content: 'klaar' }), { prompt_tokens: 200, completion_tokens: 5, cost: 0.0005 }, 'Novita'),
      ],
    })
    expect(t.result.providers).toEqual(['DeepInfra', 'DeepInfra', 'Novita'])
    expect(t.result.usage).toMatchObject({ source: 'provider_reported', inputTokens: 450, outputTokens: 35, turns: 3, toolCalls: 2, toolErrors: 0 })
    expect(t.result.usage.costUsd).toBeCloseTo(0.0035, 10)
    expect(t.result.model).toEqual({ name: 'qwen3.8-test', baseUrl: t.model.baseUrl })
  })

  it('writes bench-result.json with the fields of the contract and returns the same object', async () => {
    const t = await bench({ script: [say()] })
    expect(t.saved).toEqual(JSON.parse(JSON.stringify(t.result)))
    expect(Object.keys(t.saved).sort()).toEqual(
      ['caseId', 'durationMs', 'gate', 'label', 'model', 'patchBytes', 'providers', 'retries', 'runId', 'runStatus', 'status', 'usage'].sort(),
    )
    expect(t.result).toMatchObject({ caseId: 'AH-01', label: 'test' })
    expect(t.result.runId).toMatch(/^AH-01-test-[0-9a-f]{8}$/)
    expect(t.result.durationMs).toBeGreaterThan(0)
    // the run dir holds the trace, the patch and the clone next to the result
    for (const name of ['trace.jsonl', 'result.json', 'patch.diff', 'containers/1.txt', 'ws/work/src/x.ts']) {
      expect(existsSync(join(t.runDir, name)), name).toBe(true)
    }
  })
})

describe('runTaskBench — a stop from outside', () => {
  /** A container that hangs until the stop comes, a moment after it started. */
  const hangsUntil = (stop: AbortController, onStart?: DockerStep['onStart']): DockerStep => ({
    hang: true,
    onStart: (run) => {
      onStart?.(run)
      setTimeout(() => stop.abort(), 20)
    },
  })
  const expectStopped = (t: Awaited<ReturnType<typeof bench>>) => {
    expect(t.result).toMatchObject({ status: 'benchfout', benchError: 'afgebroken' })
    expect(t.saved).toMatchObject({ status: 'benchfout', benchError: 'afgebroken' }) // the result file exists
    expect(capturePatch).not.toHaveBeenCalled()
  }

  it('stops during the prepare: the container is killed and nothing else starts', async () => {
    const stop = new AbortController()
    const t = await bench({ signal: stop.signal, docker: { prepare: [hangsUntil(stop)] } })
    expectStopped(t)
    expect(t.docker.kills()).toEqual([`harness-${hex8Of(t.result)}-prepare-1`])
    expect(t.docker.runs).toHaveLength(1)
    expect(t.model.requests).toHaveLength(0)
  })

  it('stops during a run_tests container: the container is killed and no container starts after it', async () => {
    const stop = new AbortController()
    const t = await bench({ signal: stop.signal, script: [call('run_tests'), say()], docker: { verify: [hangsUntil(stop)] } })
    expectStopped(t)
    expect(t.docker.kills()).toEqual([`harness-${hex8Of(t.result)}-verify-2`])
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify'])
    expect(t.model.requests).toHaveLength(1)
  })

  it('stops during the hidden check: the container is killed, and the run is not scored', async () => {
    const stop = new AbortController()
    const t = await bench({ signal: stop.signal, script: [writeZ(), say()], docker: { hidden: [hangsUntil(stop)] } })
    expect(t.result).toMatchObject({ status: 'benchfout', benchError: 'afgebroken' })
    expect(t.saved.hidden).toBeUndefined()
    expect(t.docker.kills()).toEqual([`harness-${hex8Of(t.result)}-verify-4`])
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify', 'prepare', 'hidden'])
  })

  it('stops during the reinstall that comes before the hidden check: the container is killed, no hidden container starts, and it is no failed reinstall', async () => {
    const stop = new AbortController()
    const t = await bench({ signal: stop.signal, script: [writeZ(), say()], docker: { prepare: [{}, hangsUntil(stop)] } })
    expect(t.result).toMatchObject({ status: 'benchfout', benchError: 'afgebroken' }) // not "herinstallatie … faalde"
    expect(t.saved).toMatchObject({ status: 'benchfout', benchError: 'afgebroken' })
    expect(t.saved.hidden).toBeUndefined()
    expect(t.docker.kills()).toEqual([`harness-${hex8Of(t.result)}-prepare-3`])
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify', 'prepare'])
  })

  // The scan and the restore cannot be aborted, and a stop can come in the time they take. No container starts after a stop, the
  // reinstall before the hidden check no more than the hidden check itself: a container that started anyway would be killed at once, and
  // a kill that is not provably done is a benchfout of its own ("niet aantoonbaar gestopt") instead of afgebroken.
  it('starts no reinstall or hidden-check container once the stop has come, also when it came while the work tree was being made ready for them', async () => {
    const stop = new AbortController()
    const t = await start({ signal: stop.signal, script: [writeZ(), say()] })
    const restore = vi.mocked(restoreForHiddenCheck)
    const real = restore.getMockImplementation()
    if (!real) throw new Error('restoreForHiddenCheck is not spied on')
    restore.mockImplementationOnce(async (...args) => {
      stop.abort() // the stop lands during the restore
      return real(...args)
    })

    const result = await t.run()

    expect(restore).toHaveBeenCalledTimes(1) // the premise: the run did get as far as the restore
    expect(result).toMatchObject({ status: 'benchfout', benchError: 'afgebroken' })
    expect(result.hidden).toBeUndefined()
    expect(JSON.parse(readFileSync(join(t.out, result.runId, 'bench-result.json'), 'utf8'))).toMatchObject({ status: 'benchfout', benchError: 'afgebroken' })
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify']) // no reinstall and no hidden container was started…
    expect(t.docker.kills()).toEqual([]) // …so none had to be killed
  })

  it('stops a model request that is in flight', async () => {
    const stop = new AbortController()
    const t = await start({ signal: stop.signal, script: [{ delayMs: 10_000, body: completion({ content: 'te laat' }) }] })
    const running = t.run()
    await vi.waitFor(() => expect(t.model.requests).toHaveLength(1)) // the server has the request and is sitting on it
    const stopped = Date.now()
    stop.abort()
    const result = await running
    expect(Date.now() - stopped).toBeLessThan(5000) // it did not wait for the answer
    expect(result).toMatchObject({ status: 'benchfout', benchError: 'afgebroken' })
    expect(capturePatch).not.toHaveBeenCalled()
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare'])
  })

  it('stops during the wait before a retry, without a new model request, and keeps the record of that retry', async () => {
    const stop = new AbortController()
    let waiting!: () => void
    const inWait = new Promise<void>((resolve) => (waiting = resolve))
    const t = await start({
      signal: stop.signal,
      retryTransient: true,
      script: [overloaded],
      deps: {
        // like the real wait: it ends with an error when the signal fires
        sleep: (_ms, signal) =>
          new Promise<void>((_resolve, reject) => {
            waiting()
            signal.addEventListener('abort', () => reject(new Error('afgebroken')), { once: true })
          }),
      },
    })
    const running = t.run()
    await inWait
    stop.abort()
    const result = await running
    expect(result).toMatchObject({ status: 'benchfout', benchError: 'afgebroken' })
    expect(result.retries).toEqual([{ attempt: 1, kind: 'http', status: 503 }]) // a retry that was announced and then cut short
    expect(t.model.requests).toHaveLength(1)
    expect(existsSync(join(t.out, result.runId, 'bench-result.json'))).toBe(true)
  })

  it('writes an afgebroken result without a clone or a container when the stop came before anything started', async () => {
    const stop = new AbortController()
    stop.abort()
    const t = await bench({ signal: stop.signal })
    expectStopped(t)
    expect(existsSync(join(t.runDir, 'ws'))).toBe(false)
    expect(t.docker.runs).toHaveLength(0)
    expect(t.model.requests).toHaveLength(0)
  })
})

describe('runTaskBench — the scan of the git administration', () => {
  /** What a hostile prepare or test run does: it points the git file of the submodule somewhere else. */
  const rewritesSubmodulePointer = (path: string): DockerStep => ({ effect: ({ work }) => writeFileSync(join(work, path, '.git'), 'gitdir: /elsewhere\n') })

  it('is a benchfout naming the path when the prepare rewrote the submodule pointer, before the model runs or any host git', async () => {
    const repo = await createBenchRepo()
    const t = await bench({ docker: { prepare: [rewritesSubmodulePointer(repo.sub.path)] } })
    expect(t.result.status).toBe('benchfout')
    expect(t.result.benchError).toBe('git-administratie gewijzigd: changed: vendor/sub/.git')
    expect(t.model.requests).toHaveLength(0)
    expect(capturePatch).not.toHaveBeenCalled()
    expect(restoreForHiddenCheck).not.toHaveBeenCalled()
  })

  it('is a benchfout naming the path when the model loop rewrote it, and then runs no host git', async () => {
    const repo = await createBenchRepo()
    const t = await bench({ script: [call('run_tests'), say()], docker: { verify: [rewritesSubmodulePointer(repo.sub.path)] } })
    expect(t.result.status).toBe('benchfout')
    expect(t.result.benchError).toBe('git-administratie gewijzigd: changed: vendor/sub/.git')
    expect(t.result.runStatus).toBe('completed') // the run was fine; the tree cannot be trusted
    expect(capturePatch).not.toHaveBeenCalled()
    expect(restoreForHiddenCheck).not.toHaveBeenCalled()
    expect(existsSync(join(t.runDir, 'patch.diff'))).toBe(false)
  })

  it('scans before capturePatch and again before restoreForHiddenCheck', async () => {
    await bench({ script: [writeZ(), say()], docker: { hidden: [hiddenPasses] } })
    const scans = vi.mocked(assertAdminUnchanged).mock.invocationCallOrder
    const patched = vi.mocked(capturePatch).mock.invocationCallOrder[0]
    const restored = vi.mocked(restoreForHiddenCheck).mock.invocationCallOrder[0]
    expect(scans.some((n) => n < patched)).toBe(true)
    expect(scans.some((n) => n > patched && n < restored)).toBe(true)
  })
})

describe('runTaskBench — the hidden check cannot be forged', () => {
  it('removes .task-bench before the hidden container starts, so a report left by the model run counts for nothing', async () => {
    const forge: DockerStep = { effect: ({ work }) => writeReport(work, report(work, ['passed'])) } // as if the model's code wrote it
    const seen: { forgedAtStart?: boolean } = {}
    // Exit code 0 and no report: vitest died before it wrote one.
    const crashed: DockerStep = { onStart: ({ work }) => (seen.forgedAtStart = existsSync(join(work, '.task-bench/hidden.json'))) }
    const t = await bench({ script: [writeZ(), call('run_tests'), say()], docker: { verify: [forge, {}], hidden: [crashed] } })

    expect(seen.forgedAtStart).toBe(false)
    expect(t.result.status).toBe('verborgen_tests_rood')
    expect(t.result.hidden?.pass).toBe(false)
    expect(t.result.hidden?.reason).toContain('vitest-JSON ontbreekt of is onleesbaar')
    expect(fileText(t.runDir, 'patch.diff')).not.toContain('.task-bench')
  })
})

// The hidden check runs vitest from node_modules, and node_modules is in the work tree that the model can write to (the task tools
// refuse only paths with a .git segment). A model that rewrites the entry point of vitest decides what the hidden check reports. So the
// hidden check does not trust the node_modules that the model run left: the lockfile and .npmrc of the ref go back with the rest of the
// runner configuration, and the recipe's prepare (npm ci, which removes node_modules first) runs again before the hidden container.
describe('runTaskBench — the dependencies are installed afresh before the hidden check', () => {
  const VITEST_ENTRY = 'node_modules/vitest/vitest.mjs'
  const solve = [writeZ(), say()]
  const entryOf = (work: string): string | undefined => (existsSync(join(work, VITEST_ENTRY)) ? readFileSync(join(work, VITEST_ENTRY), 'utf8') : undefined)

  /** `npm ci`: it removes node_modules and installs what the lockfile says, the real vitest among it. */
  const npmCi: DockerStep = {
    effect: ({ work }) => {
      rmSync(join(work, 'node_modules'), { recursive: true, force: true })
      mkdirSync(join(work, 'node_modules/vitest'), { recursive: true })
      writeFileSync(join(work, VITEST_ENTRY), 'REAL vitest\n')
    },
  }
  /**
   * The hidden container runs whatever vitest entry point the work tree has. The real one fails the hidden test: src/y.ts, which it
   * imports, does not exist. A forged one prints a valid-looking report of a pass without running anything.
   */
  const vitestOfTheTree = (seen: { entry?: string } = {}): DockerStep => {
    const step: DockerStep = {
      onStart: ({ work }) => {
        seen.entry = entryOf(work)
      },
      effect: ({ work }) => {
        const forged = entryOf(work)?.startsWith('FORGED') === true
        step.code = forged ? 0 : 1
        writeReport(work, report(work, [forged ? 'passed' : 'failed']))
      },
    }
    return step
  }
  /** What the model does with its write_file tool. */
  const writes = (path: string, content: string, id: string): FakeTurn => call('write_file', { path, content }, id)

  it('does not let a vitest entry point that the model wrote decide the hidden check: it is installed again before the hidden container starts', async () => {
    const seen: { atGate?: string } = {}
    const atHidden: { entry?: string } = {}
    const t = await bench({
      script: [writes(VITEST_ENTRY, 'FORGED vitest: always reports a pass\n', 'forge'), ...solve],
      docker: {
        prepare: [npmCi, npmCi],
        verify: [{ onStart: ({ work }) => (seen.atGate = entryOf(work)) }], // the premise: the forgery is in the tree when the model is done
        hidden: [vitestOfTheTree(atHidden)],
      },
    })
    expect(t.result).toMatchObject({ status: 'verborgen_tests_rood', runStatus: 'completed', hidden: { pass: false } }) // not geslaagd, whatever the forged vitest reports
    expect(seen.atGate).toBe('FORGED vitest: always reports a pass\n')
    expect(atHidden.entry).toBe('REAL vitest\n') // gone and installed again by the container that came before the hidden one
    // the order of the containers is the point: the prepare of the recipe again, then the hidden check
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify', 'prepare', 'hidden'])
    expect(t.docker.runs.map((r) => r.name)).toEqual(['prepare-1', 'verify-2', 'prepare-3', 'verify-4'].map((n) => `harness-${hex8Of(t.result)}-${n}`))
    expect(t.docker.runs[2].script).toBe(buildScript(['npm ci'])) // the commands of the recipe, nothing of the model's
  })

  it('puts package-lock.json and .npmrc back to the ref before the reinstall: the model cannot choose what is installed', async () => {
    const seen: { lock?: string; npmrc?: boolean; restores?: number } = {}
    const reinstall: DockerStep = {
      onStart: ({ work }) => {
        seen.lock = readFileSync(join(work, 'package-lock.json'), 'utf8')
        seen.npmrc = existsSync(join(work, '.npmrc'))
        seen.restores = vi.mocked(restoreForHiddenCheck).mock.calls.length
      },
    }
    const t = await bench({
      script: [writes('.npmrc', 'registry=https://registry.invalid/\n', 'npmrc'), writes('package-lock.json', '{ "forged": true }\n', 'lock'), ...solve],
      docker: { prepare: [{}, reinstall], hidden: [hiddenPasses] },
    })
    expect(fileText(t.runDir, 'patch.diff')).toContain('+++ b/.npmrc') // the premise: the model did write them, and the patch was taken before the restore
    expect(seen).toEqual({ lock: t.repo.at.b['package-lock.json'], npmrc: false, restores: 1 }) // the ref has no .npmrc; the restore ran before the reinstall
    expect(t.result.status).toBe('geslaagd')
    expect(vi.mocked(restoreForHiddenCheck)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(capturePatch)).toHaveBeenCalledTimes(1) // and no host git follows the reinstall
  })

  describe('a reinstall that does not succeed', () => {
    it.each([
      ['is red', { code: 1, out: 'npm ERR! ECONNRESET' }, 'exitcode 1\nnpm ERR! ECONNRESET'],
      ['cannot run at all', { code: null, errorMessage: 'spawn docker ENOENT' }, 'docker-proces eindigde zonder exitcode: spawn docker ENOENT\n'],
    ] as const)('is a benchfout of the bench when it %s, and no hidden container starts', async (_what, step, text) => {
      const t = await bench({ script: solve, docker: { prepare: [{}, step], hidden: [hiddenPasses] } })
      expect(t.result).toMatchObject({ status: 'benchfout', runStatus: 'completed' }) // the model run itself was fine
      expect(t.result.benchError).toBe(`herinstallatie vóór de verborgen toets faalde: ${text}`)
      expect(t.saved).toMatchObject({ status: 'benchfout', benchError: t.result.benchError })
      expect(t.result.hidden).toBeUndefined()
      expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify', 'prepare']) // no hidden container
      expect(existsSync(join(t.runDir, 'hidden-vitest.json'))).toBe(false)
    })

    it('is a benchfout of the bench when it runs into its timeout', async () => {
      const t = await bench({
        script: solve,
        docker: { prepare: [{}, { hang: true }], hidden: [hiddenPasses] },
        tune: (task) => {
          task.prepareTimeoutSeconds = 0.05 // the first prepare is done long before
        },
      })
      expect(t.result.status).toBe('benchfout')
      expect(t.result.benchError).toBe('herinstallatie vóór de verborgen toets faalde: timeout\n')
      expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify', 'prepare'])
      expect(t.docker.kills()).toEqual([`harness-${hex8Of(t.result)}-prepare-3`]) // and the container is cleaned up
    })
  })

  it('has nothing to install when the recipe has no prepare commands, and goes straight to the hidden check', async () => {
    const repo = await createBenchRepo()
    const t = await bench({ script: solve, task: { recipes: [{ repoUrl: repo.url, prepare: [], verify: 'npm test' }] }, docker: { hidden: [hiddenPasses] } })
    expect(t.result.status).toBe('geslaagd')
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['verify', 'hidden'])
  })
})

// Spec §4.1: a container that failed outside the model is a benchfout. A verify container that cannot run at all (the docker binary is
// not there, the docker process ends without an exit code) says nothing about the work of the model. Counted as a red verify, an outage
// of the bench host becomes three red gate runs and a verdict on the model (verify_rood). The worker does count it as red, and
// runTaskJob does not change: this is one of the deliberate differences (see bench-worker-parity.test.ts).
describe('runTaskBench — a verify container that fails outside the model', () => {
  const REASON = 'docker-proces eindigde zonder exitcode: spawn docker ENOENT'
  const dockerGone: DockerStep = { code: null, errorMessage: 'spawn docker ENOENT' } // what a missing docker binary looks like
  const fault = `verify-container: ${REASON}`
  const limitsOf = (maxToolErrors: number) => ({ limits: { maxTurns: 10, maxOutputTokens: 20000, maxWallSeconds: 60, maxToolErrors } })
  const quickTimeout = (task: TaskConfig) => {
    task.verifyTimeoutSeconds = 0.05 // only for a test that needs a time-out: any other container is done long before
  }

  it('ends the run at the first gate run that cannot run, as a benchfout and not as verify_rood after three, and runs no gate again', async () => {
    const t = await bench({ script: [say('een'), say('twee'), say('drie')], docker: { verify: [dockerGone, dockerGone, dockerGone] } })
    expect(t.result).toMatchObject({
      status: 'benchfout',
      benchError: fault,
      runStatus: 'failed',
      error: { code: 'HARNESS_ERROR', message: 'aborted' }, // the bench aborted the run itself, as for a container that is not provably stopped
      gate: { reds: 0, lastTail: `${REASON}\n` }, // not a red verify, so not counted; the tail says what the gate saw
    })
    expect(t.saved).toMatchObject({ status: 'benchfout', benchError: fault })
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify']) // one gate run
    expect(t.model.requests).toHaveLength(1) // and the model is not asked again
    expect(outcomesOfGate(t.runDir)).toEqual([])
    expect(capturePatch).not.toHaveBeenCalled() // no host git after a container that failed
    expect(restoreForHiddenCheck).not.toHaveBeenCalled()
    expect(existsSync(join(t.runDir, 'patch.diff'))).toBe(false)
  })

  it('counts the red verifies before the one that cannot run, and not that one', async () => {
    const t = await bench({ script: [say('een'), say('twee'), say('drie')], docker: { verify: [{ code: 1, out: 'FAIL a.test.ts' }, dockerGone, {}] } })
    expect(t.result).toMatchObject({ status: 'benchfout', benchError: fault, gate: { reds: 1, lastTail: `${REASON}\n` } })
    expect(outcomesOfGate(t.runDir)).toEqual(['retry']) // the red one was sent back; the one that could not run was not judged
    expect(t.model.requests).toHaveLength(2)
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify', 'verify'])
  })

  it('does the same for a run_tests that cannot run: the run ends there, and the model does not get a tool error to work around', async () => {
    const t = await bench({ script: [call('run_tests'), say(), say()], docker: { verify: [dockerGone] } })
    expect(t.result).toMatchObject({ status: 'benchfout', benchError: fault, gate: { reds: 0 } })
    expect(t.result.gate.lastTail).toBeUndefined() // that is the tail of the gate, and no gate ran
    expect(t.docker.runs.map((r) => r.purpose)).toEqual(['prepare', 'verify']) // the gate that the next answer would have run never starts
    expect(t.model.requests).toHaveLength(1)
    expect(capturePatch).not.toHaveBeenCalled()
  })

  it('is a benchfout even when the tool error of that run_tests is one more than the model may make: that is no limiet', async () => {
    const t = await bench({ script: [call('run_tests'), say()], task: limitsOf(0), docker: { verify: [dockerGone] } })
    expect(t.result).toMatchObject({ status: 'benchfout', benchError: fault, runStatus: 'failed', error: { code: 'TOO_MANY_TOOL_ERRORS' } })
  })

  it('keeps a verify that runs into its timeout a red verify: the code of the model made it, not the bench', async () => {
    const t = await bench({ script: [say('een'), say('twee'), say('drie')], docker: { verify: [{ hang: true }, { hang: true }, { hang: true }] }, tune: quickTimeout })
    expect(t.result).toMatchObject({ status: 'verify_rood', error: { code: 'VERIFY_FAILED' }, gate: { reds: 3, lastTail: 'timeout\n' } })
    expect(t.result.benchError).toBeUndefined()
  })

  it('keeps a run_tests that runs into its timeout a tool result for the model, and the run goes on', async () => {
    const t = await bench({ script: [call('run_tests'), say()], docker: { verify: [{ hang: true }] }, tune: quickTimeout })
    expect(t.result).toMatchObject({ status: 'geen_wijzigingen', runStatus: 'completed' }) // the gate after the next answer is green; nothing was written
    expect(t.result.benchError).toBeUndefined()
    expect(t.model.requests).toHaveLength(2)
  })

  it('is no fault when the deadline of the run aborts the gate container: that stays a limiet', async () => {
    const t = await bench({
      script: [say()],
      task: { limits: { maxTurns: 10, maxOutputTokens: 20000, maxWallSeconds: 1, maxToolErrors: 3 } },
      docker: { verify: [{ hang: true }] }, // killed by the deadline; the kill is provable, so nothing is uncertain
    })
    expect(t.result).toMatchObject({ status: 'limiet', runStatus: 'timed_out' })
    expect(t.result.benchError).toBeUndefined()
    expect(t.docker.kills()).toEqual([`harness-${hex8Of(t.result)}-verify-2`])
  })
})

// The hidden container runs model-written code on a writable work tree, so what it leaves at .task-bench/hidden.json is hostile until
// proven otherwise. The bench reads that path on the host once the container is gone: it must not follow a link out of the work tree
// (the bench user can read more than the work tree: a key file in a hosted window), and must not wait on a FIFO (the stop signals
// could not run, and no result would be written). Such a run is a benchfout with a clear message, never a copy of a host file.
describe('runTaskBench — a hostile report path after the hidden check', () => {
  const MARKER = 'HOST-SECRET-MARKER-4f9c'
  const solve = [writeZ(), say()]
  /** A dir outside every work tree, with a file in it that holds the MARKER. */
  function hostSide() {
    const dir = benchTmp('host')
    writeFileSync(join(dir, 'secret.key'), MARKER)
    return { dir, secret: join(dir, 'secret.key') }
  }
  const notCopied = (t: Awaited<ReturnType<typeof bench>>) => {
    expect(runText(t.runDir)).not.toContain(MARKER) // not in hidden-vitest.json, bench-result.json, the trace, anywhere the run wrote
    expect(existsSync(join(t.runDir, 'hidden-vitest.json'))).toBe(false)
    expect(t.result.hidden).toBeUndefined()
  }

  it('refuses a hidden.json that is a symlink to a file of the host: benchfout, and nothing of that file is copied', async () => {
    const { secret } = hostSide()
    const link: DockerStep = {
      effect: ({ work }) => {
        mkdirSync(join(work, '.task-bench'))
        symlinkSync(secret, join(work, '.task-bench/hidden.json'))
      },
    }
    const t = await bench({ script: solve, docker: { hidden: [link] } })
    notCopied(t)
    expect(t.result.status).toBe('benchfout')
    expect(t.result.benchError).toBe('verborgen toets: .task-bench/hidden.json is een symlink, geen gewoon bestand')
    expect(t.saved).toMatchObject({ status: 'benchfout', runStatus: 'completed' }) // the run itself was fine
  })

  it('refuses a hidden.json that is a FIFO without waiting on it: benchfout, and the result is written', async () => {
    const fifo: DockerStep = {
      effect: ({ work }) => {
        mkdirSync(join(work, '.task-bench'))
        makeFifo(join(work, '.task-bench/hidden.json'), { delayMs: 4000 }) // a read that waits on it is released only after 4 s
      },
    }
    const started = Date.now()
    const t = await bench({ script: solve, docker: { hidden: [fifo] } })
    expect(Date.now() - started).toBeLessThan(3000) // a whole run takes about a second; a read that waits on the FIFO adds 4 s or more
    expect(t.result.status).toBe('benchfout')
    expect(t.result.benchError).toBe('verborgen toets: .task-bench/hidden.json is een FIFO, geen gewoon bestand')
    expect(t.saved.status).toBe('benchfout') // bench-result.json is there
    notCopied(t)
  })

  it('refuses .task-bench itself as a symlink to a directory outside the work tree, whatever report lies there', async () => {
    const { dir } = hostSide()
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    const swap: DockerStep = {
      effect: ({ work }) => {
        // a forged pass, which would be read as the verdict if the link were followed (the marker proves a copy)
        writeFileSync(join(elsewhere, 'hidden.json'), JSON.stringify({ ...report(work, ['passed']), marker: MARKER }))
        symlinkSync(elsewhere, join(work, '.task-bench'))
      },
    }
    const t = await bench({ script: solve, docker: { hidden: [swap] } })
    notCopied(t)
    expect(t.result.status).toBe('benchfout') // not geslaagd
    expect(t.result.benchError).toBe('verborgen toets: .task-bench is een symlink, geen gewone map')
  })

  it('removes a .task-bench symlink that the model run left, without touching what it pointed at', async () => {
    const { dir } = hostSide()
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'bewaar.txt'), 'blijft staan')
    const leave: DockerStep = { effect: ({ work }) => symlinkSync(elsewhere, join(work, '.task-bench')) } // as the model's code could
    const seen: { atStart?: boolean } = {}
    const hidden: DockerStep = { onStart: ({ work }) => (seen.atStart = existsSync(join(work, '.task-bench'))) } // no report: vitest died
    const t = await bench({ script: [writeZ(), call('run_tests'), say()], docker: { verify: [leave, {}], hidden: [hidden] } })
    expect(seen.atStart).toBe(false) // the link is gone before the hidden container starts…
    expect(readFileSync(join(elsewhere, 'bewaar.txt'), 'utf8')).toBe('blijft staan') // …and its target is as it was
    expect(t.result.status).toBe('verborgen_tests_rood') // no report, so no pass; the run is judged, not failed
  })
})

describe('runTaskBench — secrets', () => {
  /** Collects what the run prints to stdout and stderr, until `restore()`. */
  const spyOnOutput = () => {
    const chunks: string[] = []
    const write = (chunk: string | Uint8Array) => {
      chunks.push(String(chunk))
      return true
    }
    const spies = [vi.spyOn(process.stdout, 'write').mockImplementation(write), vi.spyOn(process.stderr, 'write').mockImplementation(write)]
    return { text: () => chunks.join(''), restore: () => spies.forEach((spy) => spy.mockRestore()) }
  }

  it('keeps the key out of the result, the trace, the patch and the output when the server echoes it in an error', async () => {
    const output = spyOnOutput()
    let t: Awaited<ReturnType<typeof bench>>
    try {
      t = await bench({ apiKey: DUMMY_KEY, script: [{ status: 401, body: bodyWithKeyAt(190, (p) => JSON.stringify({ error: { message: p } })) }] })
    } finally {
      output.restore()
    }
    expect(t.model.requests[0].headers.authorization).toBe(`Bearer ${DUMMY_KEY}`) // the bench did send the key
    expect(t.result.status).toBe('benchfout')
    expect(fileText(t.runDir, 'bench-result.json')).toContain('<redacted>') // the premise: the error did carry the key once
    expect(leakedFragments(runText(t.runDir)), 'the run dir').toEqual([])
    expect(leakedFragments(output.text()), 'stdout and stderr').toEqual([])
  })

  it('keeps the key out of the manifest, the patch and everything else of a run that completes', async () => {
    const t = await bench({
      apiKey: DUMMY_KEY,
      retryTransient: true,
      script: [overloaded, writeZ(), say()],
      docker: { hidden: [hiddenPasses] },
      deps: { sleep: async () => undefined },
    })
    expect(t.model.requests.every((r) => r.headers.authorization === `Bearer ${DUMMY_KEY}`)).toBe(true)
    expect(t.result.status).toBe('geslaagd')
    expect(runsSeen[0].manifest.model).toEqual({ baseUrl: t.model.baseUrl, name: 'qwen3.8-test' }) // no apiKey in the manifest…
    const runStart = readTrace(t.runDir).find((e) => e.type === 'run_start') // the manifest as the trace has it
    expect(runStart).toMatchObject({ manifest: { model: { baseUrl: t.model.baseUrl, name: 'qwen3.8-test' } } })
    expect(JSON.stringify(runStart)).not.toContain('apiKey') // …nor in its copy in the trace
    expect(leakedFragments(runText(t.runDir)), 'the run dir').toEqual([])
  })
})
