import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { flattenContent } from '../tools/registry.js'

export type ClaimResult =
  | { type: 'timeout' }
  | { type: 'job'; jobId: string; kind: string; payload: unknown }
  | { type: 'error'; message: string } // server gave a tool error; the connection is healthy
  | { type: 'runtime_mismatch' } // the MCP handed the claim back: this worker's runtime is not the job's (M45-2b); nothing to do for this job
  | { type: 'broken'; message: string } // SDK/transport failed; the connection is gone or a handler may still run
  | { type: 'stopped' } // the given signal (Ctrl-C) fired

export type StatusUpdate = {
  status: 'running' | 'done' | 'failed'
  summary?: string
  error?: string
  model_id?: string
  input_tokens?: number
  output_tokens?: number
  /** Measured by the provider (M45-2d): the cached part of the input and the thinking part of the output (never added to `output_tokens`). */
  cache_read_tokens?: number
  actual_thinking_tokens?: number
  /** What the job cost (M45-2d): `reported_cost_usd` is a decimal string, or null when there is no figure; `cost_source` says where it came from. */
  cost?: { reported_cost_usd: string | null; cost_source: 'provider_reported' | 'local' | 'none'; provider?: string }
}

/**
 * The real outcome of `update_job_status`: what the MCP actually resolved the job to, not just whether
 * the call itself errored. `unknown: true` marks the call itself as having thrown or timed out — the MCP
 * may still be processing it (and could still write a terminal status later) — which callers must treat
 * as distinct from `isError` (a definite refusal, `unknown` absent): sending a second terminal update in
 * response to an unknown outcome risks racing the MCP's own, possibly-still-pending, write (spec P12).
 */
export type StatusOutcome = {
  ok: boolean
  unknown?: boolean
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
  verifyTaskAgainstPlan(taskId: string, worktreePath: string): Promise<{ ok: boolean; unknown?: boolean; result?: 'aligned' | 'partial' | 'empty' | 'divergent'; message?: string }>
  /**
   * Best-effort: a tool error or a rejected call is never thrown; it comes back as `ok: false` so the caller
   * can report it through its own logger (the worker's `deps.log`).
   */
  log(kind: 'implementation' | 'commit' | 'test', args: LogArgs): Promise<{ ok: boolean; message?: string }>
}

/** The tool error text of `wait_for_job` for a claim whose job runtime differs from this worker's. */
export const RUNTIME_MISMATCH = 'RUNTIME_MISMATCH'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const text = (res: unknown) => {
  const content = (res as { content?: unknown }).content
  return Array.isArray(content) ? flattenContent(content) : ''
}

/**
 * `update_job_status` for a `done` request, and `verify_task_against_plan`, get this explicit request
 * timeout instead of the SDK's 60 s default (spec P12): the MCP's `done` handling can itself run long
 * (push, cascades), and a 60 s client timeout turning into a false refusal risks a second terminal
 * update racing the MCP's own possibly-still-pending write. `doneTimeoutMs`/`verifyTimeoutMs` override it
 * (tests only).
 */
const DONE_AND_VERIFY_TIMEOUT_MS = 300_000

/**
 * `requestTimeoutMs` overrides the wait_for_job request timeout (tests only). By default it is
 * waitSeconds + 30 s: the SDK would otherwise abort the long-poll after its 60 s default.
 */
export function createControlChannel(client: Client, opts: { requestTimeoutMs?: number; doneTimeoutMs?: number; verifyTimeoutMs?: number } = {}): ControlChannel {
  const doneTimeoutMs = opts.doneTimeoutMs ?? DONE_AND_VERIFY_TIMEOUT_MS
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? DONE_AND_VERIFY_TIMEOUT_MS
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
      // The MCP sets exactly this text, unchanged, in `content` (toolError); any other error text that merely contains it is an ordinary tool error.
      if (res.isError && body === RUNTIME_MISMATCH) return { type: 'runtime_mismatch' }
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
        // Only a 'done' request gets the long bound: 'running'/'failed' keep the SDK default so a
        // genuinely stuck connection is still detected promptly on those (non-terminal-conflict) paths.
        const callOpts = input.status === 'done' ? { timeout: doneTimeoutMs } : undefined
        const res = await client.callTool({ name: 'update_job_status', arguments: { job_id: jobId, ...input } }, undefined, callOpts)
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
        // A thrown call (including a client-side request timeout) is UNKNOWN, not a refusal: the MCP may
        // still be processing it. Only `res.isError` above is a definite REFUSED.
        return { ok: false, unknown: true, message: message(err) }
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
        const res = await client.callTool(
          { name: 'verify_task_against_plan', arguments: { task_id: taskId, worktree_path: worktreePath } },
          undefined,
          { timeout: verifyTimeoutMs },
        )
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
        // Same UNKNOWN/REFUSED distinction as updateStatus, for consistency; task-impl.ts's failPath
        // currently treats both as an ordinary (single, non-terminal-conflicting) failed update either way.
        return { ok: false, unknown: true, message: message(err) }
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
        return res.isError ? { ok: false, message: `${toolName} mislukt: ${text(res)}` } : { ok: true }
      } catch (err) {
        return { ok: false, message: `${toolName} mislukt: ${message(err)}` }
      }
    },
  }
}

export type StartCheck = { ok: true } | { ok: false; line: string }

/**
 * The start check (M45-2d): the MCP's `health` must list HARNESS in `runtimes`. An MCP release without M45-2b has no such
 * entry, or no field, or no `health` tool at all; it would register this worker under a runtime it does not know. A refusal
 * comes with the log line to print; the caller stops before any claim. A tool error, a missing tool and a reply that is not
 * JSON count as a refusal too. A call that throws (the connection is gone) is left to the caller, which knows whether it was lost.
 */
export async function checkHarnessRuntime(client: Client): Promise<StartCheck> {
  const refuse = (shown: string, why = ''): StartCheck => ({ ok: false, line: `STARTCHECK_FAILED: de MCP kent HARNESS niet (health.runtimes=${shown})${why}` })
  let res
  try {
    res = await client.callTool({ name: 'health', arguments: {} })
  } catch (err) {
    // The SDK throws for a tool the server does not have (older SDKs) and for a lost connection; only the first is a refusal here.
    if (err instanceof McpError && err.code === ErrorCode.MethodNotFound) return refuse('ontbrekend', `: geen health-tool (${message(err)})`)
    throw err
  }
  const body = text(res)
  if (res.isError) return refuse('ontbrekend', `: health gaf een toolfout (${body.slice(0, 200)})`)
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return refuse('ontbrekend', `: health gaf geen JSON (${body.slice(0, 200)})`)
  }
  const runtimes = (parsed as { runtimes?: unknown } | null)?.runtimes
  if (runtimes === undefined) return refuse('ontbrekend')
  if (!Array.isArray(runtimes) || !runtimes.includes('HARNESS')) return refuse(JSON.stringify(runtimes).slice(0, 200))
  return { ok: true }
}
