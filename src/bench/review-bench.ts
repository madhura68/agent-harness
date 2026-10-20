import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCostGuard, parseCeilingNanos, type CostMode } from '../cost.js'
import type { Manifest } from '../manifest.js'
import { createModelClient, type ModelClient, type ReasoningEffort } from '../model-client.js'
import { runManifest } from '../run.js'
import { openTrace, type RunResult, type TraceWriter } from '../trace.js'
import { modelSpecFor } from '../worker/job-configuration.js'
import { checkProbeForJob } from '../worker/probe-gate.js'
import { collectSecretValues, redactDeep, redactText } from '../worker/redact.js'
import { createReadOnlyTools } from '../worker/task-tools.js'
import type { WorkerConfig } from '../worker/config.js'
import type { DispatchResult } from './dispatch-result.js'
import { adaptReviewPrompt } from './review-prompt.js'
import { CaseInvalidError, loadReviewCase, stageReviewCase } from './review-case.js'
import { createReviewValidator } from './review-validator.js'
import type { RetryRecord } from './retry-client.js'
import type { ModelSpec } from './task-bench.js'
import { createTrackedClient, withDroppedCost, type TrackedClient } from './tracked-client.js'

/** The four outcomes of one review run (spec §4.1). `benchfout` is never a verdict on the model. */
export type ReviewBenchStatus = 'beoordeeld' | 'resultaat_ongeldig' | 'limiet' | 'benchfout'

/**
 * What a review run leaves in `<out>/<runId>/bench-result.json`, and what `runReviewBench` returns (the same text, redacted).
 * `runStatus` is the raw end status of `runManifest`, or `not_run` when the bench failed before it. `usage.costUsd` has to be the whole
 * bill: it includes the answers that were dropped and paid for. `configuration.costMode` is `null` only for a configuration name that the
 * worker config does not have, which the probe gate refuses.
 */
export type ReviewBenchResult = {
  caseId: string
  label: string
  runId: string
  configuration: { name: string; costMode: CostMode | null; reasoningEffort?: ReasoningEffort }
  contextTokens: number
  status: ReviewBenchStatus
  runStatus: RunResult['status'] | 'not_run'
  error?: { code: string; message: string }
  /** The accepted `DispatchResult`, or `null`. */
  result: DispatchResult | null
  validation: { attempts: number; errors: string[] }
  usage: RunResult['usage']
  /** The largest `inputTokens` of one response. */
  peakInputTokens: number
  turns: number
  toolCalls: number
  toolErrors: number
  providers: string[]
  retries: RetryRecord[]
  durationMs: number
  benchError?: string
}

const BENCH_CODES: readonly string[] = ['MODEL_ERROR', 'HARNESS_ERROR', 'TOOL_NOT_AVAILABLE', 'COST_UNKNOWN']
const LIMIT_CODES: readonly string[] = ['TOO_MANY_TOOL_ERRORS', 'CONTEXT_EXHAUSTED', 'COST_LIMIT_EXCEEDED']

/**
 * Maps the end of a run to its status (spec §4.1). A fragile contract: the order of the rules is the meaning. A bench failure, or an end
 * that nobody foresaw, is a `benchfout` and never silently a fault of the model. `accepted` is whether the validator accepted a result.
 * Whether a `beoordeeld` run is any good is for the scorer: it takes the verdict and the outcome into account, this does not.
 */
export function mapReviewStatus(r: { benchError?: string; run?: RunResult; accepted: boolean }): ReviewBenchStatus {
  if (r.benchError !== undefined || !r.run) return 'benchfout'
  const code = r.run.error?.code
  if (code !== undefined && BENCH_CODES.includes(code)) return 'benchfout'
  if (r.run.status === 'budget_exceeded' || r.run.status === 'timed_out' || (code !== undefined && LIMIT_CODES.includes(code))) return 'limiet'
  if (r.run.status === 'failed' && code === 'REVIEW_RESULT_INVALID') return 'resultaat_ongeldig'
  if (r.run.status === 'completed' && r.accepted) return 'beoordeeld'
  return 'benchfout' // an end that nobody foresaw: never silently a fault of the model
}

