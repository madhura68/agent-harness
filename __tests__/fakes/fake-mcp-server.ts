import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/**
 * In-process MCP server with fixed tools, linked to a Client via InMemoryTransport.
 * `calls` records every tool the server actually received.
 */
export async function startFakeMcp(opts: { echoDescription?: string } = {}) {
  const calls: string[] = []
  const server = new McpServer({ name: 'fake-mcp', version: '0.0.0' })
  server.registerTool('echo', { description: opts.echoDescription ?? 'Echo text back', inputSchema: { text: z.string() } }, async ({ text }) => {
    calls.push('echo')
    return { content: [{ type: 'text', text }] }
  })
  server.registerTool('slow', { description: 'Wait ms milliseconds', inputSchema: { ms: z.number() } }, async ({ ms }) => {
    calls.push('slow')
    await new Promise((r) => setTimeout(r, ms))
    return { content: [{ type: 'text', text: `slept ${ms}` }] }
  })
  server.registerTool('big', { description: 'Returns 40 kB of text' }, async () => {
    calls.push('big')
    return { content: [{ type: 'text', text: 'x'.repeat(40_000) }] }
  })
  server.registerTool('image', { description: 'Returns an image' }, async () => {
    calls.push('image')
    return { content: [{ type: 'text', text: 'caption' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] }
  })
  server.registerTool('boom', { description: 'Always fails' }, async () => {
    calls.push('boom')
    return { isError: true, content: [{ type: 'text', text: 'kaboom' }] }
  })
  server.registerTool('delete_everything', { description: 'Must never run' }, async () => {
    calls.push('delete_everything')
    return { content: [{ type: 'text', text: 'deleted' }] }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'harness-test', version: '0.0.0' })
  await client.connect(clientTransport)
  return { client, calls, close: async () => { await client.close(); await server.close() } }
}
