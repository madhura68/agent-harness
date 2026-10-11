import { describe, expect, it } from 'vitest'
import { createCostGuard, parseCeilingNanos, type CostGuard } from '../src/cost.js'
import type { Manifest } from '../src/manifest.js'
import type { ModelClient } from '../src/model-client.js'
import { runManifest, type RunDeps } from '../src/run.js'
import { openTrace } from '../src/trace.js'
import type { ChatMessage, CompleteResult, ToolCall, ToolDef, ToolExecResult, ToolRegistry } from '../src/types.js'
import { readTrace, tmp } from './helpers.js'

// M50-1b besluit 4: RunDeps.chatBudget (toolbudget, batch-reservering, slotaanroep, uitvoertokens). Met een nep-modelclient en een
// nep-registry: de tests gaan over run.ts zelf, niet over HTTP of MCP.

const STUB_MAX = 160
const CLOSING_PROMPT = 'Je kunt geen tools meer gebruiken. Antwoord nu met wat je hebt.'
const STUB_TEXT = 'de leesruimte is op; antwoord met wat je hebt'
const NOTE = 'afgekapt; vraag een sectie op met `heading`'

type Seen = { messages: ChatMessage[]; maxTokens: number; tools: ToolDef[] }
type ChatBudget = NonNullable<RunDeps['chatBudget']>
type Event = Record<string, unknown> & { type: string }

let ids = 0
const toolCall = (): ToolCall => ({ id: `t${++ids}`, name: 'read', arguments: '{}', argumentsWasObject: false })

function reply(o: { content?: string | null; calls?: number; finish?: CompleteResult['finishReason']; out?: number; cost?: number } = {}): CompleteResult {
  const toolCalls = Array.from({ length: o.calls ?? 0 }, toolCall)
  return {
    message: { content: o.content ?? null, toolCalls },
    finishReason: o.finish ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    usage: { source: 'provider_reported', inputTokens: 10, outputTokens: o.out ?? 10, ...(o.cost !== undefined ? { costUsd: o.cost } : {}) },
    model: 'm',
    durationMs: 1,
  }
}

const ok = (content: string): ToolExecResult => ({ ok: true, content, truncated: false })

function fakeRegistry(handler: (n: number) => ToolExecResult) {
  const entries = [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }]
  const executed: number[] = []
  const registry: ToolRegistry = {
    snapshot: { entries, hash: 'h' },
    toOpenAiTools: () => entries.map((e) => ({ type: 'function' as const, function: { name: e.name, description: e.description, parameters: e.inputSchema } })),
    execute: async () => {
      executed.push(executed.length + 1)
      return handler(executed.length)
    },
    close: async () => undefined,
  }
  return { registry, executed }
}

const BUDGET: ChatBudget = { toolChars: 48_000, closingReserve: 1_024 }
const LIMITS: Manifest['limits'] = { maxTurns: 6, maxOutputTokens: 4096, maxWallSeconds: 30, maxToolErrors: 2 }

async function run(
  respond: (n: number, seen: Seen) => CompleteResult,
  opts: {
    chat?: ChatBudget | null // null: no chatBudget at all
    limits?: Partial<Manifest['limits']>
    handler?: (n: number) => ToolExecResult
    costGuard?: CostGuard
  } = {},
) {
  const m: Manifest = {
    id: 'chat-budget-test', profile: 'tools', prompt: 'Vraag.',
    model: { baseUrl: 'http://127.0.0.1:1/v1', name: 'm' },
    tools: { server: { command: 'unused', args: [] }, allow: ['read'] },
    limits: { ...LIMITS, ...opts.limits },
  }
  const { registry, executed } = fakeRegistry(opts.handler ?? (() => ok('klein')))
  const seen: Seen[] = []
  const client: ModelClient = {
    async complete(messages, options) {
      const s: Seen = { messages: structuredClone(messages), maxTokens: options.maxTokens, tools: options.tools ?? [] }
      seen.push(s)
      return respond(seen.length, s)
    },
  }
  const trace = openTrace(tmp('chat-budget'), m.id)
  const chat = opts.chat === undefined ? BUDGET : opts.chat
  const result = await runManifest(m, {
    client, trace, connectRegistry: async () => registry,
    ...(chat ? { chatBudget: chat } : {}),
    ...(opts.costGuard ? { costGuard: opts.costGuard } : {}),
  })
  return { result, seen, executed, events: readTrace(trace.dir) as Event[] }
}

