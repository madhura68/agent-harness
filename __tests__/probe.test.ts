import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'
import { createModelClient } from '../src/model-client.js'
import { probeDir, runProbe } from '../src/probe.js'
import { completion, startFakeModelServer, type FakeTurn } from './fakes/fake-model-server.js'
import { bodyWithKeyAt, DUMMY_KEY, leakedFragments } from './helpers.js'

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let fake: Fake | undefined
afterEach(async () => { await fake?.close(); fake = undefined })

const echo = (text: string, id = 'c1') => ({ body: completion({ toolCalls: [{ id, name: 'echo', arguments: JSON.stringify({ text }) }] }) })
// Request order: a, b, c-turn1, c-turn2, d
const good: FakeTurn[] = [
  { body: completion({ content: 'pong' }) },
  echo('ping'),
  echo('ping'),
  echo('pong', 'c2'),
  { body: completion({ content: 'Dat kan ik niet doen.' }) },
]

async function probe(script: FakeTurn[], apiKey?: string) {
  fake = await startFakeModelServer(script)
  const client = createModelClient({ baseUrl: fake.baseUrl, name: 'm', apiKey })
  return runProbe(client, { baseUrl: fake.baseUrl, model: 'm', stepTimeoutMs: 2000 })
}

describe('runProbe', () => {
  it('rates a model that passes a-d as reliable', async () => {
    const r = await probe(good)
    expect(Object.fromEntries(Object.entries(r.steps).map(([k, v]) => [k, v.pass]))).toEqual({
      a_plain: true, b_single_tool: true, c_two_tools: true, d_nonexistent_tool: true,
    })
    expect(r.tool_calling).toBe('reliable')
    expect(r.usage_reported).toBe(true)
    expect(r.reportedModel).toBe('fake-model')
    expect(fake!.requests).toHaveLength(5)
    // c turn 2 carries the assistant call and a tool reply before the second user message
    const c2 = fake!.requests[3].body.messages
    expect(c2.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(c2[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ping' })
    expect(fake!.requests[1].body.tools[0].function.name).toBe('echo')
    expect(fake!.requests[0].body.tools).toBeUndefined()
  })

  it('rates none when b returns no tool call', async () => {
    const script = [...good]
    script[1] = { body: completion({ content: 'ping', toolCalls: [] }) }
    const r = await probe(script)
    expect(r.steps.b_single_tool.pass).toBe(false)
    expect(r.tool_calling).toBe('none')
  })

  it('rates unreliable when d calls delete_everything', async () => {
    const script = [...good]
    script[4] = { body: completion({ toolCalls: [{ id: 'x', name: 'delete_everything', arguments: '{}' }] }) }
    const r = await probe(script)
    expect(r.steps.d_nonexistent_tool.pass).toBe(false)
    expect(r.tool_calling).toBe('unreliable')
  })

  it('keeps going after a model error and records the reason', async () => {
    const script = [...good]
    script[3] = { status: 500, body: { error: { message: 'boom' } } }
    const r = await probe(script)
    expect(r.steps.c_two_tools.pass).toBe(false)
    expect(r.steps.c_two_tools.reason).toMatch(/500/)
    expect(r.steps.d_nonexistent_tool.pass).toBe(true)
    expect(r.tool_calling).toBe('unreliable')
  })

  it('fails b when the arguments are wrong', async () => {
    const script = [...good]
    script[1] = echo('pong')
    const r = await probe(script)
    expect(r.steps.b_single_tool.pass).toBe(false)
    expect(r.tool_calling).toBe('none')
  })

  it('reports usage_reported false when any step lacks usage', async () => {
    const script = [...good]
    script[0] = { body: completion({ content: 'pong', usage: null }) }
    expect((await probe(script)).usage_reported).toBe(false)
  })

  it('keeps the api key out of every reason when the server echoes it', async () => {
    const echo = { status: 401, body: bodyWithKeyAt(190, (p) => JSON.stringify({ error: { message: p } })) }
    const r = await probe([echo, echo, echo, echo], DUMMY_KEY)
    expect(fake!.requests).toHaveLength(4) // each step failed on its first request
    for (const s of Object.values(r.steps)) {
      expect(s.reason).toContain('<redacted>')
      expect(leakedFragments(s.reason)).toEqual([])
    }
    expect(leakedFragments(JSON.stringify(r))).toEqual([])
  })
})

describe('probeDir', () => {
  it('slugs model names with colons', () => {
    expect(probeDir('runs', 'qwen3:8b')).toBe(join('runs', 'probe-qwen3-8b'))
    expect(probeDir('runs', 'Qwen3-Coder:30B')).toBe(join('runs', 'probe-qwen3-coder-30b'))
  })
})

describe('harness probe CLI', () => {
  it('writes probe.json without the api key and exits 0 when reliable', async () => {
    fake = await startFakeModelServer(good)
    const out = mkdtempSync(join(tmpdir(), 'harness-probe-'))
    process.env.HARNESS_TEST_KEY = 'sk-test-secret'
    const code = await main(['probe', '--base-url', fake.baseUrl, '--model', 'qwen3:8b', '--out', out, '--api-key-env', 'HARNESS_TEST_KEY', '--step-timeout', '5'])
    delete process.env.HARNESS_TEST_KEY
    expect(code).toBe(0)
    expect(fake.requests[0].headers.authorization).toBe('Bearer sk-test-secret')
    const text = readFileSync(join(probeDir(out, 'qwen3:8b'), 'probe.json'), 'utf8')
    expect(text).not.toContain('sk-test-secret')
    expect(JSON.parse(text)).toMatchObject({ model: 'qwen3:8b', baseUrl: fake.baseUrl, tool_calling: 'reliable' })
  })

  it('exits 1 when the verdict is not reliable', async () => {
    const script = [...good]
    script[4] = { body: completion({ toolCalls: [{ id: 'x', name: 'delete_everything', arguments: '{}' }] }) }
    fake = await startFakeModelServer(script)
    const out = mkdtempSync(join(tmpdir(), 'harness-probe-'))
    expect(await main(['probe', '--base-url', fake.baseUrl, '--model', 'm', '--out', out])).toBe(1)
  })

  it('exits 1 when --api-key-env names an unset variable', async () => {
    const out = mkdtempSync(join(tmpdir(), 'harness-probe-'))
    expect(await main(['probe', '--base-url', 'http://127.0.0.1:1/v1', '--model', 'm', '--out', out, '--api-key-env', 'HARNESS_UNSET_VAR'])).toBe(1)
  })
})