const STOPPED = 'afgebroken'

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A failure of the bench itself, never of the model: it ends the run as a `benchfout`, and its message becomes the `benchError`. */
class BenchFault extends Error {}

const NO_USAGE: RunResult['usage'] = { source: 'missing', inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0, toolErrors: 0 }

/** The only tools of the model (spec §4.3). They are what `createReadOnlyTools` offers; the list is for the manifest, which records it. */
const REVIEW_TOOLS = ['list_files', 'read_file', 'search'] as const

/** The trace with the key masked in everything it writes, `result.json` and the tool and container files included. */
function redactingTrace(trace: TraceWriter, secrets: readonly string[]): TraceWriter {
  return {
    dir: trace.dir,
    event: (e) => trace.event(redactDeep(e, secrets)),
    toolContent: (callId, text) => trace.toolContent(redactText(callId, secrets), redactText(text, secrets)),
    containerOutput: (n, text) => trace.containerOutput(n, redactText(text, secrets)),
    result: (r) => trace.result(redactDeep(r, secrets)),
  }
}

/**
 * One review run (spec §4.1): the case is loaded and checked, the configuration has to have an accepted probe, the case is copied into
 * a fresh `<out>/<runId>/root/`, and the model reviews it with `list_files`, `read_file` and `search` and gives its result as the
 * final message, which the validator checks. The result is in `<out>/<runId>/bench-result.json` on every path after the case was
 * loaded, also when the gate refused or the bench itself failed or was stopped. A case that cannot be used, or a production prompt that
 * the replacements no longer fit, throws before anything is made, and `out` is not touched (spec §4.5).
 *
 * The model comes from the worker config, as it does for the worker: `litellm.baseUrl`, the configuration name, its `reasoningEffort` and
 * `extraBody`. The limits come from the case, `contextTokens` as well, not from the configuration. A hosted configuration retries
 * temporary failures and watches its costs, including the answers that are dropped for a retry (one guard serves both).
 *
 * The key goes to the client and nowhere else, and whatever reaches the trace or the result is masked: the returned result is the
 * masked one that was written. `signal` is a stop from outside; the run then ends as a `benchfout` with `benchError: "afgebroken"`.
 */
