import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCostGuard, formatNanos, parseCeilingNanos, statusCost, type CostMode } from '../src/cost.js'
import type { Manifest } from '../src/manifest.js'
import { createModelClient, type ModelClient } from '../src/model-client.js'
import { runManifest, type AfterAnswerResult } from '../src/run.js'
import { connectRegistry } from '../src/tools/registry.js'
import { openTrace } from '../src/trace.js'
import { completion, startFakeModelServer, type FakeTurn } from './fakes/fake-model-server.js'
import { startFakeMcp } from './fakes/fake-mcp-server.js'
import { tmp } from './helpers.js'

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let fake: Fake | undefined
const open: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await fake?.close()
  fake = undefined
  for (const o of open.splice(0)) await o.close().catch(() => undefined)
})

const CONFIGURATION = 'qwen3.8-or'
const limits: Manifest['limits'] = { maxTurns: 6, maxOutputTokens: 4096, maxWallSeconds: 30, maxToolErrors: 2 }
const usage = (cost?: number) => ({ prompt_tokens: 10, completion_tokens: 5, ...(cost === undefined ? {} : { cost }) })
/** A response that asks for the echo tool. */
const tool = (cost?: number, provider?: string): FakeTurn => ({
  body: completion({ toolCalls: [{ id: 'c', name: 'echo', arguments: '{"text":"hoi"}' }], usage: usage(cost), ...(provider ? { provider } : {}) }),
})
/** A final answer. */
const final = (cost?: number, provider?: string): FakeTurn => ({ body: completion({ content: 'klaar', usage: usage(cost), ...(provider ? { provider } : {}) }) })

