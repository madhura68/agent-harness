import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Manifest, ModelSpecSchema } from '../manifest.js'
import { createModelClient, type ModelClient } from '../model-client.js'
import { runManifest, type AfterAnswerResult } from '../run.js'
import { openTrace, type RunResult, type TraceWriter } from '../trace.js'
import { findRecipe, type TaskConfig } from '../worker/config.js'
import { buildScript, containerName, runInContainer, type ContainerDeps } from '../worker/containers.js'
import type { GitAdminSnapshot } from '../worker/host-git.js'
import { isGreen, verifyText } from '../worker/task-impl.js'
import { createTaskTools, type VerifyRun } from '../worker/task-tools.js'
import type { BenchCase } from './case.js'
import { BENCH_DIR, evaluateHidden, hiddenCheckScript, readHiddenReport, type HiddenReportRead, type HiddenResult } from './hidden-check.js'
import { createRetryingClient, UnusableAnswerError, type RetryRecord } from './retry-client.js'
import { BENCH_SYSTEM_PROMPT, benchTaskPrompt } from './task-prompt.js'
import { AdminChangedError, assertAdminUnchanged, capturePatch, createWorkspace, git, isRunnerConfig, restoreForHiddenCheck, snapshotAdmin, type Workspace } from './workspace.js'

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
 * model loop and hidden check. `providers` lists the `provider` of the responses that named one, in order. `usage` is what the run
 * itself counted, plus the `costUsd` of the answers that the retry client dropped (see `retries`): they were paid for, and the run
 * never saw them. The ledger reads this file, so its `usage.costUsd` has to be the whole bill.
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
 * The report is read with `readHiddenReport`, which refuses whatever the container made of the path (a link, a FIFO): `report` says
 * what it found, and an `unsafe` one has no verdict (`hidden` is then only what no usable report gives). `hidden` is the verdict on
 * whatever plain report the container left, and no report is a failed check. Whether the container itself ran is `run.runnerError`;
 * the caller must look at that first, and then at `report`.
 */
