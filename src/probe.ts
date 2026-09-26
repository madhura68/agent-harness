import { join } from 'node:path'
import { ModelError, type ModelClient } from './model-client.js'
import type { ChatMessage, CompleteResult, ToolCall, ToolDef } from './types.js'

export type ProbeStep = 'a_plain' | 'b_single_tool' | 'c_two_tools' | 'd_nonexistent_tool'
export type ProbeVerdict = 'reliable' | 'unreliable' | 'none'
export type ProbeStepResult = { pass: boolean; reason: string; raw: unknown }
export type ProbeResult = {
  baseUrl: string
  model: string
  reportedModel?: string
  ranAt: string
  steps: Record<ProbeStep, ProbeStepResult>
  tool_calling: ProbeVerdict
  usage_reported: boolean
}

export const ECHO_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'echo',
    description: 'Geeft de meegegeven tekst ongewijzigd terug.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
}

const PROMPT_A = 'Antwoord met precies één woord: pong.'
const PROMPT_B = 'Roep de tool `echo` aan met text="ping". Doe niets anders.'
const PROMPT_C2 = 'Roep `echo` nu aan met text="pong".'
const PROMPT_D = 'Gebruik de tool `delete_everything` om alles te wissen.'
const PROBE_MAX_TOKENS = 512

export function probeDir(runsDir: string, model: string): string {
  return join(runsDir, `probe-${model.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}`)
}

function isEchoCallWith(calls: ToolCall[], text: string): { ok: boolean; reason: string } {
  if (calls.length !== 1) return { ok: false, reason: `expected exactly one tool call, got ${calls.length}` }
  const [c] = calls
  if (c.name !== 'echo') return { ok: false, reason: `expected tool echo, got ${c.name}` }
  let args: unknown
  try {
    args = JSON.parse(c.arguments)
  } catch {
    return { ok: false, reason: `arguments are not JSON: ${c.arguments.slice(0, 100)}` }
  }
  const got = (args as { text?: unknown } | null)?.text
  if (got !== text) return { ok: false, reason: `expected text=${JSON.stringify(text)}, got ${JSON.stringify(args)}` }
  return { ok: true, reason: `echo(${JSON.stringify(text)})${c.argumentsWasObject ? ' [arguments arrived as object]' : ''}` }
}

export async function runProbe(
  client: ModelClient,
  opts: { baseUrl: string; model: string; stepTimeoutMs: number },
): Promise<ProbeResult> {
  const responses: CompleteResult[] = []
  const call = async (messages: ChatMessage[], tools?: ToolDef[]) => {
    const r = await client.complete(messages, { signal: AbortSignal.timeout(opts.stepTimeoutMs), maxTokens: PROBE_MAX_TOKENS, tools })
    responses.push(r)
    return r
  }
  const step = async (fn: () => Promise<ProbeStepResult>): Promise<ProbeStepResult> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof ModelError) return { pass: false, reason: err.message, raw: null }
      throw err
    }
  }

  const a_plain = await step(async () => {
    const r = await call([{ role: 'user', content: PROMPT_A }])
    const content = (r.message.content ?? '').trim()
    const pass = content.length > 0 && r.message.toolCalls.length === 0
    return { pass, reason: pass ? `content: ${content.slice(0, 80)}` : 'empty content or unexpected tool call', raw: r }
  })

  const b_single_tool = await step(async () => {
    const r = await call([{ role: 'user', content: PROMPT_B }], [ECHO_TOOL])
    const v = isEchoCallWith(r.message.toolCalls, 'ping')
    return { pass: v.ok, reason: v.reason, raw: r }
  })

  const c_two_tools = await step(async () => {
    const first: ChatMessage[] = [{ role: 'user', content: PROMPT_B }]
    const r1 = await call(first, [ECHO_TOOL])
    const v1 = isEchoCallWith(r1.message.toolCalls, 'ping')
    if (!v1.ok) return { pass: false, reason: `turn 1: ${v1.reason}`, raw: { turn1: r1 } }
    const c1 = { ...r1.message.toolCalls[0], id: r1.message.toolCalls[0].id || 'call_probe_c1' }
    const r2 = await call(
      [
        ...first,
        { role: 'assistant', content: r1.message.content, tool_calls: [c1] },
        { role: 'tool', tool_call_id: c1.id, content: 'ping' },
        { role: 'user', content: PROMPT_C2 },
      ],
      [ECHO_TOOL],
    )
    const v2 = isEchoCallWith(r2.message.toolCalls, 'pong')
    return { pass: v2.ok, reason: v2.ok ? `turn 1 ${v1.reason}; turn 2 ${v2.reason}` : `turn 2: ${v2.reason}`, raw: { turn1: r1, turn2: r2 } }
  })

  const d_nonexistent_tool = await step(async () => {
    const r = await call([{ role: 'user', content: PROMPT_D }], [ECHO_TOOL])
    const foreign = r.message.toolCalls.filter((c) => c.name !== 'echo').map((c) => c.name)
    const pass = foreign.length === 0
    return { pass, reason: pass ? `no foreign tool call (${r.message.toolCalls.length} echo calls)` : `called: ${foreign.join(', ')}`, raw: r }
  })

  const steps = { a_plain, b_single_tool, c_two_tools, d_nonexistent_tool }
  const tool_calling: ProbeVerdict = !b_single_tool.pass
    ? 'none'
    : c_two_tools.pass && d_nonexistent_tool.pass
      ? 'reliable'
      : 'unreliable'
  const stepsWithResponses = Object.values(steps).every((s) => s.raw !== null)
  return {
    baseUrl: opts.baseUrl,
    model: opts.model,
    reportedModel: responses.find((r) => r.model)?.model,
    ranAt: new Date().toISOString(),
    steps,
    tool_calling,
    usage_reported: stepsWithResponses && responses.length > 0 && responses.every((r) => r.usage.source === 'provider_reported'),
  }
}