async function run(
  script: FakeTurn[],
  opts: {
    mode?: CostMode
    ceiling?: string
    retryOnce?: boolean
    afterAnswer?: (answer: string, signal: AbortSignal) => Promise<AfterAnswerResult>
    signal?: AbortSignal
    maxWallSeconds?: number
  } = {},
) {
  fake = await startFakeModelServer(script)
  const mcp = await startFakeMcp()
  open.push(mcp)
  const m: Manifest = {
    id: 'cost-test', profile: 'tools', prompt: 'Doe iets met tools.',
    model: { baseUrl: fake.baseUrl, name: CONFIGURATION },
    tools: { server: { command: 'unused', args: [] }, allow: ['echo'] },
    limits: { ...limits, ...(opts.maxWallSeconds ? { maxWallSeconds: opts.maxWallSeconds } : {}) },
  }
  const trace = openTrace(tmp('cost'), m.id)
  const guard = createCostGuard({ mode: opts.mode ?? 'hosted', ceilingNanos: parseCeilingNanos(opts.ceiling ?? '1'), configuration: CONFIGURATION })
  // Counts the calls that reach the client, also those that never reach the server (a call on an aborted signal).
  const real = createModelClient({ baseUrl: fake.baseUrl, name: CONFIGURATION })
  let completeCalls = 0
  const client: ModelClient = { complete: (...args) => { completeCalls++; return real.complete(...args) } }
  const result = await runManifest(m, {
    client,
    trace,
    connectRegistry: async () => connectRegistry(mcp.client, ['echo']),
    costGuard: guard,
    ...(opts.retryOnce !== undefined ? { retryOnce: opts.retryOnce } : {}),
    ...(opts.afterAnswer ? { afterAnswer: opts.afterAnswer } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  return { result, guard, trace, requests: fake.requests, mcpCalls: mcp.calls, completeCalls: () => completeCalls }
}

describe('runManifest — the cost ceiling', () => {
  it('stops with COST_LIMIT_EXCEEDED when the ceiling is reached by a response with tool calls: no tools run, no further call', async () => {
    const r = await run([tool(0.01), tool(0.04), final(0.01)], { ceiling: '0.05' })
    expect(r.result.status).toBe('failed')
    expect(r.result.error).toEqual({ code: 'COST_LIMIT_EXCEEDED', message: '0.050000000 ≥ 0.050000000 USD na 2 aanroepen' })
    expect(r.requests).toHaveLength(2)
    expect(r.mcpCalls).toEqual(['echo']) // only the tool of the first response: the second response's tools did not run
    expect(r.guard.summary()).toMatchObject({ responses: 2, totalNanos: 50000000n })
  })

  it('keeps going while the total is below the ceiling', async () => {
    const r = await run([tool(0.01), tool(0.02), final(0.01)], { ceiling: '0.05' })
    expect(r.result).toMatchObject({ status: 'completed', answer: 'klaar' })
    expect(r.requests).toHaveLength(3)
  })

  it('stops when the ceiling equals the sum exactly: the sum is exact, 0.7 + 0.1 is 0.7999999999999999 in floats', async () => {
    expect(0.7 + 0.1).toBeLessThan(0.8)
    const r = await run([tool(0.7), tool(0.1), final(0.1)], { ceiling: '0.8' })
    expect(r.result.error?.code).toBe('COST_LIMIT_EXCEEDED')
    expect(r.requests).toHaveLength(2)
    expect(r.mcpCalls).toEqual(['echo'])
  })

  it.each([
    ['without afterAnswer', undefined],
    ['with an afterAnswer that accepts', async (): Promise<AfterAnswerResult> => ({ kind: 'accept' })],
  ])('keeps a final answer above the ceiling as completed (%s): it is paid for and gets no follow-up', async (_name, afterAnswer) => {
    const r = await run([final(0.09)], { ceiling: '0.05', ...(afterAnswer ? { afterAnswer } : {}) })
    expect(r.result).toMatchObject({ status: 'completed', answer: 'klaar' })
    expect(r.requests).toHaveLength(1)
    expect(statusCost(r.guard.summary())).toEqual({ reported_cost_usd: '0.090000000', cost_source: 'provider_reported' })
  })

  it('stops a follow-up call after an afterAnswer retry when the ceiling was passed: zero further calls', async () => {
    let gates = 0
    const r = await run([final(0.09), final(0.01)], {
      ceiling: '0.05',
      afterAnswer: async () => (++gates === 1 ? { kind: 'retry', message: 'Verify faalt.' } : { kind: 'accept' }),
    })
    expect(r.result.status).toBe('failed')
    expect(r.result.error).toEqual({ code: 'COST_LIMIT_EXCEEDED', message: '0.090000000 ≥ 0.050000000 USD na 1 aanroepen' })
    expect(r.requests).toHaveLength(1)
    expect(gates).toBe(1)
  })

  it('lets an afterAnswer retry go on while the total is still below the ceiling', async () => {
    let gates = 0
    const r = await run([final(0.01), final(0.01)], {
      ceiling: '0.05',
      afterAnswer: async () => (++gates === 1 ? { kind: 'retry', message: 'Verify faalt.' } : { kind: 'accept' }),
    })
    expect(r.result.status).toBe('completed')
    expect(r.requests).toHaveLength(2)
  })

  it('makes the first call whatever the ceiling is', async () => {
    const r = await run([final(0.01)], { ceiling: '0.0000000001' }) // rounds down to 0 nanos
    expect(r.result.status).toBe('completed')
    expect(r.requests).toHaveLength(1)
  })

  it('never stops a local configuration on money, whatever its ceiling is (decision 13): not even a ceiling that is 0 nanos', async () => {
    const r = await run([tool(5), tool(5), final(5)], { mode: 'local', ceiling: '0.0000000001' })
    expect(r.result.status).toBe('completed')
    expect(r.requests).toHaveLength(3)
    const guard = createCostGuard({ mode: 'local', ceilingNanos: 0n, configuration: CONFIGURATION })
    guard.afterResponse({ message: { content: 'x', toolCalls: [] }, finishReason: 'stop', usage: { source: 'provider_reported', inputTokens: 1, outputTokens: 1, costUsd: 5 }, model: undefined, durationMs: 1 })
    expect(guard.beforeRequest()).toBeUndefined()
  })

  it('never counts the amounts of a local configuration (decision 13)', async () => {
    const r = await run([tool(5), final(5)], { mode: 'local', ceiling: '0.01' })
    expect(r.result.status).toBe('completed')
    expect(r.guard.summary()).toMatchObject({ mode: 'local', totalNanos: 0n })
    expect(statusCost(r.guard.summary())).toEqual({ reported_cost_usd: '0', cost_source: 'local' })
  })
})

describe('runManifest — an unknown cost', () => {
  it('stops with COST_UNKNOWN on a hosted answer without an amount, also when it is the final answer', async () => {
    const r = await run([final(undefined)])
    expect(r.result.status).toBe('failed')
    expect(r.result.error).toEqual({ code: 'COST_UNKNOWN', message: `antwoord 1 van ${CONFIGURATION} had geen bedrag` })
    expect(statusCost(r.guard.summary())).toEqual({ reported_cost_usd: null, cost_source: 'none' })
  })

  it('stops before the tools run when a response with tool calls has no amount', async () => {
    const r = await run([tool(0.01), tool(undefined), final(0.01)])
    expect(r.result.error).toEqual({ code: 'COST_UNKNOWN', message: `antwoord 2 van ${CONFIGURATION} had geen bedrag` })
    expect(r.mcpCalls).toEqual(['echo'])
    expect(r.requests).toHaveLength(2)
    expect(statusCost(r.guard.summary())).toEqual({ reported_cost_usd: null, cost_source: 'none' }) // one answer without an amount makes the whole job unknown
  })

  it('treats an amount of 0 as an amount: a free hosted model is not unknown', async () => {
    const r = await run([final(0)])
    expect(r.result.status).toBe('completed')
    expect(statusCost(r.guard.summary())).toEqual({ reported_cost_usd: '0.000000000', cost_source: 'provider_reported' })
  })

  it('does not let a local configuration fail on a missing amount', async () => {
    const r = await run([final(undefined)], { mode: 'local' })
    expect(r.result.status).toBe('completed')
  })
})

describe('the cost report of a guard', () => {
  it('adds 0.1, 0.2 and 0.3 exactly: 0.600000000, where the float sum is 0.6000000000000001', async () => {
    expect(0.1 + 0.2 + 0.3).toBe(0.6000000000000001)
    const r = await run([tool(0.1), tool(0.2), final(0.3)])
    expect(r.result.status).toBe('completed')
    expect(statusCost(r.guard.summary())).toEqual({ reported_cost_usd: '0.600000000', cost_source: 'provider_reported' })
    expect(formatNanos(r.guard.summary().totalNanos)).toBe('0.600000000')
    expect(r.result.usage.costUsd).toBe(0.6000000000000001) // the float sum stays in the run's own usage and is never what is reported
  })

  it('names the distinct providers, in the order they were first seen, and leaves the field out when no response named one', async () => {
    const named = await run([tool(0.01, 'DeepInfra'), tool(0.01, 'Fireworks'), final(0.01, 'DeepInfra')])
    expect(statusCost(named.guard.summary())).toEqual({ reported_cost_usd: '0.030000000', cost_source: 'provider_reported', provider: 'DeepInfra,Fireworks' })
    const none = await run([final(0.01)])
    expect(statusCost(none.guard.summary())).toEqual({ reported_cost_usd: '0.010000000', cost_source: 'provider_reported' })
    expect('provider' in statusCost(none.guard.summary())).toBe(false)
  })

  it('cuts the provider text at 200 characters', () => {
    const guard = createCostGuard({ mode: 'hosted', ceilingNanos: 10n ** 12n, configuration: CONFIGURATION })
    const res = (provider: string) => ({
      message: { content: 'x', toolCalls: [] }, finishReason: 'stop' as const, usage: { source: 'provider_reported' as const, inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
      model: undefined, durationMs: 1, provider,
    })
    guard.afterResponse(res('a'.repeat(150)))
    guard.afterResponse(res('b'.repeat(150)))
    const cost = statusCost(guard.summary())
    expect(cost.provider).toHaveLength(200)
    expect(cost.provider?.startsWith(`${'a'.repeat(150)},b`)).toBe(true)
  })

  it('reports none for a hosted configuration that got no answer, and for a job without a guard', async () => {
    const r = await run([{ status: 400, body: { error: { message: 'slecht verzoek' } } }])
    expect(r.result.error?.code).toBe('MODEL_ERROR')
    expect(statusCost(r.guard.summary())).toEqual({ reported_cost_usd: null, cost_source: 'none' })
    expect(statusCost(undefined)).toEqual({ reported_cost_usd: null, cost_source: 'none' })
  })

  it('treats a negative amount as no amount', () => {
    const guard = createCostGuard({ mode: 'hosted', ceilingNanos: 10n ** 12n, configuration: CONFIGURATION })
    const stop = guard.afterResponse({
      message: { content: 'x', toolCalls: [] }, finishReason: 'stop',
      usage: { source: 'provider_reported', inputTokens: 1, outputTokens: 1, costUsd: -0.5 }, model: undefined, durationMs: 1,
    })
    expect(stop?.error.code).toBe('COST_UNKNOWN')
  })
})

describe('runManifest — one retry on a hosted storing', () => {
  const ok = final(0.01)
  const storingen: Array<[string, FakeTurn]> = [
    ['a network error', { drop: true }],
    ['HTTP 429', { status: 429, body: { error: { message: 'te druk' } } }],
    ['HTTP 503', { status: 503, body: { error: { message: 'even niet' } } }],
    ['HTTP 500', { status: 500, body: 'kapot' }],
    ['an error body in a 200', { status: 200, body: { error: { message: 'upstream', code: 502 } } }],
  ]

  it.each(storingen)('hosted: %s and then success completes after exactly two requests', async (_name, storing) => {
    const r = await run([storing, ok], { retryOnce: true })
    expect(r.result).toMatchObject({ status: 'completed', answer: 'klaar' })
    expect(r.requests).toHaveLength(2)
    expect(r.requests[1].body).toEqual(r.requests[0].body) // the same request
    expect(r.result.usage.turns).toBe(1) // a retry is no extra turn
    expect(r.guard.summary().responses).toBe(1)
  })

  it.each(storingen)('hosted: %s writes one model_retry event to the trace (attempt 1, with the kind of the failure)', async (_name, storing) => {
    const r = await run([storing, ok], { retryOnce: true })
    const events = readFileSync(join(r.trace.dir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; attempt?: number; kind?: string })
    const retries = events.filter((e) => e.type === 'model_retry')
    expect(retries).toHaveLength(1)
    expect(retries[0].attempt).toBe(1)
    expect(typeof retries[0].kind).toBe('string')
  })

  it.each(storingen)('hosted: %s twice is MODEL_ERROR after exactly two requests', async (_name, storing) => {
    const r = await run([storing, storing, ok], { retryOnce: true })
    expect(r.result.status).toBe('failed')
    expect(r.result.error?.code).toBe('MODEL_ERROR')
    expect(r.requests).toHaveLength(2)
  })

  it.each(storingen)('local (no retryOnce): %s is MODEL_ERROR after one request', async (_name, storing) => {
    const r = await run([storing, ok], { mode: 'local' })
    expect(r.result.error?.code).toBe('MODEL_ERROR')
    expect(r.requests).toHaveLength(1)
  })

  it('does not retry HTTP 400, HTTP 404 or an invalid answer', async () => {
    for (const turn of [{ status: 400, body: { error: { message: 'slecht' } } }, { status: 404, body: 'niet gevonden' }, { status: 200, body: 'geen json' }] as FakeTurn[]) {
      const r = await run([turn, ok], { retryOnce: true })
      expect(r.result.error?.code).toBe('MODEL_ERROR')
      expect(r.requests).toHaveLength(1)
      await fake?.close()
    }
  })

  it('does not retry an abort of the run', async () => {
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 100)
    const r = await run([{ delayMs: 1500, body: ok.body }, ok], { retryOnce: true, signal: stop.signal })
    expect(r.result.error).toEqual({ code: 'HARNESS_ERROR', message: 'aborted' })
    expect(r.requests).toHaveLength(1)
    expect(r.completeCalls()).toBe(1)
  })

  it('does not retry past the deadline', async () => {
    const r = await run([{ delayMs: 3000, body: ok.body }, ok], { retryOnce: true, maxWallSeconds: 1 })
    expect(r.result.status).toBe('timed_out')
    expect(r.requests).toHaveLength(1)
    expect(r.completeCalls()).toBe(1)
  })

  it('retries a storing on a later call too: the retry is per model call', async () => {
    const r = await run([tool(0.01), { status: 503, body: 'x' }, ok], { retryOnce: true })
    expect(r.result.status).toBe('completed')
    expect(r.requests).toHaveLength(3) // the first call, the call that failed, and its retry
  })
})