async function runHiddenCheck(o: {
  containers: ContainerRunner
  work: string
  files: string[]
  signal: AbortSignal
}): Promise<{ run: VerifyRun; report: HiddenReportRead; hidden: HiddenResult }> {
  rmSync(join(o.work, BENCH_DIR), { recursive: true, force: true })
  const run = await o.containers.run({ worktree: o.work, kind: 'verify', source: 'hidden_check', script: buildScript([hiddenCheckScript(o.files)]), signal: o.signal })
  const report = readHiddenReport(o.work)
  let json: unknown
  if (report.kind === 'report') {
    try {
      json = JSON.parse(report.text)
    } catch {
      // No usable report: evaluateHidden says so.
    }
  }
  return { run, report, hidden: evaluateHidden({ exitCode: run.exitCode, json, work: o.work, files: o.files }) }
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
 * `usage` with the cost of the dropped answers added to its `costUsd`: `costs` has an entry per dropped answer, and `undefined` for one
 * that reported no cost. Like the other sums of `usage`, `costUsd` stays absent unless some response reported it.
 */
function withDroppedCost(usage: RunResult['usage'], costs: Array<number | undefined>): RunResult['usage'] {
  const reported = costs.filter((cost): cost is number => cost !== undefined)
  if (reported.length === 0) return usage
  return { ...usage, costUsd: (usage.costUsd ?? 0) + reported.reduce((sum, cost) => sum + cost, 0) }
}

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
  // The cost of the answer that was dropped on the last attempt: no retry follows it, so it is on the error and not in `retries`.
  let droppedLastUsd = undefined as number | undefined

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
        const res = await retrying.complete(messages, options).catch((err: unknown) => {
          if (err instanceof UnusableAnswerError && err.costUsd !== undefined) droppedLastUsd = (droppedLastUsd ?? 0) + err.costUsd
          throw err
        })
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
    // No container is started once a stop has come, as in checkCase: the scan and the restore cannot be aborted, and the stop can come
    // during them. A container that started anyway is killed at once, and a kill that is not provably done would be reported as a
    // benchfout of its own ("niet aantoonbaar gestopt") instead of afgebroken.
    interrupted()
    const check = await runHiddenCheck({ containers, work: ws.work, files: c.hidden_tests, signal: inner.signal })
    interrupted()
    if (check.run.runnerError) {
      hiddenRunnerError = true
      benchError = `verborgen toets: ${check.run.runnerError}`
      return
    }
    if (check.report.kind === 'unsafe') {
      // The container made a link or a FIFO of the report: no verdict can come from it, and nothing of it is copied.
      benchError = `verborgen toets: ${check.report.why}`
      return
    }
    if (check.report.kind === 'report') writeFileSync(join(trace.dir, 'hidden-vitest.json'), check.report.text) // what was read from the checked descriptor
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
    usage: withDroppedCost(run?.usage ?? NO_USAGE, [...retries.map((r) => r.costUsd), droppedLastUsd]),
    providers,
    retries,
    patchBytes: patch?.bytes ?? 0,
    durationMs: Date.now() - started,
    ...(benchError !== undefined ? { benchError } : {}),
  }
  writeFileSync(join(trace.dir, 'bench-result.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

// ---------------------------------------------------------------------------------------------------
// The proof that a candidate task is a case: harness task-bench --check-case.
// ---------------------------------------------------------------------------------------------------

/**
 * `<out>/<caseId>-check-<hex8>/case-check.json`: the evidence that a candidate task is a valid bench case (spec §4.2, criteria 2, 3
 * and 6). `ok` is true exactly when `problems` is empty, and `problems` says in words what is wrong. It holds what a machine can
 * prove; whatever needs a person's judgment is not in here.
 *
 * Read `ok` and `problems` first. A part the check did not get to has no verdict: `hiddenOnBase` and `hiddenOnRef` then say
 * `niet gedraaid`, and `baseVerifyGreen` is false. And `hiddenOnBase.pass === false` is the wanted value, not the proof: what
 * proves that the hidden tests fail on base is a hidden file with status "failed" in vitest's own report (`failsForReal`).
 * `lines` is the size of `ref_commit` (insertions and deletions, a rename counted as a delete and an add).
 */
export type CaseCheck = {
  caseId: string
  ok: boolean
  baseVerifyGreen: boolean
  hiddenOnBase: HiddenResult
  hiddenOnRef: HiddenResult
  refChangesRunnerConfig: boolean
  hiddenMatchesRef: boolean
  lines: number
  problems: string[]
}

/** A hidden check that did not run: no verdict, and every hidden file unrun. */
const notRun = (files: string[]): HiddenResult => ({ pass: false, reason: 'niet gedraaid', files: files.map((file) => ({ file, ran: false, passed: 0, failed: 0, other: 0 })) })

/** Why a prepare container was not green, in a few words (the output is in the trace). */
const redReason = (run: VerifyRun): string => run.runnerError ?? (run.timedOut ? 'timeout' : `exitcode ${run.exitCode}`)

// The tests that ref_commit adds or changes: `*.test.ts` under `__tests__/`, the same shape as an entry of `hidden_tests` (BenchCaseSchema).
const HIDDEN_TEST_PATH = /^__tests__\/.+\.test\.ts$/

/**
 * The pairs of `git diff --name-status -z`: `<status>\0<path>\0` for every changed file. Never two paths for one change: the diff
 * runs with `--no-renames`, so a rename is a delete and an add.
 */
function parseNameStatus(text: string): Array<{ status: string; path: string }> {
  const parts = text.split('\0')
  if (parts.at(-1) === '') parts.pop()
  if (parts.length % 2 !== 0) throw new Error(`onverwachte uitvoer van git diff --name-status: ${JSON.stringify(text.slice(0, 200))}`)
  const changes: Array<{ status: string; path: string }> = []
  for (let i = 0; i < parts.length; i += 2) changes.push({ status: parts[i], path: parts[i + 1] })
  return changes
}

/**
 * The lines (insertions plus deletions) of a `git diff --shortstat`: " 3 files changed, 11 insertions(+), 2 deletions(-)". Git
 * leaves out a part that is 0, and translates the words around the numbers; the markers (+) and (-) stay, so the numbers are found
 * by them. Output that has neither marker is not understood, and is never taken for a size of 0.
 */
function shortstatLines(text: string): number {
  if (text.trim() === '') return 0 // no change at all
  const insertions = /(\d+)[^\d(]*\(\+\)/.exec(text)
  const deletions = /(\d+)[^\d(]*\(-\)/.exec(text)
  if (!insertions && !deletions) throw new Error(`onverwachte uitvoer van git diff --shortstat: ${JSON.stringify(text.slice(0, 200))}`)
  return Number(insertions?.[1] ?? 0) + Number(deletions?.[1] ?? 0)
}

/**
 * What the diff between `base_commit` and `ref_commit` says about a case, from the text of the two diffs (`--name-status -z` and
 * `--shortstat`, both `--no-renames`). `hidden_tests` has to be, as a set, the test files that ref adds (A) or modifies (M): a
 * deleted test can never be a hidden test, and a rename counts as a delete and an add. `missing` are the test files of ref that
 * `hidden_tests` lacks, `extra` the entries that are none of them (both sorted). `refChangesRunnerConfig` is true when ref changes,
 * in any way, a file of the runner configuration in the root of the repo (`isRunnerConfig`, the set that the restore puts back).
 */
export function analyseRefDiff(o: { nameStatus: string; shortstat: string; hiddenTests: string[] }): {
  refChangesRunnerConfig: boolean
  hiddenMatchesRef: boolean
  missing: string[]
  extra: string[]
  lines: number
} {
  const changes = parseNameStatus(o.nameStatus)
  const refTests = new Set(changes.filter((c) => (c.status === 'A' || c.status === 'M') && HIDDEN_TEST_PATH.test(c.path)).map((c) => c.path))
  const hidden = new Set(o.hiddenTests)
  const missing = [...refTests].filter((path) => !hidden.has(path)).sort()
  const extra = [...hidden].filter((path) => !refTests.has(path)).sort()
  return {
    // Only a name in the root: `isRunnerConfig` takes a name, and `tsconfig.*\.json` would match `tsconfig/x.json` as a path.
    refChangesRunnerConfig: changes.some((c) => !c.path.includes('/') && isRunnerConfig(c.path)),
    hiddenMatchesRef: missing.length === 0 && extra.length === 0,
    missing,
    extra,
    lines: shortstatLines(o.shortstat),
  }
}

// The part of vitest's JSON report that tells which files failed.
const FileStatusSchema = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string().optional(),
      assertionResults: z.array(z.object({ status: z.string() })).optional(),
    }),
  ),
})

