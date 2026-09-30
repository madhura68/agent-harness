// `harness doc-server`: a stdio MCP server over a frozen docset (M5, model comparison). It offers the four doc tools of
// scrum4me-mcp, pinned at 285c98ae, with the same names, descriptions and input schemas, so a model reads here the interface
// text it reads in Scrum4Me. Result keys and error texts follow that server too.
// Unlike production on purpose: no authentication, no Postgres full-text search (see parseQuery and searchDocs), and a
// get_product_doc answer that stays within the harness's tool-output limit (see fitChunk).
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { TOOL_OUTPUT_LIMIT } from '../tools/registry.js'

// The doc folders of scrum4me-mcp in its order; `list_product_docs` sorts on this order.
const FOLDERS = ['adr', 'architecture', 'grills', 'patterns', 'plans', 'runbooks', 'specs', 'manual', 'api'] as const
type Folder = (typeof FOLDERS)[number]

// Every doc of a docset is active and in an enabled folder, and was last updated when the set was frozen.
const STATUS = 'active'

const productIdField = z.string().min(1)
const folderField = z.enum(FOLDERS)
const slugField = z.string().min(1).max(80)

// Input schemas as scrum4me-mcp defines them; a test compares the resulting JSON schemas with the captured ones.
const searchShape = {
  query: z.string().min(2).max(200),
  product_id: productIdField,
  folder: folderField.optional(),
  limit: z.number().int().min(1).max(50).default(10),
  include_archived: z.boolean().default(false),
  include_disabled: z.boolean().default(false),
}
const getShape = {
  product_id: productIdField,
  folder: folderField,
  slug: slugField,
  max_chars: z.number().int().min(500).max(40_000).default(12_000),
  offset: z.number().int().min(0).default(0),
  heading: z.string().optional(),
}
const listShape = {
  product_id: productIdField,
  folder: folderField.optional(),
  status: z.enum(['draft', 'active', 'deprecated', 'archived']).optional(),
  include_disabled: z.boolean().default(false),
}
const relatedShape = { product_id: productIdField, folder: folderField, slug: slugField }

const READ_ONLY = { readOnlyHint: true, idempotentHint: true }

// --- The docset ---------------------------------------------------------------------------------------------------------

export class DocsetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocsetError'
  }
}

type Doc = { folder: Folder; slug: string; title: string; content: string }
export type Docset = { frozenAt: string; docs: Doc[] } // docs in folder order, then slug

