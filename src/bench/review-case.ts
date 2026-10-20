import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

/**
 * A review case (M8 spec §4.1, §4.2): a directory with `case.json`, the production prompt, the `payload.json` of the production job
 * and the sources that job saw. `case.json` pins every other file by sha256, so one changed byte stops the bench before a run dir
 * exists. `loadReviewCase` does that check; `stageReviewCase` then copies payload and sources into the workspace of the model.
 */

const CASE_FILE = 'case.json'
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
const fileRef = z.object({ file: z.string().min(1), sha256: sha256Hex }).strict()

// A key becomes the name `sources/<key>` in the workspace, so it is one path segment; `__dispatch_input` is one.
const sourceKey = z.string().regex(/^(?!\.{1,2}$)[^/\\\0]+$/, 'moet één padonderdeel zijn')

export const ReviewCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    prompt: fileRef,
    payload: fileRef,
    sources: z.array(z.object({ key: sourceKey, file: z.string().min(1), sha256: sha256Hex }).strict()).min(1),
    // The same bounds as `Manifest['limits']`, which these become.
    limits: z
      .object({
        maxTurns: z.number().int().positive(),
        maxOutputTokens: z.number().int().positive(),
        maxWallSeconds: z.number().int().positive(),
        maxToolErrors: z.number().int().nonnegative(),
      })
      .strict(),
    // Required: `read_file` with offset/limit has no limit of its own, only the context window bounds it (spec §4.1).
    contextTokens: z.number().int().positive(),
    // A plain decimal, as `parseCeilingNanos` reads it.
    maxCostUsd: z.string().regex(/^\d+(\.\d+)?$/),
  })
  .strict()
  .superRefine((c, context) => {
    const seen = new Set<string>()
    c.sources.forEach((source, i) => {
      if (seen.has(source.key)) context.addIssue({ code: 'custom', path: ['sources', i, 'key'], message: `sleutel ${source.key} komt twee keer voor` })
      seen.add(source.key)
    })
  })

export type ReviewCase = z.infer<typeof ReviewCaseSchema>

/** The case cannot be used. The message is `CASE_INVALID: <file>: <reason>`, with the file as `case.json` names it. */
export class CaseInvalidError extends Error {
  constructor(file: string, reason: string) {
    super(`CASE_INVALID: ${file}: ${reason}`)
    this.name = 'CaseInvalidError'
  }
}

export type LoadedReviewCase = {
  case: ReviewCase
  /** The case dir, absolute. */
  dir: string
  /** The production prompt, as it is in `review.md`. */
  prompt: string
  /** `payload.json`, parsed. */
  payload: unknown
  /** `dispatch.input.review_documents` of the payload: what the answer of the model must repeat. */
  expectedDocuments: unknown
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const errorCode = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err))

/**
 * The bytes of a regular file inside the case dir. `file` is relative and has no `..`; nothing on the way, from the case dir down, is a
 * symlink (lstat, so the link itself is looked at). The ancestors of the case dir itself are not looked at: a tmp dir may sit below one.
 */