const toolMessages = (s: Seen) => s.messages.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool')
const closingEvents = (events: Event[]) => events.filter((e) => e.type === 'closing_call')

/** The closing call: tools [] on the wire, the fixed user message last, a closing_call event right before its model_request with 0 tools. */
function expectClosing(r: Awaited<ReturnType<typeof run>>, index: number, reason: string): void {
  const s = r.seen[index]
  expect(s.tools).toEqual([])
  expect(s.messages.at(-1)).toEqual({ role: 'user', content: CLOSING_PROMPT })
  expect(closingEvents(r.events)).toHaveLength(1)
  const at = r.events.findIndex((e) => e.type === 'closing_call')
  expect(r.events[at]).toMatchObject({ type: 'closing_call', reason })
  expect(r.events[at + 1]).toMatchObject({ type: 'model_request', tools: 0 })
  expect(r.seen).toHaveLength(index + 1) // at most one closing call, and nothing after it
}

/** Every tool call of every assistant message has exactly one answer, in order. */
function expectEveryCallAnswered(messages: ChatMessage[]): void {
  const asked = messages.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.id) : []))
  const answered = messages.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : []))
  expect(answered).toEqual(asked)
}

describe('chatBudget — toolbudget: afkappen', () => {
  it.each([48_000, 2_000])('kapt een te groot docresultaat af tot de rest (toolChars %i), ook met aanhalingstekens en regeleinden', async (toolChars) => {
    const big = '"a\nb"\t'.repeat(12_000)
    const r = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'Antwoord met wat er was.' })), {
      chat: { toolChars, closingReserve: 1_024 },
      handler: () => ok(big),
    })
    const msg = toolMessages(r.seen[1])[0].content
    expect(msg.length).toBeLessThanOrEqual(toolChars)
    expect(msg.length).toBeGreaterThanOrEqual(toolChars - 4) // binary search: at most one escaped character short
    const parsed = JSON.parse(msg) as { ok: boolean; content: string; truncated: boolean }
    expect(parsed.truncated).toBe(true)
    expect(parsed.content).toContain(NOTE)
    expect(parsed.content.startsWith('"a\nb"\t')).toBe(true)
    expect(r.result).toMatchObject({ status: 'completed', answer: 'Antwoord met wat er was.' })
  })

  it('bewaking: laat een resultaat dat past ongemoeid', async () => {
    const r = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'ok' })), { handler: () => ok('kort') })
    expect(toolMessages(r.seen[1])[0].content).toBe(JSON.stringify({ ok: true, content: 'kort', truncated: false }))
    expect(r.seen[1].tools).toHaveLength(1) // rest is still far above 360: a normal call with tools
    expect(closingEvents(r.events)).toHaveLength(0)
  })

  it('de afkap houdt het bericht geldige JSON, binnen de ruimte en zonder losse surrogaat, ook met emoji en stuurtekens', async () => {
    const content = '😀\u0001a'.repeat(500)
    for (let toolChars = 360; toolChars <= 420; toolChars++) {
      const r = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'ok' })), { chat: { toolChars, closingReserve: 1_024 }, handler: () => ok(content) })
      const msg = toolMessages(r.seen[1])[0].content
      expect(msg.length, `ruimte ${toolChars}`).toBeLessThanOrEqual(toolChars)
      const parsed = JSON.parse(msg) as { content: string; truncated: boolean } // throws on invalid JSON
      expect(parsed.truncated).toBe(true)
      expect(parsed.content, `ruimte ${toolChars}`).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
      expect(msg, `ruimte ${toolChars}`).not.toMatch(/\\ud[89ab][0-9a-f]{2}|\\ud[c-f][0-9a-f]{2}/i) // no escaped half either
      expect(content.startsWith(parsed.content.slice(0, parsed.content.indexOf('\nafgekapt')))).toBe(true)
    }
  })

  it('het tool_result-event zegt truncated: true als de chatbudget afkapt, ook als het registryresultaat dat niet was', async () => {
    const cut = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'ok' })), { chat: { toolChars: 1_000, closingReserve: 1_024 }, handler: () => ok('x'.repeat(5_000)) })
    expect(cut.events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true, truncated: true })
    expect(JSON.parse(toolMessages(cut.seen[1])[0].content).truncated).toBe(true)
    const whole = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'ok' })), { handler: () => ok('kort') })
    expect(whole.events.find((e) => e.type === 'tool_result')).toMatchObject({ truncated: false })
    const registryCut = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'ok' })), { handler: () => ({ ok: true, content: 'kort', truncated: true }) })
    expect(registryCut.events.find((e) => e.type === 'tool_result')).toMatchObject({ truncated: true })
    const stub = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'ok' })), { chat: { toolChars: 300, closingReserve: 1_024 } })
    expect(stub.events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, errorCode: 'TOOL_BUDGET', truncated: false })
  })

  it('bewaking: zonder chatBudget meldt tool_result alleen de truncated van de registry', async () => {
    const r = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'ok' })), { chat: null, handler: () => ok('x'.repeat(60_000)) })
    expect(r.events.find((e) => e.type === 'tool_result')).toMatchObject({ truncated: false })
  })

  it('telt de som van alle tool-berichten, ook bij grote batches, en laat nooit een aanroep zonder antwoord', async () => {
    for (const perBatch of [25, 40, 150]) {
      const r = await run((_n, s) => (s.tools.length > 0 ? reply({ calls: perBatch }) : reply({ content: 'Klaar.' })), {
        limits: { maxTurns: 30 },
        handler: () => ok('z'.repeat(3_000)),
      })
      const last = r.seen.at(-1)!
      const sum = toolMessages(last).reduce((total, m) => total + m.content.length, 0)
      expect(sum, `batch van ${perBatch}`).toBeLessThanOrEqual(48_000)
      expect(r.executed.length).toBeGreaterThan(0)
      expectEveryCallAnswered(last.messages)
      expect(r.result.status).toBe('completed')
      expect(closingEvents(r.events)).toHaveLength(1)
    }
  })
})

