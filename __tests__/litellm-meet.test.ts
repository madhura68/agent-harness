import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as meet from '../deploy/max2/litellm/meet.mjs'
import { allFiles, dirContains, leakedFragments, tmp } from './helpers.js'

// deploy/max2/litellm/meet.mjs, mode `meet` (M45 increment 1, T-2018), against a local node:http stub that plays LiteLLM.
// The script runs as a child process, because its exit code, stdout and files are the contract; its exported pure functions
// get focused unit tests at the end. The key values are obviously fake. The six numbered blocks are the brief's red tests.

const SCRIPT = fileURLToPath(new URL('../deploy/max2/litellm/meet.mjs', import.meta.url))
// No hex-only stretches in the keys: the random hex of a canary string must never contain a fragment of them.
const KEY = 'sk-test-master-ghijklmnopqrstuv'
const OR_KEY = 'sk-or-test-wxyzghijklmnopqr'
const ANTWOORD = 'ANTWOORD-MARKER-pong' // the content of every stub answer: it must never reach an output file
const DENK = 'DENK-MARKER-thinking-out-loud' // the stub's thinking text: only its length may be recorded

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON is inspected ad hoc in tests
type Json = any
type Verzoek = { n: number; methode: string; pad: string; authorization: string | undefined; body: Json }
type Stuur = { status?: number; headers?: Record<string, string>; body?: unknown; vertraging?: number; verbreek?: 'voor' | 'midden' }
type Handler = (v: Verzoek) => Stuur | undefined
type Stub = Awaited<ReturnType<typeof startStub>>

const stubs: Array<{ close: () => Promise<void> }> = []
const mappen: string[] = []

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((s) => s.close()))
  for (const map of mappen.splice(0)) rmSync(map, { recursive: true, force: true }) // only the directories this file made
})

function nieuweMap(): string {
  const map = tmp('meet')
  mappen.push(map)
  return map
}

// ---- the stub ----

/** Which of the five thinking forms a request asked for (1 = no field). */
function vormVan(body: Json): number {
  if (body?.reasoning_effort === 'none') return 2
  if (body?.reasoning?.effort === 'none') return 3
  if (body?.reasoning_effort === 'medium') return 4
  if (body?.reasoning?.effort === 'medium') return 5
  return 1
}

/** The form-specific fields of a chat body: everything but model, messages and max_tokens. */
function extraVan(body: Json): Record<string, unknown> {
  const { model: _model, messages: _messages, max_tokens: _maxTokens, ...rest } = body
  return rest
}

type Voltooiing = { tokens?: number | null; finish?: string; denk?: Record<string, unknown>; kosten?: number; provider?: string; id?: string }

/** A chat completion as LiteLLM returns it. tokens: null leaves completion_tokens_details out of usage. */
function voltooiing(o: Voltooiing = {}): Json {
  const usage: Record<string, unknown> = { prompt_tokens: 18, completion_tokens: 3, total_tokens: 21 }
  if (o.tokens !== null) usage.completion_tokens_details = { reasoning_tokens: o.tokens ?? 0 }
  if (o.kosten !== undefined) usage.cost = o.kosten
  return {
    id: o.id ?? 'chatcmpl-test',
    object: 'chat.completion',
    ...(o.provider === undefined ? {} : { provider: o.provider }),
    choices: [{ index: 0, finish_reason: o.finish ?? 'stop', message: { role: 'assistant', content: ANTWOORD, ...o.denk } }],
    usage,
  }
}

/** What LiteLLM does when nothing special is set up: hosted answers think unless asked not to (forms 2 and 3). */
function standaard(v: Verzoek): Stuur {
  if (v.pad === '/health/readiness') {
    return { body: { status: 'healthy', db: 'Not connected', cache: null, litellm_version: '1.83.3', success_callbacks: [] } }
  }
  if (v.pad === '/v1/models') {
    // Deliberately not sorted.
    return { body: { object: 'list', data: [{ id: 'qwen3.8-or' }, { id: 'gsq-lokaal' }, { id: 'qwen3.8-or-neg' }] } }
  }
  const model = v.body?.model
  if (model === 'gsq-lokaal') return { headers: { 'x-litellm-response-cost': '0.0' }, body: voltooiing() }
  if (model === 'qwen3.8-or') {
    const vorm = vormVan(v.body)
    const uit = vorm === 2 || vorm === 3
    return {
      headers: { 'x-litellm-response-cost': '0.00015', 'llm_provider-x-litellm-response-cost': '0.00012' },
      body: voltooiing({ tokens: uit ? 0 : 30, denk: uit ? undefined : { reasoning_content: DENK }, kosten: 0.00012, provider: 'TestProvider', id: `gen-test-${v.n}` }),
    }
  }
  return { status: 404, body: { error: { message: 'No allowed providers are available for the selected model.', code: 404 } } }
}

/** Per thinking form, the answer of the hosted model; any other request gets the default answer. */
function perVorm(vormen: Record<number, Voltooiing | Stuur>): Handler {
  return (v) => {
    if (v.body?.model !== 'qwen3.8-or' || v.body.max_tokens !== 256) return undefined
    const keuze = vormen[vormVan(v.body)]
    if (keuze === undefined) return undefined
    return 'status' in keuze || 'body' in keuze || 'headers' in keuze ? (keuze as Stuur) : { body: voltooiing(keuze as Voltooiing) }
  }
}

function stuurAntwoord(res: ServerResponse, s: Stuur): void {
  const verstuur = () => {
    if (res.destroyed || res.socket?.destroyed) return
    if (s.verbreek === 'voor') {
      res.socket?.destroy()
      return
    }
    const tekst = typeof s.body === 'string' ? s.body : JSON.stringify(s.body ?? {})
    if (s.verbreek === 'midden') {
      res.writeHead(s.status ?? 200, { 'content-type': 'application/json', 'content-length': String(tekst.length + 100) })
      res.write(tekst.slice(0, 10))
      setTimeout(() => res.socket?.destroy(), 20)
      return
    }
    res.writeHead(s.status ?? 200, { 'content-type': 'application/json', ...s.headers })
    res.end(tekst)
  }
  if (s.vertraging) setTimeout(verstuur, s.vertraging).unref()
  else verstuur()
}

