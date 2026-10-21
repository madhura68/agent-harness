import { z } from 'zod'

/**
 * The result of a review job as production accepts it (M8 spec §3 and §4.4). This file is a COPY, not a design: the schema must not
 * drift from what `finalizeChildResult` admits, so each piece names where it was taken from. All of it was read at exactly the
 * commit given, never at a newer one; a change upstream is a deliberate update here, with the commit below changed.
 *
 *   repo scrum4me-shared (git.jp-visser.nl/janpeter/scrum4me-shared), commit 7c41ddc:
 *   - `REVIEW_DOCUMENT_KEY_PATTERN`, `id`, `common`, `validMarkdownPath`, `reviewDocumentRefSchema` and `reviewDocumentsSchema`:
 *     lib/queue-review-documents.ts:3, :32-69 (`id` is the one of that file; the `id` of queue-dispatch-validation.ts is a twin).
 *   - `text`, `uuid`, `gitSha` and `branchRef`: lib/queue-dispatch-validation.ts:6, :8, :10, :16.
 *   - `DISPATCH_MAX_JSON_BYTES` and `withinJsonLimit`: lib/queue-dispatch-validation.ts:28-37.
 *   - `dispatchResultSchema`: lib/queue-dispatch-validation.ts:117-124.
 *   - `isQueueDispatchRequestId`, the test behind `uuid`: lib/queue-identity.ts:168-170.
 *   repo scrum4me-docker (git.jp-visser.nl/janpeter/scrum4me-docker), commit 78e7347d:
 *   - `canonicalJson` is the `canonical` of lib/dispatch-child.ts:47, which `finalizeChildResult` (:197-222) calls to compare
 *     `review.documents` with the documents of the request. The copy keeps its semantics: keys sorted, an undefined value in an
 *     object left out, arrays in order.
 *
 * Zod: no adaptation to zod 4 was needed. scrum4me-shared accepts zod ^3.25 || ^4 and develops against ^4.0.0, and everything it uses
 * here (`z.discriminatedUnion`, `.strict()`, `.superRefine`, `.refine`) is the same call in the ^4.6.5 of this repo. The copies differ from
 * the originals only in form: the `export` of what no caller here needs is dropped, and arrow functions get parentheses.
 */

// --- scrum4me-shared lib/queue-review-documents.ts @7c41ddc ------------------------------------------------

const REVIEW_DOCUMENT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,48}$/

const id = z.string().min(1).max(128).regex(/^[^\s\u0000-\u001f\u007f]+$/)
const common = {
  key: z.string().regex(REVIEW_DOCUMENT_KEY_PATTERN),
  title: z.string().min(1).max(200),
  product_id: id,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}

function validMarkdownPath(path: string): boolean {
  return !path.startsWith('/') && !/[\\\u0000-\u001f\u007f]/.test(path)
    && /\.md$/i.test(path)
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

const reviewDocumentRefSchema = z.discriminatedUnion('source', [
  z.object({ ...common, source: z.literal('product_doc'), doc_id: id, revision_id: id }).strict(),
  z.object({
    ...common,
    source: z.literal('git'),
    path: z.string().min(1).max(1024).refine(validMarkdownPath),
    commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
  }).strict(),
])

const reviewDocumentsSchema = z.object({
  version: z.literal(1),
  items: z.array(reviewDocumentRefSchema).min(1).max(8),
}).strict().superRefine((block, context) => {
  const seen = new Set<string>()
  block.items.forEach((item, index) => {
    if (seen.has(item.key)) {
      context.addIssue({
        code: 'custom', path: ['items', index, 'key'], message: 'Duplicate document key',
      })
    }
    seen.add(item.key)
  })
})

// --- scrum4me-shared lib/queue-identity.ts @7c41ddc ---------------------------------------------------------

function isQueueDispatchRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

// --- scrum4me-shared lib/queue-dispatch-validation.ts @7c41ddc ----------------------------------------------

const text = z.string().min(1).max(32000)
const uuid = z.string().refine(isQueueDispatchRequestId, 'Expected UUID')
const gitSha = z.string().regex(/^[0-9a-f]{40}$/)
// The publish branch is never free text: it reaches the central publisher's git argv.
// Mirror exactly what the mcp publisher requires - `codex/queue-<requestId>` with the
// dispatch request-id UUID shape (scrum4me-mcp src/dispatch/publication.ts:29, and the
// docker consumer scrum4me-docker lib/dispatch-code-artifact.ts:78) - so anything like
// `--upload-pack=x`, `refs/../x` or a value with spaces is refused at the contract.
const branchRef = z.string().regex(/^codex\/queue-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

export const DISPATCH_MAX_JSON_BYTES = 256 * 1024
/** HTTP consumers must also bound the original request bytes before JSON.parse. */
function withinJsonLimit(value: unknown): boolean {
  try {
    const json = JSON.stringify(value)
    return json !== undefined && new TextEncoder().encode(json).length <= DISPATCH_MAX_JSON_BYTES
  } catch {
    return false
  }
}

export const dispatchResultSchema = z.object({
  version: z.literal(1), outcome: z.enum(['succeeded', 'failed', 'cancelled']),
  summary: z.string().min(1).max(4000), report_markdown: text,
  checks: z.array(z.object({ name: text, status: z.enum(['passed', 'failed', 'not_run']),
    evidence: z.string().min(1).max(4000) }).strict()).max(128),
  review: z.object({ verdict: z.enum(['GO', 'NO-GO', 'COMMENT']), documents: reviewDocumentsSchema }).strict().optional(),
  code: z.object({ base_sha: gitSha, head_sha: gitSha, branch: branchRef, artifact_id: uuid }).strict().optional(),
}).strict().refine(withinJsonLimit, 'Dispatch result exceeds 256 KiB UTF-8')

export type DispatchResult = z.infer<typeof dispatchResultSchema>

// --- scrum4me-docker lib/dispatch-child.ts:47 @78e7347d -----------------------------------------------------

/**
 * The text that two values are compared by (`canonical` of production): `JSON.stringify` with a replacer that rebuilds every object
 * with its keys sorted. An undefined value in an object is left out, an array keeps its order. Like production, it returns
 * `undefined` (typed as a string) for an undefined top-level value, so that a missing document list never equals a real one.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v)
}
