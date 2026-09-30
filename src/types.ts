export type Role = 'system' | 'user' | 'assistant' | 'tool'

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export type ToolDef = {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}

export type ToolCall = {
  id: string // supplied by the model, or assigned by the harness (Task 9)
  name: string
  arguments: string // always a string; an object from the server is normalised
  argumentsWasObject: boolean
}

export type Usage = {
  source: 'provider_reported' | 'missing'
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  // The next two are read whenever the response gives a finite number, also when the token counts are missing
  // (source 'missing'): a billed amount must not vanish. Absent otherwise. 0 is a number: a free model reports it.
  costUsd?: number // usage.cost
  // usage.completion_tokens_details.reasoning_tokens. These are part of outputTokens (the fixture: 27 of its 44), not on
  // top of it: never add them to outputTokens.
  reasoningTokens?: number
}

export type CompleteResult = {
  message: { content: string | null; toolCalls: ToolCall[] }
  finishReason: 'stop' | 'length' | 'tool_calls' | 'other'
  usage: Usage
  model: string | undefined // what the server reports
  reasoning?: string // message.reasoning, otherwise message.reasoning_content; only ever a non-empty string
  durationMs: number // measured from just before fetch to just after the response body is read
  systemFingerprint?: string // system_fingerprint
  provider?: string // top-level `provider` of the response (OpenRouter names who served the request); only ever a non-empty string
}

export type RunStatus = 'completed' | 'failed' | 'budget_exceeded' | 'timed_out'

export type ErrorCode =
  | 'UNKNOWN_TOOL'
  | 'MALFORMED_ARGS'
  | 'SCHEMA_MISMATCH'
  | 'TOOL_ERROR'
  | 'TOOL_TIMEOUT'
  | 'TOOL_NOT_AVAILABLE'
  | 'MODEL_ERROR'
  | 'TOO_MANY_TOOL_ERRORS'
  | 'PROBE_REQUIRED'
  | 'CONTEXT_EXHAUSTED'
  | 'VERIFY_FAILED'

// Tool contracts live here so run.ts and registry.ts share the same types.
export type ServerSpec = { command: string; args: string[]; env?: Record<string, string> } // = Manifest.tools.server
export type ToolSnapshotEntry = { name: string; description?: string; inputSchema: Record<string, unknown> }
export type ToolSnapshot = { entries: ToolSnapshotEntry[]; hash: string } // sha256 over JSON.stringify(entries), names sorted
// content is what the model sees (≤ 16 384 bytes); fullContent is set only when content was truncated.
export type ToolExecResult = { ok: boolean; content: string; errorCode?: ErrorCode; truncated: boolean; fullContent?: string }

export interface ToolRegistry {
  readonly snapshot: ToolSnapshot
  toOpenAiTools(): ToolDef[]
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecResult>
  close(): Promise<void>
}