// A slug becomes a file name and is looked up in lower case, so only lower-case names without a path separator go in.
const DocsetJsonSchema = z.object({
  frozen_at: z.string().min(1),
  files: z.array(z.object({ folder: z.enum(FOLDERS), slug: z.string().max(80).regex(/^[a-z0-9][a-z0-9._-]*$/) })).min(1),
})

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Reads `<dir>/docset.json` and the `<dir>/<folder>/<slug>.md` files it lists; the other keys of docset.json are not used. */
export function loadDocset(dir: string): Docset {
  const jsonPath = join(dir, 'docset.json')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(jsonPath, 'utf8'))
  } catch (err) {
    throw new DocsetError(`cannot read ${jsonPath}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const parsed = DocsetJsonSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
    throw new DocsetError(`invalid ${jsonPath}: ${issues}`)
  }
  const seen = new Set<string>()
  const docs = parsed.data.files.map(({ folder, slug }): Doc => {
    if (seen.has(`${folder}/${slug}`)) throw new DocsetError(`${jsonPath} lists ${folder}/${slug} twice`)
    seen.add(`${folder}/${slug}`)
    const file = join(dir, folder, `${slug}.md`)
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch (err) {
      throw new DocsetError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { folder, slug, title: titleOf(content, slug), content }
  })
  docs.sort((a, b) => FOLDERS.indexOf(a.folder) - FOLDERS.indexOf(b.folder) || byCode(a.slug, b.slug))
  return { frozenAt: parsed.data.frozen_at, docs }
}

/** The `title` of the front matter, else the first `# ` heading, else the slug. */
function titleOf(content: string, slug: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)
  const title = front ? /^title:[ \t]*(.+?)[ \t]*$/m.exec(front[1])?.[1] : undefined
  if (title) return unquote(title)
  const body = front ? content.slice(front[0].length) : content
  return /^# +(.+?) *$/m.exec(body)?.[1] ?? slug
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
  return value
}

// --- Search -------------------------------------------------------------------------------------------------------------

type Word = { text: string; start: number; end: number }

/** The words of `text`: runs of letters and digits, in lower case, with their place in `text`. Everything else separates. */
function wordsOf(text: string): Word[] {
  return Array.from(text.matchAll(/[\p{L}\p{N}]+/gu), (m) => ({ text: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length }))
}

type Sequence = string[] // one word, or the words of a phrase in order
type Clause = { alternatives: Sequence[]; exclude: boolean }

/**
 * The websearch syntax the tool description promises, read as plain word matching:
 * - every term has to be in the doc; a term is a whole word, so "tool" is not found in "tools";
 * - `OR` between two terms makes "either of the two" of them (`a b OR c` is: a, and b or c; `a OR b OR c` is one group);
 * - `-term` and `-"a phrase"` leave out the docs that have it;
 * - a phrase in quotes asks for its words directly after each other. So does a term with punctuation inside, like
 *   "tool-calling" or "IDEA_CHAT": a doc's text is cut on the same punctuation.
 */
function parseQuery(query: string): Clause[] {
  const clauses: Clause[] = []
  let joinNext = false
  for (const m of query.matchAll(/(-?)"([^"]*)(?:"|$)|(\S+)/g)) {
    const phrase = m[2] as string | undefined
    const text = phrase ?? m[3]
    const exclude = phrase === undefined ? text.startsWith('-') : m[1] === '-' // the dash itself is no word
    if (phrase === undefined && !exclude && text.toLowerCase() === 'or') {
      joinNext = clauses.length > 0 && !clauses[clauses.length - 1].exclude
      continue
    }
    const words = wordsOf(text).map((w) => w.text)
    if (words.length === 0) continue
    if (joinNext && !exclude) clauses[clauses.length - 1].alternatives.push(words)
    else clauses.push({ alternatives: [words], exclude })
    joinNext = false
  }
  return clauses
}

/** Where `sequence` starts in `words`: the indexes at which all its words follow each other. */
function occurrences(words: Word[], sequence: Sequence): number[] {
  const found: number[] = []
  for (let i = 0; i + sequence.length <= words.length; i++) {
    if (sequence.every((w, j) => words[i + j].text === w)) found.push(i)
  }
  return found
}

type Hit = { doc: Indexed; score: number; first: { index: number; length: number } | undefined }

/**
 * Docs that have every positive clause and no excluded one. The score is the number of hits, in title, slug and content
 * together; the order is score first, then slug (then folder, so two docs with the same slug keep a fixed order). `first` is
 * the earliest hit in the content, which the snippet is built around.
 */
function searchDocs(docs: Indexed[], clauses: Clause[]): Hit[] {
  if (!clauses.some((c) => !c.exclude)) return [] // only exclusions: nothing to hit
  const hits: Hit[] = []
  for (const doc of docs) {
    let score = 0
    let first: Hit['first']
    let matches = true
    for (const clause of clauses) {
      let clauseHits = 0
      for (const sequence of clause.alternatives) {
        const inContent = occurrences(doc.contentWords, sequence)
        clauseHits += inContent.length + occurrences(doc.titleWords, sequence).length + occurrences(doc.slugWords, sequence).length
        for (const index of inContent) {
          if (!first || index < first.index || (index === first.index && sequence.length > first.length)) first = { index, length: sequence.length }
        }
      }
      if (clause.exclude ? clauseHits > 0 : clauseHits === 0) {
        matches = false
        break
      }
      if (!clause.exclude) score += clauseHits
    }
    if (matches) hits.push({ doc, score, first })
  }
  return hits.sort((a, b) => b.score - a.score || byCode(a.doc.slug, b.doc.slug) || FOLDERS.indexOf(a.doc.folder) - FOLDERS.indexOf(b.doc.folder))
}

const SNIPPET_WORDS = 10

/**
 * Ten words around the first hit, four before it where there are, with << and >> around the hit. A doc without a hit in its
 * text (the words are in its title or slug) gets its first ten words. Line breaks become spaces.
 */
function snippetOf(doc: Indexed, first: Hit['first']): string {
  const words = doc.contentWords
  if (words.length === 0) return ''
  const length = first?.length ?? 0
  const size = Math.max(SNIPPET_WORDS, length)
  const wanted = first ? Math.max(0, first.index - Math.floor((size - length) / 2)) : 0
  const to = Math.min(words.length, wanted + size)
  const from = Math.max(0, to - size)
  const offset = words[from].start
  let text = doc.content.slice(offset, words[to - 1].end)
  if (first) {
    const hitStart = words[first.index].start - offset
    const hitEnd = words[first.index + first.length - 1].end - offset
    text = `${text.slice(0, hitStart)}<<${text.slice(hitStart, hitEnd)}>>${text.slice(hitEnd)}`
  }
  return text.replace(/\s+/g, ' ')
}

// --- Links --------------------------------------------------------------------------------------------------------------

const LINK_RE = /(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g // as in scrum4me-mcp: [text](href), not ![alt](src)
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:)/i

/** `href` as written, the `folder/slug` key it points at (undefined when it does not name `<folder>/<file>.md`), and its #anchor. */
type Link = { href: string; key: string | undefined; anchor: string | undefined }

/** The links of a doc to markdown files: the others (URLs, images, code files) are no relations and cannot be broken. */
function linksOf(doc: Doc): Link[] {
  const links: Link[] = []
  for (const match of doc.content.matchAll(LINK_RE)) {
    const href = match[2]
    const cut = href.search(/[#?]/)
    const path = cut === -1 ? href : href.slice(0, cut)
    if (EXTERNAL_RE.test(href) || !/\.md$/i.test(path)) continue
    const anchor = cut !== -1 && href[cut] === '#' && href.length > cut + 1 ? href.slice(cut + 1) : undefined
    links.push({ href, key: keyOf(doc.folder, path), anchor })
  }
  return links
}

/**
 * The `folder/slug` (lower case) a link path points at: relative to the folder of the doc ("x.md", "../specs/x.md"), or as
 * `docs/<folder>/<file>.md`, the way a README names a doc.
 */
function keyOf(fromFolder: Folder, path: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return undefined
  }
  const base = posix.normalize(decoded).startsWith('docs/') ? '/' : `/${fromFolder}`
  const resolved = posix.resolve(base, decoded).replace(/^\/docs(?=\/)/, '')
  const m = /^\/([^/]+)\/([^/]+)\.md$/i.exec(resolved)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined
}

// --- Reading a doc ------------------------------------------------------------------------------------------------------

/**
 * Copied from `extractHeadingSection` in scrum4me-mcp (src/tools/get-product-doc.ts): the text of the heading without its
 * `#`, trimmed and in lower case, up to the next heading of the same or a higher level.
 */
function extractHeadingSection(content: string, heading: string): string | null {
  const lines = content.split('\n')
  const target = heading.trim().toLowerCase()
  let startIdx = -1
  let startLevel = 0
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i])
    if (!m) continue
    const text = m[2].trim().toLowerCase()
    if (text === target) {
      startIdx = i
      startLevel = m[1].length
      break
    }
  }
  if (startIdx === -1) return null

  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i])
    if (m && m[1].length <= startLevel) {
      endIdx = i
      break
    }
  }
  return lines.slice(startIdx, endIdx).join('\n')
}

