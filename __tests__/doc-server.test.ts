import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDocServer, DocsetError, loadDocset } from '../src/bench/doc-server.js'
import { main } from '../src/cli.js'
import { completion, startFakeModelServer } from './fakes/fake-model-server.js'
import { tmp } from './helpers.js'

// The test docset: three small files in two folders (specs/probe-design, specs/alpha-notes, runbooks/probe-runbook) that
// link to each other. Its words are chosen so the counts below are easy to check by hand: `toolcalling` twice in the spec and
// once in each of the others, `cache` once (spec only), `context` once in the runbook and in the notes, and "rode draad"
// next to each other only in the spec (the runbook has "draad. Rode", the notes have the two words apart).
const DOCSET = fileURLToPath(new URL('./fixtures/docset', import.meta.url))
const CAPTURED = JSON.parse(readFileSync(new URL('./fixtures/scrum4me-doc-tools.schema.json', import.meta.url), 'utf8')) as {
  pin: string
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
}
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const PRODUCT = 'fixture-docs'
const FROZEN_AT = '2026-09-30T19:21:43Z'
const uri = (folder: string, slug: string) => `scrum4me-doc://product/${PRODUCT}/${folder}/${slug}`
const fileText = (folder: string, slug: string) => readFileSync(join(DOCSET, folder, `${slug}.md`), 'utf8')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are inspected ad hoc in tests
type Json = any

const open: Array<{ close(): Promise<void> }> = []
let fake: Awaited<ReturnType<typeof startFakeModelServer>> | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
  for (const o of open.splice(0)) await o.close().catch(() => undefined)
})

/** Writes a docset dir with the given docset.json (an object, or raw text) and files, for tests of their own. */
function docset(json: unknown, files: Record<string, string> = {}): string {
  const dir = tmp('docset')
  writeFileSync(join(dir, 'docset.json'), typeof json === 'string' ? json : JSON.stringify(json))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}
const entry = (folder: string, slug: string) => ({ folder, slug, source_path: `docs/${folder}/${slug}.md`, sha256: 'x', bytes: 1 })
/** A docset from `{ 'folder/slug': 'text' }`. */
const smallDocset = (docs: Record<string, string>) =>
  docset(
    { frozen_at: FROZEN_AT, files: Object.keys(docs).map((key) => entry(...(key.split('/') as [string, string]))) },
    Object.fromEntries(Object.entries(docs).map(([key, text]) => [`${key}.md`, text])),
  )

/** An MCP client on an in-memory link to the doc server; returns a `call(tool, args)` with product_id defaulted. */
async function start(dir = DOCSET) {
  const server = createDocServer(loadDocset(dir), PRODUCT)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'doc-server-test', version: '0.0.0' })
  await client.connect(clientTransport)
  open.push({ close: async () => { await client.close(); await server.close() } })
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: { product_id: PRODUCT, ...args } })) as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
      structuredContent?: unknown
    }
    const text = res.content.map((c) => c.text).join('\n')
    return { isError: res.isError === true, text, json: (res.isError ? undefined : JSON.parse(text)) as Json, structured: res.structuredContent }
  }
  return { client, call }
}

const search = async (args: Record<string, unknown>) => (await start()).call('search_product_docs', args)
const slugsOf = (json: Json): string[] => json.results.map((r: { slug: string }) => r.slug)

describe('tools/list', () => {
  it('is pinned to scrum4me-mcp 285c98ae', () => {
    expect(CAPTURED.pin).toBe('285c98ae3fc670f30f82fb5ca3cb8f92a7739dd8')
  })

  it('offers exactly the four doc tools, each with the description and input schema of the captured copy', async () => {
    const { client } = await start()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['get_product_doc', 'list_product_docs', 'related_product_docs', 'search_product_docs'])
    expect(CAPTURED.tools.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort())
    for (const want of CAPTURED.tools) {
      const got = tools.find((t) => t.name === want.name)
      expect(got?.description, `${want.name} description`).toBe(want.description)
      expect(got?.inputSchema, `${want.name} inputSchema`).toEqual(want.inputSchema)
    }
  })
})

