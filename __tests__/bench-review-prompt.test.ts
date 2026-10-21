import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { adaptReviewPrompt, REVIEW_PROMPT_REPLACEMENTS } from '../src/bench/review-prompt.js'

/** The production review prompt, byte for byte (scrum4me-mcp e89c0961:src/prompts/queue/review.md). It holds no private content. */
const FIXTURE_BYTES = readFileSync(new URL('./fixtures/queue-review.md', import.meta.url))
const ORIGINAL = FIXTURE_BYTES.toString('utf8')
/** The adapted prompt, made once with the function and checked by hand against the replacement table. */
const ADAPTED = readFileSync(new URL('./fixtures/queue-review.adapted.md', import.meta.url), 'utf8')

const SHA256 = 'f56fe0a641ddb007e5216a2063b02460e60b9836c08cbc2229d8f8661fee4ead'
/** The lines (1-based) that carry a replacement: A1 on 5 and 7, A2 on 9, A3 on 11 and 18, A4 on 17, A5 on 30, A6 on 48. */
const CHANGED_LINES = [5, 7, 9, 11, 17, 18, 30, 48]
const linesOf = (text: string): string[] => text.replace(/\n$/, '').split('\n')

describe('the fixture', () => {
  it('is the production prompt: sha256 f56fe0a6…4ead and 48 lines', () => {
    expect(createHash('sha256').update(FIXTURE_BYTES).digest('hex')).toBe(SHA256)
    expect(linesOf(ORIGINAL)).toHaveLength(48)
  })
})

describe('REVIEW_PROMPT_REPLACEMENTS', () => {
  it('lists A1, A2a, A2b, A3, A4, A5 and A6 in order, with the counts measured on the fixture', () => {
    expect(REVIEW_PROMPT_REPLACEMENTS.map(({ id, count }) => [id, count])).toEqual([
      ['A1', 2],
      ['A2a', 1],
      ['A2b', 1],
      ['A3', 3],
      ['A4', 1],
      ['A5', 1],
      ['A6', 1],
    ])
  })

  it('has exactly those counts in the fixture', () => {
    for (const { id, from, count } of REVIEW_PROMPT_REPLACEMENTS) {
      expect({ id, found: ORIGINAL.split(from).length - 1 }).toEqual({ id, found: count })
    }
  })
})

describe('adaptReviewPrompt', () => {
  it('is byte-equal to the checked-in adapted fixture', () => {
    expect(adaptReviewPrompt(ORIGINAL)).toBe(ADAPTED)
  })

  it('changes only lines 5, 7, 9, 11, 17, 18, 30 and 48 and keeps 48 lines', () => {
    const before = linesOf(ORIGINAL)
    const after = linesOf(adaptReviewPrompt(ORIGINAL))
    expect(after).toHaveLength(48)
    before.forEach((line, index) => {
      const lineNumber = index + 1
      if (CHANGED_LINES.includes(lineNumber)) expect(after[index], `line ${lineNumber} is adapted`).not.toBe(line)
      else expect(after[index], `line ${lineNumber} is untouched`).toBe(line)
    })
  })

  it('leaves no $PAYLOAD_PATH, /sources, /output or /work behind', () => {
    const adapted = adaptReviewPrompt(ORIGINAL)
    for (const path of ['$PAYLOAD_PATH', '/sources', '/output', '/work']) expect(adapted).not.toContain(path)
  })

  it('throws, naming A1, when there is one $PAYLOAD_PATH less', () => {
    const fewer = ORIGINAL.replace('$PAYLOAD_PATH', 'payload.json')
    expect(() => adaptReviewPrompt(fewer)).toThrow('review-prompt: A1 verwacht 2× "$PAYLOAD_PATH", gevonden 1')
  })

  it('throws, naming A3, when there is one `/work` too many', () => {
    const more = ORIGINAL + '`/work`\n'
    expect(() => adaptReviewPrompt(more)).toThrow('review-prompt: A3 verwacht 3× "`/work`", gevonden 4')
  })
})