async function startStub(handler: Handler = () => undefined) {
  const verzoeken: Verzoek[] = []
  const server = createServer((req, res) => {
    const stukken: Buffer[] = []
    req.on('data', (c: Buffer) => stukken.push(c))
    req.on('end', () => {
      const ruw = Buffer.concat(stukken).toString('utf8')
      let body: Json = null
      try {
        body = ruw ? JSON.parse(ruw) : null
      } catch {
        // not JSON: stays null
      }
      const v: Verzoek = { n: verzoeken.length + 1, methode: req.method ?? '', pad: req.url ?? '', authorization: req.headers.authorization, body }
      verzoeken.push(v)
      stuurAntwoord(res, handler(v) ?? standaard(v))
    })
  })
  await new Promise<void>((klaar) => server.listen(0, '127.0.0.1', klaar))
  const { port } = server.address() as AddressInfo
  const stub = {
    url: `http://127.0.0.1:${port}`,
    verzoeken,
    chat: () => verzoeken.filter((v) => v.pad === '/v1/chat/completions'),
    close: () =>
      new Promise<void>((klaar) => {
        server.closeAllConnections()
        server.close(() => klaar())
      }),
  }
  stubs.push(stub)
  return stub
}

// ---- running the script ----

type Uitslag = { code: number; stdout: string; stderr: string }

function draai(args: string[], env: Record<string, string>, script = SCRIPT, cwd?: string): Promise<Uitslag> {
  return new Promise((klaar) => {
    execFile(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : -1) : 0
      klaar({ code, stdout, stderr })
    })
  })
}

/** `meet` against the stub, with the master key in the environment (env replaces that default when given). */
function draaiMeet(stub: Stub, out: string, o: { env?: Record<string, string>; baseUrl?: string; timeoutSec?: string } = {}): Promise<Uitslag> {
  const args = ['meet', '--base-url', o.baseUrl ?? stub.url, '--out', out, '--timeout-sec', o.timeoutSec ?? '5']
  return draai(args, o.env ?? { LITELLM_MASTER_KEY: KEY })
}

function lees(out: string, naam = 'meting.json'): Json {
  return JSON.parse(readFileSync(join(out, naam), 'utf8'))
}

/** Every key name anywhere in a JSON value. */
function sleutelsIn(waarde: unknown, uit: string[] = []): string[] {
  if (Array.isArray(waarde)) waarde.forEach((w) => sleutelsIn(w, uit))
  else if (waarde !== null && typeof waarde === 'object') {
    for (const [k, w] of Object.entries(waarde)) {
      uit.push(k)
      sleutelsIn(w, uit)
    }
  }
  return uit
}

const sorted = (o: object): string[] => Object.keys(o).sort()

// ---- test 1 ----

describe('test 1: a missing precondition is exit 2, before any request', () => {
  it.each([
    ['LITELLM_MASTER_KEY is not set', {}],
    ['LITELLM_MASTER_KEY is empty', { LITELLM_MASTER_KEY: '' }],
    ['LITELLM_MASTER_KEY holds characters that cannot go in a header', { LITELLM_MASTER_KEY: 'sk bad key\n' }],
  ])('%s', async (_naam, env) => {
    const stub = await startStub()
    const out = nieuweMap()
    const r = await draaiMeet(stub, out, { env })
    expect(r.code).toBe(2)
    expect(stub.verzoeken).toHaveLength(0)
    expect(readdirSync(out)).toEqual([])
    expect(r.stderr).toContain('LITELLM_MASTER_KEY')
    expect(r.stderr).not.toContain('bad key')
    expect(r.stdout).toBe('')
  })

  it.each([
    ['no mode', []],
    ['an unknown mode', ['bogus']],
    ['no --base-url', ['meet', '--out', '<out>']],
    ['no --out', ['meet', '--base-url', '<url>']],
    ['an unknown option', ['meet', '--base-url', '<url>', '--out', '<out>', '--bogus']],
    ['a base url that is not http(s)', ['meet', '--base-url', 'ftp://127.0.0.1:4000', '--out', '<out>']],
    ['a base url that is no url at all', ['meet', '--base-url', 'niet een url', '--out', '<out>']],
    ['a --timeout-sec that is not a number', ['meet', '--base-url', '<url>', '--out', '<out>', '--timeout-sec', 'abc']],
    ['a --timeout-sec of 0', ['meet', '--base-url', '<url>', '--out', '<out>', '--timeout-sec', '0']],
    ['a negative --timeout-sec', ['meet', '--base-url', '<url>', '--out', '<out>', '--timeout-sec', '-5']],
  ])('%s prints the usage and exits 2', async (_naam, args) => {
    const stub = await startStub()
    const out = nieuweMap()
    const echt = args.map((a) => (a === '<url>' ? stub.url : a === '<out>' ? out : a))
    const r = await draai(echt, { LITELLM_MASTER_KEY: KEY })
    expect(r.code).toBe(2)
    expect(stub.verzoeken).toHaveLength(0)
    expect(readdirSync(out)).toEqual([])
    expect(r.stderr).toContain('Gebruik')
    expect(r.stdout).toBe('')
  })

  it('treats an empty --out as missing, and writes nothing in the working directory', async () => {
    const stub = await startStub()
    const cwd = nieuweMap()
    const r = await draai(['meet', '--base-url', stub.url, '--out', ''], { LITELLM_MASTER_KEY: KEY }, SCRIPT, cwd)
    expect(r.code).toBe(2)
    expect(stub.verzoeken).toHaveLength(0)
    expect(readdirSync(cwd)).toEqual([])
    expect(r.stderr).toContain('--out')
  })

  it('also runs when it is started through a symlink (an import.meta.url comparison without realpath would exit 0 silently)', async () => {
    const map = nieuweMap()
    const link = join(map, 'meet.mjs')
    symlinkSync(SCRIPT, link)
    const r = await draai(['bogus'], {}, link)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Gebruik')
  })
})

