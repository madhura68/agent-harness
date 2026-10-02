import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { z } from 'zod'
import type { Manifest, ModelSpecSchema } from '../manifest.js'
import { createModelClient, type ModelClient } from '../model-client.js'
import { runManifest, type AfterAnswerResult } from '../run.js'
import { openTrace, type RunResult, type TraceWriter } from '../trace.js'
import { findRecipe, type TaskConfig } from '../worker/config.js'
import { buildScript, containerName, runInContainer, type ContainerDeps } from '../worker/containers.js'
import { isGreen, verifyText } from '../worker/task-impl.js'
import { createTaskTools, type VerifyRun } from '../worker/task-tools.js'
import type { BenchCase } from './case.js'
import { BENCH_DIR, evaluateHidden, HIDDEN_REPORT, hiddenCheckScript, type HiddenResult } from './hidden-check.js'
import { createRetryingClient, type RetryRecord } from './retry-client.js'
import { BENCH_SYSTEM_PROMPT, benchTaskPrompt } from './task-prompt.js'
import { AdminChangedError, assertAdminUnchanged, capturePatch, createWorkspace, restoreForHiddenCheck, snapshotAdmin, type Workspace } from './workspace.js'

export type ModelSpec = z.infer<typeof ModelSpecSchema>

/** The six outcomes of one run (spec §4.1). `benchfout` is never a verdict on the model. */
export type BenchStatus = 'geslaagd' | 'verborgen_tests_rood' | 'verify_rood' | 'limiet' | 'geen_wijzigingen' | 'benchfout'

