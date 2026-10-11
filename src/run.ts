import { createHash } from 'node:crypto'
import type { CostStop } from './cost.js'
import type { Manifest } from './manifest.js'
import { ModelError, type ModelClient } from './model-client.js'
import { createPolicy, type Policy } from './tools/policy.js'
import { RegistryError } from './tools/registry.js'
import { redactManifest, type RunResult, type TraceWriter } from './trace.js'
import type { ChatMessage, CompleteResult, ErrorCode, RunStatus, ToolCall, ToolDef, ToolExecResult, ToolRegistry } from './types.js'

export type AfterAnswerResult =
  | { kind: 'accept' } // run ends as completed with this answer
  | { kind: 'retry'; message: string } // added as a user message; the loop continues
  | { kind: 'fail'; code: 'VERIFY_FAILED'; message: string } // run ends as failed

/**
 * The cost ceiling of a run (M45-2d). The worker passes the guard of the job; a run without one (the CLI) has no ceiling. A stop is the
 * terminal result of the run, `failed` with COST_LIMIT_EXCEEDED or COST_UNKNOWN; the amounts are the guard's own, exact ones.
 */
export type CostGuardHooks = {
  /** Before a model call; the guard decides whether the total has reached the ceiling (the first call is never stopped). */
  beforeRequest(): CostStop | undefined
  /** With the whole model response, after its usage was processed: adds its cost, and stops on an unknown cost or, when the response asks for tools, a reached ceiling. */
  afterResponse(res: CompleteResult): CostStop | undefined
}

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
  runStartExtra?: { jobId: string; ideaId?: string; taskId?: string; chatId?: string }
  /**
   * Called when the model gives a final answer (no tool calls, finishReason !== 'length'). Runs within the same
   * deadline and within()-signal as everything else; an abort during the hook ends the run like a model abort
   * (ABORTED or timed_out). A 'retry' does not consume a turn itself — the next model call does, and the usual
   * maxTurns/context/output budgets apply to it as normal. Task 11 wires the verify gate through this hook.
   */
  afterAnswer?: (answer: string, signal: AbortSignal) => Promise<AfterAnswerResult>
  costGuard?: CostGuardHooks
  /**
   * Repeat a model call once when it fails with a storing: a network error, an error body in a 200, HTTP 429 or HTTP >= 500. Never after
   * another failure, an abort or the deadline, and never a second time. The worker sets it for a hosted configuration only; a retry
   * changes no total, so the check before it is the one at the top of the loop.
   */
  retryOnce?: boolean
  /**
   * Opt-in budget of a chat run (M50-1b, decision 4). Without it `runManifest` behaves exactly as before. With it: the tool messages of the
   * run together stay within `toolChars` characters (each as it goes to the model, a batch reserving STUB_MAX per call); what does not fit
   * is cut off or answered with TOOL_BUDGET; one closing call without tools follows when the budget, the turns or the output tokens run
   * out; and a call with tools gets `closingReserve` output tokens less than what is left, which is kept for the closing call.
   */
  chatBudget?: ChatBudget
}

export type ChatBudget = { toolChars: number; closingReserve: number }

/** Why the one closing call of a chat run was made (the `reason` of the `closing_call` trace event). */
export type ClosingReason = 'tool_budget' | 'batch_dropped' | 'max_turns' | 'output_budget' | 'length'

type Terminal = { status: RunStatus; answer?: string; error?: { code: ErrorCode | 'HARNESS_ERROR'; message: string } }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** A failure that a repeat can cure (spec §4): the provider or the network, not the request. */
function isStoring(err: ModelError): boolean {
  const d = err.detail
  if (!d) return false
  if (d.kind === 'network' || d.kind === 'error_body') return true
  return d.kind === 'http' && d.status !== undefined && (d.status === 429 || d.status >= 500)
}

const ABORTED: Terminal = { status: 'failed', error: { code: 'HARNESS_ERROR', message: 'aborted' } }

// Context bookkeeping (limits.contextTokens). Characters per token, measured on 114 turns of real tool runs (JSON of
// each message, spike 2026-09-27): p0 1.72, p50 3.06, p95 3.89. Added text counts at the dense end and removed text
// at the sparse end, so the estimate errs high on both sides.
export const ADDED_CHARS_PER_TOKEN = 1.7
const REMOVED_CHARS_PER_TOKEN = 4
/** Below this much room a turn cannot produce anything useful. */
const MIN_TURN_TOKENS = 1024
export const charsOf = (value: unknown) => JSON.stringify(value).length
/** chatBudget: the most a TOOL_BUDGET message may take, and the room below which a call is not executed but answered with it. */
const STUB_MAX = 160
const MIN_TOOL_ROOM = 360
const TOOL_BUDGET_TEXT = 'de leesruimte is op; antwoord met wat je hebt'
const TRUNCATION_NOTE = '\nafgekapt; vraag een sectie op met `heading`'
const CLOSING_PROMPT = 'Je kunt geen tools meer gebruiken. Antwoord nu met wat je hebt.'