// ---- test 2 ----

/** A 500 body that echoes the request's Authorization header: the OpenRouter key starts at character 100, the master key at 190. */
function echoBody(authorization: string | undefined): string {
  const kop = '{"error":{"message":"'
  const deel1 = kop + '.'.repeat(100 - kop.length) + OR_KEY
  const deel2 = deel1 + '.'.repeat(190 - 'Bearer '.length - deel1.length) + (authorization ?? 'Bearer none')
  const tekst = `${deel2} ${'tail '.repeat(40)}"}}`
  if (authorization !== undefined && tekst.indexOf(KEY) !== 190) throw new Error(`master key starts at ${tekst.indexOf(KEY)}, expected 190`)
  return tekst
}

describe('test 2: a key that a response echoes does not appear in any output', () => {
  it('masks the keys before the excerpt is cut, in stdout, stderr and every file', async () => {
    const stub = await startStub((v) => ({ status: 500, body: echoBody(v.authorization) }))
    const out = nieuweMap()
    const r = await draaiMeet(stub, out, { env: { LITELLM_MASTER_KEY: KEY, OPENROUTER_API_KEY: OR_KEY } })

    expect(r.code).toBe(0) // a 5xx answer is an answer
    expect(stub.chat()[0].authorization).toBe(`Bearer ${KEY}`) // the script did send the key, in the header only
    const teksten: Record<string, string> = { stdout: r.stdout, stderr: r.stderr }
    for (const bestand of allFiles(out)) teksten[bestand] = readFileSync(bestand, 'utf8')
    expect(Object.keys(teksten).length).toBeGreaterThan(3)
    for (const [waar, tekst] of Object.entries(teksten)) {
      expect(leakedFragments(tekst, KEY), `${waar} holds part of the master key`).toEqual([])
      expect(leakedFragments(tekst, OR_KEY), `${waar} holds part of the OpenRouter key`).toEqual([])
    }
    expect(dirContains(out, KEY)).toBe(false)
    expect(dirContains(out, OR_KEY)).toBe(false)

    const kaal = lees(out).negative[0]
    expect(kaal.http_status).toBe(500)
    expect(kaal.excerpt).toContain('<redacted>') // masked, not dropped
    expect(kaal.excerpt.length).toBeLessThanOrEqual(200)
    expect(kaal.excerpt.startsWith('{"error":{"message":"....')).toBe(true)
  })

  it('also masks a key that turns up in an id, a provider or a header, not only in an excerpt', async () => {
    const stub = await startStub((v) =>
      v.body?.model === 'qwen3.8-or'
        ? { headers: { 'x-litellm-response-cost': KEY }, body: voltooiing({ provider: `P-${KEY}`, id: `gen-${KEY}` }) }
        : undefined,
    )
    const out = nieuweMap()
    const r = await draaiMeet(stub, out)
    expect(r.code).toBe(0)
    for (const tekst of [r.stdout, r.stderr, ...allFiles(out).map((f) => readFileSync(f, 'utf8'))]) expect(leakedFragments(tekst, KEY)).toEqual([])
    expect(lees(out).cost[0]).toMatchObject({ kosten_header: '<redacted>', provider: 'P-<redacted>', id: 'gen-<redacted>', bedrag: null, bron: 'none' })
  })

  it('does not put the key on the readiness request', async () => {
    const stub = await startStub()
    await draaiMeet(stub, nieuweMap())
    expect(stub.verzoeken[0].pad).toBe('/health/readiness')
    expect(stub.verzoeken[0].authorization).toBeUndefined()
    for (const v of stub.verzoeken.slice(1)) expect(v.authorization).toBe(`Bearer ${KEY}`)
  })
})

// ---- test 3 ----

