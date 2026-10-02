import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ErrorCode, RunStatus, ToolCall, Usage } from './types.js'

export type TraceEvent =
  | { type: 'run_start'; manifest: unknown; probeSkipped?: boolean; job?: { jobId: string; ideaId?: string; taskId?: string } } // manifest after redactManifest
  | { type: 'tool_snapshot'; names: string[]; hash: string }
  | { type: 'model_request'; turn: number; messages: number; tools: number; maxTokens: number; promptEstimate?: number }
  | { type: 'context_compacted'; turn: number; messages: number; bytes: number; estimateBefore: number; estimateAfter: number }
  | { type: 'model_response'; turn: number; content: string | null; toolCalls: ToolCall[]; finishReason: string; usage: Usage; reasoning?: string; durationMs: number; systemFingerprint?: string; provider?: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string; argumentsWasObject: boolean }
  | { type: 'tool_result'; callId: string; ok: boolean; errorCode?: ErrorCode; truncated: boolean; sha256: string; bytes: number }
  | { type: 'after_answer'; turn: number; outcome: 'accept' | 'retry' | 'fail' }
  // Written by the Task 11 task handler on the same trace as the run (prepare/verify containers around the gate).
  // `hidden_check` is the container of the task-bench's hidden test run, and `clean_install` the prepare container that installs the
  // dependencies on a pristine tree right before it; only the bench has them (src/bench/task-bench.ts).
  | { type: 'container'; kind: 'prepare' | 'verify'; source: 'prepare' | 'run_tests' | 'gate' | 'hidden_check' | 'clean_install'; n: number; exitCode: number | null; timedOut: boolean; durationMs: number; outputBytes: number }
  // The task-bench retried a model request after a temporary failure (src/bench/retry-client.ts); the fields are those of its RetryRecord.
  | { type: 'model_retry'; attempt: number; kind: string; status?: number; bodyCode?: number; costUsd?: number }
  | { type: 'run_end'; status: RunStatus; error?: { code: ErrorCode | 'HARNESS_ERROR'; message: string } }

// Exact spec §4.
export type RunResult = {
  runId: string
  status: RunStatus
  answer?: string
  error?: { code: string; message: string }
  model: { name: string; baseUrl: string; reported?: string }
  usage: {
    source: 'provider_reported' | 'missing'
    inputTokens: number
    outputTokens: number
    turns: number
    toolCalls: number
    toolErrors: number
    // The three below are sums over the responses that reported the field, and absent when no response did.
    cachedTokens?: number
    costUsd?: number
    // Part of outputTokens (the fixture: 27 of its 44), not on top of it: never add it to outputTokens.
    reasoningTokens?: number
  }
  durationMs: number
  toolSnapshotHash?: string
}

export interface TraceWriter {
  readonly dir: string
  event(e: TraceEvent): void
  toolContent(callId: string, text: string): void
  containerOutput(n: number, text: string): void
  result(r: RunResult): void
}

// Call ids can come from the model; never let one pick a path outside tools/.
function safeFileName(callId: string): string {
  const cleaned = callId.replace(/[^A-Za-z0-9_-]/g, '_')
  return cleaned.length > 0 ? cleaned.slice(0, 120) : '_'
}

export function openTrace(outDir: string, runId: string): TraceWriter {
  const dir = join(outDir, runId)
  if (existsSync(dir)) throw new Error(`run dir already exists: ${dir}`)
  mkdirSync(outDir, { recursive: true })
  mkdirSync(dir) // non-recursive: fails if a concurrent run created it first
  const tracePath = join(dir, 'trace.jsonl')
  return {
    dir,
    event(e) {
      appendFileSync(tracePath, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n')
    },
    toolContent(callId, text) {
      const toolsDir = join(dir, 'tools')
      mkdirSync(toolsDir, { recursive: true })
      writeFileSync(join(toolsDir, `${safeFileName(callId)}.txt`), text)
    },
    containerOutput(n, text) {
      const containersDir = join(dir, 'containers')
      mkdirSync(containersDir, { recursive: true })
      writeFileSync(join(containersDir, `${n}.txt`), text)
    },
    result(r) {
      writeFileSync(join(dir, 'result.json'), JSON.stringify(r, null, 2) + '\n')
    },
  }
}

/** Drops model.apiKey and replaces every tools.server.env value with '<redacted>'. Pure. */
export function redactManifest(m: unknown): unknown {
  const copy = structuredClone(m) as { model?: Record<string, unknown>; tools?: { server?: { env?: Record<string, unknown> } } }
  if (copy && typeof copy === 'object') {
    if (copy.model && typeof copy.model === 'object') delete copy.model.apiKey
    const env = copy.tools?.server?.env
    if (env && typeof env === 'object') {
      for (const k of Object.keys(env)) env[k] = '<redacted>'
    }
  }
  return copy
}
