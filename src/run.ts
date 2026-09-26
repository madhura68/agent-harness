import { createHash } from 'node:crypto'
import type { Manifest } from './manifest.js'
import { ModelError, type ModelClient } from './model-client.js'
import { redactManifest, type RunResult, type TraceWriter } from './trace.js'
import type { ChatMessage, ErrorCode, RunStatus, ToolCall, ToolDef, ToolExecResult, ToolRegistry } from './types.js'

export type RunDeps = {
  client: ModelClient
  trace: TraceWriter
  /** Closure bound by the CLI; called ONLY for profile 'tools'. It never exposes expanded secrets to this module. */
  connectRegistry: () => Promise<ToolRegistry>
  now?: () => number
  /** Recorded on run_start when the CLI bypassed the probe gate. */
  probeSkipped?: boolean
}

type Terminal = { status: RunStatus; answer?: string; error?: { code: ErrorCode | 'HARNESS_ERROR'; message: string } }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export async function runManifest(manifest: Manifest, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? Date.now
  const { limits } = manifest
  const started = now()
  const deadline = started + limits.maxWallSeconds * 1000
  const { trace, client } = deps

  let turns = 0
  let toolCalls = 0
  let toolErrors = 0
  let inputTokens = 0
  let outputTokens = 0
  let usageComplete = true
  let responses = 0
  let reportedModel: string | undefined
  let snapshotHash: string | undefined
  let registry: ToolRegistry | undefined
  const seenCallIds = new Set<string>()

  trace.event({ type: 'run_start', manifest: redactManifest(manifest), ...(deps.probeSkipped ? { probeSkipped: true } : {}) })

  const executeCall = async (call: ToolCall, _signal: AbortSignal): Promise<ToolExecResult> => {
    return { ok: false, errorCode: 'UNKNOWN_TOOL', content: `tool ${call.name} is not available`, truncated: false }
  }

  const loop = async (): Promise<Terminal> => {
    if (manifest.profile === 'tools') {
      registry = await deps.connectRegistry()
      snapshotHash = registry.snapshot.hash
      trace.event({ type: 'tool_snapshot', names: registry.snapshot.entries.map((e) => e.name), hash: snapshotHash })
    }
    const tools: ToolDef[] = registry ? registry.toOpenAiTools() : []
    const messages: ChatMessage[] = []
    if (manifest.system) messages.push({ role: 'system', content: manifest.system })
    messages.push({ role: 'user', content: manifest.prompt })

    for (;;) {
      if (turns + 1 > limits.maxTurns) return { status: 'budget_exceeded' }
      if (now() >= deadline) return { status: 'timed_out' }
      const maxTokens = limits.maxOutputTokens - outputTokens
      if (maxTokens <= 0) return { status: 'budget_exceeded' }
      turns++

      trace.event({ type: 'model_request', turn: turns, messages: messages.length, tools: tools.length, maxTokens })
      const signal = AbortSignal.timeout(Math.max(1, deadline - now()))
      let res
      try {
        res = await client.complete(messages, { signal, maxTokens, tools })
      } catch (err) {
        if (signal.aborted || now() >= deadline) return { status: 'timed_out' }
        if (err instanceof ModelError) return { status: 'failed', error: { code: 'MODEL_ERROR', message: err.message } }
        throw err
      }
      responses++
      if (res.model) reportedModel = res.model
      if (res.usage.source === 'provider_reported') {
        inputTokens += res.usage.inputTokens
        outputTokens += res.usage.outputTokens
      } else {
        usageComplete = false
      }
      trace.event({
        type: 'model_response', turn: turns, content: res.message.content, toolCalls: res.message.toolCalls,
        finishReason: res.finishReason, usage: res.usage,
      })

      if (outputTokens > limits.maxOutputTokens) return { status: 'budget_exceeded' }
      if (res.message.toolCalls.length === 0) {
        if (res.finishReason === 'length') return { status: 'budget_exceeded' }
        return { status: 'completed', answer: res.message.content ?? '' }
      }

      // Assign unique call ids: the model may omit them or repeat them.
      const calls = res.message.toolCalls.map((c, i) => {
        const id = c.id && !seenCallIds.has(c.id) ? c.id : `call_${turns}_${i}`
        seenCallIds.add(id)
        return { ...c, id }
      })
      messages.push({ role: 'assistant', content: res.message.content, tool_calls: calls })

      for (const call of calls) {
        if (now() >= deadline) return { status: 'timed_out' }
        toolCalls++
        trace.event({ type: 'tool_call', callId: call.id, name: call.name, arguments: call.arguments, argumentsWasObject: call.argumentsWasObject })
        const toolSignal = AbortSignal.timeout(Math.max(1, deadline - now()))
        const r = await executeCall(call, toolSignal)
        if (r.errorCode === 'TOOL_TIMEOUT' && now() >= deadline) {
          recordToolResult(call.id, r)
          return { status: 'timed_out' }
        }
        recordToolResult(call.id, r)
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ ok: r.ok, ...(r.errorCode ? { errorCode: r.errorCode } : {}), content: r.content, truncated: r.truncated }),
        })
        if (!r.ok) {
          toolErrors++
          if (toolErrors > limits.maxToolErrors) {
            return { status: 'failed', error: { code: 'TOO_MANY_TOOL_ERRORS', message: `${toolErrors} tool errors exceed maxToolErrors=${limits.maxToolErrors}` } }
          }
        }
      }
    }
  }

  const recordToolResult = (callId: string, r: ToolExecResult) => {
    trace.toolContent(callId, r.content)
    trace.event({
      type: 'tool_result', callId, ok: r.ok, ...(r.errorCode ? { errorCode: r.errorCode } : {}),
      truncated: r.truncated, sha256: sha256(r.content), bytes: Buffer.byteLength(r.content),
    })
  }

  let terminal: Terminal
  try {
    terminal = await loop()
  } catch (err) {
    terminal = { status: 'failed', error: { code: 'HARNESS_ERROR', message: err instanceof Error ? err.message : String(err) } }
  } finally {
    if (registry) await registry.close().catch(() => undefined)
  }

  trace.event({ type: 'run_end', status: terminal.status, ...(terminal.error ? { error: terminal.error } : {}) })
  const result: RunResult = {
    runId: manifest.id,
    status: terminal.status,
    ...(terminal.status === 'completed' ? { answer: terminal.answer ?? '' } : {}),
    ...(terminal.error ? { error: terminal.error } : {}),
    model: { name: manifest.model.name, baseUrl: manifest.model.baseUrl, ...(reportedModel ? { reported: reportedModel } : {}) },
    usage: {
      source: responses > 0 && usageComplete ? 'provider_reported' : 'missing',
      inputTokens, outputTokens, turns, toolCalls, toolErrors,
    },
    durationMs: now() - started,
    ...(snapshotHash ? { toolSnapshotHash: snapshotHash } : {}),
  }
  trace.result(result)
  return result
}