export async function runReviewBench(o: {
  caseDir: string
  config: WorkerConfig
  configuration: string
  probeDir: string
  label: string
  out: string
  apiKey?: string
  signal?: AbortSignal
  deps?: {
    createClient?: (m: ModelSpec & { apiKey?: string }) => ModelClient
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    now?: () => number
  }
}): Promise<ReviewBenchResult> {
  const started = Date.now()
  // A case that cannot be used, or a prompt that no longer fits, goes to the caller as it is, before any directory exists.
  const loaded = loadReviewCase(o.caseDir)
  const prompt = adaptReviewPrompt(loaded.prompt)
  const c = loaded.case

  const runId = `${c.id}-${o.label}-${randomBytes(4).toString('hex')}`
  // The key as the worker masks it (8 characters or more), and without surrounding whitespace, the form a server echoes.
  const secrets = o.apiKey ? collectSecretValues({ MODEL_API_KEY: o.apiKey }, { MODEL_API_KEY: o.apiKey.trim() }) : []
  const trace = redactingTrace(openTrace(o.out, runId), secrets)

  const known = Object.hasOwn(o.config.configurations, o.configuration) ? o.config.configurations[o.configuration] : undefined
  const validator = createReviewValidator(loaded.expectedDocuments)

  // What the result says; the pipeline below fills it in as far as it gets. (`as`: the pipeline is a closure, and without it
  // TypeScript takes these for `undefined` where they are read again below.)
  let benchError = undefined as string | undefined
  let run = undefined as RunResult | undefined
  // The model client with its retries, providers and dropped costs (src/bench/tracked-client.ts); absent until the pipeline has made it.
  let tracked: TrackedClient | undefined
  let peakInputTokens = 0

  const pipeline = async (): Promise<void> => {
    if (o.signal?.aborted) throw new BenchFault(STOPPED) // a stop that came before anything started

    const gate = checkProbeForJob(o.config, o.probeDir, o.configuration)
    if (!gate.ok) throw new BenchFault(`${gate.failure.code}: ${gate.failure.detail}`)
    const configuration = o.config.configurations[o.configuration] // past the gate: it refuses a name that the config does not have

    const root = stageReviewCase(loaded, trace.dir)

    // One guard for the retry layer, which sees the answers that are dropped, and for the run loop, which sees the ones that come back.
    const guard = createCostGuard({ mode: configuration.costMode, ceilingNanos: parseCeilingNanos(c.maxCostUsd), configuration: o.configuration })
    // The model block as the worker builds it for a job (`modelSpecFor`): one place decides what a configuration hands to the client.
    const spec: ModelSpec = modelSpecFor(o.config, { name: o.configuration, configuration, maxCostUsd: c.maxCostUsd })
    // The key goes to the client and nowhere else: not into the manifest, so not into the trace, and not into the result.
    const base = (o.deps?.createClient ?? createModelClient)({ ...spec, ...(o.apiKey ? { apiKey: o.apiKey } : {}) })
    tracked = createTrackedClient(base, { retryTransient: configuration.costMode === 'hosted', trace, sleep: o.deps?.sleep, guard })
    const served = tracked.client
    const client: ModelClient = {
      async complete(messages, options) {
        const res = await served.complete(messages, options)
        peakInputTokens = Math.max(peakInputTokens, res.usage.inputTokens)
        return res
      },
    }

    // The prompt is the one and only message: no system prompt, so that it stands at the start, as it does for `claude -p`.
    const manifest: Manifest = {
      id: runId,
      profile: 'tools',
      prompt,
      model: spec,
      tools: { server: { command: 'shared', args: [] }, allow: [...REVIEW_TOOLS] },
      limits: { ...c.limits, contextTokens: c.contextTokens },
    }
    run = await runManifest(manifest, {
      client,
      trace,
      connectRegistry: async () => createReadOnlyTools({ root }),
      afterAnswer: validator.afterAnswer,
      costGuard: guard,
      signal: o.signal,
      now: o.deps?.now,
    })
    if (o.signal?.aborted) throw new BenchFault(STOPPED) // runManifest reports that stop as an ordinary HARNESS_ERROR
  }

  try {
    await pipeline()
  } catch (err) {
    // A stop explains whatever else failed with it.
    benchError = o.signal?.aborted ? STOPPED : err instanceof BenchFault || err instanceof CaseInvalidError ? err.message : `harness: ${message(err)}`
  }

  // A dropped answer that took the guard past its ceiling (or to an unknown cost) ended the run as MODEL_ERROR, which is how the run loop
  // sees a failure of its client. The real reason is the guard's, so that is the error: a limiet or a COST_UNKNOWN, not a benchfout.
  // A timed_out or an aborted run stays what it is.
  const stop = tracked?.costStop()
  if (run && stop && run.status === 'failed' && run.error?.code === 'MODEL_ERROR') run = { ...run, error: stop.error }

  const accepted = validator.accepted()
  const usage = withDroppedCost(run?.usage ?? NO_USAGE, tracked?.droppedCosts() ?? [])
  const result: ReviewBenchResult = {
    caseId: c.id,
    label: o.label,
    runId,
    configuration: { name: o.configuration, costMode: known?.costMode ?? null, ...(known?.reasoningEffort !== undefined ? { reasoningEffort: known.reasoningEffort } : {}) },
    contextTokens: c.contextTokens,
    status: mapReviewStatus({ benchError, run, accepted: accepted !== undefined }),
    runStatus: run?.status ?? 'not_run',
    ...(run?.error ? { error: run.error } : {}),
    result: accepted ?? null,
    validation: { attempts: validator.attempts(), errors: validator.errors() },
    usage,
    peakInputTokens,
    turns: usage.turns,
    toolCalls: usage.toolCalls,
    toolErrors: usage.toolErrors,
    providers: tracked?.providers ?? [],
    retries: tracked?.retries ?? [],
    durationMs: Date.now() - started,
    ...(benchError !== undefined ? { benchError } : {}),
  }
  const masked = redactDeep(result, secrets)
  writeFileSync(join(trace.dir, 'bench-result.json'), JSON.stringify(masked, null, 2) + '\n')
  return masked
}
