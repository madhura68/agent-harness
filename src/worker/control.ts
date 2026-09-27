import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { flattenContent } from '../tools/registry.js'

export type ClaimResult =
  | { type: 'timeout' }
  | { type: 'job'; jobId: string; kind: string; payload: unknown }
  | { type: 'error'; message: string } // server gave a tool error; the connection is healthy
  | { type: 'broken'; message: string } // SDK/transport failed; the connection is gone or a handler may still run
  | { type: 'stopped' } // the given signal (Ctrl-C) fired

export type StatusUpdate = {
  status: 'running' | 'done' | 'failed'
  summary?: string
  error?: string
  model_id?: string
  input_tokens?: number
  output_tokens?: number
}

/** The real outcome of `update_job_status`: what the MCP actually resolved the job to, not just whether the call itself errored. */
export type StatusOutcome = {
  ok: boolean
  message?: string
  status?: 'running' | 'done' | 'failed' | 'skipped'
  branch?: string | null
  pushedAt?: string | null
  error?: string | null
}

export type LogArgs = {
  storyId: string
  taskId: string
  content: string
  commitHash?: string
  commitMessage?: string
  status?: 'PASSED' | 'FAILED'
}

/** The harness's own channel to the scrum4me MCP. The model never sees these tools. */
export interface ControlChannel {
  waitForJob(waitSeconds: number, signal: AbortSignal): Promise<ClaimResult>
  /** false when the server refuses (claim lost, cancelled, terminal); rejects when the call itself failed. */
  heartbeat(jobId: string): Promise<boolean>
  updateStatus(jobId: string, input: StatusUpdate): Promise<StatusOutcome>
  updateTaskStatus(taskId: string, status: 'in_progress' | 'review' | 'todo'): Promise<{ ok: boolean; message?: string }>
  verifyTaskAgainstPlan(taskId: string, worktreePath: string): Promise<{ ok: boolean; result?: 'aligned' | 'partial' | 'empty' | 'divergent'; message?: string }>
  /** Best-effort: a tool error or a rejected call is logged (never thrown) and never blocks the caller. */
  log(kind: 'implementation' | 'commit' | 'test', args: LogArgs): Promise<void>
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const text = (res: unknown) => {
  const content = (res as { content?: unknown }).content
  return Array.isArray(content) ? flattenContent(content) : ''
}

/**
 * `requestTimeoutMs` overrides the wait_for_job request timeout (tests only). By default it is
 * waitSeconds + 30 s: the SDK would otherwise abort the long-poll after its 60 s default.
 */
export function createControlChannel(client: Client, opts: { requestTimeoutMs?: number } = {}): ControlChannel {
  return {
    async waitForJob(waitSeconds, signal) {
      if (signal.aborted) return { type: 'stopped' }
      let res
      try {
        res = await client.callTool(
          { name: 'wait_for_job', arguments: { wait_seconds: waitSeconds } },
          undefined,
          { timeout: opts.requestTimeoutMs ?? (waitSeconds + 30) * 1000, signal },
        )
      } catch (err) {
        // SDK 1.30.1 reports an abort through the signal as McpError RequestTimeout, so check the signal first.
        if (signal.aborted) return { type: 'stopped' }
        return { type: 'broken', message: message(err) }
      }
      const body = text(res)
      if (res.isError) return { type: 'error', message: body }
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        return { type: 'error', message: `wait_for_job gaf geen JSON: ${body.slice(0, 200)}` }
      }
      const p = parsed as { status?: unknown; job_id?: unknown; kind?: unknown }
      if (p?.status === 'timeout') return { type: 'timeout' }
      if (typeof p?.job_id === 'string' && typeof p.kind === 'string') return { type: 'job', jobId: p.job_id, kind: p.kind, payload: parsed }
      return { type: 'error', message: `wait_for_job gaf een onbekend antwoord: ${body.slice(0, 200)}` }
    },

    async heartbeat(jobId) {
      const res = await client.callTool({ name: 'job_heartbeat', arguments: { job_id: jobId } })
      return !res.isError
    },

    async updateStatus(jobId, input) {
      try {
        const res = await client.callTool({ name: 'update_job_status', arguments: { job_id: jobId, ...input } })
        if (res.isError) return { ok: false, message: text(res) }
        const body = text(res)
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          return { ok: true }
        }
        const p = parsed as { status?: unknown; branch?: unknown; pushed_at?: unknown; error?: unknown }
        return {
          ok: true,
          status: typeof p?.status === 'string' ? (p.status as StatusOutcome['status']) : undefined,
          branch: typeof p?.branch === 'string' || p?.branch === null ? (p.branch as string | null) : undefined,
          pushedAt: typeof p?.pushed_at === 'string' || p?.pushed_at === null ? (p.pushed_at as string | null) : undefined,
          error: typeof p?.error === 'string' || p?.error === null ? (p.error as string | null) : undefined,
        }
      } catch (err) {
        return { ok: false, message: message(err) }
      }
    },

    async updateTaskStatus(taskId, status) {
      try {
        const res = await client.callTool({ name: 'update_task_status', arguments: { task_id: taskId, status } })
        return res.isError ? { ok: false, message: text(res) } : { ok: true }
      } catch (err) {
        return { ok: false, message: message(err) }
      }
    },

    async verifyTaskAgainstPlan(taskId, worktreePath) {
      try {
        const res = await client.callTool({ name: 'verify_task_against_plan', arguments: { task_id: taskId, worktree_path: worktreePath } })
        if (res.isError) return { ok: false, message: text(res) }
        const body = text(res)
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          return { ok: true }
        }
        const p = parsed as { result?: unknown }
        const result = p?.result
        const valid = result === 'aligned' || result === 'partial' || result === 'empty' || result === 'divergent'
        return { ok: true, result: valid ? result : undefined }
      } catch (err) {
        return { ok: false, message: message(err) }
      }
    },

    async log(kind, args) {
      const toolName = kind === 'implementation' ? 'log_implementation' : kind === 'commit' ? 'log_commit' : 'log_test_result'
      const toolArgs: Record<string, unknown> = { story_id: args.storyId, task_id: args.taskId, content: args.content }
      if (kind === 'commit') {
        toolArgs.commit_hash = args.commitHash
        toolArgs.commit_message = args.commitMessage
      }
      if (kind === 'test') {
        toolArgs.status = args.status
      }
      try {
        const res = await client.callTool({ name: toolName, arguments: toolArgs })
        if (res.isError) console.error(`${toolName} mislukt: ${text(res)}`)
      } catch (err) {
        console.error(`${toolName} mislukt: ${message(err)}`)
      }
    },
  }
}
