import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CaseInvalidError, loadReviewCase, ReviewCaseSchema, stageReviewCase } from '../src/bench/review-case.js'
import { parseReviewAnswer } from '../src/bench/review-validator.js'
import { benchTmp, cleanupBenchFixtures } from './fakes/bench-repo.js'
import { makeCase, type PayloadJson } from './fixtures/review-bench/make-case.js'

afterEach(() => cleanupBenchFixtures())

const PROMPT_FIXTURE = new URL('./fixtures/queue-review.md', import.meta.url)
const VALID_RESULT = readFileSync(new URL('./fixtures/review-bench/valid-result.json', import.meta.url), 'utf8')

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const bytesOf = (...path: string[]): Buffer => readFileSync(join(...path))

/** The message of the CaseInvalidError that `loadReviewCase` throws; the test fails when it throws something else, or nothing. */
function invalid(dir: string): string {
  try {
    loadReviewCase(dir)
  } catch (err) {
    expect(err).toBeInstanceOf(CaseInvalidError)
    return (err as Error).message
  }
  throw new Error('loadReviewCase did not throw')
}

/** The message must start with `CASE_INVALID: <file>: ` (spec §4.1) and carry `reason`. */
function expectInvalid(message: string, file: string, reason: string | RegExp): void {
  expect(message.startsWith(`CASE_INVALID: ${file}: `), message).toBe(true)
  if (typeof reason === 'string') expect(message).toContain(reason)
  else expect(message).toMatch(reason)
}

describe('loadReviewCase: a good case', () => {
  it('loads the synthetic case', () => {
    const made = makeCase()
    const loaded = loadReviewCase(made.dir)

    expect(loaded.dir).toBe(resolve(made.dir))
    expect(loaded.case.id).toBe('synthetic-review')
    expect(loaded.case.contextTokens).toBe(131072)
    expect(loaded.case.sources.map((s) => s.key)).toEqual(['doc', '__dispatch_input'])
    expect(loaded.prompt).toBe(readFileSync(PROMPT_FIXTURE, 'utf8'))
    expect(loaded.payload).toEqual(JSON.parse(bytesOf(made.dir, 'payload.json').toString('utf8')))
    expect(loaded.expectedDocuments).toEqual(made.documents)
  })

  it('hands the validator the documents that accept the synthetic result (task 3 and task 6 share them)', () => {
    const loaded = loadReviewCase(makeCase().dir)
    expect(parseReviewAnswer(VALID_RESULT, loaded.expectedDocuments).ok).toBe(true)
  })

  it('accepts maxToolErrors 0 and a case dir that is reached through a symlink', () => {
    const made = makeCase()
    made.editCase((c) => {
      c.limits.maxToolErrors = 0
    })
    const link = join(benchTmp('case-link'), 'case')
    symlinkSync(made.dir, link)

    expect(loadReviewCase(link).case.limits.maxToolErrors).toBe(0)
  })
})

describe('loadReviewCase: check 2, every named file is read and hashed', () => {
  it.each(['sources/doc', 'sources/__dispatch_input', 'review.md', 'payload.json'])('refuses one changed byte in %s', (file) => {
    const made = makeCase()
    made.flipByte(file)
    expectInvalid(invalid(made.dir), file, 'sha256 wijkt af')
  })

  it('names the expected and the found hash, in the one format of the spec', () => {
    const made = makeCase()
    const expected = (JSON.parse(bytesOf(made.dir, 'case.json').toString('utf8')) as { sources: Array<{ sha256: string }> }).sources[0].sha256
    made.flipByte('sources/doc')
    const found = sha256(bytesOf(made.dir, 'sources', 'doc'))

    expect(found).not.toBe(expected)
    expect(invalid(made.dir)).toBe(`CASE_INVALID: sources/doc: sha256 wijkt af: verwacht ${expected}, gevonden ${found}`)
  })

  it('refuses a file that is not there', () => {
    const made = makeCase()
    rmSync(join(made.dir, 'sources', 'doc'))
    expectInvalid(invalid(made.dir), 'sources/doc', 'ENOENT')
  })

  it('refuses a directory where a file should be', () => {
    const made = makeCase()
    rmSync(join(made.dir, 'sources', 'doc'))
    mkdirSync(join(made.dir, 'sources', 'doc'))
    expectInvalid(invalid(made.dir), 'sources/doc', 'geen gewoon bestand')
  })
})