// --- The server ---------------------------------------------------------------------------------------------------------

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** The text of a result: what the model reads, and what the harness's tool-output limit is measured on. */
const jsonText = (value: Record<string, unknown>) => JSON.stringify(value, null, 2)

/** The result as JSON text, plus the same object as structuredContent, like scrum4me-mcp's toolJson. */
function toolJson(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: jsonText(value) }], structuredContent: value }
}

/**
 * `answer(chunk)` for the longest start of `source` of at most `max` characters whose JSON text stays within TOOL_OUTPUT_LIMIT
 * bytes. The registry cuts longer output in the middle of the JSON, which drops the keys at the end (byte_size, truncated,
 * next_offset) and leaves text that does not parse. The limit is in bytes of the serialized text, where one character costs
 * one to six (multi-byte characters, JSON escapes), so the length is searched by measuring the answer, never estimated.
 * `answer` sets `truncated` and `next_offset` from the chunk it is given, which is how a shortened chunk is flagged.
 */
function fitChunk(source: string, max: number, answer: (chunk: string) => Record<string, unknown>): Record<string, unknown> {
  const tooBig = (length: number) => Buffer.byteLength(jsonText(answer(source.slice(0, length)))) > TOOL_OUTPUT_LIMIT
  let length = Math.min(max, source.length)
  if (tooBig(length)) {
    // `fits` is a length whose answer fits (an empty chunk always does: the rest of the answer is a few hundred bytes), `length`
    // one that does not. A character adds at least a byte, so the answer grows with the chunk and the search finds the longest one.
    // Only a cut inside a surrogate pair breaks that (a lone half is escaped to six bytes, the whole pair costs four). The result
    // can then be one such character short of the longest, but it never ends inside a pair: if the half fits, the whole pair does.
    let fits = 0
    while (length - fits > 1) {
      const middle = Math.floor((fits + length) / 2)
      if (tooBig(middle)) length = middle
      else fits = middle
    }
    length = fits
  }
  return answer(source.slice(0, length))
}

