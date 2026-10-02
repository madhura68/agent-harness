import { inspect } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createRetryingClient, isTransient, UnusableAnswerError, type RetryRecord } from '../src/bench/retry-client.js'
import { createModelClient, ModelError, type CompleteOptions, type ModelClient, type ModelErrorDetail } from '../src/model-client.js'
import type { ChatMessage, CompleteResult } from '../src/types.js'
import { completion, startFakeModelServer, type FakeTurn } from './fakes/fake-model-server.js'
import { DUMMY_KEY, leakedFragments } from './helpers.js'

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let fake: Fake | undefined
afterEach(async () => { await fake?.close(); fake = undefined })

const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }]
const opts = (): CompleteOptions => ({ signal: AbortSignal.timeout(5000), maxTokens: 64 })
// Nothing listens on port 1, so a request to it fails at the network level.
const REFUSED = 'http://127.0.0.1:1/v1'

/** The ModelError a call rejects with; the test fails if the call resolves or rejects with something else. */
async function modelError(call: Promise<unknown>): Promise<ModelError> {
  const err = await call.then(() => undefined, (e: unknown) => e)
  expect(err).toBeInstanceOf(ModelError)
  return err as ModelError
}

/** One call of the real client against a fake server that plays `turn`; returns the ModelError it throws. */
async function failureOf(turn: FakeTurn, apiKey?: string): Promise<ModelError> {
  fake = await startFakeModelServer([turn])
  return modelError(createModelClient({ baseUrl: fake.baseUrl, name: 'm', apiKey }).complete(msgs, opts()))
}

// The detail is new, so each case pins the message next to it: the message has to stay exactly as it was before the detail.
describe('ModelError.detail', () => {
  it('is "network" when the request fails', async () => {
    const err = await modelError(createModelClient({ baseUrl: REFUSED, name: 'm' }).complete(msgs, opts()))
    expect(err.message).toBe('model request failed: fetch failed')
    expect(err.detail).toStrictEqual({ kind: 'network' })
  })

  it('is "aborted" for that same failure when the signal is aborted', async () => {
    const err = await modelError(createModelClient({ baseUrl: REFUSED, name: 'm' }).complete(msgs, { signal: AbortSignal.abort(), maxTokens: 64 }))
    expect(err.message).toBe('model request failed: aborted (deadline)')
    expect(err.detail).toStrictEqual({ kind: 'aborted' })
  })

  it('is "aborted" when the signal fires while the response is slow', async () => {
    fake = await startFakeModelServer([{ delayMs: 3000, body: completion({ content: 'late' }) }])
    const call = createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, { signal: AbortSignal.timeout(50), maxTokens: 64 })
    const err = await modelError(call)
    expect(err.message).toBe('model request failed: aborted (deadline)')
    expect(err.detail).toStrictEqual({ kind: 'aborted' })
  })

  it('is "http" with the status for a status outside 2xx', async () => {
    const err = await failureOf({ status: 503, body: { error: { message: 'boom' } } })
    expect(err.message).toBe('model HTTP 503: {"error":{"message":"boom"}}')
    expect(err.detail).toStrictEqual({ kind: 'http', status: 503 })
  })

  it('is "error_body" with the status and the body code for a 200 that holds an error object', async () => {
    const err = await failureOf({ body: { error: { code: 429, message: 'slow down' } } })
    expect(err.message).toBe('model HTTP 200: error body: {"error":{"code":429,"message":"slow down"}}')
    expect(err.detail).toStrictEqual({ kind: 'error_body', status: 200, bodyCode: 429 })
  })

  // toStrictEqual: a code that is not a number is left out altogether, not kept as a key without a value.
  it.each([
    ['a code that is a string', { error: { code: '429', message: 'x' } }],
    ['a code that is null', { error: { code: null, message: 'x' } }],
    ['a code that is an object', { error: { code: { n: 429 }, message: 'x' } }],
    ['no code', { error: { message: 'x' } }],
    ['an error that is no object', { error: 'overloaded' }],
  ])('is "error_body" without a body code when the body has %s', async (_label, body) => {
    const err = await failureOf({ body })
    expect(err.detail).toStrictEqual({ kind: 'error_body', status: 200 })
  })

  it.each([
    ['JSON that does not parse', 'not json{', 'model HTTP 200: invalid JSON: not json{'],
    ['JSON that is a string', JSON.stringify('hello'), 'model HTTP 200: unexpected body: "hello"'],
    ['JSON that is null', 'null', 'model HTTP 200: unexpected body: null'],
    ['a body without choices', { choices: [] }, 'model HTTP 200: no choices: {"choices":[]}'],
  ])('is "invalid" with the status for %s', async (_label, body, message) => {
    const err = await failureOf({ body })
    expect(err.message).toBe(message)
    expect(err.detail).toStrictEqual({ kind: 'invalid', status: 200 })
  })

  describe('is fixed before the message is cut and masked', () => {
    it('reads the body code from the parsed body, also when the 200-character excerpt no longer shows it', async () => {
      const body = JSON.stringify({ error: { message: 'x'.repeat(300), code: 503 } })
      const err = await failureOf({ body })
      expect(err.message).not.toContain('503') // the premise: the excerpt has lost the code
      expect(err.detail).toStrictEqual({ kind: 'error_body', status: 200, bodyCode: 503 })
    })

    it('holds no text of the response: a body that echoes the key leaves nothing of it in the detail', async () => {
      const turn = { body: { error: { code: 503, message: `Invalid API key ${DUMMY_KEY}` } } }
      const err = await failureOf(turn, DUMMY_KEY)
      expect(err.message).toContain('<redacted>') // the premise: the body did carry the key
      expect(err.detail).toStrictEqual({ kind: 'error_body', status: 200, bodyCode: 503 })
      expect(leakedFragments(JSON.stringify(err.detail))).toEqual([])
      expect(leakedFragments(inspect(err, { depth: 10 }))).toEqual([])
    })
  })
})