describe('loadReviewCase: check 2, the path of a file', () => {
  it('refuses an absolute path, even to the real file with the right hash', () => {
    const made = makeCase()
    const absolute = join(made.dir, 'review.md')
    made.editCase((c) => {
      c.prompt.file = absolute
    })
    expectInvalid(invalid(made.dir), absolute, 'relatief')
  })

  it('refuses a path with .., even when it stays inside the case and the file has the right hash', () => {
    const made = makeCase()
    made.editCase((c) => {
      c.prompt.file = 'sources/../review.md'
    })
    expectInvalid(invalid(made.dir), 'sources/../review.md', '..')
  })

  it('refuses a path that is only a dot', () => {
    const made = makeCase()
    made.editCase((c) => {
      c.prompt.file = '.'
    })
    expectInvalid(invalid(made.dir), '.', 'bestandsnaam')
  })

  it.each(['case.json', 'review.md', 'payload.json', 'sources/doc', 'sources/__dispatch_input'])(
    'refuses %s as a symlink, also when the target has the right bytes',
    (file) => {
      const made = makeCase()
      const elsewhere = join(benchTmp('elsewhere'), 'target')
      const path = join(made.dir, file)
      copyFileSync(path, elsewhere)
      rmSync(path)
      symlinkSync(elsewhere, path)
      // The premise: through the link, the bytes are exactly those of the file that case.json pins.
      expect(bytesOf(path).equals(bytesOf(elsewhere))).toBe(true)

      expectInvalid(invalid(made.dir), file, 'symlink')
    },
  )

  it('refuses a source file below a directory that is a symlink', () => {
    const made = makeCase()
    const elsewhere = benchTmp('elsewhere')
    renameSync(join(made.dir, 'sources'), join(elsewhere, 'sources'))
    symlinkSync(join(elsewhere, 'sources'), join(made.dir, 'sources'))

    expectInvalid(invalid(made.dir), 'sources/doc', 'symlink')
  })
})

describe('loadReviewCase: check 1, case.json follows the schema', () => {
  it('names contextTokens when it is missing', () => {
    const made = makeCase()
    made.editCase((c) => {
      delete c.contextTokens
    })
    expectInvalid(invalid(made.dir), 'case.json', /^CASE_INVALID: case\.json: contextTokens: /)
  })

  it('refuses a case.json that is not there, or no JSON', () => {
    const made = makeCase()
    writeFileSync(join(made.dir, 'case.json'), '{ not json')
    expectInvalid(invalid(made.dir), 'case.json', 'geen geldige JSON')
    rmSync(join(made.dir, 'case.json'))
    expectInvalid(invalid(made.dir), 'case.json', 'ENOENT')
  })

  it.each([
    ['an id with a capital', 'id', (c: Record<string, unknown>) => (c.id = 'Bad-Id')],
    ['an id of 41 characters', 'id', (c: Record<string, unknown>) => (c.id = 'a'.repeat(41))],
    ['an id that starts with a dash', 'id', (c: Record<string, unknown>) => (c.id = '-bad')],
    ['no sources', 'sources', (c: Record<string, unknown>) => (c.sources = [])],
    ['contextTokens that is no whole number', 'contextTokens', (c: Record<string, unknown>) => (c.contextTokens = 1.5)],
    ['contextTokens 0', 'contextTokens', (c: Record<string, unknown>) => (c.contextTokens = 0)],
    ['a maxCostUsd that is not a decimal', 'maxCostUsd', (c: Record<string, unknown>) => (c.maxCostUsd = '1e3')],
    ['a maxCostUsd that is a number', 'maxCostUsd', (c: Record<string, unknown>) => (c.maxCostUsd = 1)],
    ['a missing maxCostUsd', 'maxCostUsd', (c: Record<string, unknown>) => delete c.maxCostUsd],
    ['a prompt hash that is no sha256', 'prompt.sha256', (c: Record<string, unknown>) => ((c.prompt as { sha256: string }).sha256 = 'abc')],
    ['a missing limit', 'limits.maxTurns', (c: Record<string, unknown>) => delete (c.limits as Record<string, unknown>).maxTurns],
    ['a limit that is no whole number', 'limits.maxWallSeconds', (c: Record<string, unknown>) => ((c.limits as Record<string, unknown>).maxWallSeconds = 1.5)],
    ['a negative limit', 'limits.maxToolErrors', (c: Record<string, unknown>) => ((c.limits as Record<string, unknown>).maxToolErrors = -1)],
    ['an unknown limit', 'limits', (c: Record<string, unknown>) => ((c.limits as Record<string, unknown>).maxCoffee = 1)],
    ['an unknown key', '(root)', (c: Record<string, unknown>) => (c.extra = true)],
    ['a source key with a slash', 'sources.0.key', (c: Record<string, unknown>) => ((c.sources as Array<{ key: string }>)[0].key = 'a/b')],
    ['a source key ..', 'sources.0.key', (c: Record<string, unknown>) => ((c.sources as Array<{ key: string }>)[0].key = '..')],
    ['a source key that is used twice', 'sources', (c: Record<string, unknown>) => (c.sources as unknown[]).push((c.sources as unknown[])[0])],
  ])('refuses %s', (_name, path, mutate) => {
    const made = makeCase()
    made.editCase((c) => {
      mutate(c)
    })
    expectInvalid(invalid(made.dir), 'case.json', `case.json: ${path}`)
  })

  it('exports the schema with strict keys: a sibling key is not silently dropped', () => {
    const made = makeCase()
    const raw = JSON.parse(bytesOf(made.dir, 'case.json').toString('utf8')) as Record<string, unknown>
    expect(ReviewCaseSchema.safeParse(raw).success).toBe(true)
    expect(ReviewCaseSchema.safeParse({ ...raw, ref: 'x' }).success).toBe(false)
  })
})