/** The tool message as the model gets it: the serialised result. */
const toolMessageContent = (r: Pick<ToolExecResult, 'ok' | 'errorCode' | 'content' | 'truncated'>) =>
  JSON.stringify({ ok: r.ok, ...(r.errorCode ? { errorCode: r.errorCode } : {}), content: r.content, truncated: r.truncated })

/**
 * The tool message of `r` within `room` characters of serialised message. A result that does not fit is cut off (truncated: true, with a
 * note); the cut is found by binary search on the length of the serialised message, so escapes count. `room` must hold the note.
 */
function fitToolMessage(r: ToolExecResult, room: number): { message: string; cut: boolean } {
  const whole = toolMessageContent(r)
  if (whole.length <= room) return { message: whole, cut: false }
  const messageFor = (n: number) => toolMessageContent({ ...r, content: r.content.slice(0, n) + TRUNCATION_NOTE, truncated: true })
  let lo = 0
  let hi = r.content.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (messageFor(mid).length <= room) lo = mid
    else hi = mid - 1
  }
  // No guard against a cut inside a surrogate pair is needed: JSON.stringify writes a lone half as a 6-character escape, so the message
  // with the whole pair is shorter than the one with its first half. If the one fits, so does the other, and the search never stops on a split.
  return { message: messageFor(lo), cut: true }
}

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
export function connectWithin(connect: Promise<ToolRegistry>, signal: AbortSignal): Promise<ToolRegistry> {
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
  // Each stays undefined until a response reports the field: a response without it (Ollama has no cost) adds nothing.
  let cachedTokens: number | undefined
  let costUsd: number | undefined
  let reasoningTokens: number | undefined
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
    if (manifest.history) messages.push(...manifest.history)
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

    // chatBudget: characters of tool messages in the transcript, and the reason of the closing call that must come next.
    const chat = deps.chatBudget
    let toolSpent = 0
    let closing: ClosingReason | undefined

    for (;;) {
      if (aborted()) return ABORTED
      const overCeiling = deps.costGuard?.beforeRequest()
      if (overCeiling) return overCeiling
      // The closing call is one extra turn: it may go past maxTurns.
      if (turns + 1 > limits.maxTurns) {
        if (!chat) return { status: 'budget_exceeded' }
        closing ??= 'max_turns'
      }
      if (now() >= deadline) return { status: 'timed_out' }
      let maxTokens = limits.maxOutputTokens - outputTokens
      if (maxTokens <= 0) return { status: 'budget_exceeded' }
      if (chat && !closing) {
        // maxOutputTokens counts per run: a call with tools leaves the reserve for the closing call.
        if (maxTokens - chat.closingReserve < MIN_TURN_TOKENS) closing = 'output_budget'
        else maxTokens -= chat.closingReserve
      }
      if (closing) messages.push({ role: 'user', content: CLOSING_PROMPT })
      const callTools = closing ? [] : tools
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

      if (closing) trace.event({ type: 'closing_call', reason: closing })
      trace.event({
        type: 'model_request', turn: turns, messages: messages.length, tools: callTools.length, maxTokens,
        ...(limits.contextTokens !== undefined ? { promptEstimate: estimate() } : {}),
      })
      const signal = within(deadline - now())
      const charsAtRequest = charsOf(messages)
      let res
      for (let attempt = 1; ; attempt++) {
        try {
          res = await client.complete(messages, { signal, maxTokens, tools: callTools })
          break
        } catch (err) {
          if (aborted()) return ABORTED
          if (signal.aborted || now() >= deadline) return { status: 'timed_out' }
          if (!(err instanceof ModelError)) throw err
          if (deps.retryOnce && attempt === 1 && isStoring(err)) {
            trace.event({ type: 'model_retry', attempt, kind: err.detail?.kind ?? 'unknown', ...(err.detail?.status !== undefined ? { status: err.detail.status } : {}) })
            continue
          }
          return { status: 'failed', error: { code: 'MODEL_ERROR', message: err.message } }
        }
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
      if (typeof res.usage.cachedTokens === 'number') cachedTokens = (cachedTokens ?? 0) + res.usage.cachedTokens
      if (typeof res.usage.costUsd === 'number') costUsd = (costUsd ?? 0) + res.usage.costUsd
      if (typeof res.usage.reasoningTokens === 'number') reasoningTokens = (reasoningTokens ?? 0) + res.usage.reasoningTokens
      trace.event({
        type: 'model_response', turn: turns, content: res.message.content, toolCalls: res.message.toolCalls,
        finishReason: res.finishReason, usage: res.usage, durationMs: res.durationMs,
        ...(res.reasoning !== undefined ? { reasoning: res.reasoning } : {}),
        ...(res.systemFingerprint !== undefined ? { systemFingerprint: res.systemFingerprint } : {}),
        ...(res.provider !== undefined ? { provider: res.provider } : {}),
      })
      // After the usage and before anything the response asks for: an unknown cost, or a reached ceiling with tools still to run, ends the run here.
      // The closing call is answered without tools whatever it asks for, so a reached ceiling does not stop it; an unknown cost still does.
      const costStop = deps.costGuard?.afterResponse(closing ? { ...res, message: { ...res.message, toolCalls: [] } } : res)
      if (costStop) return costStop

      if (closing) {
        // The last word: any text is the answer (also one cut off by the token limit); tool calls in it are not executed.
        const closingText = res.message.content ?? ''
        return closingText.trim() === '' ? { status: 'budget_exceeded' } : { status: 'completed', answer: closingText }
      }
      if (outputTokens > limits.maxOutputTokens) return { status: 'budget_exceeded' }
      if (res.message.toolCalls.length === 0) {
        if (res.finishReason === 'length') {
          if (!chat) return { status: 'budget_exceeded' }
          messages.push({ role: 'assistant', content: res.message.content ?? '' }) // like the retry below: some servers refuse content null without tool_calls
          // The cost ceiling stays a hard limit: if this answer itself reached it, beforeRequest stops the closing call (COST_LIMIT_EXCEEDED).
          closing = 'length'
          continue
        }
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
        // The rejected answer must stay in the transcript: without it the model never sees what it said, and two
        // user turns in a row (the previous turn plus this retry) is a shape some OpenAI-compatible servers reject.
        messages.push({ role: 'assistant', content: answerText })
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
      if (chat && chat.toolChars - toolSpent < calls.length * STUB_MAX) {
        // Not even a stub per call fits: the batch stays out of the transcript (an assistant message with tool_calls needs every answer).
        closing = 'batch_dropped'
        continue
      }
      messages.push({ role: 'assistant', content: res.message.content, tool_calls: calls })

      for (const [index, call] of calls.entries()) {
        if (aborted()) return ABORTED
        if (now() >= deadline) return { status: 'timed_out' }
        toolCalls++
        trace.event({ type: 'tool_call', callId: call.id, name: call.name, arguments: call.arguments, argumentsWasObject: call.argumentsWasObject })
        // Room for this call: what is left, minus a stub for each later call of the batch.
        const toolRoom = chat ? chat.toolChars - toolSpent - (calls.length - index - 1) * STUB_MAX : Infinity
        if (chat && toolRoom < MIN_TOOL_ROOM) {
          const stub: ToolExecResult = { ok: false, errorCode: 'TOOL_BUDGET', content: TOOL_BUDGET_TEXT, truncated: false }
          recordToolResult(call.id, stub, false)
          const stubMessage = toolMessageContent(stub)
          toolSpent += stubMessage.length
          messages.push({ role: 'tool', tool_call_id: call.id, content: stubMessage })
          closing = 'tool_budget'
          continue // not a tool error: it does not count towards maxToolErrors
        }
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
        const fitted = chat ? fitToolMessage(r, toolRoom) : { message: toolMessageContent(r), cut: false }
        const toolMessage = fitted.message
        recordToolResult(call.id, r, fitted.cut)
        toolSpent += toolMessage.length
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolMessage })
        if (!r.ok) {
          toolErrors++
          if (toolErrors > limits.maxToolErrors) {
            return { status: 'failed', error: { code: 'TOO_MANY_TOOL_ERRORS', message: `${toolErrors} tool errors exceed maxToolErrors=${limits.maxToolErrors}` } }
          }
        }
      }
      if (chat && !closing && chat.toolChars - toolSpent < MIN_TOOL_ROOM) closing = 'tool_budget'
    }
  }

  // Spec §7: tools/<callId>.txt holds the full content; the model only ever sees the truncated text.
  // `cut`: the chat budget cut the content off, so the model saw truncated: true (the trace says so too).
  const recordToolResult = (callId: string, r: ToolExecResult, cut = false) => {
    const full = r.fullContent ?? r.content
    trace.toolContent(callId, full)
    trace.event({
      type: 'tool_result', callId, ok: r.ok, ...(r.errorCode ? { errorCode: r.errorCode } : {}),
      truncated: r.truncated || cut, sha256: sha256(full), bytes: Buffer.byteLength(full),
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
      ...(cachedTokens !== undefined ? { cachedTokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    },
    durationMs: now() - started,
    ...(snapshotHash ? { toolSnapshotHash: snapshotHash } : {}),
  }
  trace.result(result)
  return result
}
