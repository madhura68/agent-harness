import type { AfterAnswerResult } from '../run.js'
import { canonicalJson, DISPATCH_MAX_JSON_BYTES, dispatchResultSchema, type DispatchResult } from './dispatch-result.js'

/**
 * The `afterAnswer` check of a review run (M8 spec §4.4): it replays what `finalizeChildResult` of production checks on
 * `/output/result.json`, on the final answer of the model, with one repeat question. In production the object is a file, so the
 * bench accepts one ```json fence around it and nothing else besides it.
 *
 * It does NOT look at `checks` (X-m3): production does not either, so a wrong or empty list is not an invalid result.
 */

/** The most that the object may weigh, in UTF-8 bytes: the size that production allows for `result.json`. */
export const REVIEW_RESULT_MAX_BYTES = DISPATCH_MAX_JSON_BYTES

const NOT_ONE_OBJECT = 'antwoord is niet precies één JSON-object'
const FENCE = /^```json\n([\s\S]*)\n```$/

export type ReviewAnswerParse = { ok: true; result: DispatchResult } | { ok: false; error: string }

/**
 * Step 1: the text of the one object in the answer, or undefined. `trim()` strips the whitespace and a BOM (U+FEFF). A fence is
 * exactly ```json, a newline, the object, a newline and ```; a closing fence in the middle means more than one fence (valid JSON never
 * has a line that starts with ```, since a newline inside a string is escaped).
 */
function objectText(answer: string): string | undefined {
  const trimmed = answer.trim()
  let body = trimmed
  const fence = FENCE.exec(trimmed)
  if (fence) {
    if (fence[1].includes('\n```')) return undefined
    body = fence[1].trim()
  }
  return body.startsWith('{') && body.endsWith('}') ? body : undefined
}

/** The path of a zod issue as a text; an issue on the object itself, like an unknown key, has an empty path. */
const pathOf = (path: readonly PropertyKey[]): string => (path.length === 0 ? '(root)' : path.map(String).join('.'))

/** The five steps of spec §4.4, in order; the first that fails gives the error. `expectedDocuments` is `review_documents` of the input. */
export function parseReviewAnswer(answer: string, expectedDocuments: unknown): ReviewAnswerParse {
  const body = objectText(answer)
  if (body === undefined) return { ok: false, error: NOT_ONE_OBJECT }

  if (Buffer.byteLength(body, 'utf8') > REVIEW_RESULT_MAX_BYTES) return { ok: false, error: 'resultaat groter dan 256 KiB' }

  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (err) {
    return { ok: false, error: `antwoord is geen geldige JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  const parsed = dispatchResultSchema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => `schema: ${pathOf(issue.path)}: ${issue.message}`).join('; ') }
  }
  const result = parsed.data

  if (!result.review) return { ok: false, error: 'review ontbreekt' }
  if (canonicalJson(result.review.documents) !== canonicalJson(expectedDocuments)) {
    return { ok: false, error: 'review.documents wijkt af van de input' }
  }
  return { ok: true, result }
}

export type ReviewValidator = {
  /** The `afterAnswer` hook of the run: accept, one retry with the reason, and then `REVIEW_RESULT_INVALID`. */
  afterAnswer(answer: string, signal: AbortSignal): Promise<AfterAnswerResult>
  /** The result that was accepted, once an answer was. */
  accepted(): DispatchResult | undefined
  /** How many answers the hook has judged. */
  attempts(): number
  /** The error of each answer that was refused, in order. */
  errors(): string[]
}

export function createReviewValidator(expectedDocuments: unknown): ReviewValidator {
  const errors: string[] = []
  let attempts = 0
  let accepted: DispatchResult | undefined
  return {
    // Nothing here waits, so the signal is not used.
    async afterAnswer(answer) {
      attempts += 1
      const parsed = parseReviewAnswer(answer, expectedDocuments)
      if (parsed.ok) {
        accepted = parsed.result
        return { kind: 'accept' }
      }
      errors.push(parsed.error)
      if (errors.length === 1) {
        return { kind: 'retry', message: `${parsed.error}\n\nAntwoord alleen met het gecorrigeerde JSON-object.` }
      }
      return { kind: 'fail', code: 'REVIEW_RESULT_INVALID', message: `resultaat ongeldig na herhaalvraag: ${parsed.error}` }
    },
    accepted: () => accepted,
    attempts: () => attempts,
    errors: () => [...errors],
  }
}
