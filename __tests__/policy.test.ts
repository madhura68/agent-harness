import { afterEach, describe, expect, it } from 'vitest'
import { createPolicy } from '../src/tools/policy.js'
import { connectRegistry } from '../src/tools/registry.js'
import type { ToolCall, ToolSnapshot } from '../src/types.js'
import { startFakeMcp } from './fakes/fake-mcp-server.js'

const open: Array<{ close(): Promise<void> }> = []
afterEach(async () => { for (const o of open.splice(0)) await o.close().catch(() => undefined) })

const call = (name: string, args: string): ToolCall => ({ id: 'c', name, arguments: args, argumentsWasObject: false })

const handSnapshot: ToolSnapshot = {
  hash: 'h',
  entries: [
    { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'noreq', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  ],
}

describe('createPolicy', () => {
  const policy = createPolicy(handSnapshot)

  it('accepts a valid call with parsed args', () => {
    expect(policy.check(call('echo', '{"text":"hoi"}'))).toEqual({ ok: true, name: 'echo', args: { text: 'hoi' } })
  })

  it('rejects an unknown tool first, even with broken JSON', () => {
    expect(policy.check(call('delete_everything', 'not json'))).toMatchObject({ ok: false, errorCode: 'UNKNOWN_TOOL' })
  })

  it.each([['not json'], ['[1,2]'], ['"text"'], ['null'], ['42']])('rejects %s as MALFORMED_ARGS', (args) => {
    expect(policy.check(call('echo', args))).toMatchObject({ ok: false, errorCode: 'MALFORMED_ARGS' })
  })

  it('treats empty arguments as {} only when nothing is required', () => {
    expect(policy.check(call('noreq', ''))).toEqual({ ok: true, name: 'noreq', args: {} })
    expect(policy.check(call('echo', ''))).toMatchObject({ ok: false, errorCode: 'MALFORMED_ARGS' })
  })

  it('rejects a schema violation with the ajv message', () => {
    const d = policy.check(call('echo', '{"text":42}'))
    expect(d).toMatchObject({ ok: false, errorCode: 'SCHEMA_MISMATCH' })
    expect(d.ok === false && d.message).toMatch(/must be string/)
  })

  it('allows extra properties when additionalProperties is not set', () => {
    expect(policy.check(call('echo', '{"text":"a","extra":1}'))).toMatchObject({ ok: true })
  })

  it('compiles the schema the MCP SDK really emits and enforces required', async () => {
    const fake = await startFakeMcp()
    open.push(fake)
    const reg = await connectRegistry(fake.client, ['echo', 'slow'])
    open.push(reg)
    const echoSchema = reg.snapshot.entries.find((e) => e.name === 'echo')!.inputSchema
    expect(echoSchema.$schema).toBe("http://json-schema.org/draft-07/schema#") // SDK 1.30.1 still emits draft-07
    const p = createPolicy(reg.snapshot)
    const d = p.check(call('echo', '{}'))
    expect(d).toMatchObject({ ok: false, errorCode: 'SCHEMA_MISMATCH' })
    expect(d.ok === false && d.message).toMatch(/must have required property/)
    expect(p.check(call('slow', '{"ms":5}'))).toMatchObject({ ok: true, args: { ms: 5 } })
  })
})