describe('loadReviewCase: the order of the checks is 1, 2, 3', () => {
  it('reports case.json (1) before a changed byte (2)', () => {
    const made = makeCase()
    made.flipByte('review.md')
    made.editCase((c) => {
      delete c.contextTokens
    })
    expectInvalid(invalid(made.dir), 'case.json', /^CASE_INVALID: case\.json: contextTokens: /)
  })

  it('reports a changed byte (2) before the structure of payload.json (3)', () => {
    const made = makeCase()
    // The payload no longer has review_documents or source_artifacts, and case.json still holds the old hash.
    writeFileSync(join(made.dir, 'payload.json'), '{}')
    expectInvalid(invalid(made.dir), 'payload.json', 'sha256 wijkt af')
  })

  it('reports a changed source (2) before keys that disagree (3)', () => {
    const made = makeCase()
    made.editPayload((p) => {
      p.dispatch.source_artifacts = []
    })
    made.flipByte('sources/doc')
    expectInvalid(invalid(made.dir), 'sources/doc', 'sha256 wijkt af')
  })

  it('checks the prompt first, then the payload, then the sources in the order of case.json', () => {
    const made = makeCase()
    made.flipByte('sources/__dispatch_input')
    made.flipByte('sources/doc')
    expectInvalid(invalid(made.dir), 'sources/doc', 'sha256 wijkt af')
    made.flipByte('payload.json')
    expectInvalid(invalid(made.dir), 'payload.json', 'sha256 wijkt af')
    made.flipByte('review.md')
    expectInvalid(invalid(made.dir), 'review.md', 'sha256 wijkt af')
  })
})

describe('loadReviewCase: check 3, payload.json', () => {
  it('refuses a payload that is no JSON', () => {
    const made = makeCase()
    writeFileSync(join(made.dir, 'payload.json'), 'not json')
    made.editCase((c) => {
      c.payload.sha256 = sha256('not json')
    })
    expectInvalid(invalid(made.dir), 'payload.json', 'geen geldige JSON')
  })

  it.each([
    ['review_documents is missing', (p: PayloadJson) => delete p.dispatch.input.review_documents],
    ['review_documents is null', (p: PayloadJson) => (p.dispatch.input.review_documents = null)],
    ['input is missing', (p: PayloadJson) => delete (p.dispatch as Record<string, unknown>).input],
    ['dispatch is missing', (p: PayloadJson) => delete (p as Partial<PayloadJson>).dispatch],
  ])('refuses a payload where %s', (_name, mutate) => {
    const made = makeCase()
    made.editPayload((p) => {
      mutate(p)
    })
    expectInvalid(invalid(made.dir), 'payload.json', 'dispatch.input.review_documents')
  })

  it('takes review_documents of the payload as expectedDocuments, whatever its shape', () => {
    const made = makeCase()
    made.editPayload((p) => {
      p.dispatch.input.review_documents = { version: 1, items: [] }
    })
    expect(loadReviewCase(made.dir).expectedDocuments).toEqual({ version: 1, items: [] })
  })

  it.each([
    ['source_artifacts is missing', (p: PayloadJson) => delete (p.dispatch as Record<string, unknown>).source_artifacts],
    ['source_artifacts is no list', (p: PayloadJson) => (p.dispatch.source_artifacts = { doc: 'x' })],
  ])('refuses a payload where %s', (_name, mutate) => {
    const made = makeCase()
    made.editPayload((p) => {
      mutate(p)
    })
    expectInvalid(invalid(made.dir), 'payload.json', 'source_artifacts is geen lijst')
  })

  it('refuses a source_artifacts entry that is no {key, sha256}', () => {
    const made = makeCase()
    made.editPayload((p) => {
      p.dispatch.source_artifacts = [{ key: 'doc' }]
    })
    expectInvalid(invalid(made.dir), 'payload.json', 'source_artifacts[0]')
  })

  it('refuses a key in case.json that source_artifacts does not have', () => {
    const made = makeCase()
    made.editPayload((p) => {
      p.dispatch.source_artifacts = (p.dispatch.source_artifacts as Array<{ key: string }>).filter((a) => a.key !== '__dispatch_input')
    })
    expectInvalid(invalid(made.dir), 'payload.json', 'sleutel __dispatch_input staat in case.json maar niet in dispatch.source_artifacts')
  })

  it('refuses a key in source_artifacts that case.json does not have', () => {
    const made = makeCase()
    made.editCase((c) => {
      c.sources = c.sources.filter((s) => s.key !== '__dispatch_input')
    })
    expectInvalid(invalid(made.dir), 'payload.json', 'sleutel __dispatch_input staat in dispatch.source_artifacts maar niet in case.json')
  })

  it('refuses a key with another sha256 on both sides', () => {
    const made = makeCase()
    made.editPayload((p) => {
      ;(p.dispatch.source_artifacts as Array<{ sha256: string }>)[0].sha256 = 'f'.repeat(64)
    })
    expectInvalid(invalid(made.dir), 'payload.json', /sleutel doc: sha256 in dispatch\.source_artifacts \(f{64}\) wijkt af van case\.json \([0-9a-f]{64}\)/)
  })

  it('refuses a key that source_artifacts has twice', () => {
    const made = makeCase()
    made.editPayload((p) => {
      const list = p.dispatch.source_artifacts as unknown[]
      list.push(list[0])
    })
    expectInvalid(invalid(made.dir), 'payload.json', 'sleutel doc twee keer')
  })
})

