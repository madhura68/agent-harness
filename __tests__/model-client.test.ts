import { afterEach, describe, expect, it } from 'vitest'
import { createModelClient, ModelError } from '../src/model-client.js'
import { completion, startFakeModelServer } from './fakes/fake-model-server.js'

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let fake: Fake | undefined
afterEach(async () => { await fake?.close(); fake = undefined })

const msgs = [{ role: 'user' as const, content: 'hi' }]
const opts = () => ({ signal: AbortSignal.timeout(5000), maxTokens: 64 })

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
