import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createModelClient, maskKey, ModelError, transportTimeouts } from '../src/model-client.js'
import { completion, startFakeModelServer } from './fakes/fake-model-server.js'
import { bodyWithKeyAt, DUMMY_KEY, leakedFragments } from './helpers.js'

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let fake: Fake | undefined
afterEach(async () => { await fake?.close(); fake = undefined })

const msgs = [{ role: 'user' as const, content: 'hi' }]
const opts = () => ({ signal: AbortSignal.timeout(5000), maxTokens: 64 })
// Read verbatim so the server returns the fixture's exact bytes, not a re-stringified copy.
const fixture = (name: string) => readFileSync(join('__tests__', 'fixtures', name), 'utf8')

describe('fake model server', () => {
  it('plays scripted turns in order', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'one' }) }, { body: completion({ content: 'two' }) }])
    const c = createModelClient({ baseUrl: fake.baseUrl, name: 'm' })
    expect((await c.complete(msgs, opts())).message.content).toBe('one')
    expect((await c.complete(msgs, opts())).message.content).toBe('two')
  })
})

describe('createModelClient', () => {
  it('returns a plain answer with provider-reported usage', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'pong', usage: { prompt_tokens: 12, completion_tokens: 3 }, model: 'qwen' }) }])
    const r = await createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, opts())
    expect(r.message).toEqual({ content: 'pong', toolCalls: [] })
    expect(r.finishReason).toBe('stop')
    expect(r.usage).toEqual({ source: 'provider_reported', inputTokens: 12, outputTokens: 3 })
    expect(r.model).toBe('qwen')
    const req = fake.requests[0]
    expect(req.url).toBe('/v1/chat/completions')
    expect(req.body).toMatchObject({ model: 'm', messages: msgs, max_tokens: 64, stream: false })
    expect(req.body.tools).toBeUndefined()
  })

  it('marks usage missing when the response has none', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'x', usage: null }) }])
    const r = await createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, opts())
    expect(r.usage).toEqual({ source: 'missing', inputTokens: 0, outputTokens: 0 })
  })

  it('normalises tool-call arguments given as string, object or absent', async () => {
    fake = await startFakeModelServer([{
      body: completion({ toolCalls: [
        { id: 'a', name: 'echo', arguments: '{"text":"ping"}' },
        { id: 'b', name: 'echo', arguments: { text: 'pong' } },
        { name: 'noargs' },
      ] }),
    }])
    const tools = [{ type: 'function' as const, function: { name: 'echo', parameters: { type: 'object' } } }]
    const r = await createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, { ...opts(), tools })
    expect(r.finishReason).toBe('tool_calls')
    expect(r.message.toolCalls).toEqual([
      { id: 'a', name: 'echo', arguments: '{"text":"ping"}', argumentsWasObject: false },
      { id: 'b', name: 'echo', arguments: '{"text":"pong"}', argumentsWasObject: true },
      { id: '', name: 'noargs', arguments: '', argumentsWasObject: false },
    ])
    expect(fake.requests[0].body.tools).toEqual(tools)
  })

  it('serialises assistant tool_calls in OpenAI wire format', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'done' }) }])
    await createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'calling', tool_calls: [{ id: 'c1', name: 'echo', arguments: '{"text":"ping"}', argumentsWasObject: false }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ping' },
    ], opts())
    expect(fake.requests[0].body.messages[1]).toEqual({
      role: 'assistant',
      content: 'calling',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"ping"}' } }],
    })
    expect(fake.requests[0].body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ping' })
  })

  it('maps an unknown finish_reason to other', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'x', finishReason: 'content_filter' }) }])
    const r = await createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, opts())
    expect(r.finishReason).toBe('other')
  })

  it.each([
    ['HTTP 500', { status: 500, body: { error: { message: 'boom' } } }],
    ['HTTP 200 with an error body', { body: { error: { message: 'model "nope" not found' } } }],
    ['HTTP 200 with empty choices', { body: { choices: [] } }],
    ['HTTP 200 without choices', { body: { id: 'x' } }],
    ['invalid JSON', { body: 'not json{' }],
  ])('throws ModelError on %s', async (_label, turn) => {
    fake = await startFakeModelServer([turn])
    const p = createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, opts())
    await expect(p).rejects.toBeInstanceOf(ModelError)
    await expect(p).rejects.toMatchObject({ code: 'MODEL_ERROR' })
  })

  it('includes the status code and a body excerpt in the error message', async () => {
    fake = await startFakeModelServer([{ status: 500, body: { error: { message: 'boom' } } }])
    await expect(createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, opts()))
      .rejects.toThrow(/500.*boom/)
  })

  it('throws ModelError on a network failure', async () => {
    const c = createModelClient({ baseUrl: 'http://127.0.0.1:1/v1', name: 'm' })
    await expect(c.complete(msgs, opts())).rejects.toBeInstanceOf(ModelError)
  })

  it('aborts within 100 ms when the signal fires during a slow response', async () => {
    fake = await startFakeModelServer([{ delayMs: 3000, body: completion({ content: 'late' }) }])
    const started = Date.now()
    const p = createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, { signal: AbortSignal.timeout(50), maxTokens: 8 })
    await expect(p).rejects.toBeInstanceOf(ModelError)
    expect(Date.now() - started).toBeLessThan(150)
  })

  it('sends the bearer header only when an apiKey is set and never leaks it in errors', async () => {
    fake = await startFakeModelServer([
      { body: completion({ content: 'x' }) },
      { body: completion({ content: 'y' }) },
      { status: 401, body: { error: { message: 'bad key' } } },
    ])
    await createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, opts())
    const keyed = createModelClient({ baseUrl: fake.baseUrl, name: 'm', apiKey: 'sk-test-secret' })
    await keyed.complete(msgs, opts())
    expect(fake.requests[0].headers.authorization).toBeUndefined()
    expect(fake.requests[1].headers.authorization).toBe('Bearer sk-test-secret')
    const err = await keyed.complete(msgs, opts()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ModelError)
    expect((err as Error).message).not.toContain('sk-test-secret')
  })
})

