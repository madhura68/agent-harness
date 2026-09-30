import { Agent, fetch } from 'undici'
import type { ChatMessage, CompleteResult, ToolCall, ToolDef, Usage } from './types.js'

export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
/** reasoningEffort goes out as OpenAI `reasoning_effort`; Ollama's /v1 turns thinking off with 'none' (its `think` field is ignored there). */
/**
 * headersTimeoutMs: transport timeout for headers and body; unset = none. With stream:false the headers only arrive
 * after the whole generation, and undici's 300 s default cut off long thinking turns. The run deadline (the signal)
 * bounds every request anyway.
 */
export type ModelClientOptions = {
  baseUrl: string
  name: string
  apiKey?: string
  reasoningEffort?: ReasoningEffort
  /**
   * Extra request fields (temperature, seed, a provider block, a reasoning object). They are merged underneath the
   * client's own fields, so model, messages, max_tokens, stream, tools and reasoning_effort keep the client's value
   * whenever the client sets one. Reserved keys are refused where the config is loaded (assertExtraBody in manifest.ts).
   */
  extraBody?: Record<string, unknown>
  headersTimeoutMs?: number
  now?: () => number // test seam for durationMs; defaults to Date.now
}
export type CompleteOptions = { signal: AbortSignal; maxTokens: number; tools?: ToolDef[] }
export type ModelClient = { complete(messages: ChatMessage[], options: CompleteOptions): Promise<CompleteResult> }

export class ModelError extends Error {
  readonly code = 'MODEL_ERROR' as const
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ModelError'
  }
}

/** 0 disables undici's timeout. */
export function transportTimeouts(opts: Pick<ModelClientOptions, 'headersTimeoutMs'>): { headersTimeout: number; bodyTimeout: number } {
  const ms = opts.headersTimeoutMs ?? 0
  return { headersTimeout: ms, bodyTimeout: ms }
}

const FINISH_REASONS = new Set(['stop', 'length', 'tool_calls'])

// Same floor as worker/redact.ts: a shorter value is a placeholder (Ollama takes any string), and masking it would mangle ordinary text.
const MIN_MASKED_KEY_LENGTH = 8

/**
 * Replaces every occurrence of the key with '<redacted>'. The key without surrounding whitespace counts too: undici
 * trims a header value before sending it, so that is the form a server echoes. Each form needs 8 characters; without
 * a key, or with one shorter than that, the text stays as it is.
 */
export function maskKey(text: string, apiKey: string | undefined): string {
  if (!apiKey) return text
  let masked = text
  // The padded form goes first: it contains the trimmed one, so masking it first removes it in full.
  for (const form of new Set([apiKey, apiKey.trim()])) {
    if (form.length >= MIN_MASKED_KEY_LENGTH) masked = masked.replaceAll(form, '<redacted>')
  }
  return masked
}

function excerpt(text: string): string {
  return text.slice(0, 200)
}

// Only a real number counts: a string ('0.01'), null or an object is ignored rather than coerced. 0 is a number.
function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

function parseUsage(raw: unknown): Usage {
  const u = raw as {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    cost?: unknown // OpenRouter: what the request cost, in dollars
    prompt_tokens_details?: { cached_tokens?: unknown }
    completion_tokens_details?: { reasoning_tokens?: unknown }
  } | undefined
  if (u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number') {
    return {
      source: 'provider_reported',
      inputTokens: u.prompt_tokens,
      outputTokens: u.completion_tokens,
      cachedTokens: numberOrUndefined(u.prompt_tokens_details?.cached_tokens),
      costUsd: numberOrUndefined(u.cost),
      reasoningTokens: numberOrUndefined(u.completion_tokens_details?.reasoning_tokens),
    }
  }
  return { source: 'missing', inputTokens: 0, outputTokens: 0 }
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

// message.reasoning, falling back to message.reasoning_content (some OpenAI-compatible servers use the latter name).
function parseReasoning(message: { reasoning?: unknown; reasoning_content?: unknown }): string | undefined {
  return nonEmptyString(message.reasoning) ?? nonEmptyString(message.reasoning_content)
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return []
  return raw.map((c: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }) => {
    const args = c?.function?.arguments
    const wasObject = args !== null && typeof args === 'object'
    return {
      id: typeof c?.id === 'string' ? c.id : '',
      name: typeof c?.function?.name === 'string' ? c.function.name : '',
      arguments: typeof args === 'string' ? args : wasObject ? JSON.stringify(args) : '',
      argumentsWasObject: wasObject,
    }
  })
}

// Internal ToolCall -> OpenAI wire shape; the harness never sends its own bookkeeping fields.
function toWire(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !m.tool_calls || m.tool_calls.length === 0) return m
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
    }
  })
}

export function createModelClient(opts: ModelClientOptions): ModelClient {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const dispatcher = new Agent(transportTimeouts(opts))
  const now = opts.now ?? Date.now
  return {
    async complete(messages, options) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`
      const body: Record<string, unknown> = {
        ...opts.extraBody,
        model: opts.name,
        messages: toWire(messages),
        max_tokens: options.maxTokens,
        stream: false,
      }
      if (options.tools && options.tools.length > 0) body.tools = options.tools
      if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort

      const requestStart = now()
      let text: string
      let status: number
      try {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal, dispatcher })
        status = res.status
        text = await res.text()
      } catch (err) {
        const reason = options.signal.aborted ? 'aborted (deadline)' : err instanceof Error ? err.message : String(err)
        throw new ModelError(`model request failed: ${maskKey(reason, opts.apiKey)}`, { cause: err })
      }
      const durationMs = now() - requestStart
      // Mask first, cut second: excerpt() keeps 200 characters, and a key that straddles the cut would leave a prefix
      // maskKey can no longer match. Errors use this copy; a good answer is still parsed from the raw text.
      const maskedText = maskKey(text, opts.apiKey)
      if (status < 200 || status >= 300) {
        throw new ModelError(`model HTTP ${status}: ${excerpt(maskedText)}`)
      }
      let json: { error?: unknown; choices?: unknown; usage?: unknown; model?: unknown; system_fingerprint?: unknown; provider?: unknown }
      try {
        json = JSON.parse(text)
      } catch (err) {
        throw new ModelError(`model HTTP ${status}: invalid JSON: ${excerpt(maskedText)}`, { cause: err })
      }
      if (json === null || typeof json !== 'object') {
        throw new ModelError(`model HTTP ${status}: unexpected body: ${excerpt(maskedText)}`)
      }
      if (json.error) {
        throw new ModelError(`model HTTP ${status}: error body: ${excerpt(maskedText)}`)
      }
      const choice = Array.isArray(json.choices) ? json.choices[0] : undefined
      if (!choice || typeof choice !== 'object') {
        throw new ModelError(`model HTTP ${status}: no choices: ${excerpt(maskedText)}`)
      }
      const message = (choice as { message?: { content?: unknown; tool_calls?: unknown; reasoning?: unknown; reasoning_content?: unknown } }).message ?? {}
      const finish = (choice as { finish_reason?: unknown }).finish_reason
      return {
        message: {
          content: typeof message.content === 'string' ? message.content : null,
          toolCalls: parseToolCalls(message.tool_calls),
        },
        finishReason: typeof finish === 'string' && FINISH_REASONS.has(finish) ? (finish as CompleteResult['finishReason']) : 'other',
        usage: parseUsage(json.usage),
        model: typeof json.model === 'string' ? json.model : undefined,
        reasoning: parseReasoning(message),
        durationMs,
        systemFingerprint: nonEmptyString(json.system_fingerprint),
        provider: nonEmptyString(json.provider),
      }
    },
  }
}
