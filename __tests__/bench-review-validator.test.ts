import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canonicalJson, dispatchResultSchema } from '../src/bench/dispatch-result.js'
import { createReviewValidator, parseReviewAnswer, REVIEW_RESULT_MAX_BYTES } from '../src/bench/review-validator.js'

type Json = Record<string, unknown>

/** The synthetic production-shaped result (spec §4.4). It holds no text of the private case. */
const VALID = JSON.parse(readFileSync(new URL('./fixtures/review-bench/valid-result.json', import.meta.url), 'utf8')) as Json & {
  review: { verdict: string; documents: { version: number; items: Json[] } }
}
/** What the job input pinned; the result must repeat it. */
const DOCUMENTS = VALID.review.documents

const NOT_ONE = 'antwoord is niet precies één JSON-object'
const TOO_BIG = 'resultaat groter dan 256 KiB'
const RETRY_SUFFIX = '\n\nAntwoord alleen met het gecorrigeerde JSON-object.'
const signal = new AbortController().signal

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const answerOf = (obj: unknown): string => JSON.stringify(obj)
const fenced = (obj: unknown): string => '```json\n' + JSON.stringify(obj, null, 2) + '\n```'
/** Same value, every object with its keys in the opposite order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Json).reverse().map(([k, v]) => [k, reverseKeys(v)]))
  }
  return value
}

describe('the fixture', () => {
  it('is a result as production writes it: version, outcome, summary, report_markdown, checks and review', () => {
    expect(Object.keys(VALID)).toEqual(['version', 'outcome', 'summary', 'report_markdown', 'checks', 'review'])
    expect(VALID.review.documents.items.length).toBeGreaterThanOrEqual(2)
    expect(dispatchResultSchema.safeParse(VALID).success).toBe(true)
  })
})

describe('parseReviewAnswer: what it accepts', () => {
  it('accepts the fixture as one bare JSON object', () => {
    const r = parseReviewAnswer(answerOf(VALID), DOCUMENTS)
    expect(r).toEqual({ ok: true, result: VALID })
  })

  it('accepts one ```json fence around the object', () => {
    expect(parseReviewAnswer(fenced(VALID), DOCUMENTS)).toEqual({ ok: true, result: VALID })
  })

  it('accepts whitespace and a BOM around the object, and around the fence (Review Focus 1)', () => {
    expect(parseReviewAnswer('﻿ \n\t' + answerOf(VALID) + '\n \r\n', DOCUMENTS)).toEqual({ ok: true, result: VALID })
    expect(parseReviewAnswer('﻿\n' + fenced(VALID) + ' \n\n', DOCUMENTS)).toEqual({ ok: true, result: VALID })
    expect(parseReviewAnswer(' ﻿' + fenced(VALID), DOCUMENTS)).toEqual({ ok: true, result: VALID })
  })

  it('accepts pretty-printed JSON and blank lines inside the fence', () => {
    expect(parseReviewAnswer('```json\n\n' + JSON.stringify(VALID, null, 4) + '\n\n```', DOCUMENTS)).toEqual({ ok: true, result: VALID })
  })

  it('accepts a different key order in review.documents, because only array order counts', () => {
    const reordered = clone(VALID)
    reordered.review.documents = reverseKeys(VALID.review.documents) as typeof reordered.review.documents
    expect(Object.keys(reordered.review.documents.items[0])).not.toEqual(Object.keys(DOCUMENTS.items[0]))
    expect(parseReviewAnswer(answerOf(reordered), DOCUMENTS)).toEqual({ ok: true, result: reordered })
    // the expected side is just as free in its key order
    expect(parseReviewAnswer(answerOf(VALID), reverseKeys(DOCUMENTS))).toEqual({ ok: true, result: VALID })
  })

  it('accepts a different key order of the result itself', () => {
    expect(parseReviewAnswer(answerOf(reverseKeys(VALID)), DOCUMENTS)).toEqual({ ok: true, result: VALID })
  })

  it('accepts outcome "failed" with a review: the scorer decides about the outcome', () => {
    const failed = { ...clone(VALID), outcome: 'failed' }
    expect(parseReviewAnswer(answerOf(failed), DOCUMENTS)).toEqual({ ok: true, result: failed })
  })

  it('does not look at checks: an empty list and a failed check both pass (X-m3)', () => {
    const none = { ...clone(VALID), checks: [] }
    expect(parseReviewAnswer(answerOf(none), DOCUMENTS)).toEqual({ ok: true, result: none })
    const failedCheck = { ...clone(VALID), checks: [{ name: 'n', status: 'failed', evidence: 'does not match' }] }
    expect(parseReviewAnswer(answerOf(failedCheck), DOCUMENTS).ok).toBe(true)
  })
})

describe('parseReviewAnswer: step 1, exactly one JSON object', () => {
  const object = answerOf(VALID)
  const cases: Array<[string, string]> = [
    ['text before the object', 'Hier is mijn resultaat:\n' + object],
    ['text after the object', object + '\nSucces ermee!'],
    ['text before the fence', 'Hier is mijn resultaat:\n' + fenced(VALID)],
    ['text after the fence', fenced(VALID) + '\nSucces ermee!'],
    ['an empty answer (Review Focus 3)', ''],
    ['only whitespace and a BOM', ' ﻿\n\t '],
    ['a bare ``` fence, without json', '```\n' + object + '\n```'],
    ['a fence in another language', '```JSON\n' + object + '\n```'],
    ['an unclosed fence', '```json\n' + object],
    ['two fences', fenced(VALID) + '\n\n' + fenced(VALID)],
    ['a fence with text inside, around the object', '```json\nHier:\n' + object + '\n```'],
    ['an empty fence', '```json\n\n```'],
    ['an array', '[' + object + ']'],
    ['a string', '"' + object.replace(/"/g, '\\"') + '"'],
  ]
  it.each(cases)('rejects %s', (_name, answer) => {
    expect(parseReviewAnswer(answer, DOCUMENTS)).toEqual({ ok: false, error: NOT_ONE })
  })
})

describe('parseReviewAnswer: step 2, at most 256 KiB', () => {
  const pad = (n: number, ch = 'a') => `{"x":"` + ch.repeat(n) + `"}`

  it('exports the limit as 256 KiB', () => {
    expect(REVIEW_RESULT_MAX_BYTES).toBe(256 * 1024)
  })

  it('stops an object of one byte over the limit, before it looks at the schema', () => {
    expect(Buffer.byteLength(pad(REVIEW_RESULT_MAX_BYTES - 8 + 1))).toBe(REVIEW_RESULT_MAX_BYTES + 1)
    expect(parseReviewAnswer(pad(REVIEW_RESULT_MAX_BYTES - 8 + 1), DOCUMENTS)).toEqual({ ok: false, error: TOO_BIG })
  })

  it('lets an object of exactly the limit through to the schema', () => {
    expect(Buffer.byteLength(pad(REVIEW_RESULT_MAX_BYTES - 8))).toBe(REVIEW_RESULT_MAX_BYTES)
    const r = parseReviewAnswer(pad(REVIEW_RESULT_MAX_BYTES - 8), DOCUMENTS)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/^schema: /)
  })

  it('counts UTF-8 bytes, not characters', () => {
    const answer = pad(131073, 'é') // 131 081 characters, 262 154 bytes
    expect(answer.length).toBeLessThan(REVIEW_RESULT_MAX_BYTES)
    expect(Buffer.byteLength(answer)).toBeGreaterThan(REVIEW_RESULT_MAX_BYTES)
    expect(parseReviewAnswer(answer, DOCUMENTS)).toEqual({ ok: false, error: TOO_BIG })
  })

  it('applies to the object inside a fence', () => {
    expect(parseReviewAnswer('```json\n' + pad(REVIEW_RESULT_MAX_BYTES) + '\n```', DOCUMENTS)).toEqual({ ok: false, error: TOO_BIG })
  })
})

describe('parseReviewAnswer: step 3, JSON and the strict schema', () => {
  const errorOf = (answer: string): string => {
    const r = parseReviewAnswer(answer, DOCUMENTS)
    if (r.ok) throw new Error('expected an error')
    return r.error
  }

  it('names a key that the schema does not know, under (root)', () => {
    expect(errorOf(answerOf({ ...clone(VALID), extra: 1 }))).toBe('schema: (root): Unrecognized key: "extra"')
  })

  it('names the path of a nested field, joined with dots', () => {
    const bad = clone(VALID)
    bad.review.documents.items[1].sha256 = 'abc'
    const error = errorOf(answerOf(bad))
    expect(error).toMatch(/^schema: review\.documents\.items\.1\.sha256: /)
    expect(error).not.toContain('; ')
  })

  it('names an unknown key inside review, as the path of that object', () => {
    const bad = clone(VALID)
    ;(bad.review as Json).note = 'x'
    expect(errorOf(answerOf(bad))).toBe('schema: review: Unrecognized key: "note"')
  })

  it('gives one entry per issue, separated by "; "', () => {
    const bad = { ...clone(VALID), summary: '', outcome: 'done' }
    const parts = errorOf(answerOf(bad)).split('; ')
    expect(parts).toHaveLength(2)
    expect(parts.every((p) => p.startsWith('schema: '))).toBe(true)
    expect(parts.some((p) => p.startsWith('schema: summary: '))).toBe(true)
    expect(parts.some((p) => p.startsWith('schema: outcome: '))).toBe(true)
  })

  it('rejects a missing required field', () => {
    const bad = clone(VALID) as Json
    delete bad.report_markdown
    expect(errorOf(answerOf(bad))).toMatch(/^schema: report_markdown: /)
  })

  it('rejects a duplicate document key', () => {
    const bad = clone(VALID)
    bad.review.documents.items[1].key = 'spec'
    expect(errorOf(answerOf(bad))).toMatch(/^schema: review\.documents\.items\.1\.key: Duplicate document key$/)
  })

  it('reports text that starts with { and ends with } but is not JSON', () => {
    const error = errorOf('{"version": 1, "outcome": }')
    expect(error).toMatch(/^antwoord is geen geldige JSON: /)
  })

  it('reports two objects glued together as not valid JSON', () => {
    expect(errorOf('{"a":1}{"b":2}')).toMatch(/^antwoord is geen geldige JSON: /)
  })
})

describe('parseReviewAnswer: step 4, review must be there', () => {
  it('rejects outcome "failed" without review, as production does', () => {
    const bad = { ...clone(VALID), outcome: 'failed' } as Json
    delete bad.review
    expect(parseReviewAnswer(answerOf(bad), DOCUMENTS)).toEqual({ ok: false, error: 'review ontbreekt' })
  })

  it('rejects outcome "succeeded" without review as well', () => {
    const bad = clone(VALID) as Json
    delete bad.review
    expect(parseReviewAnswer(answerOf(bad), DOCUMENTS)).toEqual({ ok: false, error: 'review ontbreekt' })
  })
})

describe('parseReviewAnswer: step 5, review.documents must repeat the input', () => {
  const DIFFERS = 'review.documents wijkt af van de input'

  it('rejects the same documents in another array order', () => {
    const bad = clone(VALID)
    bad.review.documents.items.reverse()
    expect(parseReviewAnswer(answerOf(bad), DOCUMENTS)).toEqual({ ok: false, error: DIFFERS })
  })

  it('rejects a changed value', () => {
    const bad = clone(VALID)
    bad.review.documents.items[0].title = 'Another title'
    expect(parseReviewAnswer(answerOf(bad), DOCUMENTS)).toEqual({ ok: false, error: DIFFERS })
  })

  it('rejects a missing document', () => {
    const bad = clone(VALID)
    bad.review.documents.items.pop()
    expect(parseReviewAnswer(answerOf(bad), DOCUMENTS)).toEqual({ ok: false, error: DIFFERS })
  })

  it('treats an expected value that is missing as a difference', () => {
    expect(parseReviewAnswer(answerOf(VALID), undefined)).toEqual({ ok: false, error: DIFFERS })
  })
})

describe('canonicalJson', () => {
  it('sorts object keys at every depth and keeps the order of arrays', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null } })).toBe('{"a":{"c":null,"d":[3,1,2]},"b":1}')
    expect(canonicalJson([{ b: 1, a: 2 }, { a: 1 }])).toBe('[{"a":2,"b":1},{"a":1}]')
  })

  it('leaves out an undefined value in an object', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  it('gives the same text for the same value in another key order, and another text for another array order', () => {
    expect(canonicalJson(reverseKeys(DOCUMENTS))).toBe(canonicalJson(DOCUMENTS))
    expect(canonicalJson({ items: [1, 2] })).not.toBe(canonicalJson({ items: [2, 1] }))
  })
})

describe('createReviewValidator', () => {
  const badCases: Array<[string, string, string]> = [
    ['text around the object', 'Klaar!\n' + answerOf(VALID), NOT_ONE],
    ['an unknown key', answerOf({ ...clone(VALID), extra: true }), 'schema: (root): Unrecognized key: "extra"'],
    ['outcome "failed" without review', answerOf((({ review: _review, ...rest }) => ({ ...rest, outcome: 'failed' }))(clone(VALID))), 'review ontbreekt'],
    ['documents in another array order', answerOf((() => { const b = clone(VALID); b.review.documents.items.reverse(); return b })()), 'review.documents wijkt af van de input'],
    ['more than 256 KiB', `{"x":"${'a'.repeat(REVIEW_RESULT_MAX_BYTES)}"}`, TOO_BIG],
    ['an empty answer (Review Focus 3)', '', NOT_ONE],
    ['a bare ``` fence', '```\n' + answerOf(VALID) + '\n```', NOT_ONE],
  ]

  it.each(badCases)('%s: one retry, then REVIEW_RESULT_INVALID', async (_name, answer, error) => {
    const v = createReviewValidator(DOCUMENTS)
    expect(v.attempts()).toBe(0)
    expect(v.accepted()).toBeUndefined()

    expect(await v.afterAnswer(answer, signal)).toEqual({ kind: 'retry', message: error + RETRY_SUFFIX })
    expect(v.attempts()).toBe(1)

    expect(await v.afterAnswer(answer, signal)).toEqual({ kind: 'fail', code: 'REVIEW_RESULT_INVALID', message: `resultaat ongeldig na herhaalvraag: ${error}` })
    expect(v.attempts()).toBe(2)
    expect(v.errors()).toEqual([error, error])
    expect(v.accepted()).toBeUndefined()
  })

  it('accepts the fixture at once, and hands it out', async () => {
    const v = createReviewValidator(DOCUMENTS)
    expect(await v.afterAnswer(answerOf(VALID), signal)).toEqual({ kind: 'accept' })
    expect(v.attempts()).toBe(1)
    expect(v.errors()).toEqual([])
    expect(v.accepted()).toEqual(VALID)
  })

  it('accepts a fenced answer with whitespace and a BOM around it', async () => {
    const v = createReviewValidator(DOCUMENTS)
    expect(await v.afterAnswer('﻿\n' + fenced(VALID) + '\n  ', signal)).toEqual({ kind: 'accept' })
    expect(v.accepted()).toEqual(VALID)
  })

  it('accepts a valid answer after one error, with attempts() 2', async () => {
    const v = createReviewValidator(DOCUMENTS)
    expect(await v.afterAnswer('', signal)).toEqual({ kind: 'retry', message: NOT_ONE + RETRY_SUFFIX })
    expect(await v.afterAnswer(answerOf(VALID), signal)).toEqual({ kind: 'accept' })
    expect(v.attempts()).toBe(2)
    expect(v.errors()).toEqual([NOT_ONE])
    expect(v.accepted()).toEqual(VALID)
  })

  it('reports the error of each attempt, also when the two differ', async () => {
    const v = createReviewValidator(DOCUMENTS)
    expect(await v.afterAnswer('praat', signal)).toMatchObject({ kind: 'retry' })
    expect(await v.afterAnswer(answerOf({ ...clone(VALID), extra: 1 }), signal)).toEqual({
      kind: 'fail',
      code: 'REVIEW_RESULT_INVALID',
      message: 'resultaat ongeldig na herhaalvraag: schema: (root): Unrecognized key: "extra"',
    })
    expect(v.errors()).toEqual([NOT_ONE, 'schema: (root): Unrecognized key: "extra"'])
  })

  it('accepts outcome "failed" with a review', async () => {
    const v = createReviewValidator(DOCUMENTS)
    const failed = { ...clone(VALID), outcome: 'failed' }
    expect(await v.afterAnswer(answerOf(failed), signal)).toEqual({ kind: 'accept' })
    expect(v.accepted()).toEqual(failed)
  })

  it('accepts documents with another key order than the input', async () => {
    const v = createReviewValidator(DOCUMENTS)
    const reordered = clone(VALID)
    reordered.review.documents = reverseKeys(DOCUMENTS) as typeof reordered.review.documents
    expect(await v.afterAnswer(answerOf(reordered), signal)).toEqual({ kind: 'accept' })
  })

  it('does not hand out its list of errors for editing', async () => {
    const v = createReviewValidator(DOCUMENTS)
    await v.afterAnswer('', signal)
    v.errors().push('x')
    expect(v.errors()).toEqual([NOT_ONE])
  })

  it('keeps no state between two validators', async () => {
    const a = createReviewValidator(DOCUMENTS)
    const b = createReviewValidator(DOCUMENTS)
    await a.afterAnswer('', signal)
    expect(b.attempts()).toBe(0)
    expect(await b.afterAnswer('', signal)).toMatchObject({ kind: 'retry' })
  })
})
