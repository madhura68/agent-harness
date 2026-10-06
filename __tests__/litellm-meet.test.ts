import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { Agent, createServer, request as httpRequest, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as meet from '../deploy/max2/litellm/meet.mjs'
import { loadManifest } from '../src/manifest.js'
import { allFiles, dirContains, leakedFragments, tmp } from './helpers.js'

// deploy/max2/litellm/meet.mjs against local node:http stubs (M45 increment 1). Mode `meet` (T-2018, tests 1-6) talks to a stub that
// plays LiteLLM; `proxy` (T-2019, test 7) sits between a client and such a stub; `opzoeken` (test 8) talks to a stub that plays
// OpenRouter; `manifesten` (test 9) needs no server. The script runs as a child process, because its exit code, stdout and files are
// the contract; its exported pure functions get focused unit tests at the end. The key values are obviously fake. The nine numbered
// blocks are the brief's red tests.

const SCRIPT = fileURLToPath(new URL('../deploy/max2/litellm/meet.mjs', import.meta.url))
// No hex-only stretches in the keys: the random hex of a canary string must never contain a fragment of them.
const KEY = 'sk-test-master-ghijklmnopqrstuv'
const OR_KEY = 'sk-or-test-wxyzghijklmnopqr'
const ANTWOORD = 'ANTWOORD-MARKER-pong' // the content of every stub answer: it must never reach an output file
const DENK = 'DENK-MARKER-thinking-out-loud' // the stub's thinking text: only its length may be recorded

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON is inspected ad hoc in tests
type Json = any
// `ruw` is the request body as received, `headers` the request headers with lower-cased names (a repeated header is joined).
type Verzoek = { n: number; methode: string; pad: string; authorization: string | undefined; headers: IncomingHttpHeaders; ruw: string; body: Json }
// A Buffer body is sent as it is (the gzip and byte-exact tests); anything else is sent as text or as JSON.
type Stuur = { status?: number; headers?: Record<string, string | string[]>; body?: unknown; vertraging?: number; verbreek?: 'voor' | 'midden' }
type Handler = (v: Verzoek) => Stuur | undefined
type Stub = Awaited<ReturnType<typeof startStub>>

// Most tests start a child process (or several); a machine under load needs more than the 5 s of the default for that.
vi.setConfig({ testTimeout: 30_000 })

const stubs: Array<{ close: () => Promise<void> }> = []
const mappen: string[] = []
// Every proxy this file starts, to be stopped after its test. Also the children of tests that fail: a regression must not leave a proxy behind.
const proxies: Array<{ stop: () => Promise<number | null> }> = []
const kinderen = new Set<ChildProcess>()
// A backstop for a worker that ends before afterEach could run.
process.once('exit', () => {
  for (const kind of kinderen) if (kind.exitCode === null && kind.signalCode === null) kind.kill('SIGKILL')
})

afterEach(async () => {
  // The proxies first: a child process that outlives its test would keep a port and a log file in a directory that is removed below.
  await Promise.all(proxies.splice(0).map((p) => p.stop()))
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
    const tekst = Buffer.isBuffer(s.body) ? '' : typeof s.body === 'string' ? s.body : JSON.stringify(s.body ?? {})
    if (s.verbreek === 'midden') {
      res.writeHead(s.status ?? 200, { 'content-type': 'application/json', 'content-length': String(tekst.length + 100) })
      res.write(tekst.slice(0, 10))
      setTimeout(() => res.socket?.destroy(), 20)
      return
    }
    res.writeHead(s.status ?? 200, { 'content-type': 'application/json', ...s.headers })
    res.end(Buffer.isBuffer(s.body) ? s.body : tekst)
  }
  if (s.vertraging) setTimeout(verstuur, s.vertraging).unref()
  else verstuur()
}

async function startStub(handler: Handler = () => undefined) {
  const verzoeken: Verzoek[] = []
  const afgebroken: number[] = [] // the requests whose connection was cut before the stub had answered
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
      const v: Verzoek = { n: verzoeken.length + 1, methode: req.method ?? '', pad: req.url ?? '', authorization: req.headers.authorization, headers: req.headers, ruw, body }
      verzoeken.push(v)
      res.on('close', () => {
        if (!res.writableFinished) afgebroken.push(v.n)
      })
      stuurAntwoord(res, handler(v) ?? standaard(v))
    })
  })
  await new Promise<void>((klaar) => server.listen(0, '127.0.0.1', klaar))
  const { port } = server.address() as AddressInfo
  const stub = {
    url: `http://127.0.0.1:${port}`,
    verzoeken,
    afgebroken,
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

/** The message line of a usage error (the usage text follows it). The usage text lists every option, so only this line shows that the right problem was named. */
const eersteRegel = (r: Uitslag): string => r.stderr.split('\n')[0]

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

  it('masks before it cuts: a key that straddles the 200-character cut of a provider or an id leaves no prefix behind', async () => {
    // The key starts at character 190: a cut before the mask would keep its first ten characters, which the mask no longer matches.
    const provider = '.'.repeat(190) + KEY
    const id = `gen-${'.'.repeat(186)}${KEY}`
    const stub = await startStub((v) => (v.body?.model === 'qwen3.8-or' || v.body?.model === 'qwen3.8-or-neg' ? { body: voltooiing({ provider, id }) } : undefined))
    const out = nieuweMap()
    const r = await draaiMeet(stub, out)
    expect(r.code).toBe(0)
    for (const tekst of [r.stdout, r.stderr, ...allFiles(out).map((f) => readFileSync(f, 'utf8'))]) expect(leakedFragments(tekst, KEY)).toEqual([])
    const meting = lees(out)
    expect(meting.cost[0].provider).toBe(`${'.'.repeat(190)}<redacted>`)
    expect(meting.cost[0].id).toBe(`gen-${'.'.repeat(186)}<redacted>`)
    // The negative control keeps the id and the provider of a 2xx answer by the same rule.
    expect(meting.negative[0]).toEqual({ variant: 'kaal', http_status: 200, id: `gen-${'.'.repeat(186)}<redacted>`, provider: `${'.'.repeat(190)}<redacted>` })
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

// ---- test 7 ----

// The proxy runs as a child process on a port the OS picks (--listen 127.0.0.1:0, announced on stdout), so no test can collide with
// another one or with a service on the machine. Every proxy is stopped in afterEach.

type ProxyProces = {
  poort: number
  log: string
  stdout: () => string
  stderr: () => string
  signaal: (signaal: NodeJS.Signals) => void
  uitgang: Promise<number | null>
  stop: () => Promise<number | null>
}

const CHAT = '/v1/chat/completions'
const VRAAG = 'VRAAG-MARKER-hoofdstad-van-frankrijk' // the user message of the proxy tests: it must never reach the log
const AUTH = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }
// An address of this machine other than the loopback one, if it has any: the proxy must not answer there.
const LAN_ADRES = Object.values(networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal)?.address
// The fields of a normal log line, sorted; a line for an upstream that gave no answer has one more: fout.
const LOGVELDEN = ['bedrag', 'body_usage_cost', 'bron', 'finish_reason', 'http_status', 'id', 'kosten_header', 'model', 'provider', 'provider_kosten_header', 'reasoning_tokens', 'tijd', 'toolcalls']

/** The proxy in front of `upstream`. Resolves once it has said that it listens. */
async function startProxy(upstream: string, o: { env?: Record<string, string>; log?: string; timeoutSec?: string; signaalOpRegel?: NodeJS.Signals } = {}): Promise<ProxyProces> {
  const log = o.log ?? join(nieuweMap(), 'antwoorden.jsonl')
  const args = [SCRIPT, 'proxy', '--listen', '127.0.0.1:0', '--upstream', upstream, '--log', log, ...(o.timeoutSec ? ['--timeout-sec', o.timeoutSec] : [])]
  const kind = spawn(process.execPath, args, { env: { PATH: process.env.PATH ?? '', ...o.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  kinderen.add(kind)
  let uit = ''
  let fout = ''
  kind.stdout.setEncoding('utf8')
  kind.stderr.setEncoding('utf8')
  kind.stdout.on('data', (d: string) => {
    uit += d
  })
  kind.stderr.on('data', (d: string) => {
    fout += d
  })
  kind.on('error', () => {}) // 'exit' follows; an unhandled 'error' event would throw inside the test worker
  const uitgang = new Promise<number | null>((klaar) => kind.once('exit', (code) => klaar(code)))
  const proces: ProxyProces = {
    poort: 0,
    log,
    stdout: () => uit,
    stderr: () => fout,
    signaal: (s) => kind.kill(s),
    uitgang,
    stop: async () => {
      if (kind.exitCode === null && kind.signalCode === null) kind.kill('SIGTERM')
      const dwing = setTimeout(() => kind.kill('SIGKILL'), 5000) // a proxy that ignores SIGTERM must not outlive its test
      const code = await uitgang
      clearTimeout(dwing)
      return code
    },
  }
  proxies.push(proces)
  proces.poort = await new Promise<number>((klaar, mislukt) => {
    const timer = setTimeout(() => mislukt(new Error(`the proxy did not say within 10 s that it listens; stderr: ${fout}`)), 10_000)
    let gemeld = false
    kind.stdout.on('data', () => {
      const m = /^proxy luistert op 127\.0\.0\.1:(\d+)\n/.exec(uit)
      if (m && !gemeld) {
        gemeld = true
        // Straight from the callback, in the same tick: the moment the line is read is the earliest a client can signal.
        if (o.signaalOpRegel) kind.kill(o.signaalOpRegel)
        clearTimeout(timer)
        klaar(Number(m[1]))
      }
    })
    void uitgang.then((code) => {
      clearTimeout(timer)
      mislukt(new Error(`the proxy stopped with code ${code} before it listened; stderr: ${fout}`))
    })
  })
  return proces
}

/**
 * `proxy` run to its end, for a start that has to fail (exit 1 or 2). Unlike draai() it never leaves a process behind when it does not:
 * a proxy that starts listening after all is killed after 5 s, and with the test at the latest.
 */
function draaiProxy(args: string[], env: Record<string, string> = {}): Promise<Uitslag> {
  return new Promise((klaar) => {
    const kind = spawn(process.execPath, [SCRIPT, 'proxy', ...args], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    kinderen.add(kind)
    let stdout = ''
    let stderr = ''
    kind.stdout.setEncoding('utf8')
    kind.stderr.setEncoding('utf8')
    kind.stdout.on('data', (d: string) => {
      stdout += d
    })
    kind.stderr.on('data', (d: string) => {
      stderr += d
    })
    kind.on('error', () => {})
    const uitgang = new Promise<number | null>((gestopt) => kind.once('exit', (code) => gestopt(code)))
    const dwing = setTimeout(() => kind.kill('SIGKILL'), 5000)
    proxies.push({
      stop: async () => {
        if (kind.exitCode === null && kind.signalCode === null) kind.kill('SIGKILL')
        return await uitgang
      },
    })
    void uitgang.then((code) => {
      clearTimeout(dwing)
      klaar({ code: code ?? -1, stdout, stderr })
    })
  })
}

type ViaProxy = { status: number; statusMessage: string; headers: IncomingHttpHeaders; rawHeaders: string[]; body: Buffer }

/** One request to the proxy as a client would send it; node:http, so nothing is added or decompressed on the way. */
function naarProxy(proces: ProxyProces, o: { methode?: string; pad?: string; headers?: Record<string, string | string[]>; body?: string | Buffer; agent?: Agent } = {}): Promise<ViaProxy> {
  return new Promise((klaar, mislukt) => {
    const req = httpRequest({ host: '127.0.0.1', port: proces.poort, method: o.methode ?? 'POST', path: o.pad ?? CHAT, headers: o.headers, agent: o.agent ?? false }, (res) => {
      const stukken: Buffer[] = []
      res.on('data', (c: Buffer) => stukken.push(c))
      res.on('end', () => klaar({ status: res.statusCode ?? 0, statusMessage: res.statusMessage ?? '', headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(stukken) }))
      res.on('error', mislukt)
    })
    req.on('error', mislukt)
    req.end(o.body)
  })
}

function chatBody(model = 'qwen3.8-or', inhoud = VRAAG): string {
  return JSON.stringify({ model, messages: [{ role: 'system', content: 'SYSTEEM-MARKER' }, { role: 'user', content: inhoud }], max_tokens: 64, stream: false })
}

/** A chat completion through the proxy, with the (fake) master key as Authorization header. */
function chatViaProxy(proces: ProxyProces, o: { model?: string; inhoud?: string; headers?: Record<string, string | string[]>; pad?: string; agent?: Agent } = {}): Promise<ViaProxy> {
  return naarProxy(proces, { pad: o.pad, headers: { ...AUTH, ...o.headers }, body: chatBody(o.model, o.inhoud), agent: o.agent })
}

function leesLog(proces: ProxyProces): Json[] {
  const tekst = readFileSync(proces.log, 'utf8')
  if (tekst === '') return []
  expect(tekst.endsWith('\n'), 'every log line ends in a newline').toBe(true)
  return tekst.slice(0, -1).split('\n').map((regel) => JSON.parse(regel))
}

/** Every value of a response header, in order, from the raw header list (a repeated header stays repeated). */
function waardenVan(raw: string[], naam: string): string[] {
  return raw.flatMap((w, i) => (i % 2 === 0 && w.toLowerCase() === naam ? [raw[i + 1]] : []))
}

async function wachtOp<T>(lees: () => T | undefined, ms = 5000): Promise<T> {
  const einde = Date.now() + ms
  for (;;) {
    const waarde = lees()
    if (waarde !== undefined) return waarde
    if (Date.now() > einde) throw new Error('waited too long for the expected state')
    await new Promise((klaar) => setTimeout(klaar, 20))
  }
}

describe('test 7: the proxy passes everything through, and logs only the agreed fields', () => {
  it('returns the answer unchanged: status, headers and the exact body bytes', async () => {
    // Indented by 3 and with non-ASCII text: a parse and serialise on the way would not give the same bytes back.
    const bytes = Buffer.from(JSON.stringify({ ...voltooiing({ kosten: 0.00012, provider: 'TestProvider', id: 'gen-pass' }), extra: 'ünïcode ✓ 日本語' }, null, 3), 'utf8')
    const koppen = {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(bytes.length),
      'x-litellm-response-cost': '0.00015',
      'llm_provider-x-litellm-response-cost': '0.00012',
      'x-litellm-call-id': 'call-123',
      'x-dup': ['een', 'twee'],
    }
    const stub = await startStub(() => ({ status: 200, headers: koppen, body: bytes }))
    const proces = await startProxy(stub.url)

    const a = await chatViaProxy(proces)
    expect(a.status).toBe(200)
    expect(a.statusMessage).toBe('OK')
    expect(Buffer.compare(a.body, bytes)).toBe(0)
    for (const [naam, waarde] of Object.entries(koppen)) expect(waardenVan(a.rawHeaders, naam), naam).toEqual(Array.isArray(waarde) ? waarde : [waarde])
  })

  it('returns a chunked upstream answer complete, and a large body in both directions byte for byte', async () => {
    const groot = Buffer.from(JSON.stringify({ ...voltooiing({ kosten: 0.5 }), vulling: 'ü'.repeat(300_000) }), 'utf8')
    // No content-length from the stub, so Node sends the answer in chunked encoding.
    const stub = await startStub(() => ({ body: groot }))
    const proces = await startProxy(stub.url)
    const vraag = chatBody('qwen3.8-or', 'z'.repeat(300_000))

    const a = await chatViaProxy(proces, { inhoud: 'z'.repeat(300_000) })
    expect(a.status).toBe(200)
    expect(Buffer.compare(a.body, groot)).toBe(0)
    expect(stub.verzoeken[0].ruw).toBe(vraag)
    expect(stub.verzoeken[0].ruw.length).toBeGreaterThan(300_000)
  })

  it('forwards the request unchanged except for accept-encoding: identity', async () => {
    const stub = await startStub(() => ({ body: voltooiing() }))
    const proces = await startProxy(stub.url)
    const pad = `${CHAT}?versie=2&q=%20x`
    const body = chatBody('qwen3.8-or', 'ünïcode ✓ 日本語')
    const koppen = { ...AUTH, 'accept-encoding': 'gzip, deflate, br', 'x-custom-header': ['een', 'twee'], 'user-agent': 'test-client/1' }
    await naarProxy(proces, { pad, headers: koppen, body })

    expect(stub.verzoeken).toHaveLength(1)
    const v = stub.verzoeken[0]
    expect(v.methode).toBe('POST')
    expect(v.pad).toBe(pad)
    expect(v.ruw).toBe(body)
    expect(v.headers['accept-encoding']).toBe('identity')
    expect(v.authorization).toBe(`Bearer ${KEY}`)
    expect(v.headers['content-type']).toBe('application/json')
    expect(v.headers['x-custom-header']).toBe('een, twee')
    expect(v.headers['user-agent']).toBe('test-client/1')
    // Besides that, only what a hop has to set itself: the host of the upstream, the length of the body, the connection.
    const gestuurd = new Set(Object.keys(koppen))
    expect(Object.keys(v.headers).filter((naam) => !gestuurd.has(naam)).sort()).toEqual(['connection', 'content-length', 'host'])
    expect(v.headers.host).toBe(new URL(stub.url).host)
    expect(v.headers['content-length']).toBe(String(Buffer.byteLength(body)))
  })

  it('asks for an uncompressed answer when the client did not mention compression, and sends a request without a body as it is', async () => {
    const stub = await startStub(() => ({ body: { object: 'list', data: [] } }))
    const proces = await startProxy(stub.url)
    await naarProxy(proces, { methode: 'GET', pad: '/v1/models', headers: { authorization: `Bearer ${KEY}`, 'x-custom-header': 'een' } })
    const v = stub.verzoeken[0]
    expect(v.methode).toBe('GET')
    expect(v.headers['accept-encoding']).toBe('identity')
    expect(v.headers['x-custom-header']).toBe('een')
    expect(v.headers['content-length']).toBeUndefined()
    expect(v.ruw).toBe('')
  })

  it('forwards every request, but logs only a POST whose path ends in /chat/completions', async () => {
    const stub = await startStub((v) => (v.pad === '/v1/models' ? { body: { object: 'list', data: [{ id: 'qwen3.8-or' }] } } : { body: voltooiing({ kosten: 0.00012, provider: 'P', id: 'gen-x' }) }))
    const proces = await startProxy(stub.url)

    const modellen = await naarProxy(proces, { methode: 'GET', pad: '/v1/models', headers: AUTH })
    expect(JSON.parse(modellen.body.toString('utf8'))).toEqual({ object: 'list', data: [{ id: 'qwen3.8-or' }] })
    await naarProxy(proces, { pad: '/v1/embeddings', headers: AUTH, body: '{"model":"qwen3.8-or","input":"y"}' })
    await naarProxy(proces, { methode: 'GET', pad: CHAT, headers: AUTH }) // not a POST
    await naarProxy(proces, { pad: `${CHAT}/extra`, headers: AUTH, body: chatBody() }) // does not end in /chat/completions
    expect(leesLog(proces)).toEqual([])

    await naarProxy(proces, { pad: '/chat/completions', headers: AUTH, body: chatBody() }) // no /v1 in front: still the same endpoint
    await chatViaProxy(proces, { pad: `${CHAT}?x=1` }) // a query string does not hide the path
    expect(leesLog(proces)).toHaveLength(2)
    expect(stub.verzoeken.map((v) => `${v.methode} ${v.pad}`)).toEqual([
      'GET /v1/models',
      'POST /v1/embeddings',
      'GET /v1/chat/completions',
      'POST /v1/chat/completions/extra',
      'POST /chat/completions',
      'POST /v1/chat/completions?x=1',
    ])
  })

  it('only ever talks to its upstream: a request target that names another host is refused, and a path that looks like one stays a path', async () => {
    const stub = await startStub(() => ({ body: voltooiing() }))
    const proces = await startProxy(stub.url)

    for (const pad of ['http://voorbeeld.invalid/v1/chat/completions', 'voorbeeld.invalid:80', '*']) {
      const a = await naarProxy(proces, { methode: pad === '*' ? 'OPTIONS' : 'POST', pad, headers: AUTH, body: chatBody() })
      expect(a.status, pad).toBe(400)
    }
    expect(stub.verzoeken).toHaveLength(0)
    expect(leesLog(proces)).toEqual([])

    // These are paths on the upstream, whatever they look like.
    await naarProxy(proces, { methode: 'GET', pad: '//voorbeeld.invalid/x' })
    await naarProxy(proces, { methode: 'GET', pad: '/@voorbeeld.invalid/x' })
    expect(stub.verzoeken.map((v) => v.pad)).toEqual(['//voorbeeld.invalid/x', '/@voorbeeld.invalid/x'])
    expect(stub.verzoeken.every((v) => v.headers.host === new URL(stub.url).host)).toBe(true)
  })

  it('logs one line per chat completion with exactly the agreed fields, and no header, key or message content', async () => {
    const stub = await startStub(() => ({
      headers: { 'x-litellm-response-cost': '0.00015', 'llm_provider-x-litellm-response-cost': '0.00012' },
      body: voltooiing({
        tokens: 30,
        finish: 'tool_calls',
        denk: { reasoning_content: DENK, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_product_docs', arguments: '{"query":"TOOLARG-MARKER"}' } }] },
        kosten: 0.00021,
        provider: 'TestProvider',
        id: 'gen-log-1',
      }),
    }))
    const proces = await startProxy(stub.url)
    const voor = Date.now()
    await chatViaProxy(proces, { headers: { 'x-custom-header': 'HEADER-MARKER', 'user-agent': 'UA-MARKER' } })
    const na = Date.now()

    const regels = leesLog(proces)
    expect(regels).toHaveLength(1)
    const { tijd, ...rest } = regels[0]
    expect(sorted(regels[0])).toEqual(LOGVELDEN)
    expect(rest).toEqual({
      model: 'qwen3.8-or',
      http_status: 200,
      kosten_header: '0.00015',
      provider_kosten_header: '0.00012',
      body_usage_cost: 0.00021,
      provider: 'TestProvider',
      id: 'gen-log-1',
      bedrag: 0.00021,
      bron: 'provider_reported',
      finish_reason: 'tool_calls',
      reasoning_tokens: 30,
      toolcalls: true,
    })
    // 'tijd' is the moment the answer was complete: ISO-8601, within this test.
    expect(new Date(tijd).toISOString()).toBe(tijd)
    expect(Date.parse(tijd)).toBeGreaterThanOrEqual(voor)
    expect(Date.parse(tijd)).toBeLessThanOrEqual(na)

    const tekst = readFileSync(proces.log, 'utf8')
    for (const verboden of ['HEADER-MARKER', 'UA-MARKER', VRAAG, 'SYSTEEM-MARKER', ANTWOORD, DENK, 'search_product_docs', 'TOOLARG-MARKER', 'call_1', KEY, 'authorization', 'content-type']) {
      expect(tekst, verboden).not.toContain(verboden)
    }
    expect(leakedFragments(tekst, KEY)).toEqual([])
    for (const kanaal of [proces.stdout(), proces.stderr()]) expect(leakedFragments(kanaal, KEY)).toEqual([])
  })

  it('logs an answer without tool calls, without a thinking signal and without a cost as such', async () => {
    const stub = await startStub(() => ({ body: voltooiing({ tokens: null, finish: 'length', provider: 'P', id: 'gen-y' }) }))
    const proces = await startProxy(stub.url)
    await chatViaProxy(proces)
    const { tijd: _tijd, ...rest } = leesLog(proces)[0]
    expect(rest).toEqual({
      model: 'qwen3.8-or',
      http_status: 200,
      kosten_header: null,
      provider_kosten_header: null,
      body_usage_cost: null,
      provider: 'P',
      id: 'gen-y',
      bedrag: null,
      bron: 'none',
      finish_reason: 'length',
      reasoning_tokens: 'ontbreekt',
      toolcalls: false,
    })
  })

  describe('the amount and where it came from', () => {
    const beide = { 'x-litellm-response-cost': '0.0004', 'llm_provider-x-litellm-response-cost': '0.0003' }
    // One proxy for the whole table: the stub picks the answer by the model name of the request.
    const gevallen: Array<[string, Record<string, string>, number | undefined, number | null, string]> = [
      ['an amount only in the header of LiteLLM', { 'x-litellm-response-cost': '0.0004' }, undefined, 0.0004, 'litellm_computed'],
      ['an amount only in the provider header', { 'llm_provider-x-litellm-response-cost': '0.0003' }, undefined, 0.0003, 'provider_reported'],
      ['both headers: the provider header wins', beide, undefined, 0.0003, 'provider_reported'],
      ['the body cost wins over both headers', beide, 0.0005, 0.0005, 'provider_reported'],
      ['a header of 0 is no amount', { 'x-litellm-response-cost': '0' }, undefined, null, 'none'],
      ['no amount anywhere', {}, undefined, null, 'none'],
    ]

    it('is read from the headers when the body has none, in the order body, provider header, LiteLLM header', async () => {
      const stub = await startStub((v) => {
        const geval = gevallen[Number(v.body?.model)]
        return { headers: geval[1], body: voltooiing({ kosten: geval[2], provider: 'P', id: 'gen-h' }) }
      })
      const proces = await startProxy(stub.url)
      for (let i = 0; i < gevallen.length; i++) await chatViaProxy(proces, { model: String(i) })
      const regels = leesLog(proces)
      expect(regels).toHaveLength(gevallen.length)
      gevallen.forEach(([naam, koppen, bodyKosten, bedrag, bron], i) => {
        expect(regels[i], naam).toMatchObject({
          bedrag,
          bron,
          kosten_header: koppen['x-litellm-response-cost'] ?? null,
          provider_kosten_header: koppen['llm_provider-x-litellm-response-cost'] ?? null,
          body_usage_cost: bodyKosten ?? null,
        })
      })
    })
  })

  describe('a compressed body is passed on untouched and logged as niet_leesbaar', () => {
    const gz = gzipSync(JSON.stringify(voltooiing({ kosten: 0.0005, provider: 'GzProv', id: 'gen-gz' })))
    const onleesbaar = { model: 'qwen3.8-or', http_status: 200, kosten_header: '0.0004', provider_kosten_header: null, body_usage_cost: null, provider: null, id: null, bedrag: null, bron: 'niet_leesbaar', finish_reason: null, reasoning_tokens: null, toolcalls: null }

    it('gives the client exactly the bytes and headers it got, and logs no amount', async () => {
      const stub = await startStub(() => ({ headers: { 'content-encoding': 'gzip', 'content-length': String(gz.length), 'x-litellm-response-cost': '0.0004' }, body: gz }))
      const proces = await startProxy(stub.url)
      const a = await chatViaProxy(proces, { headers: { 'accept-encoding': 'gzip' } })

      expect(a.status).toBe(200)
      expect(waardenVan(a.rawHeaders, 'content-encoding')).toEqual(['gzip'])
      expect(waardenVan(a.rawHeaders, 'content-length')).toEqual([String(gz.length)])
      expect(Buffer.compare(a.body, gz)).toBe(0)
      expect(JSON.parse(gunzipSync(a.body).toString('utf8')).id).toBe('gen-gz') // still one whole gzip stream
      expect(stub.verzoeken[0].headers['accept-encoding']).toBe('identity') // the proxy did ask for an uncompressed answer
      const { tijd, ...rest } = leesLog(proces)[0]
      expect(typeof tijd).toBe('string')
      expect(rest).toEqual(onleesbaar)
    })

    it('counts every content-encoding other than identity, whatever its case, as compressed', async () => {
      const stub = await startStub((v) => ({ headers: { 'content-encoding': v.body.model, 'x-litellm-response-cost': '0.0004' }, body: gz }))
      const proces = await startProxy(stub.url)
      const waarden = ['GZIP', 'br', 'deflate', 'gzip, br', 'identity, gzip']
      for (const waarde of waarden) await chatViaProxy(proces, { model: waarde })
      const regels = leesLog(proces)
      expect(regels.map((r) => r.bron)).toEqual(waarden.map(() => 'niet_leesbaar'))
    })

    it('reads an answer with content-encoding: identity as usual', async () => {
      const stub = await startStub(() => ({ headers: { 'content-encoding': 'Identity' }, body: voltooiing({ kosten: 0.0005, provider: 'P', id: 'gen-i' }) }))
      const proces = await startProxy(stub.url)
      await chatViaProxy(proces)
      expect(leesLog(proces)[0]).toMatchObject({ bron: 'provider_reported', bedrag: 0.0005, id: 'gen-i' })
    })
  })

  describe('an answer with an error status is passed on and logged with its status', () => {
    it.each([400, 401, 404, 429, 500, 503])('%i', async (status) => {
      const foutBody = Buffer.from(JSON.stringify({ error: { message: 'FOUTTEKST-MARKER bad request', code: status } }))
      const stub = await startStub(() => ({ status, headers: { 'x-request-id': 'req-1' }, body: foutBody }))
      const proces = await startProxy(stub.url)
      const a = await chatViaProxy(proces)

      expect(a.status).toBe(status)
      expect(Buffer.compare(a.body, foutBody)).toBe(0)
      expect(waardenVan(a.rawHeaders, 'x-request-id')).toEqual(['req-1'])
      const { tijd: _tijd, ...rest } = leesLog(proces)[0]
      expect(rest).toEqual({
        model: 'qwen3.8-or',
        http_status: status,
        kosten_header: null,
        provider_kosten_header: null,
        body_usage_cost: null,
        provider: null,
        id: null,
        bedrag: null,
        bron: 'none',
        finish_reason: null,
        reasoning_tokens: 'ontbreekt',
        toolcalls: false,
      })
      expect(readFileSync(proces.log, 'utf8')).not.toContain('FOUTTEKST-MARKER') // the status is logged, not the message
    })

    it('also copes with an error body that is no JSON, and with a request body that is no JSON', async () => {
      const stub = await startStub(() => ({ status: 502, headers: { 'content-type': 'text/html' }, body: '<html>FOUTTEKST-MARKER</html>' }))
      const proces = await startProxy(stub.url)
      const a = await naarProxy(proces, { headers: AUTH, body: 'dit is geen JSON' })
      expect(a.status).toBe(502)
      expect(a.body.toString('utf8')).toBe('<html>FOUTTEKST-MARKER</html>')
      expect(leesLog(proces)[0]).toMatchObject({ model: null, http_status: 502, bron: 'none', id: null })
    })
  })

  describe('a key never reaches the log', () => {
    it('masks the key of the request when the upstream echoes it, also when it straddles the 200-character cut, with no key in the environment of the proxy', async () => {
      const token = (v: Verzoek) => (v.authorization ?? '').replace('Bearer ', '')
      const stub = await startStub((v) => ({
        body:
          v.body?.model === 'tekst'
            ? voltooiing({ provider: `P-${v.authorization}`, id: `gen-${v.authorization}` }) // the whole header value
            : voltooiing({ provider: '.'.repeat(190) + token(v), id: `gen-${'.'.repeat(186)}${token(v)}` }), // the key from character 190
      }))
      const proces = await startProxy(stub.url, { env: {} })
      await chatViaProxy(proces, { model: 'tekst' })
      await chatViaProxy(proces, { model: 'rand' })

      const tekst = readFileSync(proces.log, 'utf8')
      expect(leakedFragments(tekst, KEY)).toEqual([])
      for (const kanaal of [proces.stdout(), proces.stderr()]) expect(leakedFragments(kanaal, KEY)).toEqual([])
      const [eerste, tweede] = leesLog(proces)
      expect(eerste.provider).toContain('<redacted>')
      expect(eerste.id).toContain('<redacted>')
      expect(tweede.provider).toBe(`${'.'.repeat(190)}<redacted>`)
      expect(tweede.id).toBe(`gen-${'.'.repeat(186)}<redacted>`)
    })

    it('also masks the keys in its own environment, whatever the Authorization header of the request says', async () => {
      const stub = await startStub(() => ({ body: voltooiing({ provider: `P-${OR_KEY}`, id: `gen-${KEY}` }) }))
      const proces = await startProxy(stub.url, { env: { LITELLM_MASTER_KEY: KEY, OPENROUTER_API_KEY: OR_KEY } })
      await chatViaProxy(proces, { headers: { authorization: 'Bearer een-heel-ander-token-0123456789' } })
      const tekst = readFileSync(proces.log, 'utf8')
      expect(leakedFragments(tekst, KEY)).toEqual([])
      expect(leakedFragments(tekst, OR_KEY)).toEqual([])
      expect(leesLog(proces)[0]).toMatchObject({ provider: 'P-<redacted>', id: 'gen-<redacted>' })
    })

    it('masks a key that turns up in a cost header or in the model of the request, not only in the provider and the id', async () => {
      const stub = await startStub((v) => ({
        headers: { 'x-litellm-response-cost': (v.authorization ?? '').replace('Bearer ', ''), 'llm_provider-x-litellm-response-cost': v.authorization ?? '' },
        body: voltooiing({ provider: 'P', id: 'gen-h' }),
      }))
      const proces = await startProxy(stub.url, { env: {} })
      await chatViaProxy(proces, { model: `model-${KEY}` })
      expect(leakedFragments(readFileSync(proces.log, 'utf8'), KEY)).toEqual([])
      expect(leesLog(proces)[0]).toMatchObject({ model: 'model-<redacted>', kosten_header: '<redacted>', provider_kosten_header: '<redacted>', bedrag: null, bron: 'none' })
    })

    it('leaves a short Authorization token alone: it is a placeholder (Ollama takes any string), and masking it would mangle ordinary text', async () => {
      const stub = await startStub(() => ({ body: voltooiing({ provider: 'none-provider', id: 'gen-none' }) }))
      const proces = await startProxy(stub.url)
      await chatViaProxy(proces, { headers: { authorization: 'Bearer none' } })
      expect(leesLog(proces)[0]).toMatchObject({ provider: 'none-provider', id: 'gen-none' })
    })
  })

  describe('an upstream that gives no answer', () => {
    it('is answered with a 502 and logged with the kind of failure, and the proxy keeps running', async () => {
      const stub = await startStub((v) => (v.body?.model === 'kapot' ? { verbreek: 'voor' } : v.body?.model === 'half' ? { verbreek: 'midden' } : { body: voltooiing({ kosten: 0.0001 }) }))
      const proces = await startProxy(stub.url)

      const a = await chatViaProxy(proces, { model: 'kapot' })
      expect(a.status).toBe(502)
      expect(a.body.length).toBeLessThan(200) // short text
      expect(a.body.toString('utf8')).not.toContain(KEY)
      expect((await chatViaProxy(proces, { model: 'half' })).status).toBe(502) // an answer that breaks off half-way is no answer either
      expect((await chatViaProxy(proces, { model: 'goed' })).status).toBe(200)

      const regels = leesLog(proces)
      expect(regels.map((r) => [r.model, r.http_status, r.bron, r.fout])).toEqual([
        ['kapot', null, 'none', 'ECONNRESET'],
        ['half', null, 'none', 'ECONNRESET'],
        ['goed', 200, 'provider_reported', undefined],
      ])
      const { tijd, fout, ...rest } = regels[0]
      expect(sorted(regels[0])).toEqual([...LOGVELDEN, 'fout'].sort())
      expect(fout).toBe('ECONNRESET')
      expect(new Date(tijd).toISOString()).toBe(tijd)
      expect(rest).toEqual({
        model: 'kapot',
        http_status: null,
        kosten_header: null,
        provider_kosten_header: null,
        body_usage_cost: null,
        provider: null,
        id: null,
        bedrag: null,
        bron: 'none',
        finish_reason: null,
        reasoning_tokens: null,
        toolcalls: null,
      })
      expect(sorted(regels[2])).toEqual(LOGVELDEN) // a normal line has no fout field
      expect(proces.stderr()).toBe('')
    })

    it('logs ECONNREFUSED when nothing listens at the upstream', async () => {
      const proces = await startProxy('http://127.0.0.1:1')
      const a = await chatViaProxy(proces)
      expect(a.status).toBe(502)
      expect(leesLog(proces)[0]).toMatchObject({ model: 'qwen3.8-or', http_status: null, bron: 'none', fout: 'ECONNREFUSED' })
    })

    it('gives a time-out as a 502 with the kind "timeout"', async () => {
      const stub = await startStub(() => ({ vertraging: 3000, body: voltooiing() }))
      const proces = await startProxy(stub.url, { timeoutSec: '0.3' })
      const a = await chatViaProxy(proces)
      expect(a.status).toBe(502)
      expect(leesLog(proces)[0]).toMatchObject({ http_status: null, bron: 'none', fout: 'timeout' })
    })

    it('does not log a request that is not a chat completion', async () => {
      const proces = await startProxy('http://127.0.0.1:1')
      const a = await naarProxy(proces, { methode: 'GET', pad: '/v1/models', headers: AUTH })
      expect(a.status).toBe(502)
      expect(leesLog(proces)).toEqual([])
    })
  })

  describe('a client that goes away', () => {
    it('takes its upstream request with it, and the line says so', async () => {
      const stub = await startStub((v) => ({ vertraging: v.body?.model === 'traag' ? 3000 : 0, body: voltooiing() }))
      const proces = await startProxy(stub.url)
      const req = httpRequest({ host: '127.0.0.1', port: proces.poort, method: 'POST', path: CHAT, headers: AUTH, agent: false })
      req.on('error', () => {})
      req.end(chatBody('traag'))
      await wachtOp(() => (stub.verzoeken.length > 0 ? true : undefined))
      req.destroy()

      const regel = await wachtOp(() => leesLog(proces)[0])
      expect(regel).toMatchObject({ model: 'traag', http_status: null, bron: 'none', fout: 'client_verbroken' })
      await wachtOp(() => (stub.afgebroken.length > 0 ? true : undefined)) // the connection to the upstream was cut as well
      expect((await chatViaProxy(proces, { model: 'weer-goed' })).status).toBe(200) // and the proxy goes on
    })
  })

  describe('starting and stopping', () => {
    it('says on stdout where it listens and nothing else, and stops with exit 0 on SIGTERM and on SIGINT', async () => {
      const stub = await startStub()
      for (const signaal of ['SIGTERM', 'SIGINT'] as const) {
        const proces = await startProxy(stub.url)
        const regel = `proxy luistert op 127.0.0.1:${proces.poort}\n`
        expect(proces.stdout()).toBe(regel)
        expect(proces.stderr()).toBe('')
        proces.signaal(signaal)
        expect(await proces.uitgang, signaal).toBe(0)
        expect(proces.stdout()).toBe(regel)
        expect(proces.stderr()).toBe('')
        await expect(naarProxy(proces, { methode: 'GET', pad: '/' })).rejects.toMatchObject({ code: 'ECONNREFUSED' }) // the port is closed again
      }
    })

    it('treats a signal that arrives the moment the line is read as a stop, not as the default action of the signal', async () => {
      const stub = await startStub()
      // The signal is sent from the callback that reads the line, in the same tick, so it arrives as early as a client can send it.
      for (const signaal of ['SIGTERM', 'SIGINT', 'SIGTERM', 'SIGINT', 'SIGTERM'] as const) {
        const proces = await startProxy(stub.url, { signaalOpRegel: signaal })
        expect(await proces.uitgang, signaal).toBe(0)
      }
    })

    it('is not stopped by SIGHUP, which a dropped terminal sends: only SIGINT and SIGTERM stop it', async () => {
      const stub = await startStub(() => ({ body: voltooiing() }))
      const proces = await startProxy(stub.url)
      proces.signaal('SIGHUP')
      await new Promise((klaar) => setTimeout(klaar, 150))
      expect((await chatViaProxy(proces)).status).toBe(200) // still there
      proces.signaal('SIGTERM')
      expect(await proces.uitgang).toBe(0)
    })

    it('stops right away when a client holds an idle keep-alive connection (the model client of the harness does)', async () => {
      const stub = await startStub(() => ({ body: voltooiing() }))
      const proces = await startProxy(stub.url)
      const agent = new Agent({ keepAlive: true })
      try {
        expect((await chatViaProxy(proces, { agent })).status).toBe(200) // the connection stays open in the pool of the agent
        const start = Date.now()
        proces.signaal('SIGTERM')
        expect(await proces.uitgang).toBe(0)
        expect(Date.now() - start).toBeLessThan(meet.STOP_GRACE_MS)
      } finally {
        agent.destroy()
      }
    })

    it('stops after a grace period when a request is still in flight, and logs that request as dropped', async () => {
      const stub = await startStub(() => ({ vertraging: 10_000, body: voltooiing() }))
      const proces = await startProxy(stub.url)
      const klant = chatViaProxy(proces).catch((e: unknown) => e) // the proxy cuts it: socket hang up
      await wachtOp(() => (stub.verzoeken.length > 0 ? true : undefined))
      const start = Date.now()
      proces.signaal('SIGTERM')
      expect(await proces.uitgang).toBe(0)
      expect(Date.now() - start).toBeLessThan(meet.STOP_GRACE_MS + 3000)
      expect(await klant).toBeInstanceOf(Error)
      expect(leesLog(proces)).toEqual([expect.objectContaining({ model: 'qwen3.8-or', http_status: null, fout: 'client_verbroken' })])
    })

    it.skipIf(!LAN_ADRES)('listens on 127.0.0.1 only: the port is closed on the other addresses of the machine', async () => {
      const stub = await startStub()
      const proces = await startProxy(stub.url)
      const fout = await new Promise<NodeJS.ErrnoException | null>((klaar) => {
        const verbinding = connect({ host: LAN_ADRES ?? '', port: proces.poort }, () => {
          verbinding.destroy()
          klaar(null)
        })
        verbinding.on('error', (e: NodeJS.ErrnoException) => klaar(e))
      })
      expect(fout?.code).toBe('ECONNREFUSED')
    })

    it('exits 1 with a message when it cannot listen, and leaves no log file behind', async () => {
      const stub = await startStub()
      const eerste = await startProxy(stub.url)
      const log = join(nieuweMap(), 'tweede.jsonl')
      const r = await draaiProxy(['--listen', `127.0.0.1:${eerste.poort}`, '--upstream', stub.url, '--log', log])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('EADDRINUSE')
      expect(r.stdout).toBe('')
      expect(existsSync(log)).toBe(false) // a rerun with the same --log must be possible
    })
  })

  describe('a wrong option is exit 2 before it listens', () => {
    it.each([
      ['a host other than 127.0.0.1', ['--listen', '0.0.0.0:4001'], '--listen'],
      ['a host name', ['--listen', 'localhost:4001'], '--listen'],
      ['an IPv6 host', ['--listen', '[::1]:4001'], '--listen'],
      ['no port', ['--listen', '127.0.0.1'], '--listen'],
      ['an empty port', ['--listen', '127.0.0.1:'], '--listen'],
      ['a port that is no number', ['--listen', '127.0.0.1:abc'], '--listen'],
      ['a port that is too large', ['--listen', '127.0.0.1:70000'], '--listen'],
      ['a negative port', ['--listen', '127.0.0.1:-1'], '--listen'],
      ['an upstream that is not http(s)', ['--upstream', 'ftp://127.0.0.1:4000'], '--upstream'],
      ['an upstream that is no url at all', ['--upstream', 'niet een url'], '--upstream'],
      ['a --timeout-sec of 0', ['--timeout-sec', '0'], '--timeout-sec'],
      ['a --timeout-sec that is not a number', ['--timeout-sec', 'abc'], '--timeout-sec'],
      ['an unknown option', ['--bogus'], '--bogus'],
    ])('%s', async (_naam, afwijking, genoemd) => {
      const stub = await startStub()
      const log = join(nieuweMap(), 'antwoorden.jsonl')
      const basis: Record<string, string> = { '--listen': '127.0.0.1:0', '--upstream': stub.url, '--log': log }
      const args = Object.entries(basis).flatMap(([k, w]) => (afwijking[0] === k ? [] : [k, w]))
      const r = await draaiProxy([...args, ...afwijking])
      expect(r.code).toBe(2)
      expect(eersteRegel(r)).toContain(genoemd)
      expect(r.stderr).toContain('Gebruik')
      expect(r.stdout).toBe('')
      expect(stub.verzoeken).toHaveLength(0)
      expect(existsSync(log)).toBe(false)
    })

    it.each(['--listen', '--upstream', '--log'])('a missing %s', async (ontbrekend) => {
      const stub = await startStub()
      const log = join(nieuweMap(), 'antwoorden.jsonl')
      const basis: Record<string, string> = { '--listen': '127.0.0.1:0', '--upstream': stub.url, '--log': log }
      const args = Object.entries(basis).flatMap(([k, w]) => (k === ontbrekend ? [] : [k, w]))
      const r = await draaiProxy(args)
      expect(r.code).toBe(2)
      expect(eersteRegel(r)).toContain(`ontbrekende optie: ${ontbrekend}`)
      expect(r.stdout).toBe('')
    })

    it('a --log that already exists: the earlier file is left untouched', async () => {
      const stub = await startStub()
      const log = join(nieuweMap(), 'antwoorden.jsonl')
      writeFileSync(log, 'STALE')
      const r = await draaiProxy(['--listen', '127.0.0.1:0', '--upstream', stub.url, '--log', log])
      expect(r.code).toBe(2)
      expect(eersteRegel(r)).toContain('--log')
      expect(r.stdout).toBe('')
      expect(readFileSync(log, 'utf8')).toBe('STALE')
    })
  })
})

// ---- test 8 ----

// A stub that plays OpenRouter. Every field the script must not keep carries EXTRA, so a leak shows up as a plain string search.
const GEN_PAD = '/api/v1/generation'
const ENDPOINTS_PAD = '/api/v1/models/qwen/qwen3.8-27b/endpoints'
const OUD = '2026-01-01T00:00:00.000Z' // long ago: no wait before a lookup
const EXTRA = 'EXTRA-MARKER-niet-bewaren'

type Generatie = { provider_name?: unknown; total_cost?: unknown; status?: number; body?: unknown; verbreek?: 'voor' }

// Alibaba only bf16, AkashML bf16 and fp8, DeepInfra only fp8, Zonder without a precision.
const ENDPOINTLIJST = [
  { provider_name: 'Alibaba', quantization: 'bf16' },
  { provider_name: 'AkashML', quantization: 'bf16' },
  { provider_name: 'AkashML', quantization: 'fp8' },
  { provider_name: 'DeepInfra', quantization: 'fp8' },
  { provider_name: 'Zonder', quantization: null },
]

function openRouter(o: { generaties?: Record<string, Generatie>; endpoints?: Stuur; lijst?: object[] } = {}): Handler {
  return (v) => {
    if (v.methode !== 'GET') return undefined
    const url = new URL(v.pad, 'http://stub')
    if (url.pathname === GEN_PAD) {
      const id = url.searchParams.get('id') ?? ''
      const g = o.generaties?.[id]
      if (g === undefined) return { status: 404, body: { error: { message: `Generation ${id} not found`, code: 404 } } }
      if (g.verbreek) return { verbreek: g.verbreek }
      const data = { id, provider_name: 'provider_name' in g ? g.provider_name : 'Alibaba', total_cost: 'total_cost' in g ? g.total_cost : 0.00012, model: EXTRA, upstream_id: EXTRA, tokens_prompt: 18 }
      return { status: g.status ?? 200, body: g.body ?? { data } }
    }
    if (url.pathname === ENDPOINTS_PAD) {
      const endpoints = (o.lijst ?? ENDPOINTLIJST).map((e) => ({ ...e, tag: EXTRA, pricing: { prompt: EXTRA }, context_length: 131072 }))
      return o.endpoints ?? { body: { data: { id: 'qwen/qwen3.8-27b', name: EXTRA, endpoints } } }
    }
    return undefined
  }
}

const antwoordRegel = (id: string | null, o: object = {}) => ({ tijd: OUD, model: 'qwen3.8-or', http_status: 200, id, bedrag: 0.00012, bron: 'provider_reported', ...o })

/** Writes meting.json (its cost lines) and/or antwoorden.jsonl in `map`; returns the paths, to be passed with --in. */
function schrijfInvoer(map: string, o: { meting?: object[]; antwoorden?: object[] }): string[] {
  const paden: string[] = []
  if (o.meting) {
    paden.push(join(map, 'meting.json'))
    writeFileSync(paden.at(-1) as string, JSON.stringify({ readiness: { http_status: 200 }, cost: o.meting }))
  }
  if (o.antwoorden) {
    paden.push(join(map, 'antwoorden.jsonl'))
    writeFileSync(paden.at(-1) as string, `${o.antwoorden.map((r) => JSON.stringify(r)).join('\n')}\n`)
  }
  return paden
}

/** `opzoeken` against the stub (always with --base-url: the script must never reach the real OpenRouter from a test). */
function draaiOpzoeken(stub: Stub, o: { invoer: string[]; out: string; env?: Record<string, string>; extra?: string[] }): Promise<Uitslag> {
  const args = ['opzoeken', ...o.invoer.flatMap((f) => ['--in', f]), '--out', o.out, '--base-url', stub.url, ...(o.extra ?? [])]
  return draai(args, o.env ?? { OPENROUTER_API_KEY: OR_KEY })
}

/** An error body that holds the Authorization header of the request from character 190 on, so the key itself starts at character 190. */
function echoBodyOr(authorization: string | undefined): string {
  const kop = '{"error":{"message":"'
  return `${kop}${'.'.repeat(190 - 'Bearer '.length - kop.length)}${authorization ?? 'Bearer none'} ${'tail '.repeat(40)}"}}`
}

const genVerzoeken = (stub: Stub) => stub.verzoeken.filter((v) => v.pad.startsWith(GEN_PAD))

describe('test 8: opzoeken keeps only the provider, the cost and the precision, and is careful with the key', () => {
  it.each([
    ['OPENROUTER_API_KEY is not set', {}],
    ['OPENROUTER_API_KEY is empty', { OPENROUTER_API_KEY: '' }],
    ['OPENROUTER_API_KEY holds characters that cannot go in a header', { OPENROUTER_API_KEY: 'sk bad key\n' }],
    ['only the master key of LiteLLM is set', { LITELLM_MASTER_KEY: KEY }],
  ])('%s: exit 2 before the first request, and nothing is written', async (_naam, env) => {
    const stub = await startStub(openRouter({ generaties: { 'gen-a': {} } }))
    const map = nieuweMap()
    const invoer = schrijfInvoer(map, { antwoorden: [antwoordRegel('gen-a')] })
    const out = join(map, 'opzoeken.json')
    const r = await draaiOpzoeken(stub, { invoer, out, env })
    expect(r.code).toBe(2)
    expect(stub.verzoeken).toHaveLength(0)
    expect(existsSync(out)).toBe(false)
    expect(eersteRegel(r)).toContain('OPENROUTER_API_KEY')
    expect(r.stderr).not.toContain('bad key')
    expect(r.stdout).toBe('')
  })

  describe('a wrong option or input is exit 2 before the first request', () => {
    // Each entry builds the arguments after the mode name (`goed` is a valid input file) and names what the message line must mention.
    const gevallen: Array<[string, string, (map: string, stub: Stub, goed: string) => string[]]> = [
      ['no --in', '--in', (map, stub) => ['--out', join(map, 'o.json'), '--base-url', stub.url]],
      ['no --out', '--out', (_map, stub, goed) => ['--in', goed, '--base-url', stub.url]],
      ['an unknown option', '--bogus', (map, stub, goed) => ['--in', goed, '--out', join(map, 'o.json'), '--base-url', stub.url, '--bogus']],
      ['an empty --in', '--in', (map, stub) => ['--in', '', '--out', join(map, 'o.json'), '--base-url', stub.url]],
      ['an --in that does not exist', 'bestaat-niet.jsonl', (map, stub) => ['--in', join(map, 'bestaat-niet.jsonl'), '--out', join(map, 'o.json'), '--base-url', stub.url]],
      ['a base url that is not http(s)', '--base-url', (map, _stub, goed) => ['--in', goed, '--out', join(map, 'o.json'), '--base-url', 'ftp://127.0.0.1:1']],
      [
        'a meting.json that is no JSON',
        'meting.json',
        (map, stub) => {
          writeFileSync(join(map, 'meting.json'), '{ niet af')
          return ['--in', join(map, 'meting.json'), '--out', join(map, 'o.json'), '--base-url', stub.url]
        },
      ],
      [
        'a meting.json whose cost is no list',
        'cost',
        (map, stub) => {
          writeFileSync(join(map, 'meting.json'), '{"cost": {"a": 1}}')
          return ['--in', join(map, 'meting.json'), '--out', join(map, 'o.json'), '--base-url', stub.url]
        },
      ],
      [
        'a meting.json that is a list',
        'meting.json',
        (map, stub) => {
          writeFileSync(join(map, 'meting.json'), '[]')
          return ['--in', join(map, 'meting.json'), '--out', join(map, 'o.json'), '--base-url', stub.url]
        },
      ],
      [
        'an antwoorden.jsonl with a line that is no JSON',
        'antwoorden.jsonl',
        (map, stub) => {
          writeFileSync(join(map, 'antwoorden.jsonl'), `${JSON.stringify(antwoordRegel('gen-a'))}\n{ afgebroken\n`)
          return ['--in', join(map, 'antwoorden.jsonl'), '--out', join(map, 'o.json'), '--base-url', stub.url]
        },
      ],
    ]

    it.each(gevallen)('%s', async (_naam, genoemd, bouw) => {
      const stub = await startStub(openRouter({ generaties: { 'gen-a': {} } }))
      const map = nieuweMap()
      const goed = join(map, 'goed.jsonl')
      writeFileSync(goed, `${JSON.stringify(antwoordRegel('gen-a'))}\n`)
      const r = await draai(['opzoeken', ...bouw(map, stub, goed)], { OPENROUTER_API_KEY: OR_KEY })
      expect(r.code).toBe(2)
      expect(eersteRegel(r)).toContain(genoemd)
      expect(r.stderr).toContain('Gebruik')
      expect(r.stdout).toBe('')
      expect(stub.verzoeken).toHaveLength(0)
      expect(existsSync(join(map, 'o.json'))).toBe(false)
    })

    it('an --out that already exists: the earlier file is left untouched', async () => {
      const stub = await startStub(openRouter({ generaties: { 'gen-a': {} } }))
      const map = nieuweMap()
      const invoer = schrijfInvoer(map, { antwoorden: [antwoordRegel('gen-a')] })
      const out = join(map, 'opzoeken.json')
      writeFileSync(out, 'STALE')
      const r = await draaiOpzoeken(stub, { invoer, out })
      expect(r.code).toBe(2)
      expect(eersteRegel(r)).toContain('--out')
      expect(stub.verzoeken).toHaveLength(0)
      expect(readFileSync(out, 'utf8')).toBe('STALE')
    })
  })

  it('looks up every gen- answer of qwen3.8-or once, from both files, and fetches the endpoint list once', async () => {
    const speciaal = 'gen-met spatie/en&x=1' // the id goes into the query string: it has to be encoded
    const stub = await startStub(
      openRouter({
        generaties: {
          'gen-alibaba': {},
          'gen-akash': { provider_name: 'AkashML', total_cost: 0.0002 },
          'gen-deepinfra': { provider_name: 'DeepInfra', total_cost: 0.0003 },
          'gen-onbekend': { provider_name: 'NietInDeLijst', total_cost: 0.0004 },
          'gen-zonder': { provider_name: 'Zonder' },
          [speciaal]: {},
        },
      }),
    )
    const map = nieuweMap()
    const invoer = schrijfInvoer(map, {
      meting: [
        { stap: 'reasoning', vorm: 1, ...antwoordRegel('gen-alibaba') },
        { stap: 'reasoning', vorm: 2, ...antwoordRegel('gen-akash', { bedrag: 0.0002 }) },
        { stap: 'canary', ...antwoordRegel(speciaal) },
      ],
      antwoorden: [
        antwoordRegel('gen-deepinfra'),
        antwoordRegel('gen-alibaba', { tijd: '2026-02-02T00:00:00.000Z' }), // the same answer again: looked up once
        antwoordRegel('gen-zonder'),
        antwoordRegel('gen-onbekend'),
        antwoordRegel('gen-lokaal-niet', { model: 'gsq-lokaal' }), // another configuration: not looked up
        antwoordRegel('gen-neg-niet', { model: 'qwen3.8-or-neg' }), // the negative control: not looked up either
      ],
    })
    const out = join(map, 'opzoeken.json')
    const r = await draaiOpzoeken(stub, { invoer, out })
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')

    // The requests: the endpoint list once, each lookup once, in the order of first appearance, always with the key in the header.
    expect(stub.verzoeken.filter((v) => v.pad === ENDPOINTS_PAD)).toHaveLength(1)
    expect(genVerzoeken(stub).map((v) => new URL(v.pad, 'http://stub').searchParams.get('id'))).toEqual(['gen-alibaba', 'gen-akash', speciaal, 'gen-deepinfra', 'gen-zonder', 'gen-onbekend'])
    expect(stub.verzoeken).toHaveLength(7)
    for (const v of stub.verzoeken) {
      expect(v.methode).toBe('GET')
      expect(v.authorization).toBe(`Bearer ${OR_KEY}`)
      expect(v.pad).not.toContain(OR_KEY)
    }

    // The output: exactly the agreed shape, nothing else of what OpenRouter sent.
    const uit = lees(map, 'opzoeken.json')
    expect(sorted(uit)).toEqual(['antwoorden', 'endpoints'])
    expect(uit.endpoints).toEqual({ http_status: 200, lijst: ENDPOINTLIJST })
    expect(uit.antwoorden.map((a: Json) => a.id)).toEqual(['gen-alibaba', 'gen-akash', speciaal, 'gen-deepinfra', 'gen-zonder', 'gen-onbekend'])
    for (const a of uit.antwoorden) {
      expect(sorted(a)).toEqual(['bedrag', 'bron', 'id', 'oordeel', 'opzoeking', 'tijd'])
      expect(sorted(a.opzoeking)).toEqual(['http_status', 'provider_name', 'total_cost'])
    }
    expect(uit.antwoorden.map((a: Json) => [a.opzoeking.provider_name, a.opzoeking.total_cost, a.oordeel])).toEqual([
      ['Alibaba', 0.00012, 'bf16 volgens endpointlijst'],
      ['AkashML', 0.0002, 'precisie niet eenduidig aangetoond'],
      ['Alibaba', 0.00012, 'bf16 volgens endpointlijst'],
      ['DeepInfra', 0.0003, 'niet in BF16-lijst'],
      ['Zonder', 0.00012, 'niet in BF16-lijst'],
      ['NietInDeLijst', 0.0004, 'niet in BF16-lijst'],
    ])
    expect(uit.antwoorden[0]).toEqual({ id: 'gen-alibaba', tijd: OUD, bron: 'provider_reported', bedrag: 0.00012, opzoeking: { http_status: 200, provider_name: 'Alibaba', total_cost: 0.00012 }, oordeel: 'bf16 volgens endpointlijst' })
    expect(dirContains(map, EXTRA)).toBe(false)
    for (const kanaal of [r.stdout, r.stderr, readFileSync(out, 'utf8')]) expect(leakedFragments(kanaal, OR_KEY)).toEqual([])
    expect(r.stdout).toBe('endpoints 200\nopzoeken 6 antwoorden, 6 opgezocht, 6 met aanbieder\n')
  })

  it('judges the provider of an answer against the endpoint list: one precision, several, another one, none', async () => {
    const stub = await startStub(
      openRouter({
        lijst: [
          { provider_name: 'EenBf16', quantization: 'bf16' },
          { provider_name: 'TweeKeerBf16', quantization: 'bf16' },
          { provider_name: 'TweeKeerBf16', quantization: 'BF16' }, // the same precision, written differently
          { provider_name: 'Gemengd', quantization: 'bf16' },
          { provider_name: 'Gemengd', quantization: 'fp8' },
          { provider_name: 'Anders', quantization: 'fp8' },
          { provider_name: 'LeegEnBf16', quantization: null },
          { provider_name: 'LeegEnBf16', quantization: 'bf16' },
        ],
        generaties: {
          'gen-1': { provider_name: 'EenBf16' },
          'gen-2': { provider_name: 'TweeKeerBf16' },
          'gen-3': { provider_name: 'Gemengd' },
          'gen-4': { provider_name: 'Anders' },
          'gen-5': { provider_name: 'Afwezig' },
          'gen-6': { provider_name: 'eenbf16 ' }, // the name as another case with a trailing space still is that provider
          'gen-7': { provider_name: 'LeegEnBf16' },
        },
      }),
    )
    const map = nieuweMap()
    const invoer = schrijfInvoer(map, { antwoorden: [1, 2, 3, 4, 5, 6, 7].map((n) => antwoordRegel(`gen-${n}`)) })
    const out = join(map, 'opzoeken.json')
    expect((await draaiOpzoeken(stub, { invoer, out })).code).toBe(0)
    expect(lees(map, 'opzoeken.json').antwoorden.map((a: Json) => a.oordeel)).toEqual([
      'bf16 volgens endpointlijst',
      'bf16 volgens endpointlijst',
      'precisie niet eenduidig aangetoond',
      'niet in BF16-lijst',
      'niet in BF16-lijst',
      'bf16 volgens endpointlijst',
      'precisie niet eenduidig aangetoond',
    ])
  })

  it('gives an answer without a gen- id "aanbieder niet gemeten via OpenRouter", without a request', async () => {
    const stub = await startStub(openRouter({ generaties: { 'gen-ok': {} } }))
    const map = nieuweMap()
    const invoer = schrijfInvoer(map, {
      antwoorden: [
        antwoordRegel('chatcmpl-123'), // not a generation id
        antwoordRegel(null, { http_status: null, bedrag: null, bron: 'none', fout: 'ECONNRESET' }), // no answer at all
        antwoordRegel('GEN-hoofdletters'),
        antwoordRegel('gen-ok'),
        antwoordRegel('gen-'), // the prefix alone is an id too: looked up (and not found)
      ],
    })
    const out = join(map, 'opzoeken.json')
    const r = await draaiOpzoeken(stub, { invoer, out })
    expect(r.code).toBe(0)
    expect(genVerzoeken(stub).map((v) => new URL(v.pad, 'http://stub').searchParams.get('id'))).toEqual(['gen-ok', 'gen-'])
    const uit = lees(map, 'opzoeken.json')
    expect(uit.antwoorden.map((a: Json) => [a.id, a.oordeel])).toEqual([
      ['chatcmpl-123', 'aanbieder niet gemeten via OpenRouter'],
      [null, 'aanbieder niet gemeten via OpenRouter'],
      ['GEN-hoofdletters', 'aanbieder niet gemeten via OpenRouter'],
      ['gen-ok', 'bf16 volgens endpointlijst'],
      ['gen-', 'niet gemeten (opzoeking mislukt)'],
    ])
    expect(uit.antwoorden[0].opzoeking).toBeNull()
    expect(uit.antwoorden[1].opzoeking).toBeNull()
    expect(sorted(uit.antwoorden[1])).toEqual(['bedrag', 'bron', 'id', 'oordeel', 'opzoeking', 'tijd'])
    expect(r.stdout).toBe('endpoints 200\nopzoeken 5 antwoorden, 2 opgezocht, 1 met aanbieder\n')
  })

  it('keeps the status and a masked excerpt of a failed lookup or endpoint list, and the key that the body echoes does not get out', async () => {
    const stub = await startStub((v) => {
      const url = new URL(v.pad, 'http://stub')
      if (url.pathname === GEN_PAD && url.searchParams.get('id') === 'gen-500') return { status: 500, body: echoBodyOr(v.authorization) }
      if (url.pathname === GEN_PAD && url.searchParams.get('id') === 'gen-rand') {
        // A 200 whose provider_name holds the key from character 190: the cut of a name must come after the mask.
        return { body: { data: { provider_name: '.'.repeat(190) + (v.authorization ?? '').replace('Bearer ', ''), total_cost: 0.1 } } }
      }
      if (url.pathname === GEN_PAD && url.searchParams.get('id') === 'gen-geen-naam') return { body: { data: { total_cost: 0.1 } } }
      if (url.pathname === ENDPOINTS_PAD) return { status: 502, body: echoBodyOr(v.authorization) }
      return undefined
    })
    const map = nieuweMap()
    const invoer = schrijfInvoer(map, { antwoorden: [antwoordRegel('gen-500'), antwoordRegel('gen-rand'), antwoordRegel('gen-geen-naam')] })
    const out = join(map, 'opzoeken.json')
    const r = await draaiOpzoeken(stub, { invoer, out, env: { OPENROUTER_API_KEY: OR_KEY, LITELLM_MASTER_KEY: KEY } })

    expect(r.code).toBe(0) // a 5xx answer is an answer
    expect(stub.verzoeken[0].authorization).toBe(`Bearer ${OR_KEY}`) // the script did send the key, in the header only
    const tekst = readFileSync(out, 'utf8')
    for (const [waar, inhoud] of Object.entries({ stdout: r.stdout, stderr: r.stderr, uitvoer: tekst })) {
      expect(leakedFragments(inhoud, OR_KEY), `${waar} holds part of the OpenRouter key`).toEqual([])
      expect(leakedFragments(inhoud, KEY), `${waar} holds part of the master key`).toEqual([])
    }
    const uit = JSON.parse(tekst)
    expect(sorted(uit.endpoints)).toEqual(['excerpt', 'http_status', 'lijst'])
    expect(uit.endpoints).toMatchObject({ http_status: 502, lijst: [] })
    expect(uit.endpoints.excerpt).toContain('<redacted>')
    expect(uit.endpoints.excerpt.length).toBeLessThanOrEqual(200)
    expect(uit.endpoints.excerpt.startsWith('{"error":{"message":"....')).toBe(true)

    const [fout, rand, geenNaam] = uit.antwoorden
    expect(sorted(fout.opzoeking)).toEqual(['excerpt', 'http_status', 'provider_name', 'total_cost'])
    expect(fout.opzoeking).toMatchObject({ http_status: 500, provider_name: null, total_cost: null })
    expect(fout.opzoeking.excerpt).toContain('<redacted>') // masked, not dropped
    expect(fout.opzoeking.excerpt.length).toBeLessThanOrEqual(200)
    expect(fout.opzoeking.excerpt.startsWith('{"error":{"message":"....')).toBe(true)
    expect(rand.opzoeking.provider_name).toBe(`${'.'.repeat(190)}<redacted>`)
    expect(geenNaam.opzoeking).toEqual({ http_status: 200, provider_name: null, total_cost: 0.1 })
    // The endpoint list did not come, so no answer can be set against it; a lookup without a provider name cannot be judged at all.
    expect(uit.antwoorden.map((a: Json) => a.oordeel)).toEqual(['niet gemeten (opzoeking mislukt)', 'niet gemeten (endpointlijst mislukt)', 'niet gemeten (opzoeking mislukt)'])
  })

  it('treats an endpoint list that is no list as a list that failed', async () => {
    const stub = await startStub(openRouter({ generaties: { 'gen-a': {} }, endpoints: { body: { data: { endpoints: 'geen lijst' } } } }))
    const map = nieuweMap()
    const out = join(map, 'opzoeken.json')
    const r = await draaiOpzoeken(stub, { invoer: schrijfInvoer(map, { antwoorden: [antwoordRegel('gen-a')] }), out })
    expect(r.code).toBe(0)
    expect(lees(map, 'opzoeken.json').endpoints).toEqual({ http_status: 200, lijst: [] })
    expect(lees(map, 'opzoeken.json').antwoorden[0].oordeel).toBe('niet gemeten (endpointlijst mislukt)')
  })

  it('stops at a lookup without an HTTP answer, keeps what it has, and exits 1', async () => {
    const stub = await startStub(openRouter({ generaties: { 'gen-1': {}, 'gen-2': { verbreek: 'voor' }, 'gen-3': {} } }))
    const map = nieuweMap()
    const out = join(map, 'opzoeken.json')
    const invoer = schrijfInvoer(map, { antwoorden: [antwoordRegel('chatcmpl-1'), antwoordRegel('gen-1'), antwoordRegel('gen-2'), antwoordRegel('gen-3')] })
    const r = await draaiOpzoeken(stub, { invoer, out })
    expect(r.code).toBe(1)
    expect(genVerzoeken(stub)).toHaveLength(2) // nothing after the cut
    const uit = lees(map, 'opzoeken.json')
    expect(uit.afgebroken).toEqual({ stap: 'generation', reden: 'ECONNRESET' })
    expect(uit.endpoints.http_status).toBe(200)
    expect(uit.antwoorden.map((a: Json) => a.id)).toEqual(['chatcmpl-1', 'gen-1'])
    expect(r.stderr).toContain('generation')
    expect(r.stderr).toContain('ECONNRESET')
  })

  it('stops at an endpoint list without an HTTP answer, before any lookup', async () => {
    const stub = await startStub((v) => (v.pad === ENDPOINTS_PAD ? { verbreek: 'voor' } : undefined))
    const map = nieuweMap()
    const out = join(map, 'opzoeken.json')
    const r = await draaiOpzoeken(stub, { invoer: schrijfInvoer(map, { antwoorden: [antwoordRegel('gen-1')] }), out })
    expect(r.code).toBe(1)
    expect(genVerzoeken(stub)).toHaveLength(0)
    expect(lees(map, 'opzoeken.json')).toEqual({ antwoorden: [], afgebroken: { stap: 'endpoints', reden: 'ECONNRESET' } })
  })

  it('exits 1 when nothing listens at the base url', async () => {
    const stub = await startStub()
    const map = nieuweMap()
    const out = join(map, 'opzoeken.json')
    const args = ['opzoeken', '--in', schrijfInvoer(map, { antwoorden: [antwoordRegel('gen-1')] })[0], '--out', out, '--base-url', 'http://127.0.0.1:1']
    const r = await draai(args, { OPENROUTER_API_KEY: OR_KEY })
    expect(r.code).toBe(1)
    expect(lees(map, 'opzoeken.json').afgebroken).toEqual({ stap: 'endpoints', reden: 'ECONNREFUSED' })
    expect(stub.verzoeken).toHaveLength(0)
  })

  it('looks an answer up 10 s after it came, and waits only for the rest of that time', async () => {
    const tijd = new Date(Date.now() - 9_500).toISOString()
    let aankomst = 0
    const handler = openRouter({ generaties: { 'gen-nieuw': {} } })
    const stub = await startStub((v) => {
      if (v.pad.startsWith(GEN_PAD)) aankomst = Date.now()
      return handler(v)
    })
    const map = nieuweMap()
    const out = join(map, 'opzoeken.json')
    const r = await draaiOpzoeken(stub, { invoer: schrijfInvoer(map, { antwoorden: [antwoordRegel('gen-nieuw', { tijd })] }), out })
    expect(r.code).toBe(0)
    // The clock of a timer may run a millisecond or so ahead of Date.now(); without the wait the lookup would be 500 ms too early.
    expect(aankomst).toBeGreaterThanOrEqual(Date.parse(tijd) + 10_000 - 25)
    expect(lees(map, 'opzoeken.json').antwoorden[0].oordeel).toBe('bf16 volgens endpointlijst')
  })
})

// ---- test 9 ----

const GSQ_INSTELLINGEN = { name: 'qwen3.8-gsq-rco:27b-iq3_s-text', reasoningEffort: 'none', extraBody: { top_p: 0.95, chat_template_kwargs: { enable_thinking: false } } }
const RUN_EXTRA_OR = { reasoning: { effort: 'medium' } }
const DOC_TOOLS = ['search_product_docs', 'get_product_doc', 'list_product_docs', 'related_product_docs']
// The docs run of M5 (docs/runbooks/model-comparison.md, "Eerste run met docs"), word for word.
const M5_DOCS_RUN = {
  profile: 'tools',
  system:
    'Je beantwoordt vragen over de productdocumentatie. Zoek het antwoord op met de documentatietools en geef bij elke aanroep product_id "fixture-docs" mee. Noem bij je antwoord de doc waar het vandaan komt, als folder/slug.',
  history: [
    { role: 'user', content: 'Ik ga je een paar vragen stellen over de probe.' },
    { role: 'assistant', content: 'Prima. Stel je vraag, dan zoek ik het op in de documentatie.' },
  ],
  prompt: 'Hoeveel stappen noemt het ontwerp van de probe in de sectie Aanpak, en wat doet de laatste stap?',
  limits: { maxTurns: 8, maxOutputTokens: 4096, maxWallSeconds: 240, maxToolErrors: 2, contextTokens: 65536 },
}
const MANIFEST_UITVOER = ['run-gsq-lokaal.json', 'run-qwen3.8-or.json', 'probe-extra-gsq.json']

/**
 * A directory with the two inputs of `manifesten`, and a stand-in for the checkout with the two paths that the manifests point at.
 * A string is written as it is (for a file that is no JSON); undefined leaves the file out.
 */
function maakManifestInvoer(o: { gsq?: unknown; extraOr?: unknown; zonderCli?: boolean; zonderDocset?: boolean } = {}): { uit: string; repo: string } {
  const uit = nieuweMap()
  const repo = nieuweMap()
  const schrijf = (naam: string, waarde: unknown) => {
    if (waarde !== undefined) writeFileSync(join(uit, naam), typeof waarde === 'string' ? waarde : JSON.stringify(waarde))
  }
  schrijf('gsq-lokaal.json', 'gsq' in o ? o.gsq : GSQ_INSTELLINGEN)
  schrijf('run-extra-or.json', 'extraOr' in o ? o.extraOr : RUN_EXTRA_OR)
  if (!o.zonderCli) {
    mkdirSync(join(repo, 'dist'), { recursive: true })
    writeFileSync(join(repo, 'dist', 'cli.js'), '')
  }
  if (!o.zonderDocset) mkdirSync(join(repo, '__tests__', 'fixtures', 'docset'), { recursive: true })
  return { uit, repo }
}

function draaiManifesten(uit: string, repo: string, cwd?: string): Promise<Uitslag> {
  return draai(['manifesten', '--uit', uit, '--repo', repo], {}, SCRIPT, cwd)
}

describe('test 9: manifesten writes the M5 docs run for both configurations, and the probe fields of the local one', () => {
  it('writes both run manifests and the probe fields, and both are valid for the harness', async () => {
    const { uit, repo } = maakManifestInvoer()
    const r = await draaiManifesten(uit, repo)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('geschreven run-gsq-lokaal.json\ngeschreven run-qwen3.8-or.json\ngeschreven probe-extra-gsq.json\n')
    expect(readdirSync(uit).sort()).toEqual(['gsq-lokaal.json', 'probe-extra-gsq.json', 'run-extra-or.json', 'run-gsq-lokaal.json', 'run-qwen3.8-or.json'])

    // The harness itself accepts them (loadManifest throws on anything it would refuse).
    loadManifest(join(uit, 'run-gsq-lokaal.json'))
    loadManifest(join(uit, 'run-qwen3.8-or.json'))
    const gsq = lees(uit, 'run-gsq-lokaal.json')
    const hosted = lees(uit, 'run-qwen3.8-or.json')

    // The docs run of M5, the same for both; the doc server runs from the checkout.
    const docServer = {
      server: { command: 'node', args: [join(repo, 'dist', 'cli.js'), 'doc-server', '--dir', join(repo, '__tests__', 'fixtures', 'docset'), '--product-id', 'fixture-docs'] },
      allow: DOC_TOOLS,
    }
    for (const manifest of [gsq, hosted]) expect(manifest).toMatchObject({ ...M5_DOCS_RUN, tools: docServer })
    expect(sorted(gsq)).toEqual(['history', 'id', 'limits', 'model', 'profile', 'prompt', 'system', 'tools'])
    expect(sorted(hosted)).toEqual(sorted(gsq))

    // The model block: through the proxy, under the name of the configuration, the thinking settings of each.
    expect(gsq.model).toEqual({ baseUrl: 'http://127.0.0.1:4001/v1', name: 'gsq-lokaal', reasoningEffort: GSQ_INSTELLINGEN.reasoningEffort, extraBody: GSQ_INSTELLINGEN.extraBody })
    expect(hosted.model).toEqual({ baseUrl: 'http://127.0.0.1:4001/v1', name: 'qwen3.8-or', extraBody: RUN_EXTRA_OR })
    expect(sorted(hosted.model)).toEqual(['baseUrl', 'extraBody', 'name']) // no reasoningEffort: the form of run-extra-or.json is the whole instruction

    // The ids are unique, and are the names of the run directories.
    expect(gsq.id).toBe('m45-gsq-lokaal')
    expect(hosted.id).toBe('m45-qwen3-8-or') // the schema allows no dot in an id
    expect(gsq.id).not.toBe(hosted.id)

    // Never a key and never a provider block (LiteLLM sets that), and nothing of M5 that was not asked for.
    for (const manifest of [gsq, hosted]) {
      const sleutels = sleutelsIn(manifest)
      for (const verboden of ['apiKey', 'api_key', 'provider', 'temperature', 'seed']) expect(sleutels, verboden).not.toContain(verboden)
    }

    // The probe gets the fields that the request of the local configuration really carries: its extraBody and its reasoning_effort.
    const probe = lees(uit, 'probe-extra-gsq.json')
    expect(probe).toEqual({ ...GSQ_INSTELLINGEN.extraBody, reasoning_effort: 'none' })
    expect(probe).toEqual({ ...gsq.model.extraBody, reasoning_effort: gsq.model.reasoningEffort })
  })

  it.each([
    ['no thinking setting and no extra fields', { name: 'x', reasoningEffort: null, extraBody: null }, {}, {}],
    ['a thinking setting only', { name: 'x', reasoningEffort: 'none', extraBody: null }, { reasoningEffort: 'none' }, { reasoning_effort: 'none' }],
    ['extra fields only', { name: 'x', reasoningEffort: null, extraBody: { temperature: 0.2 } }, { extraBody: { temperature: 0.2 } }, { temperature: 0.2 }],
    ['an empty extraBody counts as none', { name: 'x', reasoningEffort: 'low', extraBody: {} }, { reasoningEffort: 'low' }, { reasoning_effort: 'low' }],
    [
      'a reasoning_effort in the extra fields, next to no thinking setting',
      { name: 'x', reasoningEffort: null, extraBody: { reasoning_effort: 'medium', top_k: 20 } },
      { extraBody: { reasoning_effort: 'medium', top_k: 20 } },
      { reasoning_effort: 'medium', top_k: 20 },
    ],
    [
      'a nested reasoning object next to a thinking setting',
      { name: 'x', reasoningEffort: 'high', extraBody: { reasoning: { effort: 'high' } } },
      { reasoningEffort: 'high', extraBody: { reasoning: { effort: 'high' } } },
      { reasoning: { effort: 'high' }, reasoning_effort: 'high' },
    ],
  ])('the local configuration with %s', async (_naam, gsq, verwachtModel, verwachtProbe) => {
    const { uit, repo } = maakManifestInvoer({ gsq })
    expect((await draaiManifesten(uit, repo)).code).toBe(0)
    loadManifest(join(uit, 'run-gsq-lokaal.json'))
    const model = lees(uit, 'run-gsq-lokaal.json').model
    expect(model).toEqual({ baseUrl: 'http://127.0.0.1:4001/v1', name: 'gsq-lokaal', ...verwachtModel })
    expect(sorted(model)).toEqual(sorted({ baseUrl: 1, name: 1, ...verwachtModel }))
    expect(lees(uit, 'probe-extra-gsq.json')).toEqual(verwachtProbe)
  })

  it('leaves extraBody out of the hosted manifest when run-extra-or.json is {}', async () => {
    const { uit, repo } = maakManifestInvoer({ extraOr: {} })
    expect((await draaiManifesten(uit, repo)).code).toBe(0)
    loadManifest(join(uit, 'run-qwen3.8-or.json'))
    expect(lees(uit, 'run-qwen3.8-or.json').model).toEqual({ baseUrl: 'http://127.0.0.1:4001/v1', name: 'qwen3.8-or' })
  })

  it('points the doc server at an absolute path of the checkout, also when --repo is relative and ends in a slash', async () => {
    const { uit, repo } = maakManifestInvoer()
    const wortel = realpathSync(tmpdir())
    const r = await draai(['manifesten', '--uit', uit, '--repo', `./${basename(repo)}/`], {}, SCRIPT, wortel)
    expect(r.code).toBe(0)
    const args = lees(uit, 'run-gsq-lokaal.json').tools.server.args
    expect(args[0]).toBe(join(wortel, basename(repo), 'dist', 'cli.js'))
    expect(args[3]).toBe(join(wortel, basename(repo), '__tests__', 'fixtures', 'docset'))
  })

  describe('a wrong option or input is exit 2, and nothing is written', () => {
    const gevallen: Array<[string, Parameters<typeof maakManifestInvoer>[0], string]> = [
      ['a missing gsq-lokaal.json', { gsq: undefined }, 'gsq-lokaal.json'],
      ['a gsq-lokaal.json that is no JSON', { gsq: '{ niet af' }, 'gsq-lokaal.json'],
      ['a gsq-lokaal.json that is null', { gsq: 'null' }, 'gsq-lokaal.json'],
      ['a gsq-lokaal.json that is a list', { gsq: [] }, 'gsq-lokaal.json'],
      ['a gsq-lokaal.json without name', { gsq: { reasoningEffort: null, extraBody: null } }, 'name'],
      ['a name that is no string', { gsq: { name: 5, reasoningEffort: null, extraBody: null } }, 'name'],
      ['an empty name', { gsq: { name: '', reasoningEffort: null, extraBody: null } }, 'name'],
      ['a gsq-lokaal.json without reasoningEffort', { gsq: { name: 'x', extraBody: null } }, 'reasoningEffort'],
      ['a reasoningEffort that is no string', { gsq: { name: 'x', reasoningEffort: 5, extraBody: null } }, 'reasoningEffort'],
      ['an empty reasoningEffort', { gsq: { name: 'x', reasoningEffort: '', extraBody: null } }, 'reasoningEffort'],
      ['a gsq-lokaal.json without extraBody', { gsq: { name: 'x', reasoningEffort: null } }, 'extraBody'],
      ['an extraBody that is a list', { gsq: { name: 'x', reasoningEffort: null, extraBody: [] } }, 'extraBody'],
      ['an extraBody that is a string', { gsq: { name: 'x', reasoningEffort: null, extraBody: 'x' } }, 'extraBody'],
      ['a provider block in the extraBody of the local configuration', { gsq: { name: 'x', reasoningEffort: null, extraBody: { provider: { only: ['x'] } } } }, 'provider'],
      ['a missing run-extra-or.json', { extraOr: undefined }, 'run-extra-or.json'],
      ['a run-extra-or.json that is no JSON', { extraOr: '{ niet af' }, 'run-extra-or.json'],
      ['a run-extra-or.json that is a list', { extraOr: [] }, 'run-extra-or.json'],
      ['a run-extra-or.json that is null', { extraOr: 'null' }, 'run-extra-or.json'],
      ['a run-extra-or.json that is a string', { extraOr: '"x"' }, 'run-extra-or.json'],
      ['a provider block in run-extra-or.json', { extraOr: { provider: { only: ['x'] } } }, 'provider'],
      ['a checkout without dist/cli.js', { zonderCli: true }, 'dist/cli.js'],
      ['a checkout without the docset', { zonderDocset: true }, 'docset'],
    ]

    it.each(gevallen)('%s', async (_naam, invoer, melding) => {
      const { uit, repo } = maakManifestInvoer(invoer)
      const voor = readdirSync(uit).sort()
      const r = await draaiManifesten(uit, repo)
      expect(r.code).toBe(2)
      expect(eersteRegel(r)).toContain(melding)
      expect(r.stderr).toContain('Gebruik')
      expect(r.stdout).toBe('')
      expect(readdirSync(uit).sort()).toEqual(voor)
    })

    it.each([
      ['no --uit', ['--repo', '<repo>'], '--uit'],
      ['no --repo', ['--uit', '<uit>'], '--repo'],
      ['an unknown option', ['--uit', '<uit>', '--repo', '<repo>', '--bogus'], '--bogus'],
      ['an --uit that does not exist', ['--uit', '<uit>/bestaat-niet', '--repo', '<repo>'], 'gsq-lokaal.json'],
    ])('%s', async (_naam, args, genoemd) => {
      const { uit, repo } = maakManifestInvoer()
      const echt = args.map((a) => a.replace('<uit>', uit).replace('<repo>', repo))
      const r = await draai(['manifesten', ...echt], {})
      expect(r.code).toBe(2)
      expect(eersteRegel(r)).toContain(genoemd)
      expect(r.stderr).toContain('Gebruik')
      expect(readdirSync(uit).sort()).toEqual(['gsq-lokaal.json', 'run-extra-or.json'])
    })

    it.each(MANIFEST_UITVOER)('an existing %s: it is left untouched, and the other files are not written either', async (naam) => {
      const { uit, repo } = maakManifestInvoer()
      writeFileSync(join(uit, naam), 'STALE')
      const r = await draaiManifesten(uit, repo)
      expect(r.code).toBe(2)
      expect(eersteRegel(r)).toContain(naam)
      expect(readFileSync(join(uit, naam), 'utf8')).toBe('STALE')
      expect(readdirSync(uit).sort()).toEqual([naam, 'gsq-lokaal.json', 'run-extra-or.json'].sort())
    })
  })
})

describe('the files in deploy/max2/litellm', () => {
  it('never hold the name prefix of the harness containers (a worker with task-config removes containers by that prefix)', () => {
    const map = fileURLToPath(new URL('../deploy/max2/litellm/', import.meta.url))
    const bestanden = readdirSync(map)
    expect(bestanden).toContain('meet.mjs')
    for (const bestand of bestanden) expect(readFileSync(join(map, bestand), 'utf8'), bestand).not.toContain('harness-')
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

describe('isGecomprimeerd', () => {
  it.each([
    [{}, false],
    [{ 'content-encoding': 'identity' }, false],
    [{ 'content-encoding': ' Identity ' }, false],
    [{ 'content-encoding': '' }, false],
    [{ 'content-encoding': 'gzip' }, true],
    [{ 'content-encoding': 'GZIP' }, true],
    [{ 'content-encoding': 'br' }, true],
    [{ 'content-encoding': 'identity, gzip' }, true],
  ])('%j is %s', (headers, verwacht) => {
    expect(meet.isGecomprimeerd(headers)).toBe(verwacht)
  })
})

describe('proxyRecord', () => {
  const antwoord = (o: object) => ({ http_status: 200, headers: {}, json: undefined, tijd: '2026-10-05T20:00:00.000Z', ...o })

  it('takes finish_reason, reasoning_tokens and toolcalls from the first choice only', () => {
    const json = {
      id: 'gen-1',
      choices: [
        { finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c1' }] } },
        { finish_reason: 'stop', message: {} },
      ],
      usage: { cost: 0.5, completion_tokens_details: { reasoning_tokens: 7 } },
    }
    expect(meet.proxyRecord('m', antwoord({ json }))).toMatchObject({ finish_reason: 'tool_calls', reasoning_tokens: 7, toolcalls: true, bedrag: 0.5, bron: 'provider_reported' })
  })

  it('counts an empty tool_calls list, a missing one and a malformed one as no tool calls', () => {
    const record = (tool_calls: unknown) => meet.proxyRecord('m', antwoord({ json: { choices: [{ finish_reason: 'stop', message: { tool_calls } }] } })).toolcalls
    expect([record([]), record(undefined), record(null), record('x'), record({ length: 3 })]).toEqual([false, false, false, false, false])
    expect(meet.proxyRecord('m', antwoord({ json: { choices: [] } }))).toMatchObject({ finish_reason: null, toolcalls: false, reasoning_tokens: 'ontbreekt' })
  })

  it('masks before it cuts, and cuts the model name as well', () => {
    const regel = meet.proxyRecord('m'.repeat(300), antwoord({ json: { provider: '.'.repeat(190) + KEY, id: 'gen-1' } }), [KEY])
    expect(regel.provider).toBe(`${'.'.repeat(190)}<redacted>`)
    expect(regel.model).toHaveLength(200)
  })

  it('reads no body field of a compressed answer, whatever it is given as json, but keeps the headers it saw', () => {
    const headers = { 'content-encoding': 'gzip', 'x-litellm-response-cost': '0.5' }
    const regel = meet.proxyRecord('m', antwoord({ headers, json: { id: 'gen-1', usage: { cost: 1 }, choices: [{ finish_reason: 'stop' }] } }))
    expect(regel).toMatchObject({ bron: 'niet_leesbaar', bedrag: null, kosten_header: '0.5', body_usage_cost: null, provider: null, id: null, finish_reason: null, reasoning_tokens: null, toolcalls: null })
  })
})

describe('proxyFoutRecord', () => {
  it('has the same fields as a normal line, all empty, plus the kind of failure', () => {
    expect(meet.proxyFoutRecord('qwen3.8-or', 'ECONNRESET', '2026-10-05T20:00:00.000Z')).toEqual({
      tijd: '2026-10-05T20:00:00.000Z',
      model: 'qwen3.8-or',
      http_status: null,
      kosten_header: null,
      provider_kosten_header: null,
      body_usage_cost: null,
      provider: null,
      id: null,
      bedrag: null,
      bron: 'none',
      finish_reason: null,
      reasoning_tokens: null,
      toolcalls: null,
      fout: 'ECONNRESET',
    })
  })
})

describe('precisieOordeel', () => {
  const lijst = [
    { provider_name: 'Alibaba', quantization: 'bf16' },
    { provider_name: 'Gemengd', quantization: 'bf16' },
    { provider_name: 'Gemengd', quantization: 'fp8' },
    { provider_name: 'Twee Keer Anders', quantization: 'fp8' },
    { provider_name: 'Twee Keer Anders', quantization: 'int4' },
    { provider_name: 'Leeg', quantization: null },
  ]

  it.each([
    ['one precision, and it is bf16', 'Alibaba', 'bf16 volgens endpointlijst'],
    ['the same name in other case and with spaces around it', '  ALIBABA ', 'bf16 volgens endpointlijst'],
    ['several precisions, one of them bf16', 'Gemengd', 'precisie niet eenduidig aangetoond'],
    ['several precisions, none of them bf16', 'Twee Keer Anders', 'precisie niet eenduidig aangetoond'],
    ['a precision that is not given', 'Leeg', 'niet in BF16-lijst'],
    ['a provider that is not in the list', 'Afwezig', 'niet in BF16-lijst'],
    ['no provider name', null, 'niet gemeten (opzoeking mislukt)'],
  ])('%s', (_naam, provider, verwacht) => {
    expect(meet.precisieOordeel(provider, lijst)).toBe(verwacht)
  })

  it('cannot judge anything against a list that is not there, and a failed lookup comes first', () => {
    expect(meet.precisieOordeel('Alibaba', null)).toBe('niet gemeten (endpointlijst mislukt)')
    expect(meet.precisieOordeel(null, null)).toBe('niet gemeten (opzoeking mislukt)')
    expect(meet.precisieOordeel('Alibaba', [])).toBe('niet in BF16-lijst')
  })
})

describe('wachtMs', () => {
  const nu = Date.parse('2026-10-05T20:00:10.000Z')

  it.each([
    ['an answer of just now: the full 10 s', '2026-10-05T20:00:10.000Z', 10_000],
    ['an answer of 4 s ago: the other 6 s', '2026-10-05T20:00:06.000Z', 6_000],
    ['an answer of exactly 10 s ago: no wait', '2026-10-05T20:00:00.000Z', 0],
    ['an answer of long ago: no wait', '2026-01-01T00:00:00.000Z', 0],
    ['a moment in the future (clocks differ): never longer than 10 s', '2026-10-05T21:00:00.000Z', 10_000],
    ['no moment at all: the full 10 s, to be safe', null, 10_000],
    ['a moment that is no date: the full 10 s', 'gisteren', 10_000],
  ])('%s', (_naam, tijd, verwacht) => {
    expect(meet.wachtMs(tijd, nu)).toBe(verwacht)
  })
})

describe('probeExtra', () => {
  it('is the extra fields plus reasoning_effort, and {} when both are missing', () => {
    expect(meet.probeExtra({ top_p: 0.9 }, 'none')).toEqual({ top_p: 0.9, reasoning_effort: 'none' })
    expect(meet.probeExtra(null, 'low')).toEqual({ reasoning_effort: 'low' })
    expect(meet.probeExtra({ top_p: 0.9 }, null)).toEqual({ top_p: 0.9 })
    expect(meet.probeExtra(null, null)).toEqual({})
  })

  it('lets reasoningEffort win over a reasoning_effort in the extra fields, as the model client does', () => {
    expect(meet.probeExtra({ reasoning_effort: 'low', top_p: 0.9 }, 'high')).toEqual({ reasoning_effort: 'high', top_p: 0.9 })
  })

  it('does not change what it is given', () => {
    const extra = { top_p: 0.9 }
    meet.probeExtra(extra, 'none')
    expect(extra).toEqual({ top_p: 0.9 })
  })
})

describe('leesBasisUrl', () => {
  it('names the option in its message, so --upstream is not reported as --base-url', () => {
    expect(() => meet.leesBasisUrl('niet een url', '--upstream')).toThrow('--upstream moet een http(s)-URL zijn')
    expect(() => meet.leesBasisUrl('ftp://x')).toThrow('--base-url moet een http(s)-URL zijn')
    expect(meet.leesBasisUrl('http://127.0.0.1:4000/v1/', '--upstream')).toBe('http://127.0.0.1:4000')
  })
})

describe('OPENROUTER_BASIS', () => {
  it('is the real OpenRouter: it is where the key goes when --base-url is left out, so a change is a decision', () => {
    expect(meet.OPENROUTER_BASIS).toBe('https://openrouter.ai')
  })
})
