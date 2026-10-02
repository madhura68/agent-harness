import { setTimeout as wait } from 'node:timers/promises'
import { ModelError, type ModelClient, type ModelErrorDetail } from '../model-client.js'

/**
 * One retry of a model request, as the trace and the result file record it. `attempt` numbers the retries from 1: the first
 * failure that is retried is attempt 1. `status` and `bodyCode` are there when the failure had one.
 */
export type RetryRecord = { attempt: number; kind: string; status?: number; bodyCode?: number }

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
 * Wraps a model client so that a request which fails with a temporary error is made again, up to `maxRetries` times
 * (default 3), after the matching entry of `delaysMs` (default 2 s, 8 s, 30 s; the last one repeats if the list is
 * shorter). Every retry gets the same messages and options, so also the same signal. `onRetry` is called once per
 * retry, before the wait. `sleep` is a test seam; the default is a real timer that the signal cuts short.
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
      for (let retry = 0; ; retry++) {
        try {
          return await inner.complete(messages, options)
        } catch (err) {
          const detail = transientDetail(err, options.signal)
          if (!detail || retry >= maxRetries) throw err
          opts.onRetry?.({
            attempt: retry + 1,
            kind: detail.kind,
            ...(detail.status !== undefined ? { status: detail.status } : {}),
            ...(detail.bodyCode !== undefined ? { bodyCode: detail.bodyCode } : {}),
          })
          const delayMs = delaysMs[Math.min(retry, delaysMs.length - 1)] ?? 0
          // A real wait rejects when the signal fires and a stub may just return; both end in the model failure, not in the abort.
          await sleep(delayMs, options.signal).catch((waitErr: unknown) => {
            if (!options.signal.aborted) throw waitErr
          })
          if (options.signal.aborted) throw err
        }
      }
    },
  }
}