describe('isTransient', () => {
  const live = new AbortController().signal // never aborted
  const failure = (detail: ModelErrorDetail) => new ModelError('model failure', detail)

  const TRANSIENT: Array<[label: string, detail: ModelErrorDetail]> = [
    ['a network failure', { kind: 'network' }],
    ...[408, 429, 500, 502, 503, 504, 599].map((status): [string, ModelErrorDetail] => [`HTTP ${status}`, { kind: 'http', status }]),
    ...[408, 429, 500, 503, 599].map((bodyCode): [string, ModelErrorDetail] => [`an error body with code ${bodyCode}`, { kind: 'error_body', status: 200, bodyCode }]),
  ]

  // Next to the retryable statuses on both sides of each edge: 407/409, 428/430 and 499/600.
  const FINAL: Array<[label: string, detail: ModelErrorDetail]> = [
    ['an aborted request', { kind: 'aborted' }],
    ['an invalid answer', { kind: 'invalid', status: 200 }],
    ['HTTP without a status', { kind: 'http' }],
    ['an error body without a code', { kind: 'error_body', status: 200 }],
    ...[400, 401, 403, 404, 407, 409, 428, 430, 499, 600].map((status): [string, ModelErrorDetail] => [`HTTP ${status}`, { kind: 'http', status }]),
    ...[400, 401, 404, 499, 600].map((bodyCode): [string, ModelErrorDetail] => [`an error body with code ${bodyCode}`, { kind: 'error_body', status: 200, bodyCode }]),
  ]

  it.each(TRANSIENT)('is true for %s', (_label, detail) => {
    expect(isTransient(failure(detail), live)).toBe(true)
  })

  it.each(FINAL)('is false for %s', (_label, detail) => {
    expect(isTransient(failure(detail), live)).toBe(false)
  })

  it.each([
    ['a plain Error', new Error('fetch failed')],
    ['a TypeError', new TypeError('fetch failed')],
    ['a ModelError without a detail', new ModelError('model request failed: fetch failed')],
    ['a lookalike that is no ModelError', { code: 'MODEL_ERROR', detail: { kind: 'network' } }],
    ['a string', 'network'],
    ['undefined', undefined],
  ])('is false for %s', (_label, err) => {
    expect(isTransient(err, live)).toBe(false)
  })

  it('is false for every failure once the signal is aborted', () => {
    const stopped = AbortSignal.abort()
    for (const [label, detail] of TRANSIENT) expect(isTransient(failure(detail), stopped), label).toBe(false)
  })
})

