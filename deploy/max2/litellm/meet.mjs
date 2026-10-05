// Measurement script for the M45 trial window on max2 (increment 1). Node built-ins only: it runs from the clone on max2
// without an npm install.
//
//   node meet.mjs meet --base-url http://127.0.0.1:4000 --out <dir> [--timeout-sec 660]
//
// Modes: meet (below). The modes proxy, manifesten and opzoeken are added to MODI in the next task.
//
// Keys come from the environment only and go into a header only: LITELLM_MASTER_KEY (meet), OPENROUTER_API_KEY (opzoeken).
// Everything written to disk and every error text passes through maskeer, which replaces a key by <redacted>; the progress lines
// on stdout hold only step names and status codes.
//
// Exit codes: 0 every request got an HTTP answer (4xx and 5xx included), 1 a request got no answer (the run stops and
// meting.json says where), 2 a mandatory key, option or mode is missing or unusable (stops before the first request).
//
// meet writes into --out: meting.json (the result), probe-extra-or.json (the uit-vorm: the request fields that turn thinking
// off, {} if none), run-extra-or.json (the aan-vorm), kanarie.txt (the canary strings that were sent, one per line).

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const REDACTED = '<redacted>'
export const MODEL_LOKAAL = 'gsq-lokaal'
export const MODEL_GEHOST = 'qwen3.8-or'
export const MODEL_NEGATIEF = 'qwen3.8-or-neg'
export const PROMPT = 'Antwoord alleen met: pong'
// Just above the 600 s that LiteLLM gives an upstream request, so a time-out of LiteLLM itself arrives as an HTTP answer.
export const STANDAARD_TIMEOUT_SEC = 660

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

/** Everything written to disk goes through here, so the masking cannot be forgotten at a single call site. */
export function schrijfJson(pad, waarde, sleutels) {
  writeFileSync(pad, `${JSON.stringify(maskeerDiep(waarde, sleutels), null, 2)}\n`)
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
 * One request. Resolves with every HTTP answer, 4xx and 5xx included: { http_status, headers (lower-cased names), tekst, json
 * (undefined when the body is no JSON), tijd (ISO-8601, when the body was complete) }. Rejects with GeenAntwoord when no
 * complete answer arrives: a network error, a connection that breaks off, or `timeoutMs` passing for the whole request.
 *
 * node:http and not fetch: fetch gives up on its own after 300 s of waiting for headers or body, below the 660 s default that
 * is meant to outlast LiteLLM's own 600 s time-out.
 */
export function vraag({ url, methode = 'GET', sleutel, body, timeoutMs }) {
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
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const headers = { accept: 'application/json', connection: 'close' }
    if (sleutel) headers.authorization = `Bearer ${sleutel}`
    if (data) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(data.length)
    }
    // agent: false, so a connection that a test or a proxy cuts is never reused by the next request.
    const req = (doel.protocol === 'https:' ? https : http).request(doel, { method: methode, headers, agent: false }, (res) => {
      let tekst = ''
      res.setEncoding('utf8')
      res.on('data', (stuk) => {
        tekst += stuk
      })
      res.on('end', () => eindig(gelukt, { http_status: res.statusCode, headers: res.headers, tekst, json: leesJson(tekst), tijd: new Date().toISOString() }))
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

function kortTekst(waarde) {
  return typeof waarde === 'string' ? waarde.slice(0, 200) : null
}

/** The record of one hosted answer, shared by the cost lines here and the proxy lines of the next task. `antwoord` is a result of vraag(). */
export function antwoordRecord(model, antwoord) {
  const kosten = kostenVelden(antwoord)
  return {
    tijd: antwoord.tijd,
    model,
    http_status: antwoord.http_status,
    ...kosten,
    provider: kortTekst(antwoord.json?.provider),
    id: kortTekst(antwoord.json?.id),
    ...bepaalBron(kosten),
  }
}

/** Only a successful answer counts for the cost criterion; a 4xx or 5xx has no cost to speak of. */
export function inKostencriterium(record) {
  return record.http_status >= 200 && record.http_status < 300
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
    return { variant, http_status: antwoord.http_status, id: kortTekst(antwoord.json?.id), provider: kortTekst(antwoord.json?.provider) }
  }
  return { variant, http_status: antwoord.http_status, excerpt: maskeer(antwoord.tekst, sleutels).slice(0, 200) }
}

// ---- options ----

/** The base without trailing slash and without /v1 (the harness takes /v1 in its base url, so it is easy to paste one here). */
export function leesBasisUrl(waarde) {
  let url
  try {
    url = new URL(waarde)
  } catch {
    throw new GebruiksFout('--base-url moet een http(s)-URL zijn')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new GebruiksFout('--base-url moet een http(s)-URL zijn')
  return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
}

export function leesTimeoutMs(waarde) {
  if (waarde === undefined) return STANDAARD_TIMEOUT_SEC * 1000
  const seconden = DECIMAAL.test(waarde.trim()) ? Number(waarde) : NaN
  // An hour is plenty and keeps the value well below what setTimeout can hold.
  if (!(seconden > 0 && seconden <= 3600)) throw new GebruiksFout('--timeout-sec moet een getal groter dan 0 en hoogstens 3600 zijn')
  return Math.round(seconden * 1000)
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
      staat.cost.push({ stap: 'reasoning', vorm, ...antwoordRecord(MODEL_GEHOST, antwoord) })
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
      if (model === MODEL_GEHOST) staat.cost.push({ stap: 'canary', ...antwoordRecord(model, antwoord) })
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

// ---- dispatch ----

// One entry per mode: its usage line, its options, the options that must be there, and the function that runs it.
const MODI = {
  meet: {
    gebruik: 'meet --base-url <url zonder /v1> --out <map> [--timeout-sec <seconden, standaard 660>]   (omgeving: LITELLM_MASTER_KEY)',
    opties: { 'base-url': { type: 'string' }, out: { type: 'string' }, 'timeout-sec': { type: 'string' } },
    verplicht: ['base-url', 'out'],
    uitvoeren: meetModus,
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