describe('test 3: every step records exactly its fields, and no message content', () => {
  it('writes the table fields per step and nothing else', async () => {
    // The uit-vorm variant of the negative control answers 200 here, so both shapes of a negative entry are seen.
    const stub = await startStub((v) =>
      v.body?.model === 'qwen3.8-or-neg' && v.body.reasoning_effort === 'none' ? { body: voltooiing({ id: 'gen-neg-200', provider: 'NegProvider' }) } : undefined,
    )
    const out = nieuweMap()
    const r = await draaiMeet(stub, out)
    expect(r.code).toBe(0)

    const meting = lees(out)
    expect(sorted(meting)).toEqual(['bridge', 'canary', 'cost', 'denkstand', 'models', 'negative', 'readiness', 'reasoning'])
    expect(meting.readiness).toEqual({ http_status: 200, status: 'healthy', db: 'Not connected', litellm_version: '1.83.3' })
    expect(meting.models).toEqual({ http_status: 200, ids: ['gsq-lokaal', 'qwen3.8-or', 'qwen3.8-or-neg'] }) // sorted
    expect(meting.bridge).toEqual({
      http_status: 200,
      usage: { prompt_tokens: 18, completion_tokens: 3, total_tokens: 21, completion_tokens_details: { reasoning_tokens: 0 } },
      kosten_header: '0.0',
      provider_kosten_header: null,
      body_usage_cost: null,
    })

    expect(meting.reasoning).toHaveLength(5)
    meting.reasoning.forEach((regel: Json, i: number) => {
      expect(sorted(regel)).toEqual(['denktekst_lengte', 'denktekst_velden', 'finish_reason', 'http_status', 'reasoning_tokens', 'stand', 'vorm'])
      expect(regel.vorm).toBe(i + 1)
    })
    expect(meting.reasoning[0]).toEqual({ vorm: 1, http_status: 200, finish_reason: 'stop', reasoning_tokens: 30, denktekst_velden: ['reasoning_content'], denktekst_lengte: DENK.length, stand: 'aan' })
    expect(meting.reasoning[1]).toEqual({ vorm: 2, http_status: 200, finish_reason: 'stop', reasoning_tokens: 0, denktekst_velden: [], denktekst_lengte: 0, stand: 'uit' })
    expect(meting.denkstand).toEqual({ uit_vorm: 2, aan_vorm: 4 })

    expect(meting.cost).toHaveLength(6) // the five reasoning answers and the hosted canary answer
    const kostenSleutels = ['bedrag', 'body_usage_cost', 'bron', 'http_status', 'id', 'kosten_header', 'model', 'provider', 'provider_kosten_header', 'stap', 'tijd']
    meting.cost.forEach((regel: Json, i: number) => {
      expect(regel.model).toBe('qwen3.8-or')
      if (i < 5) {
        expect(sorted(regel)).toEqual([...kostenSleutels, 'vorm'].sort())
        expect(regel.stap).toBe('reasoning')
        expect(regel.vorm).toBe(i + 1)
      } else {
        expect(sorted(regel)).toEqual(kostenSleutels)
        expect(regel.stap).toBe('canary')
      }
    })

    expect(meting.negative).toHaveLength(3)
    expect(meting.negative.map((n: Json) => n.variant)).toEqual(['kaal', 'uit-vorm', 'aan-vorm'])
    expect(sorted(meting.negative[0])).toEqual(['excerpt', 'http_status', 'variant']) // non-2xx: a masked excerpt
    expect(sorted(meting.negative[2])).toEqual(['excerpt', 'http_status', 'variant'])
    expect(meting.negative[1]).toEqual({ variant: 'uit-vorm', http_status: 200, id: 'gen-neg-200', provider: 'NegProvider' }) // 2xx: no body text
    expect(meting.negative[0].excerpt).toBe(JSON.stringify({ error: { message: 'No allowed providers are available for the selected model.', code: 404 } }))

    expect(meting.canary).toEqual([
      { model: 'gsq-lokaal', http_status: 200 },
      { model: 'qwen3.8-or', http_status: 200 },
      { model: 'qwen3.8-or-neg', http_status: 404 },
    ])

    // No message anywhere: not as a key, and not as text (the stub's answer and thinking text carry markers).
    const sleutels = sleutelsIn(meting)
    for (const verboden of ['messages', 'content', 'message', 'choices', 'reasoning_content']) expect(sleutels).not.toContain(verboden)
    expect(dirContains(out, ANTWOORD)).toBe(false)
    expect(dirContains(out, DENK)).toBe(false)
  })

  it('sends the requests in the agreed order and shape', async () => {
    const stub = await startStub()
    const out = nieuweMap()
    await draaiMeet(stub, out)

    expect(stub.verzoeken.map((v) => `${v.methode} ${v.pad}`)).toEqual([
      'GET /health/readiness',
      'GET /v1/models',
      ...Array<string>(12).fill('POST /v1/chat/completions'),
    ])
    const chat = stub.chat()
    expect(chat.map((v) => v.body.model)).toEqual([
      'gsq-lokaal',
      ...Array<string>(5).fill('qwen3.8-or'),
      ...Array<string>(3).fill('qwen3.8-or-neg'),
      'gsq-lokaal',
      'qwen3.8-or',
      'qwen3.8-or-neg',
    ])
    expect(chat.map((v) => v.body.max_tokens)).toEqual([64, 256, 256, 256, 256, 256, 256, 256, 256, 64, 64, 64])
    for (const v of chat.slice(0, 9)) expect(v.body.messages).toEqual([{ role: 'user', content: 'Antwoord alleen met: pong' }])

    // The five forms, in order; then the negative control bare, with the uit-vorm (2) and with the aan-vorm (4).
    const vormen = [{}, { reasoning_effort: 'none' }, { reasoning: { effort: 'none' } }, { reasoning_effort: 'medium' }, { reasoning: { effort: 'medium' } }]
    expect(chat.slice(1, 6).map((v) => extraVan(v.body))).toEqual(vormen)
    expect(chat.slice(6, 9).map((v) => extraVan(v.body))).toEqual([{}, vormen[1], vormen[3]])

    // The canaries: each its own M45-CANARY-<16 hex> in the user message, the same three strings in kanarie.txt.
    const regels = readFileSync(join(out, 'kanarie.txt'), 'utf8').split('\n')
    expect(regels.pop()).toBe('') // a closing newline
    expect(regels).toHaveLength(3)
    expect(new Set(regels).size).toBe(3)
    regels.forEach((kanarie, i) => {
      expect(kanarie).toMatch(/^M45-CANARY-[0-9a-f]{16}$/)
      expect(chat[9 + i].body.messages).toHaveLength(1)
      expect(chat[9 + i].body.messages[0].role).toBe('user')
      expect(chat[9 + i].body.messages[0].content).toContain(kanarie)
    })
  })

  it('prints one short line per step and nothing else', async () => {
    const stub = await startStub()
    const r = await draaiMeet(stub, nieuweMap())
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      [
        'readiness 200',
        'models 200',
        'bridge 200',
        'reasoning 200 200 200 200 200 uit-vorm=2 aan-vorm=4',
        'negative kaal=404 uit-vorm=404 aan-vorm=404',
        'canary 200 200 404',
        'cost 6 antwoorden, 6 binnen kostencriterium, 6 met bedrag',
        '',
      ].join('\n'),
    )
    expect(r.stderr).toBe('')
  })

  it('creates the output directory when it is not there yet', async () => {
    const stub = await startStub()
    const out = join(nieuweMap(), 'nieuw', 'diep')
    const r = await draaiMeet(stub, out)
    expect(r.code).toBe(0)
    expect(readdirSync(out).sort()).toEqual(['kanarie.txt', 'meting.json', 'probe-extra-or.json', 'run-extra-or.json'])
  })

  it('takes a base url with or without /v1 and a trailing slash', async () => {
    const stub = await startStub()
    await draaiMeet(stub, nieuweMap(), { baseUrl: `${stub.url}/v1/` })
    expect(stub.verzoeken[0].pad).toBe('/health/readiness')
    expect(stub.verzoeken[1].pad).toBe('/v1/models')
    expect(stub.verzoeken.every((v) => !v.pad.startsWith('/v1/v1'))).toBe(true)
  })
})

