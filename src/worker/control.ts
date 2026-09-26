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

/** The harness's own channel to the scrum4me MCP. The model never sees these tools. */
export interface ControlChannel {
  waitForJob(waitSeconds: number, signal: AbortSignal): Promise<ClaimResult>
  /** false when the server refuses (claim lost, cancelled, terminal); rejects when the call itself failed. */
  heartbeat(jobId: string): Promise<boolean>
  updateStatus(jobId: string, input: StatusUpdate): Promise<{ ok: boolean; message?: string }>
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
        return res.isError ? { ok: false, message: text(res) } : { ok: true }
      } catch (err) {
        return { ok: false, message: message(err) }
      }
    },
  }
}
