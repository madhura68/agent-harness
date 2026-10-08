// Measurement script for the M45 trial window on max2 (increment 1). Node built-ins only: it runs from the clone on max2
// without an npm install. Trial tool only: the production config (config.yaml) no longer has the negative-control model
// `qwen3.8-or-neg`, so the `meet` negative control only works against the increment-1 config of the trial.
//
//   node meet.mjs meet --base-url http://127.0.0.1:4000 --out <dir> [--timeout-sec 660]
//   node meet.mjs proxy --listen 127.0.0.1:4001 --upstream http://127.0.0.1:4000 --log <file> [--timeout-sec 660]
//   node meet.mjs manifesten --uit <dir> --repo <checkout>
//   node meet.mjs opzoeken --in <meting.json | antwoorden.jsonl> [--in ...] --out <file> [--base-url https://openrouter.ai]
//
// Modes: meet (below), proxy (a recording proxy between the harness and LiteLLM), manifesten (the run manifests of both
// configurations) and opzoeken (cost and provider of the hosted answers at OpenRouter).
//
// Keys come from the environment only and go into a header only: LITELLM_MASTER_KEY (meet), OPENROUTER_API_KEY (opzoeken).
// Everything written to disk and every error text passes through maskeer, which replaces a key by <redacted>; the progress lines
// on stdout hold only step names and status codes.
//
// Exit codes: 0 every request got an HTTP answer (4xx and 5xx included), 1 a request got no answer (the run stops and the
// result says where), 2 a mandatory key, option or mode is missing or unusable (stops before the first request).
// No mode overwrites or removes a file: an output that is there already is exit 2, because nothing on max2 is deleted for good.
//
// meet writes into --out: meting.json (the result), probe-extra-or.json (the uit-vorm: the request fields that turn thinking
// off, {} if none), run-extra-or.json (the aan-vorm), kanarie.txt (the canary strings that were sent, one per line).
//
// proxy stays up until SIGINT or SIGTERM and appends one JSON line per POST .../chat/completions to --log (see proxyRecord).
//
// manifesten reads gsq-lokaal.json (the model settings of the production worker: { name, reasoningEffort, extraBody }, the last
// two null when not set) and run-extra-or.json (written by meet) from --uit and writes run-gsq-lokaal.json, run-qwen3.8-or.json
// and probe-extra-gsq.json next to them.
//
// opzoeken writes --out: the endpoint list of the hosted model and, per hosted answer, the provider and cost OpenRouter has for it.

import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const REDACTED = '<redacted>'
export const MODEL_LOKAAL = 'gsq-lokaal'
export const MODEL_GEHOST = 'qwen3.8-or'
// Increment 1 only: the negative control exists in the trial config, not in the production config of 2d.
export const MODEL_NEGATIEF = 'qwen3.8-or-neg'
export const PROMPT = 'Antwoord alleen met: pong'
// Just above the 600 s that LiteLLM gives an upstream request, so a time-out of LiteLLM itself arrives as an HTTP answer.
export const STANDAARD_TIMEOUT_SEC = 660
// Where the key goes when --base-url is left out of opzoeken. A different host is a decision, so a test pins it.
export const OPENROUTER_BASIS = 'https://openrouter.ai'
// How long a stop of the proxy waits for requests that are still being answered, before it cuts them.
export const STOP_GRACE_MS = 2000

// The five ways to ask for thinking on or off, in the order the decision rule reads them.
export const DENKVORMEN = [
  { vorm: 1, extra: {} },
  { vorm: 2, extra: { reasoning_effort: 'none' } },
  { vorm: 3, extra: { reasoning: { effort: 'none' } } },
  { vorm: 4, extra: { reasoning_effort: 'medium' } },
  { vorm: 5, extra: { reasoning: { effort: 'medium' } } },
]

const UITVOER = ['meting.json', 'probe-extra-or.json', 'run-extra-or.json', 'kanarie.txt']
// What a header value may hold; a key outside this would make Node throw instead of send the request.
const HEADERTEKENS = /^[\x21-\x7e]+$/
const DECIMAAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
// Same floor as the model client: a shorter Authorization token is a placeholder (Ollama takes any string), and masking it would mangle ordinary text.
const MIN_MASKER_LENGTE = 8

/** An unusable option, key or mode: main() prints the message with the usage line and exits 2. */
export class GebruiksFout extends Error {}

/** No complete HTTP answer arrived. `reden` is an error code or kind ('timeout'), never a message. */
export class GeenAntwoord extends Error {
  constructor(reden) {
    super(`geen antwoord: ${reden}`)
    this.name = 'GeenAntwoord'
    this.reden = reden
  }
}

// ---- masking ----

/** Replaces every occurrence of every key by <redacted>. Do this before cutting a text short: a cut first can leave the front of a key. */
export function maskeer(tekst, sleutels) {
  let uit = String(tekst)
  // Longest first, so a key that contains another key is masked in full.
  for (const sleutel of sleutels.filter(Boolean).sort((a, b) => b.length - a.length)) uit = uit.split(sleutel).join(REDACTED)
  return uit
}

/** maskeer over every string in a JSON value, object keys included. */
export function maskeerDiep(waarde, sleutels) {
  if (typeof waarde === 'string') return maskeer(waarde, sleutels)
  if (Array.isArray(waarde)) return waarde.map((w) => maskeerDiep(w, sleutels))
  if (waarde !== null && typeof waarde === 'object') {
    return Object.fromEntries(Object.entries(waarde).map(([k, w]) => [maskeer(k, sleutels), maskeerDiep(w, sleutels)]))
  }
  return waarde
}

/**
 * Everything written to disk goes through here, so the masking cannot be forgotten at a single call site. `vlag` 'wx' makes the write
 * fail when the file is there, for the outputs that must never overwrite anything.
 */
export function schrijfJson(pad, waarde, sleutels, vlag = 'w') {
  writeFileSync(pad, `${JSON.stringify(maskeerDiep(waarde, sleutels), null, 2)}\n`, { flag: vlag })
}

// ---- one HTTP request ----

function leesJson(tekst) {
  try {
    return JSON.parse(tekst)
  } catch {
    return undefined
  }
}

function foutSoort(fout) {
  const soort = typeof fout?.code === 'string' ? fout.code : typeof fout?.name === 'string' ? fout.name : 'fout'
  return soort.slice(0, 60)
}

/**
 * One request, raw: the body as bytes, the headers as the server sent them. Resolves with every HTTP answer, 4xx and 5xx included:
 * { http_status, statusMessage, rawHeaders (as received: names in their own case, a repeated header repeated), headers (lower-cased
 * names), body (Buffer), tijd (ISO-8601, when the body was complete) }. `headers` goes to http.request as it is: an object, or a flat
 * [name, value, ...] list. Rejects with GeenAntwoord when no complete answer arrives: a network error, a connection that breaks
 * off, `timeoutMs` passing for the whole request, or `signal` aborting.
 *
 * node:http and not fetch: fetch gives up on its own after 300 s of waiting for headers or body, below the 660 s default that
 * is meant to outlast LiteLLM's own 600 s time-out.
 */