const answer: CompleteResult = {
  message: { content: 'ok', toolCalls: [] },
  finishReason: 'stop',
  usage: { source: 'provider_reported', inputTokens: 1, outputTokens: 1 },
  model: 'm',
  durationMs: 1,
}

/** An inner client that plays one outcome per call: an Error is thrown, a result is returned. It records its arguments. */
function scriptedInner(script: Array<Error | CompleteResult>) {
  const calls: Array<{ messages: ChatMessage[]; options: CompleteOptions }> = []
  const inner: ModelClient = {
    async complete(messages, options) {
      calls.push({ messages, options })
      const next = script[calls.length - 1]
      if (!next) throw new Error('script exhausted')
      if (next instanceof Error) throw next
      return next
    },
  }
  return { inner, calls }
}

/** A wait that resolves at once and records the waits it was asked for. */
function instantSleep() {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => { waits.push(ms) } }
}

const http = (status: number) => new ModelError(`model HTTP ${status}: x`, { kind: 'http', status })

describe('createRetryingClient', () => {
  it('returns the answer after two 503s, with a record for each retry', async () => {
    const { inner, calls } = scriptedInner([http(503), http(503), answer])
    const records: RetryRecord[] = []
    const client = createRetryingClient(inner, { onRetry: (r) => records.push(r), sleep: instantSleep().sleep })
    await expect(client.complete(msgs, opts())).resolves.toBe(answer)
    expect(calls).toHaveLength(3)
    // toStrictEqual: a status or a code the failure does not have is absent from the record, not a key without a value.
    expect(records).toStrictEqual([{ attempt: 1, kind: 'http', status: 503 }, { attempt: 2, kind: 'http', status: 503 }])
  })

  it('throws the fourth failure after three retries, waiting 2 s, 8 s and 30 s', async () => {
    const failures = [http(503), http(503), http(503), http(503)]
    const { inner, calls } = scriptedInner([...failures, answer]) // the answer is never reached
    const records: RetryRecord[] = []
    const { waits, sleep } = instantSleep()
    const client = createRetryingClient(inner, { onRetry: (r) => records.push(r), sleep })
    await expect(client.complete(msgs, opts())).rejects.toBe(failures[3])
    expect(calls).toHaveLength(4)
    expect(records.map((r) => r.attempt)).toEqual([1, 2, 3])
    expect(waits).toEqual([2000, 8000, 30000])
  })

  it.each([
    ['an HTTP 400', http(400)],
    ['an invalid answer', new ModelError('model HTTP 200: invalid JSON: x', { kind: 'invalid', status: 200 })],
    ['an error that is no ModelError', new TypeError('boom')],
  ])('does not retry %s', async (_label, failure) => {
    const { inner, calls } = scriptedInner([failure, answer])
    const records: RetryRecord[] = []
    const { waits, sleep } = instantSleep()
    const client = createRetryingClient(inner, { onRetry: (r) => records.push(r), sleep })
    await expect(client.complete(msgs, opts())).rejects.toBe(failure)
    expect(calls).toHaveLength(1)
    expect(records).toEqual([])
    expect(waits).toEqual([])
  })

  it('does not retry a transient failure that surfaces after the signal was aborted', async () => {
    const controller = new AbortController()
    const failure = new ModelError('model request failed: fetch failed', { kind: 'network' })
    const inner: ModelClient = { complete: async () => { controller.abort(); throw failure } }
    const { waits, sleep } = instantSleep()
    const client = createRetryingClient(inner, { sleep })
    await expect(client.complete(msgs, { signal: controller.signal, maxTokens: 64 })).rejects.toBe(failure)
    expect(waits).toEqual([])
  })

  describe('when the stop comes during the wait', () => {
    // A real wait rejects when its signal fires; a stub may just return. Either way no new request follows the stop.
    const WAITS: Array<[label: string, makeSleep: (stop: () => void) => (ms: number, signal: AbortSignal) => Promise<void>]> = [
      ['a wait that rejects', (stop) => async () => { stop(); throw new DOMException('The operation was aborted', 'AbortError') }],
      ['a wait that just returns', (stop) => async () => { stop() }],
    ]

    it.each(WAITS)('passes the last failure on, without a new call, with %s', async (_label, makeSleep) => {
      const controller = new AbortController()
      const failure = http(503)
      const { inner, calls } = scriptedInner([failure, answer])
      const client = createRetryingClient(inner, { sleep: makeSleep(() => controller.abort()) })
      await expect(client.complete(msgs, { signal: controller.signal, maxTokens: 64 })).rejects.toBe(failure)
      expect(calls).toHaveLength(1)
    })

    it('does not hide a wait that fails for another reason', async () => {
      const broken = new Error('timer broke')
      const { inner, calls } = scriptedInner([http(503), answer])
      const client = createRetryingClient(inner, { sleep: async () => { throw broken } })
      await expect(client.complete(msgs, opts())).rejects.toBe(broken)
      expect(calls).toHaveLength(1)
    })
  })

  it('gives the retry the same messages and options objects, and the wait the signal of the call', async () => {
    const { inner, calls } = scriptedInner([http(503), answer])
    const seen: AbortSignal[] = []
    const client = createRetryingClient(inner, { sleep: async (_ms, signal) => { seen.push(signal) } })
    const options = opts()
    await client.complete(msgs, options)
    expect(calls).toHaveLength(2)
    expect(calls[1].messages).toBe(msgs)
    expect(calls[1].options).toBe(options)
    expect(calls[0].messages).toBe(msgs)
    expect(calls[0].options).toBe(options)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(options.signal)
  })

  it('leaves the answer of a first attempt that succeeds alone: no record, no wait', async () => {
    const { inner, calls } = scriptedInner([answer])
    const records: RetryRecord[] = []
    const { waits, sleep } = instantSleep()
    const client = createRetryingClient(inner, { onRetry: (r) => records.push(r), sleep })
    await expect(client.complete(msgs, opts())).resolves.toBe(answer)
    expect(calls).toHaveLength(1)
    expect(records).toEqual([])
    expect(waits).toEqual([])
  })

  it.each([
    ['a network failure', new ModelError('model request failed: fetch failed', { kind: 'network' }), { attempt: 1, kind: 'network' }],
    ['an HTTP 429', http(429), { attempt: 1, kind: 'http', status: 429 }],
    [
      'an error body with a code',
      new ModelError('model HTTP 200: error body: x', { kind: 'error_body', status: 200, bodyCode: 502 }),
      { attempt: 1, kind: 'error_body', status: 200, bodyCode: 502 },
    ],
  ])('records %s with what the failure has and nothing else', async (_label, failure, record) => {
    const { inner } = scriptedInner([failure, answer])
    const records: RetryRecord[] = []
    await createRetryingClient(inner, { onRetry: (r) => records.push(r), sleep: instantSleep().sleep }).complete(msgs, opts())
    expect(records).toStrictEqual([record])
  })

  describe('maxRetries and delaysMs', () => {
    it('honours both, and repeats the last delay when the list is shorter than maxRetries', async () => {
      const { inner, calls } = scriptedInner([http(503), http(503), http(503), http(503), answer])
      const { waits, sleep } = instantSleep()
      const client = createRetryingClient(inner, { maxRetries: 4, delaysMs: [5, 7], sleep })
      await expect(client.complete(msgs, opts())).resolves.toBe(answer)
      expect(calls).toHaveLength(5)
      expect(waits).toEqual([5, 7, 7, 7])
    })

    it('does not retry at all with maxRetries 0', async () => {
      const failure = http(503)
      const { inner, calls } = scriptedInner([failure, answer])
      const { waits, sleep } = instantSleep()
      await expect(createRetryingClient(inner, { maxRetries: 0, sleep }).complete(msgs, opts())).rejects.toBe(failure)
      expect(calls).toHaveLength(1)
      expect(waits).toEqual([])
    })
  })

  // The default wait is a real timer. The delays are short here, so the tests stay fast.
  describe('without a sleep of its own', () => {
    it('really waits between the attempts', async () => {
      const { inner } = scriptedInner([http(503), http(503), answer])
      const started = performance.now()
      await createRetryingClient(inner, { delaysMs: [30, 30, 30] }).complete(msgs, opts())
      expect(performance.now() - started).toBeGreaterThanOrEqual(50) // two waits of 30 ms
    })

    it('is cut short by the stop, and then passes the last failure on', async () => {
      const failure = http(503)
      const { inner, calls } = scriptedInner([failure, answer])
      const controller = new AbortController()
      const started = performance.now()
      const call = createRetryingClient(inner, { delaysMs: [60_000] }).complete(msgs, { signal: controller.signal, maxTokens: 64 })
      setTimeout(() => controller.abort(), 20)
      await expect(call).rejects.toBe(failure)
      expect(performance.now() - started).toBeLessThan(5000)
      expect(calls).toHaveLength(1)
    })
  })
})

