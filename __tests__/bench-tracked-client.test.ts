import { describe, expect, it } from 'vitest'
import { createTrackedClient, CostStopError, withDroppedCost } from '../src/bench/tracked-client.js'
import { UnusableAnswerError } from '../src/bench/retry-client.js'
import { createCostGuard, parseCeilingNanos, type CostGuard } from '../src/cost.js'
import { ModelError, type CompleteOptions, type ModelClient } from '../src/model-client.js'
import type { RunResult, TraceEvent, TraceWriter } from '../src/trace.js'
import type { ChatMessage, CompleteResult } from '../src/types.js'

const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }]
const opts = (signal: AbortSignal = AbortSignal.timeout(5000)): CompleteOptions => ({ signal, maxTokens: 64 })

const answer = (provider?: string, costUsd?: number): CompleteResult => ({
  message: { content: 'ok', toolCalls: [] },
  finishReason: 'stop',
  usage: { source: 'provider_reported', inputTokens: 10, outputTokens: 2, ...(costUsd !== undefined ? { costUsd } : {}) },
  model: 'm',
  durationMs: 1,
  ...(provider !== undefined ? { provider } : {}),
})

/** An answer that came back whole but cannot be used: finish reason 'other'. */
const other = (costUsd?: number, provider?: string): CompleteResult => ({ ...answer(provider, costUsd), message: { content: '', toolCalls: [] }, finishReason: 'other' })

/** A base client that plays `script` in order (a thrown error for an Error) and counts its calls. */
function scripted(script: Array<CompleteResult | Error>) {
  let calls = 0
  const base: ModelClient = {
    async complete() {
      const next = script[calls++]
      if (next === undefined) throw new Error('script ran out')
      if (next instanceof Error) throw next
      return next
    },
  }
  return { base, calls: () => calls }
}

/** A trace that only keeps its events. */
function memoryTrace() {
  const events: TraceEvent[] = []
  const trace: TraceWriter = { dir: '/nowhere', event: (e) => void events.push(e), toolContent() {}, containerOutput() {}, result() {} }
  return { trace, events }
}

const instantSleep = async () => {}

const usage = (costUsd?: number): RunResult['usage'] => ({
  source: 'provider_reported',
  inputTokens: 10,
  outputTokens: 2,
  turns: 1,
  toolCalls: 0,
  toolErrors: 0,
  ...(costUsd !== undefined ? { costUsd } : {}),
})

const hostedGuard = (ceiling: string): CostGuard => createCostGuard({ mode: 'hosted', ceilingNanos: parseCeilingNanos(ceiling), configuration: 'test-model' })

describe('withDroppedCost', () => {
  it('adds the costs of the dropped answers to the cost of the usage', () => {
    expect(withDroppedCost(usage(0.05), [0.01, undefined, 0.02]).costUsd).toBeCloseTo(0.08)
  })

  it('starts at 0 when the usage reported no cost but a dropped answer did', () => {
    expect(withDroppedCost(usage(), [0.02]).costUsd).toBeCloseTo(0.02)
  })

  it('returns the usage as it is, with costUsd absent, when no dropped answer reported a cost', () => {
    const u = usage()
    expect(withDroppedCost(u, [])).toBe(u)
    expect(withDroppedCost(u, [undefined, undefined])).toBe(u)
    expect('costUsd' in withDroppedCost(u, [undefined])).toBe(false)
  })
})

describe('createTrackedClient — without a guard', () => {
  it('records a dropped answer that was retried, and its cost joins the bill', async () => {
    const { base, calls } = scripted([other(0.01), answer()])
    const { trace } = memoryTrace()
    const tracked = createTrackedClient(base, { retryTransient: true, trace, sleep: instantSleep })
    await expect(tracked.client.complete(msgs, opts())).resolves.toMatchObject({ finishReason: 'stop' })
    expect(calls()).toBe(2)
    expect(tracked.retries).toHaveLength(1)
    expect(tracked.retries[0]).toMatchObject({ attempt: 1, kind: 'finish_other', costUsd: 0.01 })
    expect(withDroppedCost(usage(0.05), tracked.droppedCosts()).costUsd).toBeCloseTo(0.06)
  })

  it('writes a model_retry event to the trace for every retry', async () => {
    const { base } = scripted([other(0.01, 'P'), answer()])
    const { trace, events } = memoryTrace()
    const tracked = createTrackedClient(base, { retryTransient: true, trace, sleep: instantSleep })
    await tracked.client.complete(msgs, opts())
    expect(events).toStrictEqual([{ type: 'model_retry', attempt: 1, kind: 'finish_other', costUsd: 0.01, provider: 'P' }])
  })

  it('counts the cost and the provider of an answer that is dropped for good, from the error', async () => {
    const { base } = scripted([new UnusableAnswerError(0.02, 'P')])
    const tracked = createTrackedClient(base, { retryTransient: false, trace: memoryTrace().trace })
    await expect(tracked.client.complete(msgs, opts())).rejects.toBeInstanceOf(UnusableAnswerError)
    expect(tracked.droppedCosts()).toEqual([0.02])
    expect(tracked.providers).toContain('P')
  })

  it('lists the provider of every response in the order they came: the dropped one and the one that was used', async () => {
    const { base } = scripted([other(undefined, 'A'), answer('B')])
    const tracked = createTrackedClient(base, { retryTransient: true, trace: memoryTrace().trace, sleep: instantSleep })
    await tracked.client.complete(msgs, opts())
    expect(tracked.providers).toEqual(['A', 'B'])
  })

  it('leaves the usage as it is, with costUsd absent, when no response reported an amount', async () => {
    const { base } = scripted([other(), new UnusableAnswerError(undefined, undefined)])
    const tracked = createTrackedClient(base, { retryTransient: true, trace: memoryTrace().trace, sleep: instantSleep })
    await expect(tracked.client.complete(msgs, opts())).rejects.toBeInstanceOf(UnusableAnswerError)
    expect(tracked.droppedCosts()).toEqual([undefined, undefined])
    const u = usage()
    expect(withDroppedCost(u, tracked.droppedCosts())).toBe(u)
    expect('costUsd' in withDroppedCost(u, tracked.droppedCosts())).toBe(false)
  })

  it('does not retry around the base client without retryTransient', async () => {
    const { base, calls } = scripted([other(0.01), answer()])
    const tracked = createTrackedClient(base, { retryTransient: false, trace: memoryTrace().trace })
    // Without the retrying client the answer with finish reason 'other' is handed on as it is: no retry, no record.
    await expect(tracked.client.complete(msgs, opts())).resolves.toMatchObject({ finishReason: 'other' })
    expect(calls()).toBe(1)
    expect(tracked.retries).toEqual([])
  })

  it('retries up to 3 times and then ends with an UnusableAnswerError, as the bench has always done', async () => {
    const { base, calls } = scripted([other(0.01), other(0.01), other(0.01), other(0.04)])
    const tracked = createTrackedClient(base, { retryTransient: true, trace: memoryTrace().trace, sleep: instantSleep })
    await expect(tracked.client.complete(msgs, opts())).rejects.toBeInstanceOf(UnusableAnswerError)
    expect(calls()).toBe(4)
    expect(tracked.retries).toHaveLength(3)
    expect(withDroppedCost(usage(0), tracked.droppedCosts()).costUsd).toBeCloseTo(0.07) // the 4th answer is on the error, not in `retries`
  })
})

