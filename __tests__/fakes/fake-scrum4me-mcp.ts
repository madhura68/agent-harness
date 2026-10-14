import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/** One wait_for_job answer: a timeout, a claimed job payload, a tool error, or a handler that keeps waiting. */
export type ClaimStep = { timeout: true } | { job: unknown } | { error: string } | { hangMs: number } | { runtimeMismatch: true }

export type ToolCallRecord = { name: string; args: Record<string, unknown> }

/** Overrides the real `update_job_status` answer body for a requested status (e.g. a `done` request that the MCP actually resolves as `failed` because the push failed). */
export type UpdateOutcomeOverride = { status?: 'running' | 'done' | 'failed' | 'skipped'; branch?: string | null; pushed_at?: string | null; error?: string | null }

const toolText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
const toolError = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] })

/** What the fake `health` tool reports: `runtimes` as a list, `null` for a reply without that field (an MCP from before M45-2b), `noTool` for an MCP without the tool, `error` for a tool error. */
export type HealthSetup = { runtimes?: unknown; noTool?: boolean; error?: string }

/** The default `health` answer: the runtimes of an MCP release with M45-2b (shared `AGENT_RUNTIMES`). */
export const DEFAULT_RUNTIMES = ['CLAUDE', 'CODEX', 'HARNESS']

/**
 * In-process stand-in for the scrum4me MCP: the control tools (wait_for_job, job_heartbeat,
 * update_job_status, update_task_status, verify_task_against_plan, log_implementation, log_commit,
 * log_test_result), the four doc tools and three tools of the chat-agent's wider toolset (list_issues, get_issue, create_note).
 * `calls` records every call the server received.
 * Exhausted claim scripts answer with a timeout.
 */