describe('result shapes', () => {
  it('search_product_docs', async () => {
    const { isError, json } = await search({ query: 'cache' })
    expect(isError).toBe(false)
    expect(json).toEqual({
      results: [
        {
          uri: uri('specs', 'probe-design'), folder: 'specs', slug: 'probe-design', title: 'Ontwerp van de probe',
          status: 'active', folder_enabled: true, snippet: 'eigen tijdslimiet en de <<cache>> wordt niet gebruikt bij de',
          score: 1, match_kind: 'fts', updated_at: FROZEN_AT,
        },
      ],
      count: 1,
      query: 'cache',
    })
  })

  it('get_product_doc', async () => {
    const { call } = await start()
    const file = fileText('runbooks', 'probe-runbook')
    const { isError, json, structured } = await call('get_product_doc', { folder: 'runbooks', slug: 'probe-runbook' })
    expect(isError).toBe(false)
    expect(json).toEqual({
      uri: uri('runbooks', 'probe-runbook'), folder: 'runbooks', slug: 'probe-runbook', title: 'Runbook voor de probe',
      status: 'active', folder_enabled: true, content_md: file, byte_size: file.length, truncated: false, next_offset: null,
      updated_at: FROZEN_AT,
    })
    expect(structured).toEqual(json) // like scrum4me-mcp, the object is also sent as structuredContent
  })

  it('list_product_docs: the title is the front matter title, else the first # heading; ordered by folder, then slug', async () => {
    const { call } = await start()
    const { isError, json } = await call('list_product_docs', {})
    expect(isError).toBe(false)
    const doc = (folder: string, slug: string, title: string) => ({
      uri: uri(folder, slug), folder, slug, title, status: 'active', folder_enabled: true, updated_at: FROZEN_AT,
      byte_size: fileText(folder, slug).length,
    })
    expect(json).toEqual({
      docs: [
        doc('runbooks', 'probe-runbook', 'Runbook voor de probe'), // first # heading, no front matter
        doc('specs', 'alpha-notes', 'Alfa-notities'), // unquoted front matter title
        doc('specs', 'probe-design', 'Ontwerp van de probe'), // quoted front matter title wins over "# Probe-ontwerp — kort"
      ],
      count: 3,
    })
  })

  it('list_product_docs filters on folder and status', async () => {
    const { call } = await start()
    expect((await call('list_product_docs', { folder: 'specs' })).json.docs.map((d: { slug: string }) => d.slug)).toEqual(['alpha-notes', 'probe-design'])
    expect((await call('list_product_docs', { folder: 'plans' })).json).toEqual({ docs: [], count: 0 })
    expect((await call('list_product_docs', { status: 'active' })).json.count).toBe(3)
    expect((await call('list_product_docs', { status: 'draft' })).json).toEqual({ docs: [], count: 0 })
  })

  it('related_product_docs: forward with the anchor, backward, and a broken link', async () => {
    const { call } = await start()
    const { isError, json } = await call('related_product_docs', { folder: 'specs', slug: 'probe-design' })
    expect(isError).toBe(false)
    expect(json).toEqual({
      source_uri: uri('specs', 'probe-design'),
      forward: [{ uri: uri('runbooks', 'probe-runbook'), folder: 'runbooks', slug: 'probe-runbook', title: 'Runbook voor de probe', anchor: 'stappen' }],
      backward: [],
      broken_links: ['../plans/probe-plan.md'], // the plans folder is not in the set; the external .md link does not count
      counts: { forward: 1, backward: 0, broken: 1 },
    })
  })

  it('related_product_docs: backward links from both docs that mention the runbook, and the docs/<folder>/<file>.md form', async () => {
    const { call } = await start()
    const runbook = (await call('related_product_docs', { folder: 'runbooks', slug: 'probe-runbook' })).json
    expect(runbook).toEqual({
      source_uri: uri('runbooks', 'probe-runbook'),
      forward: [],
      backward: [
        { uri: uri('specs', 'alpha-notes'), folder: 'specs', slug: 'alpha-notes', title: 'Alfa-notities' }, // [runbook](docs/runbooks/probe-runbook.md)
        { uri: uri('specs', 'probe-design'), folder: 'specs', slug: 'probe-design', title: 'Ontwerp van de probe' }, // [runbook](../runbooks/probe-runbook.md#stappen)
      ],
      broken_links: [],
      counts: { forward: 0, backward: 2, broken: 0 },
    })
    const notes = (await call('related_product_docs', { folder: 'specs', slug: 'alpha-notes' })).json
    expect(notes.forward).toEqual([{ uri: uri('runbooks', 'probe-runbook'), folder: 'runbooks', slug: 'probe-runbook', title: 'Runbook voor de probe' }])
    expect(notes.counts).toEqual({ forward: 1, backward: 0, broken: 0 })
  })

  it('related_product_docs: same-folder links, a repeated link, query strings, and what is no link to a doc', async () => {
    const dir = smallDocset({
      'manual/hoofd': [
        '# Hoofd',
        '',
        'Plain [buur](buur.md), again [buur](./buur.md), with anchors [a](buur.md#a) and [b](buur.md#b), and [a twice](buur.md#a).',
        'A [spec](../specs/spec.md?plain=1), a [missing doc](weg.md), a [missing folder](../adr/kies.md).',
        'Not relations: ![image](plaatje.md), [code](../src/cli.ts), [site](https://example.com/x.md), [mail](mailto:a@b.nl), [top](#hoofd).',
        'A link to the doc itself, [hoofd](hoofd.md#boven), is neither a relation nor broken.',
      ].join('\n'),
      'manual/buur': '# Buur\n',
      'specs/spec': '# Spec\n',
    })
    const { call } = await start(dir)
    const { json } = await call('related_product_docs', { folder: 'manual', slug: 'hoofd' })
    expect(json.forward.map((f: { slug: string; anchor?: string }) => `${f.slug}${f.anchor ? `#${f.anchor}` : ''}`)).toEqual(['buur', 'buur#a', 'buur#b', 'spec'])
    expect(json.broken_links).toEqual(['weg.md', '../adr/kies.md'])
    expect(json.backward).toEqual([])
    expect(json.counts).toEqual({ forward: 4, backward: 0, broken: 2 })
    // The neighbour sees the main doc once, however often it links to it.
    expect((await call('related_product_docs', { folder: 'manual', slug: 'buur' })).json.backward.map((r: { slug: string }) => r.slug)).toEqual(['hoofd'])
  })
})

describe('errors', () => {
  const docArgs = { folder: 'specs', slug: 'probe-design' }
  it.each([
    ['search_product_docs', { query: 'cache' }],
    ['get_product_doc', docArgs],
    ['list_product_docs', {}],
    ['related_product_docs', docArgs],
  ])('%s: another product_id is not found or not accessible', async (tool, args) => {
    const { call } = await start()
    const r = await call(tool, { ...args, product_id: 'other-product' })
    expect(r.isError).toBe(true)
    expect(r.text).toBe("Product 'other-product' not found or not accessible")
  })

  it.each(['get_product_doc', 'related_product_docs'])('%s: an unknown doc', async (tool) => {
    const { call } = await start()
    const r = await call(tool, { folder: 'specs', slug: 'bestaat-niet' })
    expect(r.isError).toBe(true)
    expect(r.text).toBe("Doc 'specs/bestaat-niet' not found in product 'fixture-docs'")
    // A folder with no docs in this set is the same error.
    expect((await call(tool, { folder: 'plans', slug: 'probe-design' })).text).toBe("Doc 'plans/probe-design' not found in product 'fixture-docs'")
  })

  it('get_product_doc: an unknown heading', async () => {
    const { call } = await start()
    const r = await call('get_product_doc', { ...docArgs, heading: 'Bestaat niet' })
    expect(r.isError).toBe(true)
    expect(r.text).toBe("Heading 'Bestaat niet' not found in doc 'specs/probe-design'")
    // The text after the # is what counts, so a heading with its # marks is not found (as in scrum4me-mcp).
    expect((await call('get_product_doc', { ...docArgs, heading: '## Doel' })).text).toBe("Heading '## Doel' not found in doc 'specs/probe-design'")
  })

  it.each(['get_product_doc', 'related_product_docs'])('%s: a slug in capitals is lowercased before the lookup, as in scrum4me-mcp', async (tool) => {
    const { call } = await start()
    const r = await call(tool, { folder: 'runbooks', slug: 'PROBE-Runbook' })
    expect(r.isError).toBe(false)
    if (tool === 'get_product_doc') expect(r.json).toMatchObject({ slug: 'probe-runbook', uri: uri('runbooks', 'probe-runbook') })
    else expect(r.json.source_uri).toBe(uri('runbooks', 'probe-runbook'))
    // The error for an unknown doc names the slug as it was sent.
    expect((await call(tool, { folder: 'runbooks', slug: 'NOPE' })).text).toBe("Doc 'runbooks/NOPE' not found in product 'fixture-docs'")
  })

  // Review Focus 2: a model that copies the file name into the slug gets the error a real Scrum4Me gives, not the doc.
  it.each(['get_product_doc', 'related_product_docs'])('%s: a slug with .md behind it is an unknown doc', async (tool) => {
    const { call } = await start()
    const r = await call(tool, { folder: 'runbooks', slug: 'probe-runbook.md' })
    expect(r.isError).toBe(true)
    expect(r.text).toBe("Doc 'runbooks/probe-runbook.md' not found in product 'fixture-docs'")
  })

  it('a slug that tries to leave the folder is an unknown doc, not a file read', async () => {
    const { call } = await start()
    const r = await call('get_product_doc', { folder: 'specs', slug: '../runbooks/probe-runbook' })
    expect(r).toMatchObject({ isError: true, text: "Doc 'specs/../runbooks/probe-runbook' not found in product 'fixture-docs'" })
  })

  it('input that breaks the schema is refused by the server', async () => {
    const { call } = await start()
    expect((await call('search_product_docs', { query: 'x' })).isError).toBe(true) // min length 2
    expect((await call('get_product_doc', { ...docArgs, max_chars: 499 })).isError).toBe(true)
    expect((await call('list_product_docs', { folder: 'nonsense' })).isError).toBe(true)
  })
})

describe('get_product_doc: paging and headings', () => {
  const design = { folder: 'specs', slug: 'probe-design' }

  it('pages with offset and max_chars; truncated and next_offset follow, and the pieces together are the whole file', async () => {
    const { call } = await start()
    const file = fileText('specs', 'probe-design')
    // The premise of byte_size: the file has a character of more than one byte, and the size is counted in characters.
    expect(Buffer.byteLength(file)).toBeGreaterThan(file.length)

    const pieces: string[] = []
    let offset = 0
    for (let page = 0; page < 10; page++) {
      const { json } = await call('get_product_doc', { ...design, max_chars: 500, offset })
      expect(json.byte_size).toBe(file.length)
      pieces.push(json.content_md)
      if (!json.truncated) {
        expect(json.next_offset).toBeNull()
        break
      }
      expect(json.content_md).toHaveLength(500)
      expect(json.next_offset).toBe(offset + 500)
      offset = json.next_offset
    }
    expect(pieces).toHaveLength(3) // 1079 characters in pages of 500
    expect(pieces.join('')).toBe(file)
  })

  it('returns the whole file with truncated false at the default max_chars, and nothing past the end', async () => {
    const { call } = await start()
    const file = fileText('specs', 'probe-design')
    expect((await call('get_product_doc', design)).json).toMatchObject({ content_md: file, truncated: false, next_offset: null })
    const past = (await call('get_product_doc', { ...design, offset: file.length + 100 })).json
    expect(past).toMatchObject({ content_md: '', truncated: false, next_offset: null, byte_size: file.length })
  })

  it('heading gives the section up to the next heading of the same or a higher level', async () => {
    const { call } = await start()
    const file = fileText('specs', 'probe-design')

    // "## Doel" holds "### Detail": a lower level does not end it. It ends at "## Aanpak".
    const doel = (await call('get_product_doc', { ...design, heading: 'Doel' })).json
    expect(doel.content_md).toBe(file.slice(file.indexOf('## Doel'), file.indexOf('## Aanpak')).replace(/\n$/, ''))
    expect(doel.content_md).toContain('### Detail')
    expect(doel.content_md).not.toContain('## Aanpak')
    expect(doel).toMatchObject({ truncated: false, next_offset: null, byte_size: file.length })

    // Case-insensitive, and a level-3 heading ends at the next heading of level 3 or higher: the "## Aanpak" after it.
    const detail = (await call('get_product_doc', { ...design, heading: 'detail' })).json
    expect(detail.content_md).toBe('### Detail\n\nElke stap heeft een eigen tijdslimiet en de cache wordt niet gebruikt bij de eerste aanvraag.\n')
  })

  it('heading on the last section runs to the end of the file; one longer than max_chars is cut without a next_offset', async () => {
    const { call } = await start()
    const file = fileText('specs', 'probe-design')
    const aanpak = (await call('get_product_doc', { ...design, heading: '  AANPAK ' })).json
    expect(aanpak.content_md).toBe(file.slice(file.indexOf('## Aanpak')))
    expect(aanpak.truncated).toBe(false)

    // Like scrum4me-mcp: a section is cut at max_chars and flagged truncated, but there is no next_offset to continue from.
    const cut = (await call('get_product_doc', { ...design, heading: 'Aanpak', max_chars: 500 })).json
    expect(cut.content_md).toBe(aanpak.content_md.slice(0, 500))
    expect(cut).toMatchObject({ truncated: true, next_offset: null })
  })
})

describe('search_product_docs', () => {
  it('counts hits in title, slug and content; the higher score first, and equal scores by slug', async () => {
    const { json } = await search({ query: 'toolcalling' })
    expect(json.results.map((r: { slug: string; score: number }) => [r.slug, r.score])).toEqual([
      ['probe-design', 2],
      ['alpha-notes', 1], // equal scores: slug order ("alpha-notes" < "probe-runbook"), although folder order would put the runbook first
      ['probe-runbook', 1],
    ])
    expect(json.count).toBe(3)
    // "ontwerp" is in the title once and twice in the file (the front matter title and "# Probe-ontwerp"), "alpha" only in a slug.
    expect(slugsOf((await search({ query: 'ontwerp' })).json)).toEqual(['probe-design'])
    expect((await search({ query: 'ontwerp' })).json.results[0].score).toBe(3)
    const alpha = (await search({ query: 'alpha' })).json
    expect(slugsOf(alpha)).toEqual(['alpha-notes'])
    expect(alpha.results[0].score).toBe(1)
    expect(alpha.results[0].snippet).not.toContain('<<') // no hit in the text: the snippet is just its opening words
  })

  it('matches whole words, in lower case', async () => {
    expect((await search({ query: 'toolcall' })).json.count).toBe(0) // the start of a word is not the word
    expect((await search({ query: 'TOOLCALLING' })).json.count).toBe(3)
    // "tool" is a word in "dummy-tool" (twice in the spec, once in the runbook), not in "tools".
    expect((await search({ query: 'tool' })).json.results.map((r: { slug: string; score: number }) => [r.slug, r.score])).toEqual([
      ['probe-design', 2],
      ['probe-runbook', 1],
    ])
  })

  it('needs every term: two terms together', async () => {
    const { json } = await search({ query: 'toolcalling cache' })
    expect(json.results.map((r: { slug: string; score: number }) => [r.slug, r.score])).toEqual([['probe-design', 3]]) // 2 + 1
    expect((await search({ query: 'cache context' })).json.count).toBe(0) // no doc has both
  })

  it('OR between two terms asks for either', async () => {
    const { json } = await search({ query: 'cache OR context' })
    expect(json.results.map((r: { slug: string; score: number }) => [r.slug, r.score])).toEqual([
      ['alpha-notes', 1],
      ['probe-design', 1],
      ['probe-runbook', 1],
    ])
    expect(slugsOf((await search({ query: 'cache or context' })).json)).toEqual(['alpha-notes', 'probe-design', 'probe-runbook'])
    // OR joins the two terms next to it ("toolcalling OR context"); the other terms still all have to be there. Only the
    // spec has "cache", so the notes and the runbook, which match the OR part alone, are out.
    expect(slugsOf((await search({ query: 'cache toolcalling OR context' })).json)).toEqual(['probe-design'])
    // A chain of ORs is one group: "context" and one of the three after it.
    expect(slugsOf((await search({ query: 'context rode OR draad OR cache' })).json)).toEqual(['alpha-notes', 'probe-runbook'])
    // What comes after the group is a term of its own again: "rode" or "context", and also "cache".
    expect(slugsOf((await search({ query: 'context OR rode cache' })).json)).toEqual(['probe-design'])
  })

  it('-term leaves out the docs that have it', async () => {
    expect(slugsOf((await search({ query: 'toolcalling -cache' })).json)).toEqual(['alpha-notes', 'probe-runbook'])
    expect(slugsOf((await search({ query: 'toolcalling -"rode draad"' })).json)).toEqual(['alpha-notes', 'probe-runbook'])
    // Only exclusions: nothing to hit.
    expect((await search({ query: '-cache' })).json).toEqual({ results: [], count: 0, query: '-cache' })
  })

  it('a phrase in quotes asks for the words next to each other, in that order', async () => {
    const quoted = (await search({ query: '"rode draad"' })).json
    expect(quoted.results.map((r: { slug: string; score: number }) => [r.slug, r.score])).toEqual([['probe-design', 1]])
    expect(quoted.results[0].snippet).toContain('<<rode draad>>')
    // Without the quotes it is two terms: all three docs have both words (the runbook has them the other way round).
    expect(slugsOf((await search({ query: 'rode draad' })).json)).toEqual(['alpha-notes', 'probe-design', 'probe-runbook'])
    // Punctuation between the words does not matter: the runbook has "draad. Rode".
    expect(slugsOf((await search({ query: '"draad rode"' })).json)).toEqual(['probe-runbook'])
    expect(slugsOf((await search({ query: '"draad rode" OR "rode draad"' })).json)).toEqual(['probe-design', 'probe-runbook'])
  })

  it('folder filters, and limit cuts after the ordering', async () => {
    expect(slugsOf((await search({ query: 'toolcalling', folder: 'runbooks' })).json)).toEqual(['probe-runbook'])
    expect(slugsOf((await search({ query: 'toolcalling', folder: 'specs' })).json)).toEqual(['probe-design', 'alpha-notes'])
    expect((await search({ query: 'toolcalling', folder: 'plans' })).json.count).toBe(0)
    const one = (await search({ query: 'toolcalling', limit: 1 })).json
    expect(slugsOf(one)).toEqual(['probe-design'])
    expect(one.count).toBe(1) // the count of what is returned, as in scrum4me-mcp
    expect(slugsOf((await search({ query: 'toolcalling', limit: 2 })).json)).toEqual(['probe-design', 'alpha-notes'])
  })

  it('the snippet is ten words around the first hit, with << and >> around the hit', async () => {
    const { json } = await search({ query: 'toolcalling' })
    const snippets = Object.fromEntries(json.results.map((r: { slug: string; snippet: string }) => [r.slug, r.snippet]))
    // The first hit in the spec is in its opening paragraph: four words before it, five after.
    expect(snippets['probe-design']).toBe('kort De probe test <<toolcalling>> van een model. De stappen')
    for (const snippet of Object.values(snippets) as string[]) {
      expect(snippet.match(/<<[^>]*>>/g)).toHaveLength(1)
      expect(snippet.replace(/<<|>>/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)).toHaveLength(10)
    }
  })

  it('keeps the four words before the hit where there are, and shifts the window back at the end of a doc', async () => {
    const { json } = await search({ query: 'stappen' })
    const notes = json.results.find((r: { slug: string }) => r.slug === 'alpha-notes')
    expect(notes.snippet).toBe('het [runbook](docs/runbooks/probe-runbook.md) voor de <<stappen>>') // the last word of the doc: nine words before it
  })

  it('reads odd queries without failing', async () => {
    expect(slugsOf((await search({ query: 'cache OR' })).json)).toEqual(['probe-design']) // a dangling OR joins nothing
    expect(slugsOf((await search({ query: 'OR cache' })).json)).toEqual(['probe-design'])
    expect(slugsOf((await search({ query: '"rode draad' })).json)).toEqual(['probe-design']) // the quote runs to the end
    expect((await search({ query: '!!' })).json).toEqual({ results: [], count: 0, query: '!!' }) // no word in it
    expect(slugsOf((await search({ query: '(cache OR context)' })).json)).toEqual(['alpha-notes', 'probe-design', 'probe-runbook'])
    // A term with punctuation inside asks for its words next to each other, as in the text it is matched against.
    expect(slugsOf((await search({ query: 'dummy-tool' })).json)).toEqual(['probe-design', 'probe-runbook'])
    expect((await search({ query: 'tool-dummy' })).json.count).toBe(0)
  })

  it('accepts include_archived and include_disabled: every doc here is active and its folder enabled', async () => {
    const { json } = await search({ query: 'cache', include_archived: true, include_disabled: true })
    expect(json.count).toBe(1)
  })
})

describe('loadDocset', () => {
  it('reads the fixture', () => {
    const set = loadDocset(DOCSET)
    expect(set.frozenAt).toBe(FROZEN_AT)
    expect(set.docs.map((d) => `${d.folder}/${d.slug}`)).toEqual(['runbooks/probe-runbook', 'specs/alpha-notes', 'specs/probe-design'])
  })

  it.each([
    ['a double-quoted title with escapes', '---\ntitle: "Met \\"aanhalingstekens\\""\n---\n# Kop\n', 'Met "aanhalingstekens"'],
    ['a single-quoted title', "---\ntitle: 'Het ''werkt'''\n---\n# Kop\n", "Het 'werkt'"],
    ['an unquoted title with colon inside', '---\ntitle: Deel 1: begin\n---\n# Kop\n', 'Deel 1: begin'],
    ['Windows line endings', '---\r\ntitle: "Met CRLF"\r\nstatus: active\r\n---\r\n\r\n# Kop\r\n', 'Met CRLF'],
    ['front matter without a title: the first # heading after it', '---\nstatus: active\n---\n\n## Niet deze\n\n# Deze kop \n', 'Deze kop'],
    ['a # comment in the front matter is not a heading', '---\n# commentaar\nstatus: active\n---\nAlleen tekst.\n', 'kaal'],
    ['no front matter and no # heading', 'Alleen tekst.\n\n## Geen h1\n', 'kaal'],
    ['a "---" line later in the doc is no front matter', '# Kop\n\n---\ntitle: Niet dit\n---\n', 'Kop'],
  ])('title: %s', (_label, text, title) => {
    const dir = smallDocset({ 'manual/kaal': text })
    expect(loadDocset(dir).docs[0].title).toBe(title)
  })

  it.each([
    ['no docset.json', () => tmp('docset'), /docset\.json/],
    ['a docset.json that is not JSON', () => docset('{ nope'), /docset\.json/],
    ['no files', () => docset({ frozen_at: FROZEN_AT, files: [] }), /files/],
    ['a folder that is not one of the doc folders', () => docset({ frozen_at: FROZEN_AT, files: [entry('notes', 'a')] }, { 'notes/a.md': '# A' }), /folder/],
    ['a slug with a path separator', () => docset({ frozen_at: FROZEN_AT, files: [entry('specs', '../x')] }, { 'x.md': '# X' }), /slug/],
    ['a slug in capitals, which a lookup in lower case could never find', () => docset({ frozen_at: FROZEN_AT, files: [entry('specs', 'Readme')] }, { 'specs/Readme.md': '# R' }), /slug/],
    ['a slug longer than the 80 characters a tool call may name', () => docset({ frozen_at: FROZEN_AT, files: [entry('specs', 'a'.repeat(81))] }, { [`specs/${'a'.repeat(81)}.md`]: '# A' }), /slug/],
    ['the same doc twice', () => docset({ frozen_at: FROZEN_AT, files: [entry('specs', 'a'), entry('specs', 'a')] }, { 'specs/a.md': '# A' }), /specs\/a/],
    ['a file that is missing', () => docset({ frozen_at: FROZEN_AT, files: [entry('specs', 'a')] }), /specs[/\\]a\.md/],
    ['no frozen_at', () => docset({ files: [entry('specs', 'a')] }, { 'specs/a.md': '# A' }), /frozen_at/],
  ])('refuses %s with a DocsetError that names the problem', (_label, make, message) => {
    const dir = make()
    expect(() => loadDocset(dir)).toThrow(DocsetError)
    expect(() => loadDocset(dir)).toThrow(message)
  })
})

describe('harness doc-server', () => {
  async function runMain(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const code = await main(args)
      // Read the calls before mockRestore, which resets them.
      return { code, stdout: out.mock.calls.map((c) => String(c[0])).join(''), stderr: err.mock.calls.map((c) => String(c[0])).join('') }
    } finally {
      out.mockRestore()
      err.mockRestore()
    }
  }

  it('is in the usage text', async () => {
    const { code, stdout } = await runMain(['--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('harness doc-server --dir <docset-dir> --product-id <id>')
  })

  it.each([
    ['--dir', ['doc-server', '--product-id', PRODUCT]],
    ['--product-id', ['doc-server', '--dir', DOCSET]],
  ])('needs %s', async (flag, args) => {
    const { code, stdout, stderr } = await runMain(args)
    expect(code).toBe(1)
    expect(stderr).toContain(`doc-server needs ${flag}`)
    expect(stderr).toContain('Usage:')
    expect(stdout).toBe('') // stdout belongs to the MCP protocol
  })

  it('exits 1 with a one-line message when the docset cannot be read', async () => {
    const dir = tmp('docset')
    const { code, stdout, stderr } = await runMain(['doc-server', '--dir', dir, '--product-id', PRODUCT])
    expect(code).toBe(1)
    expect(stderr).toContain(join(dir, 'docset.json'))
    expect(stderr).not.toContain('Usage:')
    expect(stdout).toBe('')
  })

  // The controller ruling for this task: --skip-probe, because without a probe.json a tools run is refused and this test is
  // about the wiring. The server is the real `harness doc-server`, started the way the comparison runner starts it.
  it('serves a harness run with profile tools: one get_product_doc call, and the tool output holds the file', async () => {
    const args = { product_id: PRODUCT, folder: 'runbooks', slug: 'probe-runbook' }
    fake = await startFakeModelServer([
      { body: completion({ toolCalls: [{ id: 'c1', name: 'get_product_doc', arguments: JSON.stringify(args) }] }) },
      { body: completion({ content: 'klaar' }) },
    ])
    const dir = tmp('doc-server-run')
    const manifest = join(dir, 'run.json')
    writeFileSync(manifest, JSON.stringify({
      id: 'doc-server-run', profile: 'tools', prompt: 'Lees het runbook.',
      model: { baseUrl: fake.baseUrl, name: 'm' },
      tools: {
        server: { command: process.execPath, args: ['--import', 'tsx', CLI, 'doc-server', '--dir', DOCSET, '--product-id', PRODUCT] },
        allow: ['get_product_doc'],
      },
      limits: { maxTurns: 3, maxOutputTokens: 256, maxWallSeconds: 60, maxToolErrors: 1 },
    }))
    const out = join(dir, 'runs')

    const { code, stdout } = await runMain(['run', manifest, '--out', out, '--skip-probe'])

    expect(stdout).toMatch(/^completed /)
    expect(code).toBe(0)
    const runDir = join(out, 'doc-server-run')
    const result = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'))
    expect(result).toMatchObject({ status: 'completed', answer: 'klaar', usage: { toolCalls: 1, toolErrors: 0 } })
    const toolOutput = JSON.parse(readFileSync(join(runDir, 'tools', 'c1.txt'), 'utf8'))
    expect(toolOutput).toMatchObject({ slug: 'probe-runbook', title: 'Runbook voor de probe', truncated: false })
    expect(toolOutput.content_md).toBe(fileText('runbooks', 'probe-runbook'))
    // The model was offered the tool as scrum4me-mcp defines it: the captured name, description and input schema.
    const want = CAPTURED.tools.find((t) => t.name === 'get_product_doc')!
    expect(fake.requests[0].body.tools).toEqual([{ type: 'function', function: { name: want.name, description: want.description, parameters: want.inputSchema } }])
    // And it read the file through the tool message of the second request.
    const toolMessage = fake.requests[1].body.messages.find((m: { role: string }) => m.role === 'tool')
    expect(JSON.parse(JSON.parse(toolMessage.content).content).content_md).toBe(fileText('runbooks', 'probe-runbook'))
  }, 30_000)
})
