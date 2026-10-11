import { TEST_CONFIGURATION } from './worker-config.js'

export type ChatTurn = { role: 'user' | 'assistant'; content: string }

/**
 * An AGENT_CHAT payload in the shape scrum4me-mcp wait_for_job builds for it (M50-1a Taak 3): the whole turns before the pending
 * message in `history`, the message to answer in `pending`, the CLAUDE.md text in `system_prompt`. source is MANUAL; the product
 * is the chat's own (code null is allowed: Product.code is optional).
 */
export function agentChatPayload(
  opts: {
    jobId?: string
    chatId?: string
    product?: { id: string; name: string; code: string | null }
    history?: ChatTurn[]
    pending?: { message_id: string; content: string }
    systemPrompt?: string
    config?: Record<string, unknown>
    /** Replaces/adds top-level fields (a test breaks the payload with it). */
    over?: Record<string, unknown>
  } = {},
) {
  return {
    job_id: opts.jobId ?? 'job1',
    kind: 'AGENT_CHAT',
    source: 'MANUAL',
    status: 'claimed',
    config: opts.config ?? { runtime: 'HARNESS', model: TEST_CONFIGURATION, max_cost_usd: '0.05' },
    chat: { id: opts.chatId ?? 'chat1', product: opts.product ?? { id: 'prod-harness', name: 'Agent-harness', code: 'HARNESS' } },
    history: opts.history ?? [],
    pending: opts.pending ?? { message_id: 'm-pending', content: 'Welke docs gaan over de worker?' },
    system_prompt: opts.systemPrompt ?? 'Je bent de chat-agent. Antwoord in het Nederlands.',
    ...opts.over,
  }
}