describe('maskKey', () => {
  it('replaces every occurrence of the key', () => {
    expect(maskKey(`a ${DUMMY_KEY} b ${DUMMY_KEY}`, DUMMY_KEY)).toBe('a <redacted> b <redacted>')
  })

  it('leaves the text alone without a key or with a key shorter than 8 characters', () => {
    const text = 'Bearer abcdefg and abc'
    expect(maskKey(text, undefined)).toBe(text)
    expect(maskKey(text, '')).toBe(text)
    expect(maskKey(text, 'abcdefg')).toBe(text) // 7 characters
    expect(maskKey(text, 'abcdefg \n')).toBe(text) // 7 once trimmed: padding does not lift it over the floor
    expect(maskKey(text, ' \n ')).toBe(text) // whitespace only: trims to nothing, and an empty needle must never reach replaceAll
  })

  it('masks a key of exactly 8 characters', () => {
    expect(maskKey('Bearer abcdefgh', 'abcdefgh')).toBe('Bearer <redacted>')
    expect(maskKey('Bearer abcdefgh', 'abcdefgh \n')).toBe('Bearer <redacted>') // 8 once trimmed, the form a server echoes
  })

  it('matches the key literally, not as a pattern', () => {
    // Read as a regular expression this key would also match 'aXbbcc'.
    expect(maskKey('a.b*c+d? aXbbcc', 'a.b*c+d?')).toBe('<redacted> aXbbcc')
  })
})

