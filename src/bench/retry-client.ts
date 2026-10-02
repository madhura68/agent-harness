import { setTimeout as wait } from 'node:timers/promises'
import { ModelError, type ModelClient, type ModelErrorDetail } from '../model-client.js'
import type { CompleteResult } from '../types.js'

/**
 * One retry of a model request, as the trace and the result file record it. `attempt` numbers the retries from 1: the first
 * failure that is retried is attempt 1. `kind` is the kind of the failure (`network`, `http`, `error_body`) or `finish_other`, for an
 * answer that came back whole but cannot be used (see `UnusableAnswerError`). `status` and `bodyCode` are there when the failure had
 * one. `costUsd` is there when the dropped answer reported what it cost: it was paid for, and the run loop never sees it.
 */
export type RetryRecord = { attempt: number; kind: string; status?: number; bodyCode?: number; costUsd?: number }

// Spec §4.1: up to three retries, with a wait that grows. The wait is bound by the run: the signal of the call stops it.
const MAX_RETRIES = 3
const DELAYS_MS = [2000, 8000, 30000]

const retryableStatus = (s: number | undefined): boolean => s === 408 || s === 429 || (s !== undefined && s >= 500 && s <= 599)

/**
 * The detail of a failure that is worth another attempt, or undefined when it is final. It decides on the kind, the status
 * and the body code that the model client fixed before it cut and masked the message, never on the message itself.
 */
function transientDetail(err: unknown, signal: AbortSignal): ModelErrorDetail | undefined {
  // A stop is never retried: after an abort, by the deadline or from outside, even a network failure is final.
  if (signal.aborted || !(err instanceof ModelError) || !err.detail) return undefined
  const d = err.detail
  if (d.kind === 'network') return d
  if (d.kind === 'http') return retryableStatus(d.status) ? d : undefined
  if (d.kind === 'error_body') return retryableStatus(d.bodyCode) ? d : undefined
  return undefined // aborted and invalid are final
}

/**
 * Whether a failure of a model request is temporary: a network failure, HTTP 408, 429 or 5xx, or a 200 whose error body
 * has such a code. Everything else is final, such as an invalid answer, any other status, and a failure that is no ModelError.
 * Once `signal` is aborted nothing is temporary.
 */
export function isTransient(err: unknown, signal: AbortSignal): boolean {
  return transientDetail(err, signal) !== undefined
}

/**
 * The failure of an answer that came back whole but cannot be used: its finish reason is 'other'. The model client turns every
 * finish reason it does not know into that one, and for OpenRouter that includes "error": a provider that fails after the answer
 * has begun gives HTTP 200 with `finish_reason: "error"` and the error inside the choice, possibly with partial output. Scored as an
 * answer, that would end a run on a model that never answered. It is final for the retrying client (`isTransient` is false for it),
 * and it is what `runManifest` ends on as MODEL_ERROR when the retries run out.
 *
 * `costUsd` is what the answer cost, and only when no retry record carries it: an answer that is dropped for a retry has its cost in
 * the record, and one that is dropped for good (no retry left, or a stop) has no record, so the error says it.
 */
export class UnusableAnswerError extends ModelError {
  constructor(readonly costUsd?: number) {
    super('model answer unusable: finish_reason other (OpenRouter reports a provider error that way)', { kind: 'invalid' })
  }
}

/**
 * Wraps a model client so that a request which fails with a temporary error is made again, up to `maxRetries` times
 * (default 3), after the matching entry of `delaysMs` (default 2 s, 8 s, 30 s; the last one repeats if the list is
 * shorter). Every retry gets the same messages and options, so also the same signal. `onRetry` is called once per
 * retry, before the wait. `sleep` is a test seam; the default is a real timer that the signal cuts short.
 *
 * An answer with finish reason 'other' counts as a temporary failure too (kind `finish_other`, with its cost in the record), and
 * takes its retries from the same budget. It is never handed on: it is retried, or, when the retries run out or the signal is
 * aborted, it ends the call as an `UnusableAnswerError`. The other finish reasons pass as they are.
 *
 * A stop during the wait ends the call with the failure that was being retried, without another request. When the
 * retries run out the last failure is thrown. The bench wraps only the hosted route in this (spec §4.1): the local
 * route never retries.
 */
export function createRetryingClient(
  inner: ModelClient,
  opts: { maxRetries?: number; delaysMs?: number[]; onRetry?: (r: RetryRecord) => void; sleep?: (ms: number, signal: AbortSignal) => Promise<void> },
): ModelClient {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES
  const delaysMs = opts.delaysMs ?? DELAYS_MS
  const sleep = opts.sleep ?? ((ms: number, signal: AbortSignal) => wait(ms, undefined, { signal }))
  return {
    async complete(messages, options) {
      /** Records the retry, waits, and gives `failure` instead of another request when the stop came meanwhile. */
      const retryAfter = async (retry: number, record: Omit<RetryRecord, 'attempt'>, failure: unknown): Promise<void> => {
        opts.onRetry?.({ attempt: retry + 1, ...record })
        const delayMs = delaysMs[Math.min(retry, delaysMs.length - 1)] ?? 0
        // A real wait rejects when the signal fires and a stub may just return; both end in the model failure, not in the abort.
        await sleep(delayMs, options.signal).catch((waitErr: unknown) => {
          if (!options.signal.aborted) throw waitErr
        })
        if (options.signal.aborted) throw failure
      }

      for (let retry = 0; ; retry++) {
        let res: CompleteResult
        try {
          res = await inner.complete(messages, options)
        } catch (err) {
          const detail = transientDetail(err, options.signal)
          if (!detail || retry >= maxRetries) throw err
          await retryAfter(
            retry,
            {
              kind: detail.kind,
              ...(detail.status !== undefined ? { status: detail.status } : {}),
              ...(detail.bodyCode !== undefined ? { bodyCode: detail.bodyCode } : {}),
            },
            err,
          )
          continue
        }
        if (res.finishReason !== 'other') return res

        const costUsd = typeof res.usage.costUsd === 'number' ? res.usage.costUsd : undefined
        // Dropped for good: no record follows, so the error carries the cost.
        if (options.signal.aborted || retry >= maxRetries) throw new UnusableAnswerError(costUsd)
        // Dropped for a retry: the record carries the cost, and so the error that a stop during the wait turns it into does not.
        await retryAfter(retry, { kind: 'finish_other', ...(costUsd !== undefined ? { costUsd } : {}) }, new UnusableAnswerError())
      }
    },
  }
}