/**
 * The hidden files that vitest reports as failed. `HiddenResult` cannot say this by itself: it counts tests, and a file that cannot be
 * imported (the usual state of the hidden test of a new module, on the commit before the module existed) has status "failed" and
 * no test at all. So a file counts as failed when its own status is "failed" or one of its tests is. Which hidden file an entry of the
 * report is, is decided by `evaluateHidden` (real paths, relative to the work tree), so that both agree: it is given the failed entries
 * only, and the files it says it ran are the failed ones (the exit code it is given plays no part).
 */
function failedHiddenFiles(reportText: string, work: string, files: string[]): string[] {
  let json: unknown
  try {
    json = JSON.parse(reportText)
  } catch {
    return []
  }
  const report = FileStatusSchema.safeParse(json)
  if (!report.success) return []
  const failed = report.data.testResults.filter((r) => r.status === 'failed' || r.assertionResults?.some((a) => a.status === 'failed'))
  return evaluateHidden({ exitCode: 0, json: { testResults: failed }, work, files }).files.filter((f) => f.ran).map((f) => f.file)
}

type HiddenCheck = Awaited<ReturnType<typeof runHiddenCheck>>

/**
 * Whether the hidden check on base_commit shows a real failure of the tests (spec §4.2 criterion 3), and not just a check that did not
 * pass: the container ended with a non-zero exit code of its own (no runner error, no time-out), vitest left a plain report, and at
 * least one hidden file has status "failed" in it. An import error counts: it is that status without a failed test. Anything else, a
 * container that never ran vitest included, proves nothing about the tests.
 */
export function failsForReal(check: Pick<HiddenCheck, 'run' | 'report'>, work: string, files: string[]): boolean {
  const { run, report } = check
  if (run.runnerError || run.timedOut || run.exitCode === null || run.exitCode === 0 || report.kind !== 'report') return false
  return failedHiddenFiles(report.text, work, files).length > 0
}

/** The verdict to put on record: `hidden`, and in front of its reason the cause when the container or its report was unusable. */
function recorded(check: HiddenCheck): HiddenResult {
  const cause = check.run.runnerError ?? (check.report.kind === 'unsafe' ? check.report.why : undefined)
  return cause === undefined ? check.hidden : { ...check.hidden, reason: `${cause}; ${check.hidden.reason}` }
}

/** A clone and the scan of its git administration, taken right after the clone and before any container. */
type Opened = { ws: Workspace; snap: GitAdminSnapshot }