// The model client turns every finish reason it does not know into 'other'. For OpenRouter that includes "error": a provider that
// fails after the answer has begun answers HTTP 200 with `finish_reason: "error"` and the error inside the choice, possibly with
// partial output. That is a provider failure and no answer, so it is retried like any other temporary failure.
describe('createRetryingClient — an answer with finish reason "other"', () => {
  const live = new AbortController().signal
  const dropped = (costUsd?: number): CompleteResult => ({
    message: { content: '', toolCalls: [] },
    finishReason: 'other',
    usage: { source: 'provider_reported', inputTokens: 100, outputTokens: 3, ...(costUsd !== undefined ? { costUsd } : {}) },
    model: 'm',
    durationMs: 1,
  })
  const MESSAGE = 'model answer unusable: finish_reason other (OpenRouter reports a provider error that way)'

  it('retries it as a temporary failure: a record of its own kind with what the dropped answer cost, a wait, and the next answer', async () => {
    const { inner, calls } = scriptedInner([dropped(0.0004), answer])
    const records: RetryRecord[] = []
    const { waits, sleep } = instantSleep()
    const client = createRetryingClient(inner, { onRetry: (r) => records.push(r), sleep })
    await expect(client.complete(msgs, opts())).resolves.toBe(answer)
    expect(calls).toHaveLength(2)
    expect(records).toStrictEqual([{ attempt: 1, kind: 'finish_other', costUsd: 0.0004 }])
    expect(waits).toEqual([2000])
  })

  it('keeps a cost of 0 (a free model reports it) and leaves the cost out when the dropped answer reported none', async () => {
    const { inner } = scriptedInner([dropped(0), dropped(), answer])
    const records: RetryRecord[] = []
    await createRetryingClient(inner, { onRetry: (r) => records.push(r), sleep: instantSleep().sleep }).complete(msgs, opts())
    expect(records).toStrictEqual([
      { attempt: 1, kind: 'finish_other', costUsd: 0 },
      { attempt: 2, kind: 'finish_other' },
    ])
  })

  it.each(['stop', 'length', 'tool_calls'] as const)('hands on an answer with finish reason %s as it is: no record, no wait', async (finishReason) => {
    const result: CompleteResult = { ...answer, finishReason }
    const { inner, calls } = scriptedInner([result])
    const records: RetryRecord[] = []
    const { waits, sleep } = instantSleep()
    await expect(createRetryingClient(inner, { onRetry: (r) => records.push(r), sleep }).complete(msgs, opts())).resolves.toBe(result)
    expect(calls).toHaveLength(1)
    expect(records).toEqual([])
    expect(waits).toEqual([])
  })

  it('gives up after three retries, waiting 2 s, 8 s and 30 s, with a ModelError that carries the cost of the last answer', async () => {
    const { inner, calls } = scriptedInner([dropped(0.001), dropped(0.002), dropped(0.003), dropped(0.004), answer]) // the answer is never reached
    const records: RetryRecord[] = []
    const { waits, sleep } = instantSleep()
    const err = await modelError(createRetryingClient(inner, { onRetry: (r) => records.push(r), sleep }).complete(msgs, opts()))
    expect(err).toBeInstanceOf(UnusableAnswerError)
    expect(err.code).toBe('MODEL_ERROR') // so runManifest ends the run failed MODEL_ERROR, which is a benchfout
    expect(err.message).toBe(MESSAGE)
    expect((err as UnusableAnswerError).costUsd).toBe(0.004) // no retry follows it, so no record has its cost
    expect(err.detail).toStrictEqual({ kind: 'invalid' })
    expect(isTransient(err, live)).toBe(false) // nothing around the client retries it again
    expect(calls).toHaveLength(4)
    expect(records).toStrictEqual([
      { attempt: 1, kind: 'finish_other', costUsd: 0.001 },
      { attempt: 2, kind: 'finish_other', costUsd: 0.002 },
      { attempt: 3, kind: 'finish_other', costUsd: 0.003 },
    ])
    expect(waits).toEqual([2000, 8000, 30000])
  })

  it('takes its retries from the same budget as every other temporary failure', async () => {
    const { inner, calls } = scriptedInner([http(503), dropped(0.001), http(503), dropped(0.002), answer])
    const records: RetryRecord[] = []
    const err = await modelError(createRetryingClient(inner, { onRetry: (r) => records.push(r), sleep: instantSleep().sleep }).complete(msgs, opts()))
    expect(err).toBeInstanceOf(UnusableAnswerError)
    expect((err as UnusableAnswerError).costUsd).toBe(0.002)
    expect(calls).toHaveLength(4)
    expect(records.map((r) => r.kind)).toEqual(['http', 'finish_other', 'http'])
  })

  it('does not retry it once the signal is aborted: it ends with the ModelError and the cost, without a record or a wait', async () => {
    const controller = new AbortController()
    const inner: ModelClient = { complete: async () => { controller.abort(); return dropped(0.001) } }
    const records: RetryRecord[] = []
    const { waits, sleep } = instantSleep()
    const err = await modelError(
      createRetryingClient(inner, { onRetry: (r) => records.push(r), sleep }).complete(msgs, { signal: controller.signal, maxTokens: 64 }),
    )
    expect(err).toBeInstanceOf(UnusableAnswerError)
    expect((err as UnusableAnswerError).costUsd).toBe(0.001)
    expect(records).toEqual([])
    expect(waits).toEqual([])
  })

  describe('when the stop comes during the wait', () => {
    // A real wait rejects when its signal fires; a stub may just return. Either way no new request follows the stop.
    it.each([
      ['a wait that rejects', (stop: () => void) => async () => { stop(); throw new DOMException('The operation was aborted', 'AbortError') }],
      ['a wait that just returns', (stop: () => void) => async () => { stop() }],
    ])('ends with the ModelError, without a new call, and counts the cost once, in the record, with %s', async (_label, makeSleep) => {
      const controller = new AbortController()
      const { inner, calls } = scriptedInner([dropped(0.001), answer])
      const records: RetryRecord[] = []
      const client = createRetryingClient(inner, { onRetry: (r) => records.push(r), sleep: makeSleep(() => controller.abort()) })
      const err = await modelError(client.complete(msgs, { signal: controller.signal, maxTokens: 64 }))
      expect(err).toBeInstanceOf(UnusableAnswerError)
      expect(err.message).toBe(MESSAGE)
      expect(calls).toHaveLength(1)
      expect(records).toStrictEqual([{ attempt: 1, kind: 'finish_other', costUsd: 0.001 }]) // announced before the wait, as for every retry
      expect((err as UnusableAnswerError).costUsd).toBeUndefined() // the record has it: the error does not say it a second time
    })
  })
})