// ---- test 4 ----

describe('test 4: cost fields and their source come from the headers and the body', () => {
  it('records the raw headers, the body cost, the provider, the id and the source per hosted answer', async () => {
    const hosted = { provider: 'ProviderX' }
    const stub = await startStub(
      perVorm({
        // body cost wins, whatever the headers say
        1: { headers: { 'x-litellm-response-cost': '0.0013', 'llm_provider-x-litellm-response-cost': '0.0011' }, body: voltooiing({ ...hosted, id: 'gen-1', kosten: 0.0012 }) },
        // no body cost: the provider header
        2: { headers: { 'x-litellm-response-cost': '0.0009', 'llm_provider-x-litellm-response-cost': '0.0007' }, body: voltooiing({ ...hosted, id: 'gen-2' }) },
        // only LiteLLM's own computation
        3: { headers: { 'x-litellm-response-cost': '0.0005' }, body: voltooiing({ ...hosted, id: 'gen-3' }) },
        // a header of 0 is no amount
        4: { headers: { 'x-litellm-response-cost': '0' }, body: voltooiing({ ...hosted, id: 'gen-4' }) },
        // a 4xx without an amount
        5: { status: 400, body: { error: { message: 'bad request', code: 400 } } },
      }),
    )
    const out = nieuweMap()
    const voor = Date.now()
    const r = await draaiMeet(stub, out)
    const na = Date.now()
    expect(r.code).toBe(0)

    const kosten = lees(out).cost
    const zonderTijd = kosten.map((regel: Json) => {
      const { tijd: _tijd, ...rest } = regel
      return rest
    })
    expect(zonderTijd.slice(0, 5)).toEqual([
      { stap: 'reasoning', vorm: 1, model: 'qwen3.8-or', http_status: 200, kosten_header: '0.0013', provider_kosten_header: '0.0011', body_usage_cost: 0.0012, provider: 'ProviderX', id: 'gen-1', bedrag: 0.0012, bron: 'provider_reported' },
      { stap: 'reasoning', vorm: 2, model: 'qwen3.8-or', http_status: 200, kosten_header: '0.0009', provider_kosten_header: '0.0007', body_usage_cost: null, provider: 'ProviderX', id: 'gen-2', bedrag: 0.0007, bron: 'provider_reported' },
      { stap: 'reasoning', vorm: 3, model: 'qwen3.8-or', http_status: 200, kosten_header: '0.0005', provider_kosten_header: null, body_usage_cost: null, provider: 'ProviderX', id: 'gen-3', bedrag: 0.0005, bron: 'litellm_computed' },
      { stap: 'reasoning', vorm: 4, model: 'qwen3.8-or', http_status: 200, kosten_header: '0', provider_kosten_header: null, body_usage_cost: null, provider: 'ProviderX', id: 'gen-4', bedrag: null, bron: 'none' },
      // the 4xx keeps its status and gets the source 'none'
      { stap: 'reasoning', vorm: 5, model: 'qwen3.8-or', http_status: 400, kosten_header: null, provider_kosten_header: null, body_usage_cost: null, provider: null, id: null, bedrag: null, bron: 'none' },
    ])
    // The hosted canary answer comes from the default stub: usage.cost 0.00012 and both headers.
    expect(zonderTijd[5]).toMatchObject({ stap: 'canary', model: 'qwen3.8-or', http_status: 200, body_usage_cost: 0.00012, bedrag: 0.00012, bron: 'provider_reported' })

    // 'tijd' is the moment of the answer: ISO-8601, within this run, in request order.
    const tijden = kosten.map((regel: Json) => regel.tijd as string)
    for (const t of tijden) {
      expect(new Date(t).toISOString()).toBe(t)
      expect(Date.parse(t)).toBeGreaterThanOrEqual(voor)
      expect(Date.parse(t)).toBeLessThanOrEqual(na)
    }
    expect([...tijden].sort()).toEqual(tijden)

    // The 4xx is outside the cost criterion; the 200 with a 0 header is inside it, and has no amount.
    expect(meet.inKostencriterium(kosten[4])).toBe(false)
    expect(meet.inKostencriterium(kosten[3])).toBe(true) // a 200 without an amount is in the criterion, and fails it
    expect(r.stdout).toContain('cost 6 antwoorden, 5 binnen kostencriterium, 4 met bedrag\n')
  })

  it('takes the amount of the hosted canary answer from the same rule, and ignores a body cost of 0', async () => {
    const stub = await startStub((v) =>
      v.body?.model === 'qwen3.8-or' && v.body.max_tokens === 64
        ? { headers: { 'x-litellm-response-cost': '0.002' }, body: voltooiing({ kosten: 0, provider: 'ProviderC', id: 'gen-canary' }) }
        : undefined,
    )
    const out = nieuweMap()
    await draaiMeet(stub, out)
    const canary = lees(out).cost[5]
    expect(canary).toMatchObject({ stap: 'canary', body_usage_cost: 0, kosten_header: '0.002', bedrag: 0.002, bron: 'litellm_computed', provider: 'ProviderC', id: 'gen-canary' })
  })
})

// ---- test 5 ----