/**
 * The proof that a candidate task is a valid case (spec §4.2, criteria 2, 3 and 6), with real containers and without a model:
 *
 * 1. A clone on `base_commit`, then the two diffs with `ref_commit` (the paths, and the size), then a clone on `ref_commit`. All host
 *    git is done here, before the first container; after that the only host git is the restore, behind its scan.
 * 2. On `base_commit`: prepare and the recipe's verify (must be green), then the scan, then `__tests__/` and the runner config of
 *    `ref_commit` put back, then the hidden tests. They must fail for real (`failsForReal`), not merely not pass.
 * 3. On `ref_commit`: prepare, the scan, and the hidden tests. They must pass.
 *
 * Every finding goes to `problems`; the result is in `<out>/<caseId>-check-<hex8>/case-check.json` on every path, and `ok` means
 * there is no problem. What cannot be judged because the bench itself failed (no recipe, a clone that fails, a red prepare, a
 * rewritten git administration) is a problem too, and ends the check there. Only a dir that cannot be made throws. The two clones
 * stay in the check dir (`ws-base`, `ws-ref`), as the clone of a bench run stays in its run dir.
 *
 * `signal` is a stop from outside. It aborts every container and waits until they are cleaned up. The result is then `ok: false` with
 * `problems: ["afgebroken"]` and nothing else, as it is for a container that was not provably stopped: a check that was cut short is
 * not judged, and the container that was killed proves nothing.
 */
