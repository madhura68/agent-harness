import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Manifest } from '../src/manifest.js'
import { createModelClient } from '../src/model-client.js'
import { runManifest } from '../src/run.js'
import { connectRegistry } from '../src/tools/registry.js'
import { openTrace } from '../src/trace.js'
import type { ToolRegistry } from '../src/types.js'
import { completion, startFakeModelServer, type FakeTurn } from './fakes/fake-model-server.js'
import { startFakeMcp } from './fakes/fake-mcp-server.js'
import { readTrace, tmp } from './helpers.js'

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let fake: Fake | undefined
const open: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await fake?.close()
  fake = undefined
  for (const o of open.splice(0)) await o.close().catch(() => undefined)
})

const limits: Manifest['limits'] = { maxTurns: 4, maxOutputTokens: 2048, maxWallSeconds: 30, maxToolErrors: 2 }
type Call = { id?: string; name: string; arguments?: unknown }
const calls = (cs: Call[], content: string | null = null): FakeTurn => ({ body: completion({ content, toolCalls: cs }) })
const answer = (text: string): FakeTurn => ({ body: completion({ content: text }) })

async function run(
  script: FakeTurn[],
  opts: { allow?: string[]; limits?: Partial<typeof limits>; connect?: (signal: AbortSignal) => Promise<ToolRegistry> } = {},
) {
  fake = await startFakeModelServer(script)
  const mcp = await startFakeMcp()
  open.push(mcp)
  const allow = opts.allow ?? ['echo', 'slow']
  const m: Manifest = {
    id: 'tools-test', profile: 'tools', prompt: 'Doe iets met tools.',
    model: { baseUrl: fake.baseUrl, name: 'm' },
    tools: { server: { command: 'unused', args: [] }, allow },
    limits: { ...limits, ...opts.limits },
  }
  const trace = openTrace(tmp('tools'), m.id)
  const connect = vi.fn(opts.connect ?? (async () => connectRegistry(mcp.client, allow)))
  const result = await runManifest(m, { client: createModelClient({ baseUrl: fake.baseUrl, name: 'm' }), trace, connectRegistry: connect })
  return { result, trace, requests: fake.requests, mcpCalls: mcp.calls, connect, events: readTrace(trace.dir) }
}

const lastToolMessages = (req: { body: { messages: Array<{ role: string; tool_call_id?: string; content: string }> } }) =>
  req.body.messages.filter((m) => m.role === 'tool')