describe('test 5: the thinking decision rule, the two files and the negative variants', () => {
  it('decides on reasoning_tokens: 0, above 0 or missing', async () => {
    const stub = await startStub(
      perVorm({
        1: { tokens: 0 }, // uit
        2: { tokens: null }, // uit: the field is missing
        3: { tokens: 0 }, // uit too, but the first one counts
        4: { tokens: 25 }, // aan
        5: { tokens: 0 }, // not aan
      }),
    )
    const out = nieuweMap()
    const r = await draaiMeet(stub, out)
    expect(r.code).toBe(0)

    const meting = lees(out)
    expect(meting.reasoning.map((x: Json) => [x.reasoning_tokens, x.stand])).toEqual([[0, 'uit'], ['ontbreekt', 'uit'], [0, 'uit'], [25, 'aan'], [0, 'uit']])
    expect(meting.denkstand).toEqual({ uit_vorm: 1, aan_vorm: 4 })
    expect(lees(out, 'probe-extra-or.json')).toEqual({}) // vorm 1 is no field at all
    expect(lees(out, 'run-extra-or.json')).toEqual({ reasoning_effort: 'medium' })
    // The empty uit-vorm drops its variant: bare and aan-vorm only.
    const neg = stub.chat().filter((v) => v.body.model === 'qwen3.8-or-neg').slice(0, 2)
    expect(neg.map((v) => extraVan(v.body))).toEqual([{}, { reasoning_effort: 'medium' }])
    expect(meting.negative.map((n: Json) => n.variant)).toEqual(['kaal', 'aan-vorm'])
  })

  it('counts a thinking text as aan, also when reasoning_tokens is 0 or missing', async () => {
    const stub = await startStub(
      perVorm({
        1: { tokens: 40, denk: { reasoning_content: DENK } }, // aan
        2: { tokens: 0, denk: { reasoning_content: 'hmm' } }, // aan, not uit: 0 tokens but a text
        3: { tokens: null }, // uit
        4: { tokens: 0, denk: { reasoning: 'hm' } }, // aan by its text alone
        5: { tokens: 0, denk: { reasoning_details: [{ type: 'reasoning.text', text: 'abc' }, { type: 'reasoning.summary', summary: 'de' }] } },
      }),
    )
    const out = nieuweMap()
    await draaiMeet(stub, out)

    const meting = lees(out)
    expect(meting.reasoning[1]).toEqual({ vorm: 2, http_status: 200, finish_reason: 'stop', reasoning_tokens: 0, denktekst_velden: ['reasoning_content'], denktekst_lengte: 3, stand: 'aan' })
    expect(meting.reasoning[2]).toMatchObject({ vorm: 3, reasoning_tokens: 'ontbreekt', denktekst_lengte: 0, stand: 'uit' })
    expect(meting.reasoning[3]).toMatchObject({ vorm: 4, reasoning_tokens: 0, denktekst_velden: ['reasoning'], denktekst_lengte: 2, stand: 'aan' })
    expect(meting.reasoning[4]).toMatchObject({ vorm: 5, denktekst_velden: ['reasoning_details'], denktekst_lengte: 5, stand: 'aan' })
    expect(meting.denkstand).toEqual({ uit_vorm: 3, aan_vorm: 4 })
    expect(lees(out, 'probe-extra-or.json')).toEqual({ reasoning: { effort: 'none' } })
    expect(lees(out, 'run-extra-or.json')).toEqual({ reasoning_effort: 'medium' })
    // All three variants: bare, with the uit-vorm, with the aan-vorm.
    const neg = stub.chat().filter((v) => v.body.model === 'qwen3.8-or-neg').slice(0, 3)
    expect(neg.map((v) => extraVan(v.body))).toEqual([{}, { reasoning: { effort: 'none' } }, { reasoning_effort: 'medium' }])
    expect(meting.negative.map((n: Json) => n.variant)).toEqual(['kaal', 'uit-vorm', 'aan-vorm'])
  })

  it('finds no form when none gives a clear answer: both files are {} and only the bare variant is sent', async () => {
    const stub = await startStub(
      perVorm({
        1: { tokens: 12 }, // aan, so not uit
        2: { tokens: 0, finish: 'length' }, // cut off without a thinking signal: onbepaald
        3: { status: 400, body: { error: { message: 'unsupported', code: 400 } } }, // no 200: onbepaald
        4: { tokens: 0 }, // uit with medium: not aan, and forms 4 and 5 are never the uit-vorm
        5: { tokens: null, finish: 'length' }, // onbepaald
      }),
    )
    const out = nieuweMap()
    const r = await draaiMeet(stub, out)
    expect(r.code).toBe(0)

    const meting = lees(out)
    expect(meting.reasoning.map((x: Json) => x.stand)).toEqual(['aan', 'onbepaald', 'onbepaald', 'uit', 'onbepaald'])
    expect(meting.reasoning[2]).toEqual({ vorm: 3, http_status: 400, finish_reason: null, reasoning_tokens: 'ontbreekt', denktekst_velden: [], denktekst_lengte: 0, stand: 'onbepaald' })
    expect(meting.denkstand).toEqual({ uit_vorm: null, aan_vorm: null })
    expect(lees(out, 'probe-extra-or.json')).toEqual({})
    expect(lees(out, 'run-extra-or.json')).toEqual({})
    expect(stub.chat().filter((v) => v.body.model === 'qwen3.8-or-neg')).toHaveLength(2) // the bare variant and the canary
    expect(meting.negative.map((n: Json) => n.variant)).toEqual(['kaal'])
  })

  it('writes the two extra files right after the reasoning step, before the negative step', async () => {
    // The negative control is the first request on qwen3.8-or-neg: look at the directory from inside the stub.
    let sawFiles: string[] | undefined
    const out = nieuweMap()
    const stub = await startStub((v) => {
      if (v.body?.model === 'qwen3.8-or-neg') sawFiles ??= readdirSync(out)
      return undefined
    })
    await draaiMeet(stub, out)
    expect(sawFiles?.sort()).toEqual(['probe-extra-or.json', 'run-extra-or.json'])
    expect(readdirSync(out).sort()).toEqual(['kanarie.txt', 'meting.json', 'probe-extra-or.json', 'run-extra-or.json'])
  })
})

