import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson } from '../../../src/bench/dispatch-result.js'
import { benchTmp } from '../../fakes/bench-repo.js'

/**
 * A synthetic review case in a tmp dir, laid out as the private one (spec §4.2): `case.json`, the production prompt as `review.md`,
 * `payload.json`, and `sources/doc` plus `sources/__dispatch_input`. It holds no text of the private case. The tests that use it call
 * `cleanupBenchFixtures()` from `afterEach`, which removes the dir again.
 *
 * Everything is consistent: every sha256 in `case.json` is that of its file, and `source_artifacts` in the payload repeats the keys and
 * hashes of `sources[]`. A test then breaks exactly one thing, with the helpers of `MadeCase`.
 */

type FileRef = { file: string; sha256: string }

/** `case.json`. Optional where a test deletes the key; the index signature is for keys that a test adds. */
export type CaseJson = {
  id: string
  prompt: FileRef
  payload: FileRef
  sources: Array<FileRef & { key: string }>
  limits: Record<string, number>
  contextTokens?: number
  maxCostUsd: string
  [extra: string]: unknown
}

/** `payload.json` as production writes it (scrum4me-docker lib/dispatch-child.ts:49,64). */
export type PayloadJson = {
  dispatch: {
    input: Record<string, unknown>
    source_artifacts: unknown
    [extra: string]: unknown
  }
}

export type MadeCase = {
  /** The case dir, to hand to `loadReviewCase`. */
  dir: string
  /** `review.documents` of valid-result.json, which the payload carries as `review_documents`: what the validator expects. */
  documents: unknown
  /** Reads `case.json`, lets `edit` change it and writes it back. Nothing else is touched, so a hash that no longer fits stays that way. */
  editCase(edit: (c: CaseJson) => void): void
  /** Same for `payload.json`, and `case.json` gets the new sha256 of the payload: only the payload checks can fail afterwards. */
  editPayload(edit: (p: PayloadJson) => void): void
  /** Changes one byte in the middle of a file of the case (a path relative to `dir`), and nothing else. */
  flipByte(file: string): void
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const writeJson = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')

const DEFAULT_DOC = [
  '# Example spec',
  '',
  'The cache is called `cache` in this spec.',
  'Entries expire after ten minutes.',
  'A miss reads through to the store.',
  '',
].join('\n')

/** The `review.documents` of the synthetic result: the one place that the validator (task 3) and this case agree on. */
function documentsOfValidResult(): unknown {
  const result = JSON.parse(readFileSync(new URL('./valid-result.json', import.meta.url), 'utf8')) as { review: { documents: unknown } }
  return result.review.documents
}

/** `doc` is the content of `sources/doc`; pass a Buffer for bytes that are no UTF-8. */
export function makeCase(opts: { doc?: string | Buffer } = {}): MadeCase {
  const dir = benchTmp('review-case')
  const documents = documentsOfValidResult()
  const doc = opts.doc ?? DEFAULT_DOC
  const input = { objective: 'Review the example spec and plan. Write only scratch files under `/tmp/`.', review_documents: documents }
  const dispatchInput = canonicalJson(input)

  mkdirSync(join(dir, 'sources'))
  copyFileSync(new URL('../queue-review.md', import.meta.url), join(dir, 'review.md'))
  writeFileSync(join(dir, 'sources', 'doc'), doc)
  writeFileSync(join(dir, 'sources', '__dispatch_input'), dispatchInput)

  const sources = [
    { key: 'doc', file: 'sources/doc', sha256: sha256(doc) },
    { key: '__dispatch_input', file: 'sources/__dispatch_input', sha256: sha256(dispatchInput) },
  ]
  const payload: PayloadJson = {
    dispatch: { input, source_artifacts: sources.map(({ key, sha256: hash }) => ({ key, sha256: hash })) },
  }
  writeJson(join(dir, 'payload.json'), payload)

  const caseJson: CaseJson = {
    id: 'synthetic-review',
    prompt: { file: 'review.md', sha256: sha256(readFileSync(join(dir, 'review.md'))) },
    payload: { file: 'payload.json', sha256: sha256(readFileSync(join(dir, 'payload.json'))) },
    sources,
    limits: { maxTurns: 30, maxOutputTokens: 64000, maxWallSeconds: 1800, maxToolErrors: 8 },
    contextTokens: 131072,
    maxCostUsd: '1',
  }
  writeJson(join(dir, 'case.json'), caseJson)

  const readCase = (): CaseJson => JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as CaseJson
  return {
    dir,
    documents,
    editCase(edit) {
      const c = readCase()
      edit(c)
      writeJson(join(dir, 'case.json'), c)
    },
    editPayload(edit) {
      const p = JSON.parse(readFileSync(join(dir, 'payload.json'), 'utf8')) as PayloadJson
      edit(p)
      writeJson(join(dir, 'payload.json'), p)
      const c = readCase()
      c.payload.sha256 = sha256(readFileSync(join(dir, 'payload.json')))
      writeJson(join(dir, 'case.json'), c)
    },
    flipByte(file) {
      const bytes = readFileSync(join(dir, file))
      bytes[Math.floor(bytes.length / 2)] ^= 0x01
      writeFileSync(join(dir, file), bytes)
    },
  }
}