describe('runManifest — tools profile', () => {
  it('executes one echo call and answers', async () => {
    const r = await run([calls([{ id: 'c1', name: 'echo', arguments: '{"text":"hoi"}' }]), answer('De tool zei hoi.')])
    expect(r.result).toMatchObject({ status: 'completed', answer: 'De tool zei hoi.', usage: { turns: 2, toolCalls: 1, toolErrors: 0 } })
    expect(r.result.toolSnapshotHash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.connect).toHaveBeenCalledTimes(1)
    expect(r.mcpCalls).toEqual(['echo'])
    const tm = lastToolMessages(r.requests[1])
    expect(tm).toHaveLength(1)
    expect(tm[0].tool_call_id).toBe('c1')
    expect(JSON.parse(tm[0].content)).toEqual({ ok: true, content: 'hoi', truncated: false })
    expect(readFileSync(join(r.trace.dir, 'tools', 'c1.txt'), 'utf8')).toBe('hoi')
    expect(r.requests[0].body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['echo', 'slow'])
    expect(r.events.map((e) => e.type)).toEqual([
      'run_start', 'tool_snapshot', 'model_request', 'model_response', 'tool_call', 'tool_result', 'model_request', 'model_response', 'run_end',
    ])
  })

  it('runs two calls from one turn in order', async () => {
    const r = await run([calls([{ id: 'a', name: 'echo', arguments: '{"text":"een"}' }, { id: 'b', name: 'echo', arguments: '{"text":"twee"}' }]), answer('ok')])
    expect(r.result.status).toBe('completed')
    const tm = lastToolMessages(r.requests[1])
    expect(tm.map((m) => [m.tool_call_id, JSON.parse(m.content).content])).toEqual([['a', 'een'], ['b', 'twee']])
  })

  it('refuses a tool outside the allowlist without reaching the MCP server and keeps going', async () => {
    const r = await run([calls([{ id: 'x', name: 'delete_everything', arguments: '{}' }]), answer('Dat mocht niet.')])
    expect(r.result.status).toBe('completed')
    expect(r.result.usage.toolErrors).toBe(1)
    expect(r.mcpCalls).not.toContain('delete_everything')
    expect(r.events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, errorCode: 'UNKNOWN_TOOL' })
  })

  it('returns SCHEMA_MISMATCH to the model', async () => {
    const r = await run([calls([{ id: 'x', name: 'echo', arguments: '{"text":42}' }]), answer('ok')])
    expect(JSON.parse(lastToolMessages(r.requests[1])[0].content)).toMatchObject({ ok: false, errorCode: 'SCHEMA_MISMATCH' })
    expect(r.mcpCalls).toEqual([])
  })

  it('fails with TOO_MANY_TOOL_ERRORS and skips the rest of the turn', async () => {
    const r = await run(
      [calls([{ id: 'a', name: 'nope', arguments: '{}' }, { id: 'b', name: 'nope2', arguments: '{}' }, { id: 'c', name: 'echo', arguments: '{"text":"x"}' }])],
      { limits: { maxToolErrors: 1 } },
    )
    expect(r.result).toMatchObject({ status: 'failed', error: { code: 'TOO_MANY_TOOL_ERRORS' } })
    expect(r.events.filter((e) => e.type === 'tool_call').map((e) => e.callId)).toEqual(['a', 'b'])
    expect(r.mcpCalls).toEqual([])
    expect(r.requests).toHaveLength(1)
  })

  it('stops at maxTurns without an extra request', async () => {
    const loop = calls([{ id: 'x', name: 'echo', arguments: '{"text":"again"}' }])
    const r = await run([loop, loop, loop, loop], { limits: { maxTurns: 2 } })
    expect(r.result.status).toBe('budget_exceeded')
    expect(r.requests).toHaveLength(2)
    expect(r.mcpCalls).toEqual(['echo', 'echo'])
  })

  it('times out during a slow tool and makes no further request', async () => {
    const started = Date.now()
    const r = await run([calls([{ id: 's', name: 'slow', arguments: '{"ms":5000}' }, { id: 'e', name: 'echo', arguments: '{"text":"x"}' }]), answer('never')], { limits: { maxWallSeconds: 1 } })
    expect(r.result.status).toBe('timed_out')
    expect(r.requests).toHaveLength(1)
    expect(r.mcpCalls).toEqual(['slow'])
    expect(Date.now() - started).toBeLessThan(2500)
    expect(r.events.find((e) => e.type === 'tool_result')).toMatchObject({ errorCode: 'TOOL_TIMEOUT' })
  })

  it('assigns unique call ids when the model omits or repeats them', async () => {
    const r = await run([
      calls([{ name: 'echo', arguments: '{"text":"a"}' }, { id: 'dup', name: 'echo', arguments: '{"text":"b"}' }, { id: 'dup', name: 'echo', arguments: '{"text":"c"}' }]),
      answer('ok'),
    ])
    const tm = lastToolMessages(r.requests[1])
    const ids = tm.map((m) => m.tool_call_id)
    expect(new Set(ids).size).toBe(3)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(tm.map((m) => JSON.parse(m.content).content)).toEqual(['a', 'b', 'c'])
    // the assistant message carries the same ids the tool messages answer
    const assistant = r.requests[1].body.messages.find((m: { role: string }) => m.role === 'assistant')
    expect(assistant.tool_calls.map((c: { id: string }) => c.id)).toEqual(ids)
    expect(r.mcpCalls).toEqual(['echo', 'echo', 'echo'])
  })

  it('keeps assistant content next to tool_calls in the next request', async () => {
    const r = await run([calls([{ id: 'c', name: 'echo', arguments: '{"text":"x"}' }], 'Ik roep echo aan.'), answer('ok')])
    const assistant = r.requests[1].body.messages.find((m: { role: string }) => m.role === 'assistant')
    expect(assistant.content).toBe('Ik roep echo aan.')
  })

  it('fails with TOOL_NOT_AVAILABLE when an allowed tool is missing, writing run_end and result.json', async () => {
    const r = await run([answer('never')], { allow: ['missing'] })
    expect(r.result).toMatchObject({ status: 'failed', error: { code: 'TOOL_NOT_AVAILABLE' } })
    expect(r.requests).toHaveLength(0)
    expect(r.events.at(-1)).toMatchObject({ type: 'run_end', status: 'failed', error: { code: 'TOOL_NOT_AVAILABLE' } })
    expect(existsSync(join(r.trace.dir, 'result.json'))).toBe(true)
  })

  it('bounds MCP startup by maxWallSeconds and aborts the connect signal', async () => {
    let seen: AbortSignal | undefined
    const started = Date.now()
    const r = await run([answer('never')], {
      limits: { maxWallSeconds: 1 },
      connect: (signal) => { seen = signal; return new Promise<ToolRegistry>(() => undefined) }, // hangs forever
    })
    expect(r.result.status).toBe('timed_out')
    expect(r.requests).toHaveLength(0)
    expect(seen?.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(2500)
  })

  it('closes a registry that connects after the startup deadline', async () => {
    const close = vi.fn(async () => undefined)
    const late = { snapshot: { entries: [], hash: 'h' }, toOpenAiTools: () => [], execute: vi.fn(), close } as unknown as ToolRegistry
    const r = await run([answer('never')], {
      limits: { maxWallSeconds: 1 },
      connect: () => new Promise<ToolRegistry>((resolve) => setTimeout(() => resolve(late), 1300)),
    })
    expect(r.result.status).toBe('timed_out')
    await new Promise((res) => setTimeout(res, 500))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('reports an MCP server that fails to start as failed/TOOL_NOT_AVAILABLE', async () => {
    const r = await run([answer('never')], { connect: async () => { throw new Error('spawn mcp-bin ENOENT') } })
    expect(r.result).toMatchObject({ status: 'failed', error: { code: 'TOOL_NOT_AVAILABLE' } })
    expect(r.result.error?.message).toMatch(/ENOENT/)
  })

  it('never reuses a model-supplied id for a generated one', async () => {
    const r = await run([
      calls([{ id: 'call_1_1', name: 'echo', arguments: '{"text":"a"}' }, { name: 'echo', arguments: '{"text":"b"}' }]),
      answer('ok'),
    ])
    const ids = lastToolMessages(r.requests[1]).map((m) => m.tool_call_id)
    expect(new Set(ids).size).toBe(2)
  })

  it('keeps the full tool content on disk while the model gets the truncated text', async () => {
    const r = await run([calls([{ id: 'b', name: 'big', arguments: '{}' }]), answer('ok')], { allow: ['big'] })
    const msg = JSON.parse(lastToolMessages(r.requests[1])[0].content)
    expect(msg.truncated).toBe(true)
    expect(Buffer.byteLength(msg.content)).toBeLessThanOrEqual(16_384)
    expect(readFileSync(join(r.trace.dir, 'tools', 'b.txt'), 'utf8')).toHaveLength(40_000)
    expect(r.events.find((e) => e.type === 'tool_result')).toMatchObject({ truncated: true, bytes: 40_000 })
  })
})

// Ollama cuts a prompt that exceeds its context from the front and then fails with "no user query found in
// messages" (spike 2026-09-27, ~30.8k of 32k tokens). limits.contextTokens keeps the prompt under that window.
describe('context budget (limits.contextTokens)', () => {
  const big = (id: string, promptTokens: number | null): FakeTurn => ({
    body: completion({ toolCalls: [{ id, name: 'big', arguments: '{}' }], usage: promptTokens === null ? null : { prompt_tokens: promptTokens, completion_tokens: 5 } }),
  })
  const isCompacted = (m: { content: string }) => (JSON.parse(m.content) as { compacted?: boolean }).compacted === true

  it('leaves the history alone without contextTokens', async () => {
    const r = await run([big('b1', 100), big('b2', 5700), answer('ok')], { allow: ['big'] })
    expect(r.result.status).toBe('completed')
    expect(lastToolMessages(r.requests[2]).map(isCompacted)).toEqual([false, false])
    expect(r.events.some((e) => e.type === 'context_compacted')).toBe(false)
    expect(r.events.find((e) => e.type === 'model_request')).not.toHaveProperty('promptEstimate')
  })

  for (const reported of [true, false]) {
    it(`compacts the oldest tool result before the window fills (usage ${reported ? 'reported' : 'missing'})`, async () => {
      const r = await run([big('b1', reported ? 100 : null), big('b2', reported ? 5700 : null), answer('ok')], {
        allow: ['big'], limits: { contextTokens: 14_000 },
      })
      expect(r.result.status).toBe('completed')
      // Request 2: one 16 kB result fits. Request 3: two do not, so the older one is replaced by a stub.
      expect(lastToolMessages(r.requests[1]).map(isCompacted)).toEqual([false])
      const third = lastToolMessages(r.requests[2])
      expect(third.map(isCompacted)).toEqual([true, false])
      expect(JSON.parse(third[0].content).content).toMatch(/call the tool again/)
      const ev = r.events.find((e) => e.type === 'context_compacted')
      expect(ev).toMatchObject({ turn: 3, messages: 1 })
      expect(ev?.estimateAfter).toBeLessThan(ev?.estimateBefore as number)
      expect(r.events.filter((e) => e.type === 'model_request').at(-1)).toMatchObject({ turn: 3, promptEstimate: ev?.estimateAfter })
      // The request never asks for more output than the window leaves.
      expect(r.requests[2].body.max_tokens).toBeLessThanOrEqual(14_000 - (ev?.estimateAfter as number))
      // Removed text is credited at the sparse end (4 chars/token), never more generously than that.
      if (reported) expect((ev?.estimateBefore as number) - (ev?.estimateAfter as number)).toBeLessThanOrEqual((ev?.bytes as number) / 4)
    })
  }

  it('stops with CONTEXT_EXHAUSTED when even a compacted history leaves no room, without another request', async () => {
    const r = await run([big('b1', 100), answer('never')], { allow: ['big'], limits: { contextTokens: 6000 } })
    expect(r.result.status).toBe('budget_exceeded')
    expect(r.result.error?.code).toBe('CONTEXT_EXHAUSTED')
    expect(r.requests).toHaveLength(1)
  })
})