describe('chatBudget — TOOL_BUDGET en batch-reservering', () => {
  it('een batch van drie waarvan de eerste bijna alles opmaakt: de rest krijgt TOOL_BUDGET zonder registry-aanroep, geen toolfout', async () => {
    const r = await run((n) => (n === 1 ? reply({ calls: 3 }) : reply({ content: 'Dit is wat ik heb.' })), {
      chat: { toolChars: 3_000, closingReserve: 1_024 },
      handler: () => ok('y'.repeat(5_000)),
    })
    expect(r.executed).toHaveLength(1)
    const msgs = toolMessages(r.seen[1])
    expect(msgs).toHaveLength(3)
    expectEveryCallAnswered(r.seen[1].messages)
    expect(JSON.parse(msgs[0].content)).toMatchObject({ ok: true, truncated: true })
    for (const m of msgs.slice(1)) expect(JSON.parse(m.content)).toMatchObject({ ok: false, errorCode: 'TOOL_BUDGET', content: STUB_TEXT, truncated: false })
    expect(msgs.reduce((total, m) => total + m.content.length, 0)).toBeLessThanOrEqual(3_000)
    expect(r.result).toMatchObject({ status: 'completed', answer: 'Dit is wat ik heb.', usage: { toolErrors: 0 } })
    expectClosing(r, 1, 'tool_budget')
  })

  it('het TOOL_BUDGET-bericht is hooguit 160 tekens', async () => {
    const r = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'ok' })), { chat: { toolChars: 300, closingReserve: 1_024 } })
    const content = toolMessages(r.seen[1])[0].content
    expect(content.length).toBeLessThanOrEqual(STUB_MAX)
    expect(JSON.parse(content)).toEqual({ ok: false, errorCode: 'TOOL_BUDGET', content: STUB_TEXT, truncated: false })
  })

  it('een batch van 40 bij een rest kleiner dan 40 × 160: de batch komt niet in het transcript en de slotaanroep volgt direct', async () => {
    const r = await run((n) => (n === 1 ? reply({ content: 'ik ga lezen', calls: 40 }) : reply({ content: 'Zonder lezen.' })), {
      chat: { toolChars: 40 * STUB_MAX - 1, closingReserve: 1_024 },
    })
    expect(r.executed).toHaveLength(0)
    expect(r.seen[1].messages.some((m) => m.role === 'assistant')).toBe(false)
    expect(r.seen[1].messages.some((m) => m.role === 'tool')).toBe(false)
    expect(r.result).toMatchObject({ status: 'completed', answer: 'Zonder lezen.', usage: { toolCalls: 0 } })
    expectClosing(r, 1, 'batch_dropped')
  })

  it('een batch van 40 bij precies genoeg ruimte voor de stubs komt wel in het transcript: eerst 5 stubs, dan 35 uitgevoerd, hooguit toolChars', async () => {
    const r = await run((n) => (n === 1 ? reply({ calls: 40 }) : reply({ content: 'ok' })), { chat: { toolChars: 40 * STUB_MAX, closingReserve: 1_024 } })
    const msgs = toolMessages(r.seen[1])
    expect(msgs).toHaveLength(40)
    expectEveryCallAnswered(r.seen[1].messages)
    // Room of call i = 6400 − spent − (39 − i) × 160, a stub being 114 characters and a result of 'klein' 47:
    // i=0: 160, i=1: 206, i=2: 252, i=3: 298, i=4: 344 (all below 360: a stub); i=5: 390 and from there on more: executed.
    const kinds = msgs.map((m) => (JSON.parse(m.content).errorCode === 'TOOL_BUDGET' ? 'stub' : 'uitgevoerd'))
    expect(kinds).toEqual([...Array(5).fill('stub'), ...Array(35).fill('uitgevoerd')])
    expect(msgs.slice(0, 5).map((m) => m.content.length)).toEqual([114, 114, 114, 114, 114])
    expect(msgs[5].content).toBe(JSON.stringify({ ok: true, content: 'klein', truncated: false }))
    expect(r.executed).toHaveLength(35)
    expect(msgs.reduce((total, m) => total + m.content.length, 0)).toBeLessThanOrEqual(40 * STUB_MAX)
    expectClosing(r, 1, 'tool_budget') // a stub was given: the closing call follows
  })

  it('ruimte 300 (onder 360): TOOL_BUDGET zonder uitvoering', async () => {
    const r = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'ok' })), { chat: { toolChars: 300, closingReserve: 1_024 } })
    expect(r.executed).toHaveLength(0)
    expect(JSON.parse(toolMessages(r.seen[1])[0].content)).toMatchObject({ errorCode: 'TOOL_BUDGET' })
    expectClosing(r, 1, 'tool_budget')
  })

  it('ruimte 0: de batch past niet eens als stub, dus niet toegevoegd en niet uitgevoerd', async () => {
    const r = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'ok' })), { chat: { toolChars: 0, closingReserve: 1_024 } })
    expect(r.executed).toHaveLength(0)
    expect(toolMessages(r.seen[1])).toHaveLength(0)
    expectClosing(r, 1, 'batch_dropped')
  })

  it('ruimte precies 360 voert uit; een rest onder 360 na de batch geeft de slotaanroep zonder een nieuwe aanroep met tools', async () => {
    const exact = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'ok' })), { chat: { toolChars: 360, closingReserve: 1_024 }, handler: () => ok('a') })
    expect(exact.executed).toHaveLength(1)
    expect(toolMessages(exact.seen[1])[0].content).toBe(JSON.stringify({ ok: true, content: 'a', truncated: false }))

    const r = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'ok' })), {
      chat: { toolChars: 500, closingReserve: 1_024 },
      handler: () => ok('c'.repeat(160)), // message of 201 characters: 299 left
    })
    expect(r.executed).toHaveLength(1)
    expect(r.events.filter((e) => e.type === 'model_request').map((e) => e.tools)).toEqual([1, 0])
    expectClosing(r, 1, 'tool_budget')
  })

  it('bewaking: toolfouten van uitgevoerde aanroepen tellen met chatBudget wel mee voor maxToolErrors', async () => {
    const r = await run((_n, s) => (s.tools.length > 0 ? reply({ calls: 1 }) : reply({ content: 'ok' })), {
      limits: { maxToolErrors: 1 },
      handler: () => ({ ok: false, errorCode: 'TOOL_ERROR', content: 'stuk', truncated: false }),
    })
    expect(r.result).toMatchObject({ status: 'failed', error: { code: 'TOO_MANY_TOOL_ERRORS' } })
  })
})