function readRegularFile(dir: string, file: string): Buffer {
  if (isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new CaseInvalidError(file, 'pad is niet relatief binnen de case (absoluut of met "..")')
  const parts = file.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.length === 0) throw new CaseInvalidError(file, 'pad noemt geen bestandsnaam')
  let current = dir
  for (const [i, part] of parts.entries()) {
    current = join(current, part)
    let stat
    try {
      stat = lstatSync(current)
    } catch (err) {
      throw new CaseInvalidError(file, `bestand niet gevonden of onleesbaar (${errorCode(err)})`)
    }
    if (stat.isSymbolicLink()) throw new CaseInvalidError(file, 'is een symlink, of ligt onder een symlink')
    if (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw new CaseInvalidError(file, 'is geen gewoon bestand')
  }
  try {
    return readFileSync(current)
  } catch (err) {
    throw new CaseInvalidError(file, `bestand niet gevonden of onleesbaar (${errorCode(err)})`)
  }
}

/** The bytes of a file that `case.json` names, once their sha256 is the pinned one. */
function readPinned(dir: string, ref: { file: string; sha256: string }): Buffer {
  const bytes = readRegularFile(dir, ref.file)
  const found = createHash('sha256').update(bytes).digest('hex')
  if (found !== ref.sha256) throw new CaseInvalidError(ref.file, `sha256 wijkt af: verwacht ${ref.sha256}, gevonden ${found}`)
  return bytes
}

/** The path of a zod issue as a text; an issue on the object itself, like an unknown key, has an empty path. */
const pathOf = (path: readonly PropertyKey[]): string => (path.length === 0 ? '(root)' : path.map(String).join('.'))

/**
 * Loads a case and checks every byte of it, in this order (the first failure is the error): (1) `case.json` follows the schema;
 * (2) every file it names is relative, a regular file and has the right sha256; (3) the payload has `review_documents`, and its
 * `source_artifacts` hold exactly the keys and hashes of `sources[]`, in both directions. It creates nothing.
 */
export function loadReviewCase(caseDir: string): LoadedReviewCase {
  const dir = resolve(caseDir)

  let raw: unknown
  try {
    raw = JSON.parse(readRegularFile(dir, CASE_FILE).toString('utf8'))
  } catch (err) {
    if (err instanceof CaseInvalidError) throw err
    throw new CaseInvalidError(CASE_FILE, `geen geldige JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const parsed = ReviewCaseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new CaseInvalidError(CASE_FILE, parsed.error.issues.map((issue) => `${pathOf(issue.path)}: ${issue.message}`).join('; '))
  }
  const c = parsed.data

  const prompt = readPinned(dir, c.prompt)
  const payloadBytes = readPinned(dir, c.payload)
  for (const source of c.sources) readPinned(dir, source)

  const bad = (reason: string): CaseInvalidError => new CaseInvalidError(c.payload.file, reason)
  let payload: unknown
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'))
  } catch (err) {
    throw bad(`geen geldige JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const dispatch = isRecord(payload) ? payload.dispatch : undefined
  const input = isRecord(dispatch) ? dispatch.input : undefined
  if (!isRecord(input) || input.review_documents == null) throw bad('dispatch.input.review_documents ontbreekt')
  const artifacts = isRecord(dispatch) ? dispatch.source_artifacts : undefined
  if (!Array.isArray(artifacts)) throw bad('dispatch.source_artifacts is geen lijst')

  const found = new Map<string, string>()
  for (const [i, artifact] of artifacts.entries()) {
    if (!isRecord(artifact) || typeof artifact.key !== 'string' || typeof artifact.sha256 !== 'string') {
      throw bad(`dispatch.source_artifacts[${i}] is geen {key, sha256}`)
    }
    if (found.has(artifact.key)) throw bad(`sleutel ${artifact.key} twee keer in dispatch.source_artifacts`)
    found.set(artifact.key, artifact.sha256)
  }
  for (const source of c.sources) {
    const hash = found.get(source.key)
    if (hash === undefined) throw bad(`sleutel ${source.key} staat in case.json maar niet in dispatch.source_artifacts`)
    if (hash !== source.sha256) {
      throw bad(`sleutel ${source.key}: sha256 in dispatch.source_artifacts (${hash}) wijkt af van case.json (${source.sha256})`)
    }
  }
  const wanted = new Set(c.sources.map((source) => source.key))
  for (const key of found.keys()) {
    if (!wanted.has(key)) throw bad(`sleutel ${key} staat in dispatch.source_artifacts maar niet in case.json`)
  }

  return { case: c, dir, prompt: prompt.toString('utf8'), payload, expectedDocuments: input.review_documents }
}

/**
 * Makes the workspace `<runDir>/root` of the model: `payload.json` and `sources/<key>`, byte copies, and an empty `work/`. The
 * production prompt says "`work/` is empty unless a repository checkout is provided", and in production `/work` is a checkout or empty;
 * the bench provides no checkout, so `work/` exists and is empty, and the model's `list_files work/` is not a tool error. Every file is
 * hashed again on the way, because the load is over by now, and all of them are read before anything is written, so a file that changed
 * leaves no root behind. A root that exists already is an error (EEXIST): a run never sees the files of another. Returns the path of the root.
 */
export function stageReviewCase(loaded: LoadedReviewCase, runDir: string): string {
  const { case: c, dir } = loaded
  const payload = readPinned(dir, c.payload)
  const sources = c.sources.map((source) => ({ key: source.key, bytes: readPinned(dir, source) }))

  const root = join(runDir, 'root')
  mkdirSync(runDir, { recursive: true })
  mkdirSync(root)
  writeFileSync(join(root, 'payload.json'), payload)
  mkdirSync(join(root, 'sources'))
  for (const { key, bytes } of sources) writeFileSync(join(root, 'sources', key), bytes)
  mkdirSync(join(root, 'work')) // empty: the bench provides no repository checkout
  return root
}