// The two halves together: the detail the real client sets is what decides here.
describe('createRetryingClient around the real model client', () => {
  const retrying = (baseUrl: string, records: RetryRecord[]) =>
    createRetryingClient(createModelClient({ baseUrl, name: 'm' }), { onRetry: (r) => records.push(r), sleep: instantSleep().sleep })

  it('retries an HTTP 503 and returns the answer that follows', async () => {
    fake = await startFakeModelServer([{ status: 503, body: { error: { message: 'busy' } } }, { body: completion({ content: 'pong' }) }])
    const records: RetryRecord[] = []
    const r = await retrying(fake.baseUrl, records).complete(msgs, opts())
    expect(r.message.content).toBe('pong')
    expect(fake.requests).toHaveLength(2)
    expect(records).toStrictEqual([{ attempt: 1, kind: 'http', status: 503 }])
  })

  it('retries a 200 whose error body carries a transient code', async () => {
    fake = await startFakeModelServer([{ body: { error: { code: 502, message: 'Provider returned error' } } }, { body: completion({ content: 'pong' }) }])
    const records: RetryRecord[] = []
    const r = await retrying(fake.baseUrl, records).complete(msgs, opts())
    expect(r.message.content).toBe('pong')
    expect(fake.requests).toHaveLength(2)
    expect(records).toStrictEqual([{ attempt: 1, kind: 'error_body', status: 200, bodyCode: 502 }])
  })

  // The body OpenRouter documents for a provider that fails after the answer has begun: HTTP 200, no top-level error, the error in the choice.
  const providerFailure = (cost?: number) => ({
    body: {
      id: 'gen-1',
      object: 'chat.completion',
      model: 'fake-model',
      choices: [{ index: 0, error: { code: 502, message: 'Provider disconnected unexpectedly' }, message: { role: 'assistant', content: '' }, finish_reason: 'error' }],
      usage: { prompt_tokens: 100, completion_tokens: 3, ...(cost !== undefined ? { cost } : {}) },
    },
  })

  it('retries a 200 whose choice carries finish_reason "error", and returns the answer that follows', async () => {
    fake = await startFakeModelServer([providerFailure(0.0004), { body: completion({ content: 'pong' }) }])
    const records: RetryRecord[] = []
    const r = await retrying(fake.baseUrl, records).complete(msgs, opts())
    expect(r.message.content).toBe('pong')
    expect(fake.requests).toHaveLength(2)
    expect(records).toStrictEqual([{ attempt: 1, kind: 'finish_other', costUsd: 0.0004 }])
  })

  it('gives up on four of them in a row with a ModelError, and no answer comes out of it', async () => {
    fake = await startFakeModelServer([providerFailure(0.001), providerFailure(0.001), providerFailure(0.001), providerFailure(0.001), { body: completion({ content: 'pong' }) }])
    const records: RetryRecord[] = []
    const err = await modelError(retrying(fake.baseUrl, records).complete(msgs, opts()))
    expect(err).toBeInstanceOf(UnusableAnswerError)
    expect(fake.requests).toHaveLength(4)
    expect(records.map((r) => r.attempt)).toEqual([1, 2, 3])
  })

  it('does not retry an HTTP 401', async () => {
    fake = await startFakeModelServer([{ status: 401, body: { error: { message: 'bad key' } } }, { body: completion({ content: 'pong' }) }])
    const records: RetryRecord[] = []
    const err = await modelError(retrying(fake.baseUrl, records).complete(msgs, opts()))
    expect(err.detail).toStrictEqual({ kind: 'http', status: 401 })
    expect(fake.requests).toHaveLength(1)
    expect(records).toEqual([])
  })

  it('does not retry an answer that is not valid JSON', async () => {
    fake = await startFakeModelServer([{ body: 'not json{' }, { body: completion({ content: 'pong' }) }])
    const records: RetryRecord[] = []
    await modelError(retrying(fake.baseUrl, records).complete(msgs, opts()))
    expect(fake.requests).toHaveLength(1)
    expect(records).toEqual([])
  })

  it('retries a failed connection three times and then gives up with the network failure', async () => {
    const records: RetryRecord[] = []
    const err = await modelError(retrying(REFUSED, records).complete(msgs, opts()))
    expect(err.detail).toStrictEqual({ kind: 'network' })
    expect(records).toStrictEqual([{ attempt: 1, kind: 'network' }, { attempt: 2, kind: 'network' }, { attempt: 3, kind: 'network' }])
  })
})