describe('chatBudget — slotaanroep: maxTurns en uitvoertokens', () => {
  it('een model dat tot maxTurns tools blijft vragen krijgt één extra beurt zonder tools en eindigt completed', async () => {
    const r = await run((_n, s) => (s.tools.length > 0 ? reply({ calls: 1 }) : reply({ content: 'Nu antwoord ik.' })), { limits: { maxTurns: 3 } })
    expect(r.result).toMatchObject({ status: 'completed', answer: 'Nu antwoord ik.', usage: { turns: 4 } })
    expect(r.seen).toHaveLength(4)
    expectClosing(r, 3, 'max_turns')
  })

  it('TOOL_BUDGET op de laatste beurt geeft ook precies één slotaanroep', async () => {
    const r = await run((n) => (n === 1 ? reply({ calls: 1 }) : n === 2 ? reply({ calls: 2 }) : reply({ content: 'Klaar.' })), {
      limits: { maxTurns: 2 },
      chat: { toolChars: 500, closingReserve: 1_024 },
      handler: () => ok('d'.repeat(60)), // message of 101 characters: 399 left, but a batch of two leaves 239 for the first call
    })
    expect(r.executed).toHaveLength(1)
    expect(toolMessages(r.seen[2]).slice(1).map((m) => JSON.parse(m.content).errorCode)).toEqual(['TOOL_BUDGET', 'TOOL_BUDGET'])
    expect(r.result).toMatchObject({ status: 'completed', answer: 'Klaar.' })
    expectClosing(r, 2, 'tool_budget')
  })

  it('een aanroep met tools krijgt maxTokens ≤ maxOutputTokens − verbruikt − 1024', async () => {
    const r = await run((n) => (n === 1 ? reply({ calls: 1, out: 1_500 }) : reply({ content: 'ok' })))
    expect(r.seen[0].maxTokens).toBe(4096 - 1_024)
    expect(r.seen[1].maxTokens).toBe(4096 - 1_500 - 1_024)
    expect(r.seen[1].tools).toHaveLength(1)
  })

  it('precies 1024 voor een aanroep met tools mag nog; daaronder volgt direct de slotaanroep met de rest', async () => {
    const edge = await run((n) => (n === 1 ? reply({ calls: 1, out: 2_048 }) : reply({ content: 'ok' })))
    expect(edge.seen[1].maxTokens).toBe(1_024)
    expect(edge.seen[1].tools).toHaveLength(1)
    expect(closingEvents(edge.events)).toHaveLength(0)

    for (const used of [2_049, 2_596, 3_596, 4_095]) {
      const r = await run((n) => (n === 1 ? reply({ calls: 1, out: used }) : reply({ content: 'Kort antwoord.' })))
      expect(r.seen[1].maxTokens, `verbruikt ${used}`).toBe(4096 - used)
      expect(r.result).toMatchObject({ status: 'completed', answer: 'Kort antwoord.' })
      expectClosing(r, 1, 'output_budget')
    }
  })

  it('een gewone aanroep op length zonder tool-aanroepen wordt gevolgd door precies één slotaanroep (completed met tekst)', async () => {
    const r = await run((n) => (n === 1 ? reply({ content: 'half antw', finish: 'length', out: 3_072 }) : reply({ content: 'Rond af.' })))
    expect(r.seen[1].messages.slice(-2)).toEqual([{ role: 'assistant', content: 'half antw' }, { role: 'user', content: CLOSING_PROMPT }])
    expect(r.seen[1].maxTokens).toBe(4096 - 3_072)
    expect(r.result).toMatchObject({ status: 'completed', answer: 'Rond af.' })
    expectClosing(r, 1, 'length')
  })

  it('de slotaanroep na length zonder tekst is budget_exceeded (lege tekst, whitespace en null)', async () => {
    for (const content of ['', '  \n', null]) {
      const r = await run((n) => (n === 1 ? reply({ content: 'half', finish: 'length' }) : reply({ content })))
      expect(r.result.status).toBe('budget_exceeded')
      expectClosing(r, 1, 'length')
    }
  })

  it('slotaanroep: tekst met finishReason length is completed met die tekst', async () => {
    const r = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: 'afgebroken maar bruikbaar', finish: 'length', out: 4_000 })), { limits: { maxTurns: 1 } })
    expect(r.result).toMatchObject({ status: 'completed', answer: 'afgebroken maar bruikbaar' })
    expectClosing(r, 1, 'max_turns')
  })

  it('slotaanroep: lege tekst is budget_exceeded', async () => {
    const r = await run((n) => (n === 1 ? reply({ calls: 1 }) : reply({ content: '' })), { limits: { maxTurns: 1 } })
    expect(r.result.status).toBe('budget_exceeded')
    expectClosing(r, 1, 'max_turns')
  })

  it('slotaanroep: tekst plus tool-aanroepen bij een bereikt plafond (gehost) is completed en de tools worden niet uitgevoerd', async () => {
    const guard = createCostGuard({ mode: 'hosted', ceilingNanos: parseCeilingNanos('0.01'), configuration: 'cfg' })
    const r = await run((n) => (n === 1 ? reply({ calls: 1, cost: 0.001 }) : reply({ content: 'Dit heb ik.', calls: 2, cost: 0.02 })), { limits: { maxTurns: 1 }, costGuard: guard })
    expect(r.result).toMatchObject({ status: 'completed', answer: 'Dit heb ik.' })
    expect(r.executed).toHaveLength(1) // only the call of the first turn
    expectClosing(r, 1, 'max_turns')
  })

  it('slotaanroep zonder bedrag stopt de kostenbewaking nog wel (COST_UNKNOWN)', async () => {
    const guard = createCostGuard({ mode: 'hosted', ceilingNanos: parseCeilingNanos('1'), configuration: 'cfg' })
    const r = await run((n) => (n === 1 ? reply({ calls: 1, cost: 0.001 }) : reply({ content: 'Dit heb ik.' })), { limits: { maxTurns: 1 }, costGuard: guard })
    expect(r.result).toMatchObject({ status: 'failed', error: { code: 'COST_UNKNOWN' } })
  })
})