export function vraagRuw({ url, methode = 'GET', headers, data, timeoutMs, signal }) {
  return new Promise((gelukt, mislukt) => {
    let klaar = false
    let timer
    const eindig = (afhandelen, waarde) => {
      if (klaar) return
      klaar = true
      clearTimeout(timer)
      afhandelen(waarde)
    }
    const geenAntwoord = (reden) => eindig(mislukt, new GeenAntwoord(reden))

    const doel = new URL(url)
    // agent: false, so a connection that a test or a proxy cuts is never reused by the next request.
    const req = (doel.protocol === 'https:' ? https : http).request(doel, { method: methode, headers, agent: false, signal }, (res) => {
      const stukken = []
      res.on('data', (stuk) => stukken.push(stuk))
      res.on('end', () =>
        eindig(gelukt, {
          http_status: res.statusCode,
          statusMessage: res.statusMessage,
          rawHeaders: res.rawHeaders,
          headers: res.headers,
          body: Buffer.concat(stukken),
          tijd: new Date().toISOString(),
        }),
      )
      res.on('error', (fout) => geenAntwoord(foutSoort(fout)))
      res.on('close', () => {
        if (!res.complete) geenAntwoord('ECONNRESET')
      })
    })
    req.on('error', (fout) => geenAntwoord(foutSoort(fout)))
    timer = setTimeout(() => {
      geenAntwoord('timeout')
      req.destroy()
    }, timeoutMs)
    timer.unref()
    req.end(data)
  })
}

/**
 * A JSON request. Resolves with every HTTP answer, 4xx and 5xx included: { http_status, headers (lower-cased names), tekst, json
 * (undefined when the body is no JSON), tijd (ISO-8601, when the body was complete) }. Rejects with GeenAntwoord like vraagRuw.
 */
export async function vraag({ url, methode = 'GET', sleutel, body, timeoutMs }) {
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const headers = { accept: 'application/json', connection: 'close' }
  if (sleutel) headers.authorization = `Bearer ${sleutel}`
  if (data) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(data.length)
  }
  const antwoord = await vraagRuw({ url, methode, headers, data, timeoutMs })
  const tekst = antwoord.body.toString('utf8')
  return { http_status: antwoord.http_status, headers: antwoord.headers, tekst, json: leesJson(tekst), tijd: antwoord.tijd }
}

// ---- amount and source ----

/** A finite number above 0 from a number or a plain decimal string (a header), else null. */
function alsBedrag(waarde) {
  const getal = typeof waarde === 'number' ? waarde : typeof waarde === 'string' && DECIMAAL.test(waarde.trim()) ? Number(waarde) : NaN
  return Number.isFinite(getal) && getal > 0 ? getal : null
}

function headerTekst(headers, naam) {
  const waarde = headers?.[naam]
  if (Array.isArray(waarde)) return waarde.join(', ')
  return typeof waarde === 'string' ? waarde : null
}

/** The three raw cost observations of one answer: both headers as strings, the body's usage.cost as a number. */
export function kostenVelden({ headers, json }) {
  const kosten = json?.usage?.cost
  return {
    kosten_header: headerTekst(headers, 'x-litellm-response-cost'),
    provider_kosten_header: headerTekst(headers, 'llm_provider-x-litellm-response-cost'),
    body_usage_cost: typeof kosten === 'number' && Number.isFinite(kosten) ? kosten : null,
  }
}

/**
 * The amount and where it came from, in this order, each only if it is a finite number above 0: the body's usage.cost
 * (provider_reported), the provider's header (provider_reported), LiteLLM's own header (litellm_computed), else none.
 */
export function bepaalBron({ body_usage_cost = null, provider_kosten_header = null, kosten_header = null }) {
  const body = alsBedrag(body_usage_cost)
  if (body !== null) return { bedrag: body, bron: 'provider_reported' }
  const provider = alsBedrag(provider_kosten_header)
  if (provider !== null) return { bedrag: provider, bron: 'provider_reported' }
  const berekend = alsBedrag(kosten_header)
  if (berekend !== null) return { bedrag: berekend, bron: 'litellm_computed' }
  return { bedrag: null, bron: 'none' }
}

/**
 * A string cut to 200 characters, else null. With `sleutels` the keys are masked first: a key that starts before the cut and ends
 * after it would otherwise leave a front that the mask no longer recognises.
 */
function kortTekst(waarde, sleutels = []) {
  return typeof waarde === 'string' ? maskeer(waarde, sleutels).slice(0, 200) : null
}

/**
 * The record of one hosted answer, shared by the cost lines of meet and the lines of the proxy. `antwoord` is a result of vraag()
 * (or has its fields); `sleutels` are masked in the provider and the id before they are cut.
 */
export function antwoordRecord(model, antwoord, sleutels = []) {
  const kosten = kostenVelden(antwoord)
  return {
    tijd: antwoord.tijd,
    model,
    http_status: antwoord.http_status,
    ...kosten,
    provider: kortTekst(antwoord.json?.provider, sleutels),
    id: kortTekst(antwoord.json?.id, sleutels),
    ...bepaalBron(kosten),
  }
}

/** The answer is a 2xx. */
function isTweehonderd(status) {
  return status >= 200 && status < 300
}

/** Only a successful answer counts for the cost criterion; a 4xx or 5xx has no cost to speak of. */
export function inKostencriterium(record) {
  return isTweehonderd(record.http_status)
}

// ---- thinking ----

/** usage.completion_tokens_details.reasoning_tokens as a number, else the string "ontbreekt". */
export function reasoningTokens(json) {
  const tokens = json?.usage?.completion_tokens_details?.reasoning_tokens
  return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 'ontbreekt'
}

/** Which thinking-text fields a message had (null and malformed ones do not count) and the total length of their text. Never the text. */
export function denktekst(bericht) {
  const velden = []
  let lengte = 0
  for (const veld of ['reasoning_content', 'reasoning']) {
    if (typeof bericht?.[veld] === 'string') {
      velden.push(veld)
      lengte += bericht[veld].length
    }
  }
  if (Array.isArray(bericht?.reasoning_details)) {
    velden.push('reasoning_details')
    for (const onderdeel of bericht.reasoning_details) {
      for (const veld of ['text', 'summary']) if (typeof onderdeel?.[veld] === 'string') lengte += onderdeel[veld].length
    }
  }
  return { velden, lengte }
}

/**
 * Aan: reasoning_tokens above 0, or a thinking text that is not empty (0 tokens with a text is still aan). Uit: HTTP 200, finish
 * reason stop, no thinking text, and reasoning_tokens 0 or missing. Anything else, such as a cut-off or an error, is onbepaald.
 */