/** Test seams. Production passes none: the real `docker` and the real `createModelClient`, and the real timer for the wait before a retry. */
export type BenchDeps = {
  containerDeps?: ContainerDeps
  createClient?: (m: ModelSpec & { apiKey?: string }) => ModelClient
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * `<out>/<runId>/bench-result.json`. `runStatus` is the raw end status of `runManifest`, or `not_run` when the bench failed before the
 * model loop started. `error` is the end error of that run (masked by the model client). `hidden` is the verdict of the hidden check,
 * and absent when that did not run or its container failed. `durationMs` is the wall time of the whole bench run: clone, prepare,
 * model loop and hidden check. `providers` lists the `provider` of the responses that named one, in order.
 */
export type BenchResult = {
  caseId: string
  label: string
  runId: string
  model: { name: string; baseUrl: string }
  status: BenchStatus
  runStatus: RunResult['status'] | 'not_run'
  error?: { code: string; message: string }
  gate: { reds: number; lastTail?: string }
  hidden?: HiddenResult
  usage: RunResult['usage']
  providers: string[]
  retries: RetryRecord[]
  patchBytes: number
  durationMs: number
  benchError?: string
}

/**
 * Maps the end of a run to its status (spec §4.1). A fragile contract: the order of the rules is the meaning. A bench failure, or
 * an end that nobody foresaw, is a `benchfout` and never silently a fault of the model.
 */
export function mapStatus(r: { benchError?: string; run?: RunResult; patchEmpty?: boolean; hidden?: HiddenResult; hiddenRunnerError?: boolean }): BenchStatus {
  if (r.benchError || !r.run) return 'benchfout'
  const code = r.run.error?.code
  if (r.run.status === 'failed' && (code === 'MODEL_ERROR' || code === 'HARNESS_ERROR' || code === 'TOOL_NOT_AVAILABLE')) return 'benchfout'
  if (r.run.status === 'budget_exceeded' || r.run.status === 'timed_out' || code === 'TOO_MANY_TOOL_ERRORS') return 'limiet'
  if (code === 'VERIFY_FAILED') return 'verify_rood'
  if (r.run.status !== 'completed') return 'benchfout' // een onbekende eindcode: nooit stil als modelfout tellen
  if (r.patchEmpty) return 'geen_wijzigingen'
  if (r.hiddenRunnerError || !r.hidden) return 'benchfout'
  return r.hidden.pass ? 'geslaagd' : 'verborgen_tests_rood'
}

// ---------------------------------------------------------------------------------------------------
// Containers: the bookkeeping of runTaskJob (src/worker/task-impl.ts), as a piece of its own.
// ---------------------------------------------------------------------------------------------------

/** What a container is for; it shows in the `container` event of the trace. */
export type ContainerSource = 'prepare' | 'run_tests' | 'gate' | 'hidden_check'

export type ContainerRunner = {
  /** Runs one container on the work tree `worktree`: a `prepare` or `verify` container with this script, which `signal` stops. Never starts one after an uncertain cleanup. */
  run(c: { worktree: string; kind: 'prepare' | 'verify'; source: ContainerSource; script: string; signal: AbortSignal }): Promise<VerifyRun>
  /** Aborts every container still running and waits until each of them is cleaned up (or its cleanup is known to be uncertain). */
  settle(): Promise<void>
  /** The name of the container that was not provably stopped, once there is one. */
  uncertain(): string | undefined
}

/**
 * The container bookkeeping of `runTaskJob`, deliberately a copy (the worker may only gain two exports, and a change there has to be
 * made here too): every call still running is tracked, so that the outcome is only decided once each has settled; a container
 * that was not provably stopped (`cleanup: 'uncertain'`) is remembered for good, aborts the run through `abort`, and no other
 * container starts after it. `id` is the first part of the container names (`containerName` keeps its first 8 characters), so
 * two runs at the same time need different ids. The counter `n` runs over every work tree this runner is used for.
 */
export function createContainerRunner(o: { id: string; task: TaskConfig; trace: TraceWriter; abort: () => void; deps?: ContainerDeps }): ContainerRunner {
  const inFlight = new Set<Promise<VerifyRun>>()
  let uncertain: string | undefined
  let containerNo = 0

  const execute = async (c: Parameters<ContainerRunner['run']>[0]): Promise<VerifyRun> => {
    // Never another container once one was not provably stopped.
    if (uncertain) return { exitCode: null, output: '', timedOut: false, runnerError: `container ${uncertain} niet aantoonbaar gestopt` }
    const n = ++containerNo
    const name = containerName(o.id, c.kind, n)
    const started = Date.now()
    const run = await runInContainer(c.kind, { name, worktree: c.worktree, task: o.task, script: c.script, signal: c.signal }, o.deps)
    o.trace.containerOutput(n, run.output)
    o.trace.event({ type: 'container', kind: c.kind, source: c.source, n, exitCode: run.exitCode, timedOut: run.timedOut, durationMs: Date.now() - started, outputBytes: Buffer.byteLength(run.output) })
    if (run.cleanup === 'uncertain') {
      uncertain = name
      o.abort() // so runManifest cannot turn this into an ordinary failure and nothing else starts
    }
    return run
  }

  return {
    run(c) {
      const call = execute(c)
      inFlight.add(call)
      const forget = () => inFlight.delete(call)
      call.then(forget, forget)
      return call
    },
    async settle() {
      if (inFlight.size === 0) return
      o.abort()
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    },
    uncertain: () => uncertain,
  }
}

// ---------------------------------------------------------------------------------------------------
// The hidden check.
// ---------------------------------------------------------------------------------------------------

/**
 * The hidden test run (spec §4.1 step 5): vitest with the JSON reporter on exactly `files`, in a verify container. The caller has put
 * `__tests__/` and the runner config back (`restoreForHiddenCheck`). `.task-bench` is removed first, so that the report can only
 * come from this container: a file the model run left there could otherwise be read as the verdict when vitest dies before it writes.
 * `hidden` is the verdict on whatever the container left (no usable report is a failed check); whether the container itself ran is
 * `run.runnerError`, and the caller must look at that first. `reportText` is the report as it was written, when there is one.
 */
async function runHiddenCheck(o: {
  containers: ContainerRunner
  work: string
  files: string[]
  signal: AbortSignal
}): Promise<{ run: VerifyRun; hidden: HiddenResult; reportText?: string }> {
  rmSync(join(o.work, BENCH_DIR), { recursive: true, force: true })
  const run = await o.containers.run({ worktree: o.work, kind: 'verify', source: 'hidden_check', script: buildScript([hiddenCheckScript(o.files)]), signal: o.signal })
  let reportText: string | undefined
  let json: unknown
  try {
    reportText = readFileSync(join(o.work, HIDDEN_REPORT), 'utf8')
    json = JSON.parse(reportText)
  } catch {
    // No usable report: evaluateHidden says so.
  }
  return { run, hidden: evaluateHidden({ exitCode: run.exitCode, json, work: o.work, files: o.files }), ...(reportText !== undefined ? { reportText } : {}) }
}

// ---------------------------------------------------------------------------------------------------
// One run.
// ---------------------------------------------------------------------------------------------------

/** The only tools of the model (spec §4.1): the six work tools of the worker, and none of its doc tools. */
const TASK_TOOLS = ['list_files', 'read_file', 'write_file', 'edit_file', 'search', 'run_tests'] as const

const STOPPED = 'afgebroken'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A failure of the bench itself, never of the model: it ends the run as a `benchfout`, and its message becomes the `benchError`. */
class BenchFault extends Error {}

const NO_USAGE: RunResult['usage'] = { source: 'missing', inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0, toolErrors: 0 }

/**
 * One bench run (spec §4.1): a fresh clone of the repo at the case's `base_commit`; prepare; the model loop of the worker with the
 * bench prompts, the six task tools and the verify gate; the patch against `base_commit`; and, for a run that completes with a
 * patch, the hidden check with the tests of `ref_commit`. The result is in `<out>/<runId>/bench-result.json` on every path, also
 * when the bench itself failed or was stopped. Only a run dir that cannot be made throws.
 *
 * `signal` is a stop from outside. It aborts the model request, the wait before a retry and every container, and waits until the
 * containers are cleaned up. The run is then a `benchfout` with `benchError: "afgebroken"`, and is never scored.
 *
 * Host git runs only on a work tree whose git administration is as it was before the first container (the scan, `assertAdminUnchanged`);
 * a container that was not provably stopped ends the run before any host git.
 */
export async function runTaskBench(o: {
  case: BenchCase
  model: ModelSpec
  label: string
  task: TaskConfig
  out: string
  apiKey?: string
  retryTransient: boolean
  signal?: AbortSignal
  deps?: BenchDeps
}): Promise<BenchResult> {
  const started = Date.now()
  const c = o.case
  const hex8 = randomBytes(4).toString('hex')
  const runId = `${c.id}-${o.label}-${hex8}`
  const trace = openTrace(o.out, runId)
  // The key goes to the client and nowhere else: not into the manifest, so not into the trace, and not into the result.
  const { apiKey: _specKey, ...spec } = o.model

  const inner = new AbortController() // aborts the run and kills any container
  const onStop = () => inner.abort()
  o.signal?.addEventListener('abort', onStop, { once: true })
  if (o.signal?.aborted) inner.abort()
  const containers = createContainerRunner({ id: hex8, task: o.task, trace, abort: () => inner.abort(), deps: o.deps?.containerDeps })

  // What the result says; the pipeline below fills it in as far as it gets. (`as`: the pipeline is a closure, and without it
  // TypeScript takes these for `undefined` where they are read again below.)
  let benchError = undefined as string | undefined
  let run = undefined as RunResult | undefined
  let patch = undefined as { bytes: number; empty: boolean } | undefined
  let hidden = undefined as HiddenResult | undefined
  let hiddenRunnerError = false
  let reds = 0
  let lastTail = undefined as string | undefined
  const retries: RetryRecord[] = []
  const providers: string[] = []

  /** Why the run has to end now, whatever else is going on: a container that was not provably stopped, or a stop from outside. */
  const stopReason = (): string | undefined => {
    const name = containers.uncertain()
    if (name) return `container ${name} niet aantoonbaar gestopt`
    return o.signal?.aborted ? STOPPED : undefined
  }
  const interrupted = (): void => {
    const reason = stopReason()
    if (reason) throw new BenchFault(reason)
  }

  const pipeline = async (): Promise<void> => {
    interrupted() // a stop that came before anything started
    const recipe = findRecipe(o.task, c.repo_url)
    if (!recipe) throw new BenchFault(`geen recept voor ${c.repo_url}`)

    let ws: Workspace
    try {
      ws = await createWorkspace({ repoUrl: c.repo_url, commit: c.base_commit, dir: join(trace.dir, 'ws') })
    } catch (err) {
      throw new BenchFault(`werkruimte aanmaken mislukt: ${message(err)}`)
    }
    const snap = await snapshotAdmin(ws) // directly after the clone, before the first container: every scan compares with this
    interrupted()

    const container = (kind: 'prepare' | 'verify', source: ContainerSource, script: string, signal: AbortSignal) =>
      containers.run({ worktree: ws.work, kind, source, script, signal })
    // Shared by the model's run_tests and the gate: both go through the uncertain flag of the container runner.
    const runVerify = async (source: 'run_tests' | 'gate', signal: AbortSignal): Promise<VerifyRun> => {
      const verified = await container('verify', source, buildScript([recipe.verify]), signal)
      if (source === 'gate' && !containers.uncertain() && !signal.aborted) lastTail = verifyText(verified)
      return verified
    }

    // An empty prepare list has nothing to run (buildScript([]) would end in a dangling &&).
    if (recipe.prepare.length > 0) {
      const prep = await container('prepare', 'prepare', buildScript(recipe.prepare), inner.signal)
      interrupted()
      if (!isGreen(prep)) throw new BenchFault(`prepare faalde: ${verifyText(prep)}`)
      // No host git has run yet, so looking now costs nothing: a tree that cannot be trusted is no reason to pay for a model run.
      await assertAdminUnchanged(ws, snap)
    }

    // The model loop of runTaskJob; the gate runs verify on every final answer.
    const base: ModelClient = (o.deps?.createClient ?? createModelClient)({ ...spec, ...(o.apiKey ? { apiKey: o.apiKey } : {}) })
    const retrying = o.retryTransient
      ? createRetryingClient(base, {
          sleep: o.deps?.sleep,
          onRetry: (r) => {
            retries.push(r)
            trace.event({ type: 'model_retry', ...r })
          },
        })
      : base
    const client: ModelClient = {
      async complete(messages, options) {
        const res = await retrying.complete(messages, options)
        if (res.provider) providers.push(res.provider)
        return res
      },
    }

    const repairs = o.task.maxVerifyRepairs
    const afterAnswer = async (_answer: string, signal: AbortSignal): Promise<AfterAnswerResult> => {
      const verified = await runVerify('gate', signal)
      if (isGreen(verified)) return { kind: 'accept' }
      reds++
      const text = verifyText(verified)
      // N = maxVerifyRepairs red gate runs end the job: attempts 1..N-1 get a retry, the N-th is final.
      if (reds >= repairs) return { kind: 'fail', code: 'VERIFY_FAILED', message: `verify ${reds}× rood: ${text}` }
      return { kind: 'retry', message: `Verify faalt (poging ${reds} van ${repairs}): ${text}` }
    }
    const manifest: Manifest = {
      id: runId,
      profile: 'tools',
      system: BENCH_SYSTEM_PROMPT,
      prompt: benchTaskPrompt(c),
      model: spec,
      tools: { server: { command: 'shared', args: [] }, allow: [...TASK_TOOLS] },
      limits: o.task.limits,
    }
    // A gate or run_tests container may still be killing when runManifest returns; its cleanup outcome decides what comes next.
    const ended = await runManifest(manifest, {
      client,
      trace,
      connectRegistry: async () => createTaskTools({ root: ws.work, runVerify: (s) => runVerify('run_tests', s) }),
      signal: inner.signal,
      afterAnswer,
    }).finally(() => containers.settle())
    run = ended
    interrupted() // the uncertain flag first: runManifest reports that abort as an ordinary HARNESS_ERROR

    // The patch against base_commit, kept for every end of the run. Host git only after the scan.
    await assertAdminUnchanged(ws, snap)
    const captured = await capturePatch(ws, c.base_commit)
    writeFileSync(join(trace.dir, 'patch.diff'), captured.patch)
    patch = { bytes: Buffer.byteLength(captured.patch), empty: captured.empty }
    if (ended.status !== 'completed' || captured.empty) return

    // The hidden check, out of the model's sight: the tests and runner config of ref_commit go back first.
    interrupted()
    await assertAdminUnchanged(ws, snap)
    await restoreForHiddenCheck(ws, c.ref_commit)
    const check = await runHiddenCheck({ containers, work: ws.work, files: c.hidden_tests, signal: inner.signal })
    interrupted()
    if (check.run.runnerError) {
      hiddenRunnerError = true
      benchError = `verborgen toets: ${check.run.runnerError}`
      return
    }
    if (check.reportText !== undefined) writeFileSync(join(trace.dir, 'hidden-vitest.json'), check.reportText)
    hidden = check.hidden
  }

  try {
    try {
      await pipeline()
    } catch (err) {
      // A stop or a container that is not provably stopped explains whatever else failed with it.
      benchError = stopReason() ?? (err instanceof BenchFault || err instanceof AdminChangedError ? err.message : `harness: ${message(err)}`)
    }
    await containers.settle() // whatever a failure left running
  } finally {
    o.signal?.removeEventListener('abort', onStop)
  }

  const result: BenchResult = {
    caseId: c.id,
    label: o.label,
    runId,
    model: { name: spec.name, baseUrl: spec.baseUrl },
    status: mapStatus({ benchError, run, patchEmpty: patch?.empty, hidden, hiddenRunnerError }),
    runStatus: run?.status ?? 'not_run',
    ...(run?.error ? { error: run.error } : {}),
    gate: { reds, ...(lastTail !== undefined ? { lastTail } : {}) },
    ...(hidden ? { hidden } : {}),
    usage: run?.usage ?? NO_USAGE,
    providers,
    retries,
    patchBytes: patch?.bytes ?? 0,
    durationMs: Date.now() - started,
    ...(benchError !== undefined ? { benchError } : {}),
  }
  writeFileSync(join(trace.dir, 'bench-result.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}