// ---- test 6 ----

describe('test 6: a request without an HTTP answer is exit 1', () => {
  it('refuses a directory that already holds a result: exit 2, no request, the earlier files untouched', async () => {
    const stub = await startStub(() => undefined)
    const out = nieuweMap()
    for (const naam of ['probe-extra-or.json', 'run-extra-or.json', 'kanarie.txt']) writeFileSync(join(out, naam), 'STALE')
    writeFileSync(join(out, 'meting.json'), '{"stale":true}')

    const r = await draaiMeet(stub, out)
    expect(r.code).toBe(2)
    expect(stub.verzoeken).toHaveLength(0)
    expect(r.stderr).toContain('kies een nieuwe map')
    expect(readFileSync(join(out, 'meting.json'), 'utf8')).toBe('{"stale":true}')
    for (const naam of ['probe-extra-or.json', 'run-extra-or.json', 'kanarie.txt']) expect(readFileSync(join(out, naam), 'utf8')).toBe('STALE')
  })

  it('stops at the first request when the connection is cut', async () => {
    const stub = await startStub((v) => (v.pad === '/health/readiness' ? { verbreek: 'voor' } : undefined))
    const out = nieuweMap()

    const r = await draaiMeet(stub, out)
    expect(r.code).toBe(1)
    expect(stub.verzoeken).toHaveLength(1) // stops directly
    expect(lees(out)).toEqual({ afgebroken: { stap: 'readiness', reden: 'ECONNRESET' } })
    expect(readdirSync(out)).toEqual(['meting.json'])
    expect(r.stderr).toContain('readiness')
    expect(r.stderr).toContain('ECONNRESET')
  })

  it('keeps what was measured when the connection is cut half-way', async () => {
    const stub = await startStub((v) => (v.body?.model === 'qwen3.8-or' && vormVan(v.body) === 3 ? { verbreek: 'voor' } : undefined))
    const out = nieuweMap()
    const r = await draaiMeet(stub, out)
    expect(r.code).toBe(1)
    expect(stub.chat()).toHaveLength(4) // the bridge and forms 1 to 3; nothing after the cut
    const meting = lees(out)
    expect(sorted(meting)).toEqual(['afgebroken', 'bridge', 'cost', 'models', 'readiness', 'reasoning'])
    expect(meting.afgebroken).toEqual({ stap: 'reasoning', reden: 'ECONNRESET' })
    expect(meting.reasoning.map((x: Json) => x.vorm)).toEqual([1, 2])
    expect(meting.cost.map((x: Json) => x.vorm)).toEqual([1, 2])
    expect(readdirSync(out)).toEqual(['meting.json']) // no extra files from a reasoning step that did not finish, no canary yet
    expect(r.stdout).not.toContain('reasoning')
  })

  it('keeps the string of a canary that was sent but not answered', async () => {
    // The hosted canary (the second) is cut. Its string was on its way, so a search of the logs has to know it.
    const stub = await startStub((v) => (v.body?.model === 'qwen3.8-or' && v.body.max_tokens === 64 ? { verbreek: 'voor' } : undefined))
    const out = nieuweMap()
    const r = await draaiMeet(stub, out)
    expect(r.code).toBe(1)
    const meting = lees(out)
    expect(meting.afgebroken).toEqual({ stap: 'canary', reden: 'ECONNRESET' })
    expect(meting.canary).toEqual([{ model: 'gsq-lokaal', http_status: 200 }])
    expect(meting.denkstand).toEqual({ uit_vorm: 2, aan_vorm: 4 }) // the reasoning step had finished
    const regels = readFileSync(join(out, 'kanarie.txt'), 'utf8').trim().split('\n')
    expect(regels).toHaveLength(2)
    expect(stub.chat().at(-1)?.body.messages[0].content).toContain(regels[1])
    expect(readdirSync(out).sort()).toEqual(['kanarie.txt', 'meting.json', 'probe-extra-or.json', 'run-extra-or.json'])
  })

  it('gives a time-out as a stop, with the reason "timeout"', async () => {
    const stub = await startStub((v) => (v.body?.model === 'gsq-lokaal' ? { vertraging: 3000, body: voltooiing() } : undefined))
    const out = nieuweMap()
    const r = await draaiMeet(stub, out, { timeoutSec: '0.3' })
    expect(r.code).toBe(1)
    expect(lees(out).afgebroken).toEqual({ stap: 'bridge', reden: 'timeout' })
    expect(sorted(lees(out))).toEqual(['afgebroken', 'models', 'readiness'])
  })

  it('treats an answer that breaks off half-way as no answer', async () => {
    const stub = await startStub((v) => (v.pad === '/v1/models' ? { verbreek: 'midden' } : undefined))
    const out = nieuweMap()
    const r = await draaiMeet(stub, out)
    expect(r.code).toBe(1)
    expect(lees(out).afgebroken).toEqual({ stap: 'models', reden: 'ECONNRESET' })
  })

  it('exits 1 when nothing listens', async () => {
    const stub = await startStub()
    const out = nieuweMap()
    const r = await draaiMeet(stub, out, { baseUrl: 'http://127.0.0.1:1' })
    expect(r.code).toBe(1)
    expect(lees(out)).toEqual({ afgebroken: { stap: 'readiness', reden: 'ECONNREFUSED' } })
    expect(stub.verzoeken).toHaveLength(0)
  })

  it('exits 0 when every request got an answer, whatever the status', async () => {
    const stub = await startStub((v) => ({ status: v.pad === '/health/readiness' ? 503 : 500, body: { error: { message: 'down' } } }))
    const out = nieuweMap()
    const r = await draaiMeet(stub, out)
    expect(r.code).toBe(0)
    expect(lees(out).readiness).toEqual({ http_status: 503, status: null, db: null, litellm_version: null })
    expect(lees(out).reasoning.every((x: Json) => x.http_status === 500 && x.stand === 'onbepaald')).toBe(true)
    expect(lees(out).denkstand).toEqual({ uit_vorm: null, aan_vorm: null })
    expect(existsSync(join(out, 'kanarie.txt'))).toBe(true)
  })
})