describe('createTrackedClient — with a guard', () => {
  it('stops with a CostStopError when the dropped answers pass the ceiling, before the wait and the next request', async () => {
    const guard = hostedGuard('1')
    const { base, calls } = scripted([other(0.4), other(0.4), other(0.4), answer()])
    let waits = 0
    const tracked = createTrackedClient(base, { retryTransient: true, trace: memoryTrace().trace, sleep: async () => void waits++, guard })
    const err = await tracked.client.complete(msgs, opts()).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(CostStopError)
    expect((err as CostStopError).stop.error.code).toBe('COST_LIMIT_EXCEEDED')
    expect(calls()).toBe(3)
    expect(waits).toBe(2) // the third answer stopped the run before its wait
    expect(tracked.costStop()).toBe((err as CostStopError).stop)
    expect(tracked.retries).toHaveLength(3)
    expect(tracked.droppedCosts().reduce<number>((sum, cost) => sum + (cost ?? 0), 0)).toBeCloseTo(1.2)
    expect(guard.summary().responses).toBe(3)
  })

  it('stops with COST_UNKNOWN on a dropped hosted answer without an amount', async () => {
    const { base, calls } = scripted([other(), answer()])
    const tracked = createTrackedClient(base, { retryTransient: true, trace: memoryTrace().trace, sleep: instantSleep, guard: hostedGuard('1') })
    const err = await tracked.client.complete(msgs, opts()).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(CostStopError)
    expect((err as CostStopError).stop.error.code).toBe('COST_UNKNOWN')
    expect(calls()).toBe(1)
    expect(tracked.costStop()).toBeDefined()
  })

  it('counts a dropped answer once when the stop comes during the wait, and sets no costStop', async () => {
    const guard = hostedGuard('1')
    const controller = new AbortController()
    const { base, calls } = scripted([other(0.01), answer()])
    const tracked = createTrackedClient(base, {
      retryTransient: true,
      trace: memoryTrace().trace,
      sleep: async () => controller.abort(),
      guard,
    })
    const err = await tracked.client.complete(msgs, opts(controller.signal)).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(UnusableAnswerError)
    expect(calls()).toBe(1)
    expect(tracked.costStop()).toBeUndefined()
    expect(guard.summary().responses).toBe(1)
    expect(tracked.droppedCosts().reduce<number>((sum, cost) => sum + (cost ?? 0), 0)).toBeCloseTo(0.01)
  })

  it('does not hand the answer that is dropped after the last retry to the guard', async () => {
    const guard = hostedGuard('1')
    const { base, calls } = scripted([other(0.01), other(0.01), other(0.01), other(0.01)])
    const tracked = createTrackedClient(base, { retryTransient: true, trace: memoryTrace().trace, sleep: instantSleep, guard })
    await expect(tracked.client.complete(msgs, opts())).rejects.toBeInstanceOf(UnusableAnswerError)
    expect(calls()).toBe(4)
    expect(guard.summary().responses).toBe(3)
    expect(tracked.costStop()).toBeUndefined()
  })

  it('does not hand a transient failure to the guard: it has no answer', async () => {
    const guard = hostedGuard('1')
    const { base } = scripted([new ModelError('model HTTP 503: x', { kind: 'http', status: 503 }), answer()])
    const tracked = createTrackedClient(base, { retryTransient: true, trace: memoryTrace().trace, sleep: instantSleep, guard })
    await tracked.client.complete(msgs, opts())
    expect(guard.summary().responses).toBe(0)
    expect(tracked.retries).toHaveLength(1)
  })
})

describe('CostStopError', () => {
  it('is a ModelError of the final kind, with the message of the stop', () => {
    const stop = { status: 'failed', error: { code: 'COST_UNKNOWN', message: 'antwoord 1 had geen bedrag' } } as const
    const err = new CostStopError(stop)
    expect(err).toBeInstanceOf(ModelError)
    expect(err.message).toBe('antwoord 1 had geen bedrag')
    expect(err.detail).toStrictEqual({ kind: 'invalid' })
    expect(err.stop).toBe(stop)
  })
})