export async function startFakeScrum4meMcp(
  opts: {
    claims?: ClaimStep[]
    failUpdate?: Array<'running' | 'done' | 'failed'>
    updateOutcome?: Partial<Record<'running' | 'done' | 'failed' | 'skipped', UpdateOutcomeOverride>>
    verifyResult?: 'aligned' | 'partial' | 'empty' | 'divergent'
    health?: HealthSetup
    /** The MCP refuses the cost of every final update, as it does for a cost report it does not allow or does not accept (scrum4me-mcp harness-cost.ts). */
    refuseCost?: 'COST_REPORT_INVALID' | 'COST_REPORT_NOT_ALLOWED'
  } = {},
) {
  const calls: ToolCallRecord[] = []
  const claims = [...(opts.claims ?? [])]
  const state = { heartbeatOk: true, failUpdate: new Set(opts.failUpdate ?? []), updateOutcome: opts.updateOutcome ?? {}, verifyResult: opts.verifyResult ?? 'aligned', health: opts.health ?? {} }
  const server = new McpServer({ name: 'fake-scrum4me', version: '0.0.0' })

  if (!state.health.noTool) {
    server.registerTool('health', {}, async () => {
      calls.push({ name: 'health', args: {} })
      if (state.health.error !== undefined) return toolError(state.health.error)
      // `runtimes: null` leaves the field out, like an MCP release that predates M45-2b.
      const runtimes = 'runtimes' in state.health ? state.health.runtimes : DEFAULT_RUNTIMES
      return toolText({ status: 'ok', version: '0.0.0', time: '2026-10-07T00:00:00.000Z', database: 'ok', ...(runtimes === null ? {} : { runtimes }) })
    })
  }
  server.registerTool('wait_for_job', { inputSchema: { wait_seconds: z.number().int().optional() } }, async (args) => {
    calls.push({ name: 'wait_for_job', args })
    const step = claims.shift() ?? { timeout: true }
    if ('hangMs' in step) {
      await new Promise((r) => setTimeout(r, step.hangMs))
      return toolText({ status: 'timeout', message: 'No job available within wait window' })
    }
    if ('error' in step) return toolError(step.error)
    // The real MCP sets exactly this text unchanged in `content` (errors.ts toolError); the claim was already returned to the queue.
    if ('runtimeMismatch' in step) return toolError('RUNTIME_MISMATCH')
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
        cache_read_tokens: z.number().int().optional(),
        actual_thinking_tokens: z.number().int().optional(),
        // The cost of the job (M45-2d): a decimal string or null, with where the figure came from.
        cost: z
          .object({ reported_cost_usd: z.string().nullable(), cost_source: z.enum(['provider_reported', 'local', 'none']), provider: z.string().optional() })
          .optional(),
      },
    },
    async (args) => {
      calls.push({ name: 'update_job_status', args })
      if (opts.refuseCost !== undefined && args.cost !== undefined) return toolError(`VALIDATION_ERROR: ${opts.refuseCost}`)
      const requested = args.status as 'running' | 'done' | 'failed' | 'skipped'
      if (state.failUpdate.has(requested as 'running' | 'done' | 'failed')) return toolError(`Job ${args.job_id} is already terminal`)
      const override = state.updateOutcome[requested] ?? {}
      return toolText({
        job_id: args.job_id,
        status: requested,
        branch: null,
        pushed_at: null,
        pr_url: null,
        verify_result: null,
        summary: args.summary ?? null,
        error: args.error ?? null,
        ...override,
      })
    },
  )
  server.registerTool('update_task_status', { inputSchema: { task_id: z.string(), status: z.enum(['todo', 'in_progress', 'review', 'done', 'failed', 'excluded']) } }, async (args) => {
    calls.push({ name: 'update_task_status', args })
    return toolText({ ok: true, task_id: args.task_id, status: args.status })
  })
  server.registerTool('verify_task_against_plan', { inputSchema: { task_id: z.string(), worktree_path: z.string() } }, async (args) => {
    calls.push({ name: 'verify_task_against_plan', args })
    return toolText({ result: state.verifyResult, task_id: args.task_id })
  })
  server.registerTool(
    'log_implementation',
    { inputSchema: { story_id: z.string(), task_id: z.string().optional(), content: z.string() } },
    async (args) => {
      calls.push({ name: 'log_implementation', args })
      return toolText({ ok: true })
    },
  )
  server.registerTool(
    'log_commit',
    { inputSchema: { story_id: z.string(), task_id: z.string().optional(), content: z.string(), commit_hash: z.string(), commit_message: z.string() } },
    async (args) => {
      calls.push({ name: 'log_commit', args })
      return toolText({ ok: true })
    },
  )
  server.registerTool(
    'log_test_result',
    { inputSchema: { story_id: z.string(), task_id: z.string().optional(), content: z.string(), status: z.enum(['PASSED', 'FAILED']) } },
    async (args) => {
      calls.push({ name: 'log_test_result', args })
      return toolText({ ok: true })
    },
  )
  // The four doc tools carry the input schemas of the real MCP (scrum4me-mcp src/tools/*-product-docs.ts): product_id is required in all of
  // them, get/related address a doc by folder + slug. Fields the real tool defaults (limit, offset, include_*) are optional here: the SDK
  // would put a default into the recorded arguments, and the tests compare those as sent.
  const folder = z.enum(['adr', 'architecture', 'grills', 'patterns', 'plans', 'runbooks', 'specs', 'manual', 'api'])
  server.registerTool(
    'search_product_docs',
    {
      description: 'Search product docs',
      inputSchema: {
        query: z.string().min(2).max(200),
        product_id: z.string().min(1),
        folder: folder.optional(),
        limit: z.number().int().min(1).max(50).optional(),
        include_archived: z.boolean().optional(),
        include_disabled: z.boolean().optional(),
      },
    },
    async (args) => {
      calls.push({ name: 'search_product_docs', args })
      return toolText({ results: [{ doc_id: 'doc1', title: 'Worker-runbook', product_id: args.product_id }] })
    },
  )
  server.registerTool(
    'get_product_doc',
    {
      description: 'Read one product doc',
      inputSchema: {
        product_id: z.string().min(1),
        folder,
        slug: z.string().min(1).max(80),
        max_chars: z.number().int().min(500).max(40_000).optional(),
        offset: z.number().int().min(0).optional(),
        heading: z.string().optional(),
      },
    },
    async (args) => {
      calls.push({ name: 'get_product_doc', args })
      return toolText({ slug: args.slug, content_md: '# Worker-runbook' })
    },
  )
  server.registerTool(
    'list_product_docs',
    {
      description: 'List product docs',
      inputSchema: {
        product_id: z.string().min(1),
        folder: folder.optional(),
        status: z.enum(['draft', 'active', 'deprecated', 'archived']).optional(),
        include_disabled: z.boolean().optional(),
      },
    },
    async (args) => {
      calls.push({ name: 'list_product_docs', args })
      return toolText({ docs: [] })
    },
  )
  server.registerTool(
    'related_product_docs',
    { description: 'Related product docs', inputSchema: { product_id: z.string().min(1), folder, slug: z.string().min(1).max(80) } },
    async (args) => {
      calls.push({ name: 'related_product_docs', args })
      return toolText({ related: [] })
    },
  )
  // Three tools of the chat-agent's wider toolset (IDEA-262, plan M53 bijlage A): product_id required (list_issues), optional and
  // nullable (create_note), absent (get_issue). The schemas follow scrum4me-mcp @ 3e5f7a0 in the fields that matter to the product scope.
  server.registerTool(
    'list_issues',
    { description: 'List issues', inputSchema: { product_id: z.string().min(1), status: z.string().optional(), limit: z.number().int().min(1).max(100).optional() } },
    async (args) => {
      calls.push({ name: 'list_issues', args })
      return toolText({ issues: [{ id: 'iss1', code: 'ISS-1', title: 'Worker hangt', product_id: args.product_id }] })
    },
  )
  server.registerTool(
    'get_issue',
    { description: 'Read one issue', inputSchema: { issue_id: z.string().min(1) } },
    async (args) => {
      calls.push({ name: 'get_issue', args })
      return toolText({ id: args.issue_id, code: 'ISS-1', title: 'Worker hangt', status: 'open' })
    },
  )
  server.registerTool(
    'create_note',
    { description: 'Create a note', inputSchema: { title: z.string().min(1), body: z.string().min(1), product_id: z.string().min(1).nullable().optional(), keywords: z.array(z.string()).optional() } },
    async (args) => {
      calls.push({ name: 'create_note', args })
      return toolText({ id: 'note1', title: args.title, product_id: args.product_id ?? null })
    },
  )

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