// ---- the pure functions ----

describe('maskeer', () => {
  it('replaces every occurrence of every key, the longest key first', () => {
    expect(meet.maskeer(`a ${KEY} b ${OR_KEY} c ${KEY}`, [KEY, OR_KEY])).toBe('a <redacted> b <redacted> c <redacted>')
    expect(meet.maskeer('xx-abc-yy', ['abc', 'xx-abc-yy'])).toBe('<redacted>') // a key inside another key is not left half-masked
  })

  it('ignores empty and missing keys and leaves other text alone', () => {
    expect(meet.maskeer('plain text', ['', undefined])).toBe('plain text')
  })
})

describe('bepaalBron', () => {
  const kosten = (o: object) => ({ body_usage_cost: null, provider_kosten_header: null, kosten_header: null, ...o })

  it('reads the body cost, then the provider header, then the LiteLLM header', () => {
    expect(meet.bepaalBron(kosten({ body_usage_cost: 0.5, provider_kosten_header: '0.4', kosten_header: '0.3' }))).toEqual({ bedrag: 0.5, bron: 'provider_reported' })
    expect(meet.bepaalBron(kosten({ provider_kosten_header: '0.4', kosten_header: '0.3' }))).toEqual({ bedrag: 0.4, bron: 'provider_reported' })
    expect(meet.bepaalBron(kosten({ kosten_header: '0.3' }))).toEqual({ bedrag: 0.3, bron: 'litellm_computed' })
    expect(meet.bepaalBron(kosten({}))).toEqual({ bedrag: null, bron: 'none' })
  })

  it('falls through a source that is not a finite number above 0', () => {
    expect(meet.bepaalBron(kosten({ body_usage_cost: 0, kosten_header: '0.3' }))).toEqual({ bedrag: 0.3, bron: 'litellm_computed' })
    expect(meet.bepaalBron(kosten({ provider_kosten_header: '0', kosten_header: '1e-5' }))).toEqual({ bedrag: 0.00001, bron: 'litellm_computed' })
  })

  it.each(['0', '0.0', '-1', 'abc', '', ' ', 'Infinity', 'NaN', '0x10', '1,5', '1.2.3'])('treats the header %j as no amount', (waarde) => {
    expect(meet.bepaalBron(kosten({ kosten_header: waarde, provider_kosten_header: waarde }))).toEqual({ bedrag: null, bron: 'none' })
  })
})

describe('beslisDenkstand', () => {
  const antwoord = (o: object) => ({ http_status: 200, finish_reason: 'stop', reasoning_tokens: 0, denktekst_lengte: 0, ...o })

  it.each([
    ['0 tokens, no text', {}, 'uit'],
    ['the tokens field is missing, no text', { reasoning_tokens: 'ontbreekt' }, 'uit'],
    ['tokens above 0', { reasoning_tokens: 7 }, 'aan'],
    ['0 tokens but a thinking text', { denktekst_lengte: 4 }, 'aan'],
    ['no tokens field but a thinking text', { reasoning_tokens: 'ontbreekt', denktekst_lengte: 1 }, 'aan'],
    ['cut off by length without any signal', { finish_reason: 'length' }, 'onbepaald'],
    ['cut off by length, but thinking', { finish_reason: 'length', reasoning_tokens: 256 }, 'aan'],
    ['no finish reason', { finish_reason: null }, 'onbepaald'],
    ['an HTTP error', { http_status: 500, reasoning_tokens: 'ontbreekt' }, 'onbepaald'],
    ['a negative token count', { reasoning_tokens: -1 }, 'onbepaald'],
  ])('%s is %s', (_naam, o, verwacht) => {
    expect(meet.beslisDenkstand(antwoord(o))).toBe(verwacht)
  })
})

describe('denktekst', () => {
  it('names the fields that were there and counts the length of their text', () => {
    const bericht = { reasoning_content: 'abc', reasoning: '', reasoning_details: [{ text: 'de' }, { summary: 'f' }, { data: 'encrypted-not-counted' }, null] }
    expect(meet.denktekst(bericht)).toEqual({ velden: ['reasoning_content', 'reasoning', 'reasoning_details'], lengte: 6 })
  })

  it('treats null, missing and malformed fields as absent', () => {
    expect(meet.denktekst({ reasoning_content: null, reasoning: 5, reasoning_details: 'x', content: 'pong' })).toEqual({ velden: [], lengte: 0 })
    expect(meet.denktekst(undefined)).toEqual({ velden: [], lengte: 0 })
  })
})

describe('kiesVormen', () => {
  const regel = (vorm: number, stand: string) => ({ vorm, stand })

  it('takes the first uit of forms 1 to 3 and the first aan of forms 4 and 5', () => {
    expect(meet.kiesVormen([regel(1, 'aan'), regel(2, 'uit'), regel(3, 'uit'), regel(4, 'aan'), regel(5, 'aan')])).toEqual({ uit_vorm: 2, aan_vorm: 4 })
    expect(meet.kiesVormen([regel(1, 'uit'), regel(2, 'uit'), regel(3, 'uit'), regel(4, 'onbepaald'), regel(5, 'aan')])).toEqual({ uit_vorm: 1, aan_vorm: 5 })
  })

  it('looks at the right forms only', () => {
    expect(meet.kiesVormen([regel(1, 'aan'), regel(2, 'aan'), regel(3, 'onbepaald'), regel(4, 'uit'), regel(5, 'onbepaald')])).toEqual({ uit_vorm: null, aan_vorm: null })
  })
})
