import { afterEach, describe, expect, it } from 'vitest'
import { connectRegistry, flattenContent, RegistryError, TOOL_OUTPUT_LIMIT } from '../src/tools/registry.js'
import type { ToolRegistry } from '../src/types.js'
import { startFakeMcp } from './fakes/fake-mcp-server.js'

const open: Array<{ close(): Promise<void> }> = []
afterEach(async () => { for (const o of open.splice(0)) await o.close().catch(() => undefined) })

async function registry(allow: string[], opts?: { echoDescription?: string }): Promise<{ reg: ToolRegistry; calls: string[] }> {
  const fake = await startFakeMcp(opts)
  open.push(fake)
  const reg = await connectRegistry(fake.client, allow)
  open.push(reg)
  return { reg, calls: fake.calls }
}

const sig = () => AbortSignal.timeout(5000)

describe('fake MCP server', () => {
  it('lists its tools', async () => {
    const fake = await startFakeMcp()
    open.push(fake)
    const { tools } = await fake.client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['big', 'boom', 'delete_everything', 'echo', 'image', 'slow'])
  })
})

describe('connectRegistry', () => {
  it('freezes a snapshot of only the allowed tools', async () => {
    const { reg } = await registry(['echo'])
    expect(reg.snapshot.entries.map((e) => e.name)).toEqual(['echo'])
    const tools = reg.toOpenAiTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]).toEqual({
      type: 'function',
      function: { name: 'echo', description: 'Echo text back', parameters: reg.snapshot.entries[0].inputSchema },
    })
    expect(reg.snapshot.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('sorts entries by name regardless of allow order', async () => {
    const { reg } = await registry(['slow', 'echo'])
    expect(reg.snapshot.entries.map((e) => e.name)).toEqual(['echo', 'slow'])
  })

  it('throws TOOL_NOT_AVAILABLE for an allowed name the server lacks', async () => {
    const fake = await startFakeMcp()
    open.push(fake)
    const err = await connectRegistry(fake.client, ['echo', 'missing']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RegistryError)
    expect(err).toMatchObject({ code: 'TOOL_NOT_AVAILABLE' })
    expect((err as Error).message).toContain('missing')
  })

  it('has a stable hash for the same catalogue and a different one when a description changes', async () => {
    const a = await registry(['echo', 'slow'])
    const b = await registry(['slow', 'echo'])
    const c = await registry(['echo', 'slow'], { echoDescription: 'Changed' })
    expect(a.reg.snapshot.hash).toBe(b.reg.snapshot.hash)
    expect(c.reg.snapshot.hash).not.toBe(a.reg.snapshot.hash)
  })
})

describe('execute', () => {
  it('returns text content', async () => {
    const { reg } = await registry(['echo'])
    expect(await reg.execute('echo', { text: 'hoi' }, sig())).toEqual({ ok: true, content: 'hoi', truncated: false })
  })

  it('truncates output above the limit and keeps the full text alongside', async () => {
    const { reg } = await registry(['big'])
    const r = await reg.execute('big', {}, sig())
    expect(r.ok).toBe(true)
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.content)).toBeLessThanOrEqual(TOOL_OUTPUT_LIMIT)
    expect(r.fullContent).toHaveLength(40_000)
  })

  it('renders non-text content as a placeholder', async () => {
    const { reg } = await registry(['image'])
    const r = await reg.execute('image', {}, sig())
    expect(r.content).toBe('caption\n[non-text content: image]')
  })

  it('maps isError to TOOL_ERROR with the text', async () => {
    const { reg } = await registry(['boom'])
    expect(await reg.execute('boom', {}, sig())).toEqual({ ok: false, errorCode: 'TOOL_ERROR', content: 'kaboom', truncated: false })
  })

  it('maps a server-side validation failure to TOOL_ERROR', async () => {
    const { reg } = await registry(['echo'])
    const r = await reg.execute('echo', { text: 42 }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
  })

  it('aborts a slow tool with TOOL_TIMEOUT within 500 ms', async () => {
    const { reg } = await registry(['slow'])
    const started = Date.now()
    const r = await reg.execute('slow', { ms: 5000 }, AbortSignal.timeout(100))
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_TIMEOUT', truncated: false })
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('refuses a tool outside the snapshot without contacting the server', async () => {
    const { reg, calls } = await registry(['echo'])
    const r = await reg.execute('delete_everything', {}, sig())
    expect(r).toEqual({ ok: false, errorCode: 'UNKNOWN_TOOL', content: 'tool not in snapshot', truncated: false })
    expect(calls).not.toContain('delete_everything')
  })
})

describe('flattenContent', () => {
  it('joins text and marks other types', () => {
    expect(flattenContent([{ type: 'text', text: 'a' }, { type: 'resource', resource: {} }, { type: 'text', text: 'b' }])).toBe('a\n[non-text content: resource]\nb')
    expect(flattenContent([])).toBe('')
    expect(flattenContent([null, 'weird'])).toBe('[non-text content: unknown]\n[non-text content: unknown]')
  })
})

describe('connectStdioRegistry', () => {
  it('passes only the default env subset plus the manifest env to the child', async () => {
    const { connectStdioRegistry } = await import('../src/tools/registry.js')
    process.env.HARNESS_HOST_SECRET = 'must-not-leak'
    try {
      const reg = await connectStdioRegistry(
        { command: process.execPath, args: ['--import', 'tsx', '__tests__/fakes/stdio-env-server.ts'], env: { GIVEN_BY_MANIFEST: '1' } },
        ['env_names'],
      )
      open.push(reg)
      const r = await reg.execute('env_names', {}, AbortSignal.timeout(10_000))
      const names: string[] = JSON.parse(r.content)
      expect(names).toContain('GIVEN_BY_MANIFEST')
      expect(names).toContain('PATH')
      expect(names).not.toContain('HARNESS_HOST_SECRET')
    } finally {
      delete process.env.HARNESS_HOST_SECRET
    }
  }, 20_000)

  it('rejects with RegistryError and cleans up when an allowed tool is missing', async () => {
    const { connectStdioRegistry } = await import('../src/tools/registry.js')
    const err = await connectStdioRegistry(
      { command: process.execPath, args: ['--import', 'tsx', '__tests__/fakes/stdio-env-server.ts'] },
      ['get_context'],
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RegistryError)
  }, 20_000)

  it('kills a child that never speaks MCP when the signal aborts', async () => {
    const { connectStdioRegistry } = await import('../src/tools/registry.js')
    const { mkdtempSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const pidFile = join(mkdtempSync(join(tmpdir(), 'harness-pid-')), 'pid')
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
    const started = Date.now()
    const err = await connectStdioRegistry({ command: process.execPath, args: ['-e', script] }, ['echo'], AbortSignal.timeout(300)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(Date.now() - started).toBeLessThan(1500)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await new Promise((r) => setTimeout(r, 200))
    const alive = (() => { try { process.kill(pid, 0); return true } catch { return false } })()
    if (alive) process.kill(pid, 'SIGKILL')
    expect(alive).toBe(false)
  }, 10_000)
})
