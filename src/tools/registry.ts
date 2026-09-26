import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ErrorCode as McpErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { ServerSpec, ToolDef, ToolExecResult, ToolRegistry, ToolSnapshot, ToolSnapshotEntry } from '../types.js'

export const TOOL_OUTPUT_LIMIT = 16_384

export class RegistryError extends Error {
  readonly code = 'TOOL_NOT_AVAILABLE' as const
  constructor(message: string) {
    super(message)
    this.name = 'RegistryError'
  }
}

/** Text items joined with '\n'; anything else becomes a visible placeholder. */
export function flattenContent(content: unknown[]): string {
  return content
    .map((item) => {
      const it = item as { type?: unknown; text?: unknown } | null
      if (it && it.type === 'text' && typeof it.text === 'string') return it.text
      const type = it && typeof it === 'object' && typeof it.type === 'string' ? it.type : 'unknown'
      return `[non-text content: ${type}]`
    })
    .join('\n')
}

/** Cuts to at most `limit` UTF-8 bytes without splitting a multi-byte character. */
function truncateUtf8(text: string, limit: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= limit) return { text, truncated: false }
  let end = limit
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true }
}

function abortPromise(signal: AbortSignal): { promise: Promise<'aborted'>; dispose(): void } {
  let onAbort: () => void = () => undefined
  const promise = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) return resolve('aborted')
    onAbort = () => resolve('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) }
}

export async function connectRegistry(
  client: Client,
  allow: string[],
  onClose?: () => Promise<void>,
  signal?: AbortSignal,
): Promise<ToolRegistry> {
  const { tools } = await client.listTools(undefined, signal ? { signal } : undefined)
  const byName = new Map(tools.map((t) => [t.name, t]))
  const missing = allow.filter((n) => !byName.has(n))
  if (missing.length > 0) throw new RegistryError(`allowed tools not offered by the MCP server: ${missing.join(', ')}`)

  const entries: ToolSnapshotEntry[] = [...new Set(allow)]
    .sort()
    .map((name) => {
      const t = byName.get(name)!
      return { name, ...(t.description ? { description: t.description } : {}), inputSchema: t.inputSchema as Record<string, unknown> }
    })
  const snapshot: ToolSnapshot = Object.freeze({
    entries,
    hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  })
  const allowed = new Set(entries.map((e) => e.name))

  return {
    snapshot,
    toOpenAiTools(): ToolDef[] {
      return entries.map((e) => ({
        type: 'function',
        function: { name: e.name, ...(e.description ? { description: e.description } : {}), parameters: e.inputSchema },
      }))
    },
    async execute(name, args, signal): Promise<ToolExecResult> {
      if (!allowed.has(name)) return { ok: false, errorCode: 'UNKNOWN_TOOL', content: 'tool not in snapshot', truncated: false }
      if (signal.aborted) return { ok: false, errorCode: 'TOOL_TIMEOUT', content: 'deadline reached before the tool call', truncated: false }
      const abort = abortPromise(signal)
      try {
        const outcome = await Promise.race([client.callTool({ name, arguments: args }, undefined, { signal }), abort.promise])
        if (outcome === 'aborted') return { ok: false, errorCode: 'TOOL_TIMEOUT', content: 'tool call aborted at the deadline', truncated: false }
        const content = Array.isArray(outcome.content) ? flattenContent(outcome.content) : JSON.stringify(outcome.structuredContent ?? outcome)
        const cut = truncateUtf8(content, TOOL_OUTPUT_LIMIT)
        const full = cut.truncated ? { fullContent: content } : {}
        if (outcome.isError) return { ok: false, errorCode: 'TOOL_ERROR', content: cut.text, truncated: cut.truncated, ...full }
        return { ok: true, content: cut.text, truncated: cut.truncated, ...full }
      } catch (err) {
        if (signal.aborted || (err instanceof McpError && err.code === McpErrorCode.RequestTimeout)) {
          return { ok: false, errorCode: 'TOOL_TIMEOUT', content: 'tool call timed out', truncated: false }
        }
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, errorCode: 'TOOL_ERROR', content: truncateUtf8(message, TOOL_OUTPUT_LIMIT).text, truncated: false }
      } finally {
        abort.dispose()
      }
    },
    async close() {
      await client.close()
      await onClose?.()
    },
  }
}

/**
 * Spawns the MCP server over stdio. The child gets the SDK's default environment subset
 * (HOME, LOGNAME, PATH, SHELL, TERM, USER) plus only what the manifest names — never process.env,
 * so host secrets such as FORGEJO_TOKEN or S4M_* do not reach it.
 */
export async function connectStdioRegistry(server: ServerSpec, allow: string[], signal?: AbortSignal): Promise<ToolRegistry> {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...getDefaultEnvironment(), ...(server.env ?? {}) },
    stderr: 'pipe',
  })
  const stderr = transport.stderr
  if (stderr) {
    createInterface({ input: stderr as NodeJS.ReadableStream }).on('line', (line) => process.stderr.write(`[mcp] ${line}\n`))
  }
  const client = new Client({ name: 'agent-harness', version: '0.1.0' })
  // A server that has not finished startup gets SIGTERM straight away. The SDK's close() first waits
  // up to 2 s for a voluntary exit, and a second close() returns at once, so the child could outlive us.
  const kill = () => {
    const pid = transport.pid
    if (pid) {
      try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
    }
  }
  signal?.addEventListener('abort', kill, { once: true })
  try {
    if (signal?.aborted) throw new Error('MCP startup aborted at the deadline')
    await client.connect(transport, signal ? { signal } : undefined)
    return await connectRegistry(client, allow, () => transport.close(), signal)
  } catch (err) {
    kill()
    await client.close().catch(() => undefined)
    throw err
  } finally {
    signal?.removeEventListener('abort', kill)
  }
}