describe('chatBudget — kostenplafond blijft hard', () => {
  it('een hosted direct antwoord op length dat zelf het plafond bereikt: de slotaanroep wordt niet gedaan (COST_LIMIT_EXCEEDED)', async () => {
    const guard = createCostGuard({ mode: 'hosted', ceilingNanos: parseCeilingNanos('0.01'), configuration: 'cfg' })
    const r = await run(() => reply({ content: 'half antwoord', finish: 'length', cost: 0.02 }), { costGuard: guard })
    expect(r.result).toMatchObject({ status: 'failed', error: { code: 'COST_LIMIT_EXCEEDED' } })
    expect(r.seen).toHaveLength(1)
    expect(closingEvents(r.events)).toHaveLength(0)
  })
})

describe('chatBudget — bewaking: zonder chatBudget gedraagt runManifest zich als voorheen', () => {
  it('maxTurns bereikt: budget_exceeded zonder extra beurt en zonder closing_call', async () => {
    const r = await run(() => reply({ calls: 1 }), { chat: null, limits: { maxTurns: 2 } })
    expect(r.result.status).toBe('budget_exceeded')
    expect(r.seen).toHaveLength(2)
    expect(r.events.filter((e) => e.type === 'model_request').map((e) => [e.turn, e.tools, e.maxTokens])).toEqual([[1, 1, 4096], [2, 1, 4086]])
    expect(closingEvents(r.events)).toHaveLength(0)
  })

  it('length zonder tool-aanroepen blijft budget_exceeded', async () => {
    const r = await run(() => reply({ content: 'half', finish: 'length' }), { chat: null })
    expect(r.result.status).toBe('budget_exceeded')
    expect(r.seen).toHaveLength(1)
  })

  it('kapt niets af en laat alle aanroepen van een grote batch uitvoeren', async () => {
    const big = 'q'.repeat(60_000)
    const r = await run((n) => (n === 1 ? reply({ calls: 40 }) : reply({ content: 'ok' })), { chat: null, handler: () => ok(big) })
    expect(r.executed).toHaveLength(40)
    expect(toolMessages(r.seen[1])).toHaveLength(40)
    expect(toolMessages(r.seen[1])[0].content).toBe(JSON.stringify({ ok: true, content: big, truncated: false }))
    expect(r.seen[1].tools).toHaveLength(1)
    expect(r.result).toMatchObject({ status: 'completed', answer: 'ok', usage: { turns: 2, toolCalls: 40, toolErrors: 0 } })
    expect(r.events.map((e) => e.type).filter((t) => t === 'model_request' || t === 'closing_call')).toEqual(['model_request', 'model_request'])
  })

  it('dezelfde run geeft dezelfde uitkomst en model_request-reeks met een ruim chatBudget (afgezien van de uitvoer-reserve)', async () => {
    const script = (n: number) => (n === 1 ? reply({ calls: 2, out: 100 }) : reply({ content: 'ok', out: 100 }))
    const without = await run(script, { chat: null })
    const withBudget = await run(script)
    expect(withBudget.result).toMatchObject({ status: without.result.status, answer: without.result.answer, usage: { turns: 2, toolCalls: 2, toolErrors: 0 } })
    const shape = (events: Event[]) => events.filter((e) => e.type === 'model_request').map((e) => [e.turn, e.messages, e.tools])
    expect(shape(withBudget.events)).toEqual(shape(without.events))
  })
})