describe('the key in model errors', () => {
  // One call against the current fake server; returns the message of the ModelError it must throw.
  async function errorMessage(baseUrl: string, apiKey = DUMMY_KEY): Promise<string> {
    const c = createModelClient({ baseUrl, name: 'm', apiKey })
    const err = await c.complete(msgs, opts()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ModelError)
    return (err as ModelError).message
  }

  it('masks the key in the error of an HTTP 401 whose body echoes it', async () => {
    fake = await startFakeModelServer([{ status: 401, body: { error: { message: `Invalid API key ${DUMMY_KEY}` } } }])
    const message = await errorMessage(fake.baseUrl)
    expect(message).toContain('<redacted>')
    expect(message).not.toContain(DUMMY_KEY)
  })

  // One row per place in complete() that puts the response text in a ModelError.
  const ECHOES: Array<[label: string, status: number, build: (payload: string) => string]> = [
    ['an HTTP 401 error body', 401, (p) => JSON.stringify({ error: { message: p } })],
    ['a 200 body that is not JSON', 200, (p) => p],
    ['a 200 body that is JSON but no object', 200, (p) => JSON.stringify(p)],
    ['a 200 with an error object', 200, (p) => JSON.stringify({ error: { message: p } })],
    ['a 200 without choices', 200, (p) => JSON.stringify({ id: p })],
  ]

  // At 190 an excerpt cut before the mask would keep the first 10 characters of the key; no stretch of 6+ may survive.
  describe.each([40, 190])('with the key starting at character %i of the body', (offset) => {
    it.each(ECHOES)('masks it in the error for %s', async (_label, status, build) => {
      fake = await startFakeModelServer([{ status, body: bodyWithKeyAt(offset, build) }])
      const message = await errorMessage(fake.baseUrl)
      expect(message).toContain('<redacted>')
      expect(leakedFragments(message)).toEqual([])
    })
  })

  it('masks the key in the reason of a transport failure', async () => {
    // undici echoes the URL in its parse error, which makes a transport failure whose reason holds the key.
    const message = await errorMessage(`http://not a url ${DUMMY_KEY}`)
    expect(message).toMatch(/^model request failed: /)
    expect(message).toContain('<redacted>')
    expect(leakedFragments(message)).toEqual([])
  })

  // undici trims a header value before it goes out, so the server never sees the padding and echoes the key without it.
  it('masks the key without surrounding whitespace when the configured key has some', async () => {
    const echo = { status: 401, body: bodyWithKeyAt(190, (p) => JSON.stringify({ error: { message: p } })) }
    fake = await startFakeModelServer([echo, echo])
    for (const padding of [' ', '\n']) {
      const message = await errorMessage(fake.baseUrl, DUMMY_KEY + padding)
      expect(message, JSON.stringify(padding)).toContain('<redacted>')
      expect(leakedFragments(message), JSON.stringify(padding)).toEqual([])
    }
    // The premise: what reached the server was the trimmed key, for both paddings.
    expect(fake.requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${DUMMY_KEY}`, `Bearer ${DUMMY_KEY}`])
  })

  it('leaves a good answer untouched: only error messages are masked', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: `the key is ${DUMMY_KEY}` }) }])
    const r = await createModelClient({ baseUrl: fake.baseUrl, name: 'm', apiKey: DUMMY_KEY }).complete(msgs, opts())
    expect(r.message.content).toBe(`the key is ${DUMMY_KEY}`)
  })
})

describe('reasoningEffort', () => {
  it('sends reasoning_effort when set', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'x' }) }])
    await createModelClient({ baseUrl: fake.baseUrl, name: 'm', reasoningEffort: 'none' }).complete(msgs, opts())
    expect(fake.requests[0].body.reasoning_effort).toBe('none')
  })

  it('omits reasoning_effort when not set', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'x' }) }])
    await createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, opts())
    expect(fake.requests[0].body).not.toHaveProperty('reasoning_effort')
  })
})

describe('extraBody', () => {
  // The fields the comparison runner adds for an OpenRouter model; `reasoning` is the nested object, not reasoning_effort.
  const fields = { temperature: 0.7, seed: 1, provider: { data_collection: 'deny', require_parameters: true }, reasoning: { effort: 'none' } }

  it('merges temperature, seed, the provider block and the reasoning object into the request, next to the client fields', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'x' }) }])
    await createModelClient({ baseUrl: fake.baseUrl, name: 'm', extraBody: fields }).complete(msgs, opts())
    expect(fake.requests[0].body).toEqual({ model: 'm', messages: msgs, max_tokens: 64, stream: false, ...fields })
  })

  it('sends them on every request, also one with tools', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'x' }) }, { body: completion({ content: 'y' }) }])
    const tools = [{ type: 'function' as const, function: { name: 'echo', parameters: { type: 'object' } } }]
    const client = createModelClient({ baseUrl: fake.baseUrl, name: 'm', extraBody: fields })
    await client.complete(msgs, opts())
    await client.complete(msgs, { ...opts(), tools })
    expect(fake.requests[1].body).toMatchObject({ ...fields, tools })
    expect(fake.requests[0].body).toMatchObject(fields)
  })

  it('adds nothing to the request without extraBody', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'x' }) }, { body: completion({ content: 'y' }) }])
    await createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, opts())
    await createModelClient({ baseUrl: fake.baseUrl, name: 'm', extraBody: {} }).complete(msgs, opts())
    for (const r of fake.requests) expect(Object.keys(r.body).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream'])
  })

  it('lets the client fields win when extraBody names one, since they are merged underneath', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'x' }) }])
    const tools = [{ type: 'function' as const, function: { name: 'echo', parameters: { type: 'object' } } }]
    const extraBody = { model: 'other', messages: [], max_tokens: 1, stream: true, tools: [], reasoning_effort: 'high' }
    await createModelClient({ baseUrl: fake.baseUrl, name: 'm', reasoningEffort: 'none', extraBody }).complete(msgs, { ...opts(), tools })
    expect(fake.requests[0].body).toEqual({ model: 'm', messages: msgs, max_tokens: 64, stream: false, tools, reasoning_effort: 'none' })
  })

  it('passes reasoning_effort from extraBody when reasoningEffort is not set', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'x' }) }])
    await createModelClient({ baseUrl: fake.baseUrl, name: 'm', extraBody: { reasoning_effort: 'low' } }).complete(msgs, opts())
    expect(fake.requests[0].body.reasoning_effort).toBe('low')
  })

  it('does not change the extraBody object it was given', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'x' }) }])
    const extraBody = structuredClone(fields)
    await createModelClient({ baseUrl: fake.baseUrl, name: 'm', extraBody }).complete(msgs, opts())
    expect(extraBody).toEqual(fields)
  })

  it('keeps the api key in the Authorization header and out of the request body', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'x' }) }])
    await createModelClient({ baseUrl: fake.baseUrl, name: 'm', apiKey: DUMMY_KEY, extraBody: fields }).complete(msgs, opts())
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${DUMMY_KEY}`)
    expect(leakedFragments(JSON.stringify(fake.requests[0].body))).toEqual([])
  })
})