export async function checkCase(o: { case: BenchCase; task: TaskConfig; out: string; signal?: AbortSignal; deps?: BenchDeps }): Promise<CaseCheck> {
  const c = o.case
  const hex8 = randomBytes(4).toString('hex')
  const trace = openTrace(o.out, `${c.id}-check-${hex8}`)

  const inner = new AbortController() // aborts every container
  const onStop = () => inner.abort()
  o.signal?.addEventListener('abort', onStop, { once: true })
  if (o.signal?.aborted) inner.abort()
  const containers = createContainerRunner({ id: hex8, task: o.task, trace, abort: () => inner.abort(), deps: o.deps?.containerDeps })

  // What the result says; the pipeline below fills it in as far as it gets.
  const problems: string[] = []
  let baseVerifyGreen = false
  let hiddenOnBase = notRun(c.hidden_tests)
  let hiddenOnRef = notRun(c.hidden_tests)
  let refChangesRunnerConfig = false
  let hiddenMatchesRef = false
  let lines = 0

  /** Why the check has to end now, whatever else is going on: a container that was not provably stopped, or a stop from outside. */
  const stopReason = (): string | undefined => {
    const name = containers.uncertain()
    if (name) return `container ${name} niet aantoonbaar gestopt`
    return o.signal?.aborted ? STOPPED : undefined
  }
  const interrupted = (): void => {
    const reason = stopReason()
    if (reason) throw new BenchFault(reason)
  }

  const open = async (commit: string, dir: string, which: string): Promise<Opened> => {
    let ws: Workspace
    try {
      ws = await createWorkspace({ repoUrl: c.repo_url, commit, dir: join(trace.dir, dir) })
    } catch (err) {
      throw new BenchFault(`werkruimte aanmaken mislukt (${which}): ${message(err)}`)
    }
    return { ws, snap: await snapshotAdmin(ws) }
  }

  const pipeline = async (): Promise<void> => {
    interrupted() // a stop that came before anything started
    const recipe = findRecipe(o.task, c.repo_url)
    if (!recipe) throw new BenchFault(`geen recept voor ${c.repo_url}`)

    // All host git comes first: both clones and both diffs. They compare two commits, not a work tree that a container has touched.
    const base = await open(c.base_commit, 'ws-base', 'base_commit')
    interrupted()
    let diff: ReturnType<typeof analyseRefDiff>
    try {
      // `-z`: without it git quotes a path with special characters, and that path would silently not match anything. `--`: a
      // revision is never taken for a path.
      const nameStatus = await git(base.ws, ['diff', '--no-renames', '--name-status', '--no-color', '-z', c.base_commit, c.ref_commit, '--'])
      const shortstat = await git(base.ws, ['diff', '--no-renames', '--shortstat', '--no-color', c.base_commit, c.ref_commit, '--'])
      diff = analyseRefDiff({ nameStatus, shortstat, hiddenTests: c.hidden_tests })
    } catch (err) {
      throw new BenchFault(`verschil tussen base_commit en ref_commit niet te bepalen: ${message(err)}`)
    }
    lines = diff.lines
    refChangesRunnerConfig = diff.refChangesRunnerConfig
    hiddenMatchesRef = diff.hiddenMatchesRef
    if (refChangesRunnerConfig) problems.push('ref_commit wijzigt de runnerconfig')
    if (!hiddenMatchesRef) {
      const differences = [...(diff.missing.length > 0 ? [`ontbreekt: ${diff.missing.join(', ')}`] : []), ...(diff.extra.length > 0 ? [`te veel: ${diff.extra.join(', ')}`] : [])]
      problems.push(`hidden_tests komt niet overeen met de testbestanden die ref_commit toevoegt of wijzigt (${differences.join('; ')})`)
    }
    const ref = await open(c.ref_commit, 'ws-ref', 'ref_commit')
    interrupted()

    // No container is started once a stop has come: the scans and the restore cannot be aborted, and the stop can come during them.
    const container = (w: Opened, kind: 'prepare' | 'verify', source: ContainerSource, script: string): Promise<VerifyRun> => {
      interrupted()
      return containers.run({ worktree: w.ws.work, kind, source, script, signal: inner.signal })
    }
    const hiddenCheck = (w: Opened): ReturnType<typeof runHiddenCheck> => {
      interrupted()
      return runHiddenCheck({ containers, work: w.ws.work, files: c.hidden_tests, signal: inner.signal })
    }
    // An empty prepare list has nothing to run (buildScript([]) would end in a dangling &&).
    const prepare = async (w: Opened, which: string): Promise<void> => {
      if (recipe.prepare.length === 0) return
      const prep = await container(w, 'prepare', 'prepare', buildScript(recipe.prepare))
      interrupted() // a prepare that the stop killed is no red prepare
      if (!isGreen(prep)) throw new BenchFault(`prepare rood op ${which} (${redReason(prep)})`)
    }

    // base_commit: verify green, and the hidden tests failing for real once the tests and runner config of ref_commit are back.
    await prepare(base, 'base_commit')
    const verified = await container(base, 'verify', 'gate', buildScript([recipe.verify]))
    interrupted()
    baseVerifyGreen = isGreen(verified)
    if (!baseVerifyGreen) problems.push('verify rood op base_commit')

    await assertAdminUnchanged(base.ws, base.snap) // before the one host git that follows a container
    await restoreForHiddenCheck(base.ws, c.ref_commit)
    const onBase = await hiddenCheck(base)
    interrupted() // the uncertain flag first: what was read from an uncertain container is thrown away
    hiddenOnBase = recorded(onBase)
    if (hiddenOnBase.pass) problems.push('verborgen test slaagt al op base_commit')
    else if (!failsForReal(onBase, base.ws.work, c.hidden_tests)) problems.push('verborgen toets op base_commit zonder echte testfout')

    // ref_commit: the hidden tests pass. No host git follows, but the verdict must not rest on a tree whose git administration was changed.
    await prepare(ref, 'ref_commit')
    await assertAdminUnchanged(ref.ws, ref.snap)
    const onRef = await hiddenCheck(ref)
    interrupted()
    hiddenOnRef = recorded(onRef)
    if (!hiddenOnRef.pass) problems.push('verborgen toets slaagt niet op ref_commit')
  }

  let failure: { error: unknown } | undefined
  try {
    try {
      await pipeline()
    } catch (error) {
      failure = { error }
    }
    await containers.settle() // whatever a failure left running, before anything is written
  } finally {
    o.signal?.removeEventListener('abort', onStop)
  }
  if (failure) {
    // A stop explains whatever else failed with it, and a check that was cut short is not judged: its one reason is all it says.
    const reason = stopReason()
    if (reason) problems.splice(0, problems.length, reason)
    else problems.push(failure.error instanceof BenchFault || failure.error instanceof AdminChangedError ? failure.error.message : `harness: ${message(failure.error)}`)
  }

  const check: CaseCheck = {
    caseId: c.id,
    ok: problems.length === 0,
    baseVerifyGreen,
    hiddenOnBase,
    hiddenOnRef,
    refChangesRunnerConfig,
    hiddenMatchesRef,
    lines,
    problems,
  }
  writeFileSync(join(trace.dir, 'case-check.json'), JSON.stringify(check, null, 2) + '\n')
  return check
}