describe('stageReviewCase', () => {
  /** A run dir that does not exist yet: the harness makes it. */
  const runDirOf = (): string => join(benchTmp('run'), 'run-1')

  it('makes <runDir>/root with payload.json and sources/<key>, byte for byte, and nothing else', () => {
    const made = makeCase()
    const runDir = runDirOf()

    const root = stageReviewCase(loadReviewCase(made.dir), runDir)

    expect(root).toBe(join(runDir, 'root'))
    expect(readdirSync(root).sort()).toEqual(['payload.json', 'sources'])
    expect(readdirSync(join(root, 'sources')).sort()).toEqual(['__dispatch_input', 'doc'])
    expect(bytesOf(root, 'payload.json').equals(bytesOf(made.dir, 'payload.json'))).toBe(true)
    expect(bytesOf(root, 'sources', 'doc').equals(bytesOf(made.dir, 'sources', 'doc'))).toBe(true)
    expect(bytesOf(root, 'sources', '__dispatch_input').equals(bytesOf(made.dir, 'sources', '__dispatch_input'))).toBe(true)
  })

  it('copies bytes, not text: a BOM, CRLF and bytes that are no UTF-8 survive', () => {
    const odd = Buffer.from([0xef, 0xbb, 0xbf, 0x72, 0x0d, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0x0d, 0x0a])
    const made = makeCase({ doc: odd })

    const root = stageReviewCase(loadReviewCase(made.dir), runDirOf())

    expect(bytesOf(root, 'sources', 'doc').equals(odd)).toBe(true)
  })

  it('copies payload.json as it stands on disk, not as JSON.stringify of the parsed value', () => {
    const made = makeCase()
    const compact = JSON.stringify(JSON.parse(bytesOf(made.dir, 'payload.json').toString('utf8')))
    writeFileSync(join(made.dir, 'payload.json'), compact)
    made.editCase((c) => {
      c.payload.sha256 = sha256(compact)
    })

    const root = stageReviewCase(loadReviewCase(made.dir), runDirOf())

    expect(bytesOf(root, 'payload.json').toString('utf8')).toBe(compact)
  })

  it('refuses a root that is already there, so a run never sees the files of another', () => {
    const made = makeCase()
    const runDir = runDirOf()
    const loaded = loadReviewCase(made.dir)
    stageReviewCase(loaded, runDir)

    expect(() => stageReviewCase(loaded, runDir)).toThrow(/EEXIST/)
  })

  it.each(['payload.json', 'sources/doc'])('checks the bytes again: %s that changed after the load is not copied, and no root is made', (file) => {
    const made = makeCase()
    const runDir = runDirOf()
    const loaded = loadReviewCase(made.dir)
    made.flipByte(file)

    expect(() => stageReviewCase(loaded, runDir)).toThrow(CaseInvalidError)
    expect(() => stageReviewCase(loaded, runDir)).toThrow(`CASE_INVALID: ${file}: sha256 wijkt af`)
    expect(existsSync(join(runDir, 'root'))).toBe(false)
  })
})