// Node's fetch (undici) has headersTimeout/bodyTimeout of 300 s. With stream:false the headers only arrive after the
// whole generation, so a thinking model that takes > 5 min per turn failed with "fetch failed" (spike 2026-09-27).
describe('transport timeouts', () => {
  it('sets no transport timeout by default: the run deadline (signal) is the only bound', () => {
    expect(transportTimeouts({})).toEqual({ headersTimeout: 0, bodyTimeout: 0 })
    expect(transportTimeouts({ headersTimeoutMs: 1500 })).toEqual({ headersTimeout: 1500, bodyTimeout: 1500 })
  })

  it('applies an explicit headersTimeoutMs to the request', async () => {
    // undici's timers have ~1 s resolution, so the gap between timeout and delay is generous.
    fake = await startFakeModelServer([{ body: completion({ content: 'late' }), delayMs: 3000 }])
    const c = createModelClient({ baseUrl: fake.baseUrl, name: 'm', headersTimeoutMs: 500 })
    await expect(c.complete(msgs, opts())).rejects.toThrow(ModelError)
  })

  it('waits for a slow response when no timeout is set', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'late' }), delayMs: 800 }])
    const r = await createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, opts())
    expect(r.message.content).toBe('late')
  })
})

describe('reasoning, cachedTokens, durationMs and systemFingerprint', () => {
  it('reads reasoning, cachedTokens and systemFingerprint from a real Ollama response', async () => {
    fake = await startFakeModelServer([{ body: fixture('ollama-v1-reasoning.json') }])
    const r = await createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, opts())
    expect(r.message.content).toBe('51')
    expect(r.reasoning).toBe(
      'The user asks "Wat is 17*3?" (What is 17*3?) and asks to answer with only the number.\n\n17 * 3 = 51\n\nThey want only the number as the answer.',
    )
    expect(r.usage.cachedTokens).toBe(0)
    expect(r.systemFingerprint).toBe('fp_ollama')
  })

  it('reads cachedTokens 22 from the second turn of the same conversation', async () => {
    fake = await startFakeModelServer([{ body: fixture('ollama-v1-cached.json') }])
    const r = await createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, opts())
    expect(r.usage.cachedTokens).toBe(22)
  })

  it('falls back to reasoning_content when the message has no reasoning field', async () => {
    const renamed = JSON.parse(fixture('ollama-v1-reasoning.json'))
    renamed.choices[0].message.reasoning_content = renamed.choices[0].message.reasoning
    delete renamed.choices[0].message.reasoning
    fake = await startFakeModelServer([{ body: renamed }])
    const r = await createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, opts())
    expect(r.reasoning).toBe(
      'The user asks "Wat is 17*3?" (What is 17*3?) and asks to answer with only the number.\n\n17 * 3 = 51\n\nThey want only the number as the answer.',
    )
  })

  it('leaves reasoning, cachedTokens and systemFingerprint undefined when the response has none, without error', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'x' }) }])
    const r = await createModelClient({ baseUrl: fake.baseUrl, name: 'm' }).complete(msgs, opts())
    expect(r.reasoning).toBeUndefined()
    expect(r.usage.cachedTokens).toBeUndefined()
    expect(r.systemFingerprint).toBeUndefined()
  })

  it('measures durationMs from just before fetch to just after the body is read', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'x' }) }])
    const ticks = [1000, 1450]
    let i = 0
    const now = () => ticks[i++]
    const r = await createModelClient({ baseUrl: fake.baseUrl, name: 'm', now }).complete(msgs, opts())
    expect(r.durationMs).toBe(450)
    expect(i).toBe(2)
  })
})
