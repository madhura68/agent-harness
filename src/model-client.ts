import type { ChatMessage, CompleteResult, ToolCall, ToolDef, Usage } from './types.js'

export type ModelClientOptions = { baseUrl: string; name: string; apiKey?: string }
export type CompleteOptions = { signal: AbortSignal; maxTokens: number; tools?: ToolDef[] }
export type ModelClient = { complete(messages: ChatMessage[], options: CompleteOptions): Promise<CompleteResult> }

export class ModelError extends Error {
  readonly code = 'MODEL_ERROR' as const
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ModelError'
  }
}

const FINISH_REASONS = new Set(['stop', 'length', 'tool_calls'])

function excerpt(text: string): string {
  return text.slice(0, 200)
}

function parseUsage(raw: unknown): Usage {
  const u = raw as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined
  if (u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number') {
    return { source: 'provider_reported', inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens }
  }
  return { source: 'missing', inputTokens: 0, outputTokens: 0 }
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
  return {
    async complete(messages, options) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`
      const body: Record<string, unknown> = {
        model: opts.name,
        messages: toWire(messages),
        max_tokens: options.maxTokens,
        stream: false,
      }
      if (options.tools && options.tools.length > 0) body.tools = options.tools

      let text: string
      let status: number
      try {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal })
        status = res.status
        text = await res.text()
      } catch (err) {
        const reason = options.signal.aborted ? 'aborted (deadline)' : err instanceof Error ? err.message : String(err)
        throw new ModelError(`model request failed: ${reason}`, { cause: err })
      }
      if (status < 200 || status >= 300) {
        throw new ModelError(`model HTTP ${status}: ${excerpt(text)}`)
      }
      let json: { error?: unknown; choices?: unknown; usage?: unknown; model?: unknown }
      try {
        json = JSON.parse(text)
      } catch (err) {
        throw new ModelError(`model HTTP ${status}: invalid JSON: ${excerpt(text)}`, { cause: err })
      }
      if (json === null || typeof json !== 'object') {
        throw new ModelError(`model HTTP ${status}: unexpected body: ${excerpt(text)}`)
      }
      if (json.error) {
        throw new ModelError(`model HTTP ${status}: error body: ${excerpt(text)}`)
      }
      const choice = Array.isArray(json.choices) ? json.choices[0] : undefined
      if (!choice || typeof choice !== 'object') {
        throw new ModelError(`model HTTP ${status}: no choices: ${excerpt(text)}`)
      }
      const message = (choice as { message?: { content?: unknown; tool_calls?: unknown } }).message ?? {}
      const finish = (choice as { finish_reason?: unknown }).finish_reason
      return {
        message: {
          content: typeof message.content === 'string' ? message.content : null,
          toolCalls: parseToolCalls(message.tool_calls),
        },
        finishReason: typeof finish === 'string' && FINISH_REASONS.has(finish) ? (finish as CompleteResult['finishReason']) : 'other',
        usage: parseUsage(json.usage),
        model: typeof json.model === 'string' ? json.model : undefined,
      }
    },
  }
}