export function beslisDenkstand({ http_status, finish_reason, reasoning_tokens, denktekst_lengte }) {
  if ((typeof reasoning_tokens === 'number' && reasoning_tokens > 0) || denktekst_lengte > 0) return 'aan'
  const geenTokens = reasoning_tokens === 0 || reasoning_tokens === 'ontbreekt'
  if (http_status === 200 && finish_reason === 'stop' && geenTokens) return 'uit'
  return 'onbepaald'
}

/** One reasoning line of meting.json, from the answer to form `vorm`. */
export function denkRecord(vorm, antwoord) {
  const keuze = antwoord.json?.choices?.[0]
  const { velden, lengte } = denktekst(keuze?.message)
  const record = {
    vorm,
    http_status: antwoord.http_status,
    finish_reason: typeof keuze?.finish_reason === 'string' ? keuze.finish_reason : null,
    reasoning_tokens: reasoningTokens(antwoord.json),
    denktekst_velden: velden,
    denktekst_lengte: lengte,
  }
  return { ...record, stand: beslisDenkstand(record) }
}

/** The uit-vorm is the first of forms 1 to 3 that is uit, the aan-vorm the first of 4 and 5 that is aan (null when there is none). */
export function kiesVormen(regels) {
  const uit = regels.find((regel) => regel.vorm <= 3 && regel.stand === 'uit')
  const aan = regels.find((regel) => regel.vorm >= 4 && regel.stand === 'aan')
  return { uit_vorm: uit?.vorm ?? null, aan_vorm: aan?.vorm ?? null }
}

/** The request fields of a form; {} for form 1 and for no form. */
export function vormExtra(vorm) {
  return vorm === null ? {} : DENKVORMEN[vorm - 1].extra
}

// ---- the other records of meting.json ----

export function readinessRecord(antwoord) {
  const json = antwoord.json
  return {
    http_status: antwoord.http_status,
    status: kortTekst(json?.status),
    db: kortTekst(json?.db),
    litellm_version: kortTekst(json?.litellm_version),
  }
}

export function modellenRecord(antwoord) {
  const lijst = Array.isArray(antwoord.json?.data) ? antwoord.json.data : []
  return { http_status: antwoord.http_status, ids: lijst.map((model) => model?.id).filter((id) => typeof id === 'string').sort() }
}

export function bridgeRecord(antwoord) {
  const usage = antwoord.json?.usage
  const gewoon = usage !== null && typeof usage === 'object' && !Array.isArray(usage)
  return { http_status: antwoord.http_status, usage: gewoon ? usage : null, ...kostenVelden(antwoord) }
}

/**
 * One variant of the negative control. A 2xx means the provider block did not do what it should, and its body is a message,
 * so only status, id and provider are kept. Anything else keeps an excerpt of the error body: masked first, then cut.
 */
export function negatiefRecord(variant, antwoord, sleutels) {
  if (inKostencriterium(antwoord)) {
    return { variant, http_status: antwoord.http_status, id: kortTekst(antwoord.json?.id, sleutels), provider: kortTekst(antwoord.json?.provider, sleutels) }
  }
  return { variant, http_status: antwoord.http_status, excerpt: maskeer(antwoord.tekst, sleutels).slice(0, 200) }
}

// ---- options ----

/**
 * The base without trailing slash and without /v1 (the harness takes /v1 in its base url, so it is easy to paste one here).
 * `optie` is the option the value came from, for the message.
 */
