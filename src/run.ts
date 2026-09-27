import { createHash } from 'node:crypto'
import type { Manifest } from './manifest.js'
import { ModelError, type ModelClient } from './model-client.js'
import { createPolicy, type Policy } from './tools/policy.js'
import { RegistryError } from './tools/registry.js'
import { redactManifest, type RunResult, type TraceWriter } from './trace.js'
import type { ChatMessage, ErrorCode, RunStatus, ToolCall, ToolDef, ToolExecResult, ToolRegistry } from './types.js'

export type AfterAnswerResult =
  | { kind: 'accept' } // run ends as completed with this answer
  | { kind: 'retry'; message: string } // added as a user message; the loop continues
  | { kind: 'fail'; code: 'VERIFY_FAILED'; message: string } // run ends as failed

export type RunDeps = {
  client: ModelClient
  trace: TraceWriter
  /**
   * Closure bound by the CLI; called ONLY for profile 'tools'. It never exposes expanded secrets to this module.
   * The signal aborts when the run's deadline passes during MCP startup.
   */
  connectRegistry: (signal: AbortSignal) => Promise<ToolRegistry>
  now?: () => number
  /** Recorded on run_start when the CLI bypassed the probe gate. */
  probeSkipped?: boolean
  /** External stop (worker: Ctrl-C or lost job ownership). Ends the run as failed/HARNESS_ERROR 'aborted'. */
  signal?: AbortSignal
  /** Worker context recorded on run_start as `job`. */
  runStartExtra?: { jobId: string; ideaId: string }
  /**
   * Called when the model gives a final answer (no tool calls, finishReason !== 'length'). Runs within the same
   * deadline and within()-signal as everything else; an abort during the hook ends the run like a model abort
   * (ABORTED or timed_out). A 'retry' does not consume a turn itself — the next model call does, and the usual
   * maxTurns/context/output budgets apply to it as normal. Task 11 wires the verify gate through this hook.
   */
  afterAnswer?: (answer: string, signal: AbortSignal) => Promise<AfterAnswerResult>
}

type Terminal = { status: RunStatus; answer?: string; error?: { code: ErrorCode | 'HARNESS_ERROR'; message: string } }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const ABORTED: Terminal = { status: 'failed', error: { code: 'HARNESS_ERROR', message: 'aborted' } }

// Context bookkeeping (limits.contextTokens). Characters per token, measured on 114 turns of real tool runs (JSON of
// each message, spike 2026-09-27): p0 1.72, p50 3.06, p95 3.89. Added text counts at the dense end and removed text
// at the sparse end, so the estimate errs high on both sides.
const ADDED_CHARS_PER_TOKEN = 1.7
const REMOVED_CHARS_PER_TOKEN = 4
/** Below this much room a turn cannot produce anything useful. */
const MIN_TURN_TOKENS = 1024
const charsOf = (value: unknown) => JSON.stringify(value).length
const COMPACTED_NOTE = (bytes: number) =>
  `[earlier tool output of ${bytes} bytes was left out to stay within the context window; call the tool again if you still need it]`

function isCompacted(content: string): boolean {
  try {
    return (JSON.parse(content) as { compacted?: unknown }).compacted === true
  } catch {
    return false
  }
}

function compactedStub(content: string): string {
  let ok = true
  try {
    ok = (JSON.parse(content) as { ok?: unknown }).ok !== false
  } catch {
    // keep ok = true
  }
  return JSON.stringify({ compacted: true, ok, content: COMPACTED_NOTE(Buffer.byteLength(content)) })
}