type Indexed = Doc & { key: string; titleWords: Word[]; slugWords: Word[]; contentWords: Word[]; links: Link[] }

export function createDocServer(docset: Docset, productId: string): McpServer {
  const docs: Indexed[] = docset.docs.map((doc) => ({
    ...doc,
    key: `${doc.folder}/${doc.slug}`,
    titleWords: wordsOf(doc.title),
    slugWords: wordsOf(doc.slug),
    contentWords: wordsOf(doc.content),
    links: linksOf(doc),
  }))
  const byKey = new Map(docs.map((d) => [d.key, d]))
  const updatedAt = docset.frozenAt

  const uriOf = (doc: Doc) => `scrum4me-doc://product/${productId}/${doc.folder}/${doc.slug}`
  /** The error for a product_id other than the one this server was started for; undefined when it is the right one. */
  const wrongProduct = (id: string) => (id === productId ? undefined : toolError(`Product '${id}' not found or not accessible`))
  /** The slug is lowercased before the lookup, as scrum4me-mcp does. A slug with `.md` behind it is therefore not found. */
  const lookup = (folder: Folder, slug: string) => byKey.get(`${folder}/${slug.toLowerCase()}`)
  const docNotFound = (input: { folder: string; slug: string; product_id: string }) =>
    toolError(`Doc '${input.folder}/${input.slug}' not found in product '${input.product_id}'`)

  const server = new McpServer({ name: 'harness-doc-server', version: '0.1.0' })

  server.registerTool(
    'search_product_docs',
    {
      title: 'Full-text search ProductDocs (Postgres tsvector)',
      description:
        'Ranked full-text search over title, slug and content_md using Postgres FTS. ' +
        'Returns snippets with ts_headline. Default excludes archived/deprecated docs ' +
        'and disabled folders — set include_archived/include_disabled to opt in. ' +
        'Use websearch syntax for queries: quoted phrases, OR, -negation.',
      inputSchema: searchShape,
      annotations: READ_ONLY,
    },
    async (input) => {
      const denied = wrongProduct(input.product_id)
      if (denied) return denied
      const pool = input.folder ? docs.filter((d) => d.folder === input.folder) : docs
      const results = searchDocs(pool, parseQuery(input.query))
        .slice(0, input.limit)
        .map(({ doc, score, first }) => ({
          uri: uriOf(doc),
          folder: doc.folder,
          slug: doc.slug,
          title: doc.title,
          status: STATUS,
          folder_enabled: true,
          snippet: snippetOf(doc, first),
          score,
          match_kind: 'fts' as const,
          updated_at: updatedAt,
        }))
      return toolJson({ results, count: results.length, query: input.query })
    },
  )

  server.registerTool(
    'get_product_doc',
    {
      title: 'Read a ProductDoc (chunked)',
      description:
        'Read the content of a ProductDoc. Use `heading` to extract a single section, ' +
        'or `offset`+`max_chars` to paginate large docs (content_md can be up to 100K chars). ' +
        'Default max_chars=12000 stays well under the MCP 10K-token warning.',
      inputSchema: getShape,
      annotations: READ_ONLY,
    },
    async (input) => {
      const denied = wrongProduct(input.product_id)
      if (denied) return denied
      const doc = lookup(input.folder, input.slug)
      if (!doc) return docNotFound(input)

      // Sizes and offsets count characters of the text, as content_md.length does in scrum4me-mcp.
      const byteSize = doc.content.length
      const answer = (body: string, truncated: boolean, nextOffset: number | null) => ({
        uri: uriOf(doc),
        folder: doc.folder,
        slug: doc.slug,
        title: doc.title,
        status: STATUS,
        folder_enabled: true,
        content_md: body,
        byte_size: byteSize,
        truncated,
        next_offset: nextOffset,
        updated_at: updatedAt,
      })
      // The chunk is cut at max_chars, or shorter where the answer would pass the harness's tool-output limit (see fitChunk).
      if (input.heading) {
        const section = extractHeadingSection(doc.content, input.heading)
        if (section === null) return toolError(`Heading '${input.heading}' not found in doc '${input.folder}/${input.slug}'`)
        // A section that is cut is flagged, but has no next_offset: offset does not apply to a section.
        return toolJson(fitChunk(section, input.max_chars, (chunk) => answer(chunk, chunk.length < section.length, null)))
      }
      const startAt = Math.min(input.offset, byteSize)
      return toolJson(
        fitChunk(doc.content.slice(startAt), input.max_chars, (chunk) => {
          const end = startAt + chunk.length
          return end < byteSize ? answer(chunk, true, end) : answer(chunk, false, null)
        }),
      )
    },
  )

  server.registerTool(
    'list_product_docs',
    {
      title: 'List ProductDocs for a product',
      description:
        'List all ProductDocs in a product, optionally filtered by folder and status. ' +
        'Returns metadata only (no content_md) so agents can browse the index cheaply. ' +
        'Use search_product_docs for full-text queries or get_product_doc to read a doc.',
      inputSchema: listShape,
      annotations: READ_ONLY,
    },
    async (input) => {
      const denied = wrongProduct(input.product_id)
      if (denied) return denied
      const listed = docs
        .filter((d) => (!input.folder || d.folder === input.folder) && (!input.status || input.status === STATUS))
        .map((d) => ({
          uri: uriOf(d),
          folder: d.folder,
          slug: d.slug,
          title: d.title,
          status: STATUS,
          folder_enabled: true,
          updated_at: updatedAt,
          byte_size: d.content.length,
        }))
      return toolJson({ docs: listed, count: listed.length })
    },
  )

  server.registerTool(
    'related_product_docs',
    {
      title: 'Find related ProductDocs via markdown link graph',
      description:
        'For a given doc, returns forward links (docs it mentions) and backward links ' +
        '(docs that reference it). Parses markdown `[text](path.md)` links and resolves ' +
        "them within the product's doc-tree. Broken links are reported separately.",
      inputSchema: relatedShape,
      annotations: READ_ONLY,
    },
    async (input) => {
      const denied = wrongProduct(input.product_id)
      if (denied) return denied
      const source = lookup(input.folder, input.slug)
      if (!source) return docNotFound(input)

      const ref = (doc: Doc, anchor?: string) => ({
        uri: uriOf(doc),
        folder: doc.folder,
        slug: doc.slug,
        title: doc.title,
        ...(anchor ? { anchor } : {}),
      })
      const forward: Array<ReturnType<typeof ref>> = []
      const brokenLinks: string[] = []
      const seen = new Set<string>()
      for (const link of source.links) {
        if (link.key === source.key) continue // a link to the doc itself relates nothing, and is not broken
        const target = link.key ? byKey.get(link.key) : undefined
        if (!target) {
          brokenLinks.push(link.href) // a .md that is not in the set
          continue
        }
        const once = link.anchor ? `${target.key}#${link.anchor}` : target.key
        if (seen.has(once)) continue
        seen.add(once)
        forward.push(ref(target, link.anchor))
      }
      const backward = docs.filter((d) => d !== source && d.links.some((l) => l.key === source.key)).map((d) => ref(d))
      return toolJson({
        source_uri: uriOf(source),
        forward,
        backward,
        broken_links: brokenLinks,
        counts: { forward: forward.length, backward: backward.length, broken: brokenLinks.length },
      })
    },
  )

  return server
}

/** `harness doc-server`: loads the docset and serves it on stdio until the client closes it. Writes nothing to stdout itself. */
export async function runDocServer(opts: { dir: string; productId: string }): Promise<void> {
  const server = createDocServer(loadDocset(opts.dir), opts.productId)
  await server.connect(new StdioServerTransport())
}