export function leesBasisUrl(waarde, optie = '--base-url') {
  let url
  try {
    url = new URL(waarde)
  } catch {
    throw new GebruiksFout(`${optie} moet een http(s)-URL zijn`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new GebruiksFout(`${optie} moet een http(s)-URL zijn`)
  return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
}

export function leesTimeoutMs(waarde) {
  if (waarde === undefined) return STANDAARD_TIMEOUT_SEC * 1000
  const seconden = DECIMAAL.test(waarde.trim()) ? Number(waarde) : NaN
  // An hour is plenty and keeps the value well below what setTimeout can hold.
  if (!(seconden > 0 && seconden <= 3600)) throw new GebruiksFout('--timeout-sec moet een getal groter dan 0 en hoogstens 3600 zijn')
  return Math.round(seconden * 1000)
}

/** Whether `waarde` is a JSON object (not null, not a list). */
function isObject(waarde) {
  return waarde !== null && typeof waarde === 'object' && !Array.isArray(waarde)
}

// ---- mode meet ----

function kostenRegel(kosten) {
  const binnen = kosten.filter(inKostencriterium)
  const metBedrag = binnen.filter((record) => record.bron !== 'none').length
  return `cost ${kosten.length} antwoorden, ${binnen.length} binnen kostencriterium, ${metBedrag} met bedrag\n`
}

async function meetModus(waarden, { env, uit, fout, sleutels }) {
  const sleutel = env.LITELLM_MASTER_KEY
  if (!sleutel) throw new GebruiksFout('LITELLM_MASTER_KEY ontbreekt in de omgeving')
  if (!HEADERTEKENS.test(sleutel)) throw new GebruiksFout('LITELLM_MASTER_KEY bevat tekens die niet in een header kunnen')
  const basis = leesBasisUrl(waarden['base-url'])
  const timeoutMs = leesTimeoutMs(waarden['timeout-sec'])
  const map = resolve(waarden.out)
  try {
    mkdirSync(map, { recursive: true })
  } catch (e) {
    throw new GebruiksFout(`--out is niet bruikbaar: ${foutSoort(e)}`)
  }
  // A measurement goes into a directory of its own: earlier results are never overwritten or removed (nothing on max2 is
  // deleted for good, and a new window starts in a new directory), and they can never mix with the results of this run.
  const aanwezig = UITVOER.filter((naam) => existsSync(join(map, naam)))
  if (aanwezig.length > 0) throw new GebruiksFout(`--out bevat al een meting (${aanwezig.join(', ')}); kies een nieuwe map`)

  const staat = {}
  const kanaries = []
  let stap = 'start'
  const stuur = (naam, aanvraag) => {
    stap = naam
    return vraag({ timeoutMs, ...aanvraag })
  }
  const chat = (naam, model, tekst, maxTokens, extra = {}) =>
    stuur(naam, {
      url: `${basis}/v1/chat/completions`,
      methode: 'POST',
      sleutel,
      body: { model, messages: [{ role: 'user', content: tekst }], max_tokens: maxTokens, ...extra },
    })

  let afgebroken = null
  try {
    const readiness = await stuur('readiness', { url: `${basis}/health/readiness` })
    staat.readiness = readinessRecord(readiness)
    uit.write(`readiness ${readiness.http_status}\n`)

    const modellen = await stuur('models', { url: `${basis}/v1/models`, sleutel })
    staat.models = modellenRecord(modellen)
    uit.write(`models ${modellen.http_status}\n`)

    const brug = await chat('bridge', MODEL_LOKAAL, PROMPT, 64)
    staat.bridge = bridgeRecord(brug)
    uit.write(`bridge ${brug.http_status}\n`)

    staat.reasoning = []
    staat.cost = []
    for (const { vorm, extra } of DENKVORMEN) {
      const antwoord = await chat('reasoning', MODEL_GEHOST, PROMPT, 256, extra)
      staat.reasoning.push(denkRecord(vorm, antwoord))
      staat.cost.push({ stap: 'reasoning', vorm, ...antwoordRecord(MODEL_GEHOST, antwoord, sleutels) })
    }
    const { uit_vorm, aan_vorm } = kiesVormen(staat.reasoning)
    staat.denkstand = { uit_vorm, aan_vorm }
    const probeExtra = vormExtra(uit_vorm)
    const runExtra = vormExtra(aan_vorm)
    // Right away, so the outcome of the reasoning step survives a later stop.
    schrijfJson(join(map, 'probe-extra-or.json'), probeExtra, sleutels)
    schrijfJson(join(map, 'run-extra-or.json'), runExtra, sleutels)
    uit.write(`reasoning ${staat.reasoning.map((r) => r.http_status).join(' ')} uit-vorm=${uit_vorm ?? 'geen'} aan-vorm=${aan_vorm ?? 'geen'}\n`)

    // Bare, with the uit-vorm and with the aan-vorm; an empty form is the bare request again, so that variant is dropped.
    staat.negative = []
    const varianten = [['kaal', {}], ['uit-vorm', probeExtra], ['aan-vorm', runExtra]].filter(([naam, extra]) => naam === 'kaal' || Object.keys(extra).length > 0)
    for (const [variant, extra] of varianten) {
      const antwoord = await chat('negative', MODEL_NEGATIEF, PROMPT, 256, extra)
      staat.negative.push(negatiefRecord(variant, antwoord, sleutels))
    }
    uit.write(`negative ${staat.negative.map((n) => `${n.variant}=${n.http_status}`).join(' ')}\n`)

    staat.canary = []
    for (const model of [MODEL_LOKAAL, MODEL_GEHOST, MODEL_NEGATIEF]) {
      const kanarie = `M45-CANARY-${randomBytes(8).toString('hex')}`
      kanaries.push(kanarie) // on its way from here on, answered or not
      const antwoord = await chat('canary', model, `${PROMPT} ${kanarie}`, 64)
      staat.canary.push({ model, http_status: antwoord.http_status })
      if (model === MODEL_GEHOST) staat.cost.push({ stap: 'canary', ...antwoordRecord(model, antwoord, sleutels) })
    }
    uit.write(`canary ${staat.canary.map((c) => c.http_status).join(' ')}\n`)
  } catch (e) {
    const bekend = e instanceof GeenAntwoord
    afgebroken = { stap, reden: bekend ? e.reden : `interne fout: ${e?.name ?? 'Error'}` }
    fout.write(`afgebroken in stap ${stap}: ${maskeer(bekend ? e.reden : (e?.stack ?? String(e)), sleutels)}\n`)
  }
  if (staat.cost?.length) uit.write(kostenRegel(staat.cost))

  // Undefined entries (steps that were not reached) drop out of the JSON.
  schrijfJson(
    join(map, 'meting.json'),
    {
      readiness: staat.readiness,
      models: staat.models,
      bridge: staat.bridge,
      reasoning: staat.reasoning,
      denkstand: staat.denkstand,
      cost: staat.cost,
      negative: staat.negative,
      canary: staat.canary,
      afgebroken: afgebroken ?? undefined,
    },
    sleutels,
  )
  if (kanaries.length > 0) writeFileSync(join(map, 'kanarie.txt'), `${kanaries.join('\n')}\n`)
  return afgebroken ? 1 : 0
}

// ---- mode proxy ----

// Headers that belong to one connection and not to the message: each hop sets its own, so they are never copied.
const VERBINDINGSKOPPEN = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']
// To the upstream also not: host, content-length and accept-encoding (the proxy sets them), and expect (the proxy has read the whole body by then).
const NIET_NAAR_UPSTREAM = new Set([...VERBINDINGSKOPPEN, 'expect', 'host', 'content-length', 'accept-encoding'])
const NIET_NAAR_CLIENT = new Set(VERBINDINGSKOPPEN)

/** A body that is compressed (any content-encoding but identity): the proxy cannot read what is in it. */
export function isGecomprimeerd(headers) {
  const waarde = headerTekst(headers, 'content-encoding')?.trim().toLowerCase()
  return waarde !== undefined && waarde !== '' && waarde !== 'identity'
}

/**
 * The log line of one answer in the proxy: the fields of antwoordRecord, plus finish_reason, reasoning_tokens and whether there were
 * tool calls. `antwoord` is { http_status, headers, json, tijd }. A compressed body is not read: the line has the source niet_leesbaar
 * and no amount, and counts as an answer without an amount; the headers it did have are kept. Never a request header, never content.
 */
export function proxyRecord(model, antwoord, sleutels = []) {
  const kortModel = kortTekst(model, sleutels)
  if (isGecomprimeerd(antwoord.headers)) {
    return {
      tijd: antwoord.tijd,
      model: kortModel,
      http_status: antwoord.http_status,
      ...kostenVelden({ headers: antwoord.headers }),
      provider: null,
      id: null,
      bedrag: null,
      bron: 'niet_leesbaar',
      finish_reason: null,
      reasoning_tokens: null,
      toolcalls: null,
    }
  }
  const keuze = antwoord.json?.choices?.[0]
  const toolcalls = keuze?.message?.tool_calls
  return {
    ...antwoordRecord(kortModel, antwoord, sleutels),
    finish_reason: kortTekst(keuze?.finish_reason, sleutels),
    reasoning_tokens: reasoningTokens(antwoord.json),
    toolcalls: Array.isArray(toolcalls) && toolcalls.length > 0,
  }
}

/** The log line when the upstream gave no answer: the same fields, all empty, plus the kind of failure (an error code, 'timeout' or 'client_verbroken'). */
export function proxyFoutRecord(model, fout, tijd) {
  return {
    tijd,
    model,
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
    fout,
  }
}

/** --listen: the host must be exactly 127.0.0.1, so the proxy cannot be reached from another machine. Port 0 lets the OS pick one. */
function leesLuisteradres(waarde) {
  const gevonden = /^([^:]*):(\d{1,5})$/.exec(waarde)
  const poort = gevonden === null ? NaN : Number(gevonden[2])
  if (gevonden === null || gevonden[1] !== '127.0.0.1' || poort > 65535) {
    throw new GebruiksFout('--listen moet 127.0.0.1:<poort> zijn (alleen het adres 127.0.0.1, poort 0 tot en met 65535)')
  }
  return poort
}

/** The model of a request body, or null when the body is no JSON or has no model. */
function modelUitBody(body) {
  const json = leesJson(body.toString('utf8'))
  return typeof json?.model === 'string' ? json.model : null
}

/** The Authorization value of a request and the token in it, as far as they are long enough to be a key and not a placeholder. */
function autorisatieGeheimen(waarde) {
  if (typeof waarde !== 'string') return []
  const token = /^\s*Bearer\s+(\S+)\s*$/i.exec(waarde)?.[1]
  return [waarde.trim(), token].filter((geheim) => typeof geheim === 'string' && geheim.length >= MIN_MASKER_LENGTE)
}

/** A flat [name, value, ...] header list without the headers in `uitgesloten`, in the order and the case it came in. */
function kopLijst(raw, uitgesloten) {
  const lijst = []
  for (let i = 0; i < raw.length; i += 2) if (!uitgesloten.has(raw[i].toLowerCase())) lijst.push(raw[i], raw[i + 1])
  return lijst
}

/** The answer of the upstream to the client: the same status, the same headers (but those of the connection), the same bytes. */
function naarClient(res, antwoord, methode) {
  if (res.destroyed) return
  const koppen = kopLijst(antwoord.rawHeaders, NIET_NAAR_CLIENT)
  const heeftLengte = antwoord.rawHeaders.some((waarde, i) => i % 2 === 0 && waarde.toLowerCase() === 'content-length')
  const geenBody = methode === 'HEAD' || antwoord.http_status < 200 || antwoord.http_status === 204 || antwoord.http_status === 304
  // An answer in chunked encoding has been read whole by now, so it leaves with a length.
  if (!heeftLengte && !geenBody) koppen.push('content-length', String(antwoord.body.length))
  if (antwoord.statusMessage) res.statusMessage = antwoord.statusMessage
  res.writeHead(antwoord.http_status, koppen)
  res.end(geenBody ? undefined : antwoord.body)
}

function nietBeschikbaar(res, reden) {
  if (res.destroyed) return
  res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(`geen antwoord van de upstream: ${reden}\n`)
}

/** One request of a client, once its body is in: forward it, log it (when it is a chat completion), return the answer. */
async function doorsturen({ req, res, body, ctrl, ctx }) {
  if (!req.url?.startsWith('/')) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('ongeldig pad\n')
    return
  }
  const chat = req.method === 'POST' && req.url.split('?')[0].endsWith('/chat/completions')
  // The key of this very request is masked as well, next to the keys of the environment: an upstream that echoes it must not get it into the log.
  const geheimen = [...ctx.sleutels, ...autorisatieGeheimen(req.headers.authorization)]
  const model = chat ? kortTekst(modelUitBody(body), geheimen) : null
  const metBody = body.length > 0 || req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
  const koppen = [...kopLijst(req.rawHeaders, NIET_NAAR_UPSTREAM), 'host', ctx.upstreamHost, 'accept-encoding', 'identity']
  if (metBody) koppen.push('content-length', String(body.length))

  let antwoord
  try {
    antwoord = await vraagRuw({ url: `${ctx.upstream}${req.url}`, methode: req.method, headers: koppen, data: metBody ? body : undefined, timeoutMs: ctx.timeoutMs, signal: ctrl.signal })
  } catch (e) {
    if (!(e instanceof GeenAntwoord)) throw e
    const klantWeg = ctrl.signal.aborted
    const reden = klantWeg ? 'client_verbroken' : e.reden
    if (chat) ctx.schrijfRegel(proxyFoutRecord(model, reden, new Date().toISOString()), geheimen)
    if (!klantWeg) nietBeschikbaar(res, reden)
    return
  }
  if (chat) {
    const gecomprimeerd = isGecomprimeerd(antwoord.headers)
    const json = gecomprimeerd ? undefined : leesJson(antwoord.body.toString('utf8'))
    ctx.schrijfRegel(proxyRecord(model, { http_status: antwoord.http_status, headers: antwoord.headers, json, tijd: antwoord.tijd }, geheimen), geheimen)
  }
  // The line is written before the answer is returned: a client that has its answer can count on its line being in the log.
  naarClient(res, antwoord, req.method)
}

function behandel(req, res, ctx) {
  const stukken = []
  const ctrl = new AbortController()
  // A client that goes away takes its upstream request with it, as it would without the proxy in between.
  res.on('close', () => {
    if (!res.writableFinished) ctrl.abort()
  })
  req.on('data', (stuk) => stukken.push(stuk))
  req.on('error', () => {}) // the connection broke off: res 'close' does the rest
  req.on('end', () => {
    doorsturen({ req, res, body: Buffer.concat(stukken), ctrl, ctx }).catch((e) => {
      // Only the kind of error: a message can quote the request.
      ctx.fout.write(`onverwachte fout in de proxy: ${foutSoort(e)}\n`)
      if (res.headersSent || res.destroyed) res.destroy()
      else {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('interne fout in de proxy\n')
      }
    })
  })
}

async function proxyModus(waarden, { uit, fout, sleutels }) {
  const poort = leesLuisteradres(waarden.listen)
  const upstream = leesBasisUrl(waarden.upstream, '--upstream')
  const timeoutMs = leesTimeoutMs(waarden['timeout-sec'])
  const logPad = resolve(waarden.log)
  if (existsSync(logPad)) throw new GebruiksFout('--log bestaat al; kies een nieuw bestand')

  const ctx = {
    upstream,
    upstreamHost: new URL(upstream).host,
    timeoutMs,
    sleutels,
    fout,
    // One whole line per call, masked: the log is read while the proxy runs. A failing write must not take the proxy down.
    schrijfRegel: (record, geheimen) => {
      try {
        appendFileSync(logPad, `${JSON.stringify(maskeerDiep(record, geheimen))}\n`)
      } catch (e) {
        fout.write(`logregel niet geschreven: ${foutSoort(e)}\n`)
      }
    },
  }
  const server = http.createServer((req, res) => behandel(req, res, ctx))

  // The signal handlers go in before anything is announced: a client that sends SIGTERM as soon as it has read the line that the proxy
  // listens must get a stop, not the default of the signal. A stop that is asked for before the proxy listens waits for it.
  let luistert = false
  let stopGevraagd = false
  let gestopt
  const afgelopen = new Promise((klaar) => {
    gestopt = klaar
  })
  const sluit = () => {
    // close() ends the idle keep-alive connections at once (the model client of the harness keeps them), so those do not hold the stop up.
    // A request that is still being answered gets a moment, then its connection is cut and so is its upstream request.
    server.close(() => gestopt(0))
    setTimeout(() => server.closeAllConnections(), STOP_GRACE_MS).unref()
  }
  const stop = () => {
    if (stopGevraagd) return
    stopGevraagd = true
    if (luistert) sluit()
  }
  // SIGHUP is sent when the terminal goes away (a dropped SSH session): a run in progress must not die of that. Only SIGINT and SIGTERM stop the proxy.
  const negeerHangup = () => {}
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('SIGHUP', negeerHangup)
  try {
    const luistertNiet = await new Promise((klaar) => {
      server.once('error', klaar)
      server.listen(poort, '127.0.0.1', () => klaar(null))
    })
    if (luistertNiet) {
      fout.write(`meet.mjs: kan niet luisteren op 127.0.0.1:${poort}: ${foutSoort(luistertNiet)}\n`)
      return 1
    }
    // The log is created only now that the proxy listens: a start that fails on the port leaves nothing behind, so the same --log can be used again.
    try {
      mkdirSync(dirname(logPad), { recursive: true })
      writeFileSync(logPad, '', { flag: 'wx' })
    } catch (e) {
      server.close()
      throw new GebruiksFout(`--log is niet bruikbaar: ${foutSoort(e)}`)
    }
    server.on('error', (e) => fout.write(`fout van de server: ${foutSoort(e)}\n`))
    luistert = true
    uit.write(`proxy luistert op 127.0.0.1:${server.address().port}\n`)
    if (stopGevraagd) sluit()
    return await afgelopen
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    process.off('SIGHUP', negeerHangup)
  }
}

// ---- mode manifesten ----

const PROXY_BASIS_URL = 'http://127.0.0.1:4001/v1'
const MANIFEST_UITVOER = [`run-${MODEL_LOKAAL}.json`, `run-${MODEL_GEHOST}.json`, 'probe-extra-gsq.json']
const DOC_TOOLS = ['search_product_docs', 'get_product_doc', 'list_product_docs', 'related_product_docs']
// The docs run of M5 (docs/runbooks/model-comparison.md, "Eerste run met docs"), word for word. Its temperature and seed are left out on
// purpose, and the limits are the same for both configurations: a time-out of the local one on the wall time is a result, not an error.
const M5_DOCS_RUN = {
  system:
    'Je beantwoordt vragen over de productdocumentatie. Zoek het antwoord op met de documentatietools en geef bij elke aanroep product_id "fixture-docs" mee. Noem bij je antwoord de doc waar het vandaan komt, als folder/slug.',
  history: [
    { role: 'user', content: 'Ik ga je een paar vragen stellen over de probe.' },
    { role: 'assistant', content: 'Prima. Stel je vraag, dan zoek ik het op in de documentatie.' },
  ],
  prompt: 'Hoeveel stappen noemt het ontwerp van de probe in de sectie Aanpak, en wat doet de laatste stap?',
  limits: { maxTurns: 8, maxOutputTokens: 4096, maxWallSeconds: 240, maxToolErrors: 2, contextTokens: 65536 },
}

/**
 * The request fields that a probe of the local configuration really carries: its extraBody, with reasoning_effort on top when the
 * configuration has a reasoningEffort. That is the order of the model client (body = { ...extraBody, model, ... }, then
 * reasoning_effort), so a reasoningEffort wins over a reasoning_effort in the extraBody. {} when both are missing.
 */
export function probeExtra(extraBody, reasoningEffort) {
  return { ...(extraBody ?? {}), ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }
}

/**
 * The docs run of M5 as a manifest of the harness, for the configuration `naam` through the proxy. The model block carries the settings
 * of the configuration and nothing else: no key (it comes from the environment of the worker) and no provider block (LiteLLM sets it).
 * The id is the name of the configuration with the characters that the manifest schema does not allow replaced (no dot).
 */
export function maakManifest({ naam, repo, reasoningEffort = null, extraBody = null }) {
  const model = { baseUrl: PROXY_BASIS_URL, name: naam }
  if (reasoningEffort) model.reasoningEffort = reasoningEffort
  if (extraBody && Object.keys(extraBody).length > 0) model.extraBody = extraBody
  return {
    id: `m45-${naam.replace(/[^a-z0-9-]/g, '-')}`,
    profile: 'tools',
    model,
    system: M5_DOCS_RUN.system,
    history: M5_DOCS_RUN.history,
    prompt: M5_DOCS_RUN.prompt,
    tools: {
      server: { command: 'node', args: [join(repo, 'dist', 'cli.js'), 'doc-server', '--dir', join(repo, '__tests__', 'fixtures', 'docset'), '--product-id', 'fixture-docs'] },
      allow: DOC_TOOLS,
    },
    limits: M5_DOCS_RUN.limits,
  }
}

function leesInstelling(map, naam) {
  let tekst
  try {
    tekst = readFileSync(join(map, naam), 'utf8')
  } catch (e) {
    throw new GebruiksFout(`${naam} ontbreekt of is niet leesbaar in ${map}: ${foutSoort(e)}`)
  }
  const waarde = leesJson(tekst)
  if (waarde === undefined) throw new GebruiksFout(`${naam} is geen geldige JSON`)
  return waarde
}

/** The provider block is set by LiteLLM; one in a manifest would confound what the trial measures. */
function geenProviderBlok(extraBody, naam) {
  if (extraBody !== null && Object.hasOwn(extraBody, 'provider')) throw new GebruiksFout(`${naam}: extraBody mag geen provider-blok bevatten (dat zet LiteLLM)`)
}

/** gsq-lokaal.json: { name, reasoningEffort, extraBody }, the last two null when not set. All three must be there: a typo must not drop a setting in silence. */
function leesGsqInstellingen(map) {
  const naam = 'gsq-lokaal.json'
  const waarde = leesInstelling(map, naam)
  if (!isObject(waarde)) throw new GebruiksFout(`${naam} moet een JSON-object zijn`)
  if (typeof waarde.name !== 'string' || waarde.name === '') throw new GebruiksFout(`${naam}: name moet een tekst zijn die niet leeg is`)
  if (waarde.reasoningEffort !== null && (typeof waarde.reasoningEffort !== 'string' || waarde.reasoningEffort === '')) {
    throw new GebruiksFout(`${naam}: reasoningEffort moet null zijn of een tekst die niet leeg is`)
  }
  if (waarde.extraBody !== null && !isObject(waarde.extraBody)) throw new GebruiksFout(`${naam}: extraBody moet null zijn of een JSON-object`)
  geenProviderBlok(waarde.extraBody, naam)
  return { reasoningEffort: waarde.reasoningEffort, extraBody: waarde.extraBody }
}

/** run-extra-or.json, written by meet: a JSON object with the request fields that turn thinking on. */
function leesExtraOr(map) {
  const naam = 'run-extra-or.json'
  const waarde = leesInstelling(map, naam)
  if (!isObject(waarde)) throw new GebruiksFout(`${naam} moet een JSON-object zijn`)
  geenProviderBlok(waarde, naam)
  return waarde
}

async function manifestenModus(waarden, { uit, sleutels }) {
  const map = resolve(waarden.uit)
  const repo = resolve(waarden.repo)
  const gsq = leesGsqInstellingen(map)
  const extraOr = leesExtraOr(map)
  // The manifests point the doc server at the checkout; a wrong --repo would only show when a run starts.
  for (const pad of [join(repo, 'dist', 'cli.js'), join(repo, '__tests__', 'fixtures', 'docset')]) {
    if (!existsSync(pad)) throw new GebruiksFout(`${pad} ontbreekt: --repo moet een gebouwde checkout zijn (npm run build)`)
  }
  const aanwezig = MANIFEST_UITVOER.filter((naam) => existsSync(join(map, naam)))
  if (aanwezig.length > 0) throw new GebruiksFout(`--uit bevat al ${aanwezig.join(', ')}; kies een nieuwe map`)

  const [lokaal, gehost, probe] = MANIFEST_UITVOER
  const uitvoer = [
    [lokaal, maakManifest({ naam: MODEL_LOKAAL, repo, reasoningEffort: gsq.reasoningEffort, extraBody: gsq.extraBody })],
    [gehost, maakManifest({ naam: MODEL_GEHOST, repo, extraBody: extraOr })],
    [probe, probeExtra(gsq.extraBody, gsq.reasoningEffort)],
  ]
  for (const [naam, inhoud] of uitvoer) {
    schrijfJson(join(map, naam), inhoud, sleutels, 'wx')
    uit.write(`geschreven ${naam}\n`)
  }
  return 0
}

// ---- mode opzoeken ----

// OpenRouter has the generation of an answer a moment after the answer; the lookup comes at least this long after it.
const OPZOEK_WACHT_MS = 10_000
const OPZOEK_TIMEOUT_MS = 30_000
const GENERATION_PAD = '/api/v1/generation'
const ENDPOINTS_PAD = '/api/v1/models/qwen/qwen3.8-27b/endpoints'

/** How long to wait before a lookup of an answer that came at `tijd`: the rest of the 10 s, never more, 10 s when the moment is not known. */
export function wachtMs(tijd, nu = Date.now()) {
  const moment = typeof tijd === 'string' ? Date.parse(tijd) : NaN
  const rest = Number.isFinite(moment) ? moment + OPZOEK_WACHT_MS - nu : OPZOEK_WACHT_MS
  return Math.min(OPZOEK_WACHT_MS, Math.max(0, rest))
}

/**
 * Whether the provider of an answer serves BF16 according to the endpoint list (a consistency check, not a measured precision of
 * the answer). `lijst` is [{ provider_name, quantization }], or null when there is no usable list. A failed lookup (no provider
 * name) is judged first.
 */
export function precisieOordeel(provider, lijst) {
  if (typeof provider !== 'string' || provider.trim() === '') return 'niet gemeten (opzoeking mislukt)'
  if (lijst === null) return 'niet gemeten (endpointlijst mislukt)'
  const naam = provider.trim().toLowerCase()
  const precisies = new Set(
    lijst
      .filter((endpoint) => typeof endpoint.provider_name === 'string' && endpoint.provider_name.trim().toLowerCase() === naam)
      .map((endpoint) => (typeof endpoint.quantization === 'string' ? endpoint.quantization.trim().toLowerCase() : null)),
  )
  if (precisies.size > 1) return 'precisie niet eenduidig aangetoond'
  if (precisies.size === 1 && precisies.has('bf16')) return 'bf16 volgens endpointlijst'
  return 'niet in BF16-lijst'
}

/** The lines of one --in file: the cost lines of a meting.json, or every line of an antwoorden.jsonl (a name ending in .jsonl). */
function leesInvoer(pad) {
  let tekst
  try {
    tekst = readFileSync(pad, 'utf8')
  } catch (e) {
    throw new GebruiksFout(`--in ${pad} is niet leesbaar: ${foutSoort(e)}`)
  }
  if (pad.endsWith('.jsonl')) {
    return tekst.split('\n').flatMap((regel, i) => {
      if (regel.trim() === '') return []
      const waarde = leesJson(regel)
      if (waarde === undefined) throw new GebruiksFout(`--in ${pad}: regel ${i + 1} is geen JSON`)
      return [waarde]
    })
  }
  const document = leesJson(tekst)
  if (!isObject(document)) throw new GebruiksFout(`--in ${pad} is geen meting.json (een JSON-object met een cost-lijst)`)
  if (document.cost === undefined) return [] // a measurement that stopped before the cost step
  if (!Array.isArray(document.cost)) throw new GebruiksFout(`--in ${pad}: cost is geen lijst`)
  return document.cost
}

/** The answers of the hosted model in the input lines, once per id (a line without an id is kept as it is), in the order they first appear. */
function verzamelAntwoorden(regels, sleutels) {
  const gezien = new Set()
  const antwoorden = []
  for (const regel of regels) {
    if (!isObject(regel) || regel.model !== MODEL_GEHOST) continue
    const id = kortTekst(regel.id, sleutels)
    if (id !== null) {
      if (gezien.has(id)) continue
      gezien.add(id)
    }
    antwoorden.push({
      id,
      tijd: kortTekst(regel.tijd, sleutels),
      bron: kortTekst(regel.bron, sleutels),
      bedrag: typeof regel.bedrag === 'number' && Number.isFinite(regel.bedrag) ? regel.bedrag : null,
    })
  }
  return antwoorden
}

/** What is kept of a lookup: the status and, from data, the provider name and the total cost. A non-2xx keeps a masked excerpt, no fields. */
function opzoekRecord(antwoord, sleutels) {
  if (!isTweehonderd(antwoord.http_status)) {
    return { http_status: antwoord.http_status, provider_name: null, total_cost: null, excerpt: maskeer(antwoord.tekst, sleutels).slice(0, 200) }
  }
  const data = antwoord.json?.data
  const kosten = data?.total_cost
  return {
    http_status: antwoord.http_status,
    provider_name: kortTekst(data?.provider_name, sleutels),
    total_cost: typeof kosten === 'number' && Number.isFinite(kosten) ? kosten : null,
  }
}

/** The endpoint list: what goes into the output, and the list to judge against (null when there is no usable one). */
function leesEndpoints(antwoord, sleutels) {
  const endpoints = antwoord.json?.data?.endpoints
  if (isTweehonderd(antwoord.http_status) && Array.isArray(endpoints)) {
    const lijst = endpoints.map((endpoint) => ({ provider_name: kortTekst(endpoint?.provider_name, sleutels), quantization: kortTekst(endpoint?.quantization, sleutels) }))
    return { record: { http_status: antwoord.http_status, lijst }, lijst }
  }
  const record = { http_status: antwoord.http_status, lijst: [] }
  if (!isTweehonderd(antwoord.http_status)) record.excerpt = maskeer(antwoord.tekst, sleutels).slice(0, 200)
  return { record, lijst: null }
}

async function opzoekenModus(waarden, { env, uit, fout, sleutels }) {
  const sleutel = env.OPENROUTER_API_KEY
  if (!sleutel) throw new GebruiksFout('OPENROUTER_API_KEY ontbreekt in de omgeving')
  if (!HEADERTEKENS.test(sleutel)) throw new GebruiksFout('OPENROUTER_API_KEY bevat tekens die niet in een header kunnen')
  const basis = leesBasisUrl(waarden['base-url'] ?? OPENROUTER_BASIS)
  if (waarden.in.some((pad) => pad === '')) throw new GebruiksFout('--in mag niet leeg zijn')
  const uitPad = resolve(waarden.out)
  if (existsSync(uitPad)) throw new GebruiksFout('--out bestaat al; kies een nieuw bestand')
  const antwoorden = verzamelAntwoorden(waarden.in.flatMap(leesInvoer), sleutels)
  try {
    mkdirSync(dirname(uitPad), { recursive: true })
  } catch (e) {
    throw new GebruiksFout(`--out is niet bruikbaar: ${foutSoort(e)}`)
  }

  const resultaat = { endpoints: undefined, antwoorden: [] }
  let stap = 'start'
  let opgezocht = 0
  let metAanbieder = 0
  let afgebroken = null
  try {
    // The list first: it needs no wait, and every answer can be judged as soon as it is looked up.
    stap = 'endpoints'
    const lijstAntwoord = await vraag({ url: `${basis}${ENDPOINTS_PAD}`, sleutel, timeoutMs: OPZOEK_TIMEOUT_MS })
    const { record, lijst } = leesEndpoints(lijstAntwoord, sleutels)
    resultaat.endpoints = record
    uit.write(`endpoints ${record.http_status}\n`)

    for (const antwoord of antwoorden) {
      if (!antwoord.id?.startsWith('gen-')) {
        resultaat.antwoorden.push({ ...antwoord, opzoeking: null, oordeel: 'aanbieder niet gemeten via OpenRouter' })
        continue
      }
      stap = 'generation'
      const wacht = wachtMs(antwoord.tijd)
      if (wacht > 0) await new Promise((klaar) => setTimeout(klaar, wacht))
      const gevonden = await vraag({ url: `${basis}${GENERATION_PAD}?id=${encodeURIComponent(antwoord.id)}`, sleutel, timeoutMs: OPZOEK_TIMEOUT_MS })
      const opzoeking = opzoekRecord(gevonden, sleutels)
      const provider = isTweehonderd(opzoeking.http_status) ? opzoeking.provider_name : null
      opgezocht++
      if (typeof provider === 'string' && provider.trim() !== '') metAanbieder++
      resultaat.antwoorden.push({ ...antwoord, opzoeking, oordeel: precisieOordeel(provider, lijst) })
    }
    uit.write(`opzoeken ${antwoorden.length} antwoorden, ${opgezocht} opgezocht, ${metAanbieder} met aanbieder\n`)
  } catch (e) {
    const bekend = e instanceof GeenAntwoord
    afgebroken = { stap, reden: bekend ? e.reden : `interne fout: ${e?.name ?? 'Error'}` }
    fout.write(`afgebroken in stap ${stap}: ${maskeer(bekend ? e.reden : (e?.stack ?? String(e)), sleutels)}\n`)
  }
  schrijfJson(uitPad, { endpoints: resultaat.endpoints, antwoorden: resultaat.antwoorden, afgebroken: afgebroken ?? undefined }, sleutels, 'wx')
  return afgebroken ? 1 : 0
}

// ---- dispatch ----

// One entry per mode: its usage line, its options, the options that must be there, and the function that runs it.
const MODI = {
  meet: {
    gebruik: 'meet --base-url <url zonder /v1> --out <map> [--timeout-sec <seconden, standaard 660>]   (omgeving: LITELLM_MASTER_KEY)',
    opties: { 'base-url': { type: 'string' }, out: { type: 'string' }, 'timeout-sec': { type: 'string' } },
    verplicht: ['base-url', 'out'],
    uitvoeren: meetModus,
  },
  proxy: {
    gebruik: 'proxy --listen 127.0.0.1:<poort> --upstream <url> --log <bestand> [--timeout-sec <seconden, standaard 660>]',
    opties: { listen: { type: 'string' }, upstream: { type: 'string' }, log: { type: 'string' }, 'timeout-sec': { type: 'string' } },
    verplicht: ['listen', 'upstream', 'log'],
    uitvoeren: proxyModus,
  },
  manifesten: {
    gebruik: 'manifesten --uit <map met gsq-lokaal.json en run-extra-or.json> --repo <gebouwde checkout van agent-harness>',
    opties: { uit: { type: 'string' }, repo: { type: 'string' } },
    verplicht: ['uit', 'repo'],
    uitvoeren: manifestenModus,
  },
  opzoeken: {
    gebruik: `opzoeken --in <meting.json of antwoorden.jsonl> [--in ...] --out <bestand> [--base-url <url, standaard ${OPENROUTER_BASIS}>]   (omgeving: OPENROUTER_API_KEY)`,
    opties: { in: { type: 'string', multiple: true }, out: { type: 'string' }, 'base-url': { type: 'string' } },
    verplicht: ['in', 'out'],
    uitvoeren: opzoekenModus,
  },
}

function gebruikstekst() {
  return ['Gebruik: node meet.mjs <modus> [opties]', ...Object.values(MODI).map((modus) => `  ${modus.gebruik}`)].join('\n')
}

/** Runs one mode and returns the exit code. `env` and `io` are parameters so a test can call it without a child process. */
export async function main(argv, env = process.env, io = { uit: process.stdout, fout: process.stderr }) {
  const sleutels = [env.LITELLM_MASTER_KEY, env.OPENROUTER_API_KEY].filter(Boolean)
  const [naam, ...rest] = argv
  try {
    if (naam === undefined) throw new GebruiksFout('geen modus opgegeven')
    if (!Object.hasOwn(MODI, naam)) throw new GebruiksFout(`onbekende modus: ${naam}`)
    const modus = MODI[naam]
    let waarden
    try {
      waarden = parseArgs({ args: rest, options: modus.opties, strict: true }).values
    } catch (e) {
      throw new GebruiksFout(String(e.message).split(/\.\s/)[0])
    }
    // An empty value counts as missing: --out "" (an unset variable in quotes) would otherwise mean the working directory.
    const ontbreekt = modus.verplicht.filter((optie) => !waarden[optie])
    if (ontbreekt.length > 0) throw new GebruiksFout(`ontbrekende optie: ${ontbreekt.map((optie) => `--${optie}`).join(', ')}`)
    return await modus.uitvoeren(waarden, { env, uit: io.uit, fout: io.fout, sleutels })
  } catch (e) {
    if (e instanceof GebruiksFout) {
      io.fout.write(`meet.mjs: ${maskeer(e.message, sleutels)}\n${gebruikstekst()}\n`)
      return 2
    }
    io.fout.write(`meet.mjs: onverwachte fout: ${maskeer(e?.stack ?? String(e), sleutels)}\n`)
    return 1
  }
}

// Real paths on both sides: process.argv[1] keeps a symlink in the path while import.meta.url does not, and a mismatch
// would make the script exit 0 without doing anything.
function directAangeroepen() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (directAangeroepen()) process.exitCode = await main(process.argv.slice(2))