/** Resolves with the value, or rejects when the signal aborts first (a late result is simply dropped). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        if (!signal.aborted) resolve(v)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/** Resolves with the connected registry, or rejects when the signal aborts first; a late registry is closed. */
function connectWithin(connect: Promise<ToolRegistry>, signal: AbortSignal): Promise<ToolRegistry> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('MCP startup exceeded the deadline'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    connect.then(
      (reg) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) void reg.close().catch(() => undefined)
        else resolve(reg)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

export async function runManifest(manifest: Manifest, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? Date.now
  const { limits } = manifest
  const started = now()
  const deadline = started + limits.maxWallSeconds * 1000
  const { trace, client } = deps
  const external = deps.signal
  const aborted = () => external?.aborted === true
  // The deadline and the external stop, as one signal for every model and tool call.
  const within = (ms: number) => {
    const timeout = AbortSignal.timeout(Math.max(1, ms))
    return external ? AbortSignal.any([timeout, external]) : timeout
  }

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
  let policy: Policy | undefined
  const seenCallIds = new Set<string>()
  // Last provider-reported prompt size and the message characters it was measured on; the estimate adds the change since.
  let calibration: { tokens: number; chars: number } | undefined
  // Characters taken out by compaction since that measurement.
  let removedChars = 0

  trace.event({
    type: 'run_start', manifest: redactManifest(manifest),
    ...(deps.probeSkipped ? { probeSkipped: true } : {}),
    ...(deps.runStartExtra ? { job: deps.runStartExtra } : {}),
  })

  const executeCall = async (call: ToolCall, signal: AbortSignal): Promise<ToolExecResult> => {
    if (!registry || !policy) {
      return { ok: false, errorCode: 'UNKNOWN_TOOL', content: `tool ${call.name} is not available in profile ${manifest.profile}`, truncated: false }
    }
    const decision = policy.check(call)
    if (!decision.ok) return { ok: false, errorCode: decision.errorCode, content: decision.message, truncated: false }
    return registry.execute(decision.name, decision.args, signal)
  }

  const loop = async (): Promise<Terminal> => {
    if (manifest.profile === 'tools') {
      if (aborted()) return ABORTED
      const connectSignal = within(deadline - now())
      try {
        registry = await connectWithin(deps.connectRegistry(connectSignal), connectSignal)
      } catch (err) {
        if (aborted()) return ABORTED
        if (connectSignal.aborted || now() >= deadline) return { status: 'timed_out' }
        const message = err instanceof RegistryError ? err.message : `MCP server unavailable: ${err instanceof Error ? err.message : String(err)}`
        return { status: 'failed', error: { code: 'TOOL_NOT_AVAILABLE', message } }
      }
      policy = createPolicy(registry.snapshot)
      snapshotHash = registry.snapshot.hash
      trace.event({ type: 'tool_snapshot', names: registry.snapshot.entries.map((e) => e.name), hash: snapshotHash })
    }
    const tools: ToolDef[] = registry ? registry.toOpenAiTools() : []
    const messages: ChatMessage[] = []
    if (manifest.system) messages.push({ role: 'system', content: manifest.system })
    messages.push({ role: 'user', content: manifest.prompt })
    const toolsChars = tools.length > 0 ? charsOf(tools) : 0

    const estimate = (): number => {
      if (!calibration) return Math.ceil((charsOf(messages) + toolsChars) / ADDED_CHARS_PER_TOKEN)
      const added = Math.max(0, charsOf(messages) + removedChars - calibration.chars)
      return calibration.tokens + Math.ceil(added / ADDED_CHARS_PER_TOKEN) - Math.floor(removedChars / REMOVED_CHARS_PER_TOKEN)
    }

    /**
     * Keeps the next prompt plus an output reserve inside contextTokens by replacing the oldest tool results with a
     * stub. Results the model has not seen yet (after the last assistant message) stay. Returns the room left for
     * output, or undefined when there is no window to respect.
     */
    const fitContext = (maxTokens: number): number | undefined => {
      const window = limits.contextTokens
      if (window === undefined) return undefined
      const reserve = Math.min(maxTokens, Math.floor(window / 4))
      const before = estimate()
      if (before + reserve <= window) return window - before
      let lastAssistant = messages.length - 1
      while (lastAssistant >= 0 && messages[lastAssistant].role !== 'assistant') lastAssistant--
      let count = 0
      let bytes = 0
      for (let i = 0; i < lastAssistant && estimate() + reserve > window; i++) {
        const m = messages[i]
        if (m.role !== 'tool' || isCompacted(m.content)) continue
        bytes += Buffer.byteLength(m.content)
        const stubbed = { ...m, content: compactedStub(m.content) }
        removedChars += charsOf(m) - charsOf(stubbed)
        messages[i] = stubbed
        count++
      }
      const after = estimate()
      if (count > 0) trace.event({ type: 'context_compacted', turn: turns + 1, messages: count, bytes, estimateBefore: before, estimateAfter: after })
      return window - after
    }

    for (;;) {
      if (aborted()) return ABORTED
      if (turns + 1 > limits.maxTurns) return { status: 'budget_exceeded' }
      if (now() >= deadline) return { status: 'timed_out' }
      let maxTokens = limits.maxOutputTokens - outputTokens
      if (maxTokens <= 0) return { status: 'budget_exceeded' }
      const room = fitContext(maxTokens)
      if (room !== undefined) {
        if (room < MIN_TURN_TOKENS) {
          return {
            status: 'budget_exceeded',
            error: { code: 'CONTEXT_EXHAUSTED', message: `prompt of ~${estimate()} tokens leaves ${room} of contextTokens=${limits.contextTokens}` },
          }
        }
        maxTokens = Math.min(maxTokens, room)
      }
      turns++

      trace.event({
        type: 'model_request', turn: turns, messages: messages.length, tools: tools.length, maxTokens,
        ...(limits.contextTokens !== undefined ? { promptEstimate: estimate() } : {}),
      })
      const signal = within(deadline - now())
      const charsAtRequest = charsOf(messages)
      let res
      try {
        res = await client.complete(messages, { signal, maxTokens, tools })
      } catch (err) {
        if (aborted()) return ABORTED
        if (signal.aborted || now() >= deadline) return { status: 'timed_out' }
        if (err instanceof ModelError) return { status: 'failed', error: { code: 'MODEL_ERROR', message: err.message } }
        throw err
      }
      responses++
      if (res.model) reportedModel = res.model
      if (res.usage.source === 'provider_reported') {
        calibration = { tokens: res.usage.inputTokens, chars: charsAtRequest }
        removedChars = 0
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
        const answerText = res.message.content ?? ''
        if (!deps.afterAnswer) return { status: 'completed', answer: answerText }
        if (aborted()) return ABORTED
        if (now() >= deadline) return { status: 'timed_out' }
        const hookSignal = within(deadline - now())
        let hookResult: AfterAnswerResult
        try {
          hookResult = await raceAbort(deps.afterAnswer(answerText, hookSignal), hookSignal)
        } catch (err) {
          if (aborted()) return ABORTED
          if (hookSignal.aborted || now() >= deadline) return { status: 'timed_out' }
          throw err
        }
        trace.event({ type: 'after_answer', turn: turns, outcome: hookResult.kind })
        if (hookResult.kind === 'accept') return { status: 'completed', answer: answerText }
        if (hookResult.kind === 'fail') return { status: 'failed', error: { code: hookResult.code, message: hookResult.message } }
        messages.push({ role: 'user', content: hookResult.message })
        continue
      }

      // Assign unique call ids: the model may omit them or repeat them.
      const calls = res.message.toolCalls.map((c, i) => {
        let id = c.id
        if (!id || seenCallIds.has(id)) {
          id = `call_${turns}_${i}`
          for (let n = 1; seenCallIds.has(id); n++) id = `call_${turns}_${i}_${n}`
        }
        seenCallIds.add(id)
        return { ...c, id }
      })
      messages.push({ role: 'assistant', content: res.message.content, tool_calls: calls })

      for (const call of calls) {
        if (aborted()) return ABORTED
        if (now() >= deadline) return { status: 'timed_out' }
        toolCalls++
        trace.event({ type: 'tool_call', callId: call.id, name: call.name, arguments: call.arguments, argumentsWasObject: call.argumentsWasObject })
        const toolSignal = within(deadline - now())
        const r = await executeCall(call, toolSignal)
        if (r.errorCode === 'TOOL_TIMEOUT' && aborted()) {
          recordToolResult(call.id, r)
          return ABORTED
        }
        if (r.errorCode === 'TOOL_TIMEOUT' && (toolSignal.aborted || now() >= deadline)) {
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

  // Spec §7: tools/<callId>.txt holds the full content; the model only ever sees the truncated text.
  const recordToolResult = (callId: string, r: ToolExecResult) => {
    const full = r.fullContent ?? r.content
    trace.toolContent(callId, full)
    trace.event({
      type: 'tool_result', callId, ok: r.ok, ...(r.errorCode ? { errorCode: r.errorCode } : {}),
      truncated: r.truncated, sha256: sha256(full), bytes: Buffer.byteLength(full),
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
