import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/** One wait_for_job answer: a timeout, a claimed job payload, a tool error, or a handler that keeps waiting. */
export type ClaimStep = { timeout: true } | { job: unknown } | { error: string } | { hangMs: number }

export type ToolCallRecord = { name: string; args: Record<string, unknown> }

const toolText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
const toolError = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] })

/**
 * In-process stand-in for the scrum4me MCP: the control tools (wait_for_job, job_heartbeat,
 * update_job_status) plus the four doc tools. `calls` records every call the server received.
 * Exhausted claim scripts answer with a timeout.
 */
export async function startFakeScrum4meMcp(opts: { claims?: ClaimStep[]; failUpdate?: Array<'running' | 'done' | 'failed'> } = {}) {
  const calls: ToolCallRecord[] = []
  const claims = [...(opts.claims ?? [])]
  const state = { heartbeatOk: true, failUpdate: new Set(opts.failUpdate ?? []) }
  const server = new McpServer({ name: 'fake-scrum4me', version: '0.0.0' })

  server.registerTool('wait_for_job', { inputSchema: { wait_seconds: z.number().int().optional() } }, async (args) => {
    calls.push({ name: 'wait_for_job', args })
    const step = claims.shift() ?? { timeout: true }
    if ('hangMs' in step) {
      await new Promise((r) => setTimeout(r, step.hangMs))
      return toolText({ status: 'timeout', message: 'No job available within wait window' })
    }
    if ('error' in step) return toolError(step.error)
    if ('job' in step) return toolText(step.job)
    return toolText({ status: 'timeout', message: 'No job available within wait window' })
  })
  server.registerTool('job_heartbeat', { inputSchema: { job_id: z.string() } }, async (args) => {
    calls.push({ name: 'job_heartbeat', args })
    if (!state.heartbeatOk) return toolError(`Job ${args.job_id} not found, not claimed by your token, or in terminal state`)
    return toolText({ ok: true, job_id: args.job_id })
  })
  server.registerTool(
    'update_job_status',
    {
      inputSchema: {
        job_id: z.string(),
        status: z.enum(['running', 'done', 'failed', 'skipped']),
        summary: z.string().max(4000).optional(),
        error: z.string().max(2000).optional(),
        model_id: z.string().optional(),
        input_tokens: z.number().int().optional(),
        output_tokens: z.number().int().optional(),
      },
    },
    async (args) => {
      calls.push({ name: 'update_job_status', args })
      if (state.failUpdate.has(args.status as 'running' | 'done' | 'failed')) return toolError(`Job ${args.job_id} is already terminal`)
      return toolText({ ok: true, status: args.status })
    },
  )
  server.registerTool('search_product_docs', { description: 'Search product docs', inputSchema: { product_id: z.string(), query: z.string() } }, async (args) => {
    calls.push({ name: 'search_product_docs', args })
    return toolText({ results: [{ doc_id: 'doc1', title: 'Worker-runbook', product_id: args.product_id }] })
  })
  server.registerTool('get_product_doc', { description: 'Read one product doc', inputSchema: { doc_id: z.string() } }, async (args) => {
    calls.push({ name: 'get_product_doc', args })
    return toolText({ doc_id: args.doc_id, content_md: '# Worker-runbook' })
  })
  server.registerTool('list_product_docs', { description: 'List product docs', inputSchema: { product_id: z.string() } }, async (args) => {
    calls.push({ name: 'list_product_docs', args })
    return toolText({ docs: [] })
  })
  server.registerTool('related_product_docs', { description: 'Related product docs', inputSchema: { doc_id: z.string() } }, async (args) => {
    calls.push({ name: 'related_product_docs', args })
    return toolText({ related: [] })
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'harness-worker-test', version: '0.0.0' })
  await client.connect(clientTransport)
  return {
    client,
    calls,
    state,
    close: async () => {
      await client.close().catch(() => undefined)
      await server.close().catch(() => undefined)
    },
  }
}
