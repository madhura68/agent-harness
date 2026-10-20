import type { CostGuard, CostStop } from '../cost.js'
import { ModelError, type ModelClient } from '../model-client.js'
import type { RunResult, TraceWriter } from '../trace.js'
import type { CompleteResult } from '../types.js'
import { createRetryingClient, UnusableAnswerError, type RetryRecord } from './retry-client.js'

/**
 * `usage` with the cost of the dropped answers added to its `costUsd`: `costs` has an entry per dropped answer, and `undefined` for one
 * that reported no cost. Like the other sums of `usage`, `costUsd` stays absent unless some response reported it.
 */
export function withDroppedCost(usage: RunResult['usage'], costs: Array<number | undefined>): RunResult['usage'] {
  const reported = costs.filter((cost): cost is number => cost !== undefined)
  if (reported.length === 0) return usage
  return { ...usage, costUsd: (usage.costUsd ?? 0) + reported.reduce((sum, cost) => sum + cost, 0) }
}

/**
 * The end of a run on its costs, thrown by the tracked client for a dropped answer that the guard stops on. Kind `invalid` is final for the
 * retrying client, and `runManifest` ends on it as MODEL_ERROR instead of crashing; the bench reads the real stop from `costStop()`.
 */
export class CostStopError extends ModelError {
  constructor(readonly stop: CostStop) {
    super(stop.error.message, { kind: 'invalid' })
  }
}

/**
 * A model client plus what the bench has to know about every response it handled, the ones that the run loop never sees included:
 * `retries` (the answers and failures that were retried), `providers` (who served each response, in order), `droppedCosts()` (what the
 * dropped answers cost, one entry per answer, `undefined` for one that reported nothing) and `costStop()` (the stop of the guard, when
 * a dropped answer caused it).
 */
export type TrackedClient = {
  client: ModelClient
  retries: RetryRecord[]
  providers: string[]
  droppedCosts(): Array<number | undefined>
  costStop(): CostStop | undefined
}

/** A dropped answer as the guard takes a response: only its cost and its provider are known, the rest is empty. */
function droppedAnswer(r: RetryRecord): CompleteResult {
  return {
    message: { content: null, toolCalls: [] },
    finishReason: 'other',
    usage: { source: 'missing', inputTokens: 0, outputTokens: 0, ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) },
    model: undefined,
    durationMs: 0,
    ...(r.provider !== undefined ? { provider: r.provider } : {}),
  }
}

/**
 * Wraps `base` for a bench run (spec §4.1). With `retryTransient` a request that fails with a temporary error, or whose answer has
 * finish reason `other`, is made again (see `createRetryingClient`); every retry is a record in `retries`, a `model_retry` event in the
 * trace, and its provider (when named) in `providers`. An answer that is dropped for good, after the last retry, is on its
 * `UnusableAnswerError`: its cost goes to `droppedCosts()` and its provider to `providers`. The provider of a response that is used goes
 * to `providers` too. Spec §5 criterion 2 rests on that list, and the ledger on `droppedCosts()`: a dropped answer was paid for, and
 * the run never saw it.
 *
 * With a `guard` the run loop's guard (`runManifest`) is not enough: it sees only the answers that `complete()` returns, and a dropped
 * answer is paid for but never returned. So each answer that is dropped for a retry (kind `finish_other`) is handed to the guard before the
 * wait: a stop is kept for `costStop()` and thrown as a `CostStopError`, without a wait and without another request. Every answer is
 * thus counted once: a dropped answer here, a returned one in `runManifest`. An answer that is dropped after the last retry is not
 * handed to the guard: the run ends as a bench failure (MODEL_ERROR) whatever it cost, and its amount is on `droppedCosts()`. A failure
 * without a response has nothing to count.
 */
export function createTrackedClient(
  base: ModelClient,
  o: {
    retryTransient: boolean
    trace: TraceWriter
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    guard?: CostGuard
  },
): TrackedClient {
  const retries: RetryRecord[] = []
  const providers: string[] = []
  // The cost of the answer that was dropped on the last attempt: no retry follows it, so it is on the error and not in `retries`.
  let droppedLast = undefined as number | undefined
  let costStop = undefined as CostStop | undefined

  const retrying = o.retryTransient
    ? createRetryingClient(base, {
        sleep: o.sleep,
        onRetry: (r) => {
          retries.push(r)
          // A dropped answer is a response too: who served it is evidence (spec §5 criterion 2), and this is the moment it arrived.
          if (r.provider) providers.push(r.provider)
          o.trace.event({ type: 'model_retry', ...r })
          if (o.guard && r.kind === 'finish_other') {
            // `afterResponse` stops on the amount (unknown) or on a ceiling reached by an answer that asks for tools; this one asks for none,
            // so a reached ceiling is for `beforeRequest`, the stop that the next request would have met.
            const stop = o.guard.afterResponse(droppedAnswer(r)) ?? o.guard.beforeRequest()
            if (stop) {
              costStop = stop
              throw new CostStopError(stop)
            }
          }
        },
      })
    : base

  const client: ModelClient = {
    async complete(messages, options) {
      const res = await retrying.complete(messages, options).catch((err: unknown) => {
        // The answer that was dropped for good has no record: its cost and its provider are on the error, and only then (see UnusableAnswerError).
        if (err instanceof UnusableAnswerError) {
          if (err.costUsd !== undefined) droppedLast = (droppedLast ?? 0) + err.costUsd
          if (err.provider) providers.push(err.provider)
        }
        throw err
      })
      if (res.provider) providers.push(res.provider)
      return res
    },
  }

  return {
    client,
    retries,
    providers,
    droppedCosts: () => [...retries.map((r) => r.costUsd), droppedLast],
    costStop: () => costStop,
  }
}
