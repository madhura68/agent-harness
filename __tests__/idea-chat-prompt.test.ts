import { describe, expect, it } from 'vitest'
import { IDEA_CHAT_SYSTEM_PROMPT, IdeaChatPayloadSchema, pendingUserMessages, renderIdeaChatUserMessage } from '../src/worker/idea-chat.js'
import { ideaChatPayload } from './fakes/idea-chat-payload.js'

describe('IdeaChatPayloadSchema', () => {
  it('accepts the MCP shape and tolerates extra fields', () => {
    const p = IdeaChatPayloadSchema.parse(ideaChatPayload())
    expect(p.idea.product_id).toBe('prod-harness')
  })

  it.each([
    ['chat', (p: Record<string, unknown>) => { delete p.chat }],
    ['idea.product_id', (p: Record<string, unknown>) => { delete (p.idea as Record<string, unknown>).product_id }],
    ['pending_user_message_ids', (p: Record<string, unknown>) => { delete (p.chat as Record<string, unknown>).pending_user_message_ids }],
  ])('rejects a payload without %s', (_name, mutate) => {
    const p = ideaChatPayload() as unknown as Record<string, unknown>
    mutate(p)
    expect(IdeaChatPayloadSchema.safeParse(p).success).toBe(false)
  })
})

describe('renderIdeaChatUserMessage', () => {
  it('starts with the product-id line and carries idea, grill and the whole chat in order', () => {
    const text = renderIdeaChatUserMessage(IdeaChatPayloadSchema.parse(ideaChatPayload()))
    expect(text.split('\n')[0]).toBe('Product-id (voor elke doc-tool): prod-harness')
    expect(text).toContain('## Idee')
    expect(text).toContain('Lokale LLM-worker')
    expect(text).toContain('## Grill')
    expect(text).toContain('Grill-inhoud')
    expect(text.indexOf('Eerste vraag')).toBeLessThan(text.indexOf('Eerste antwoord'))
    expect(text).toContain('## Te beantwoorden')
  })

  it('leaves out empty grill, plan and card-question sections', () => {
    const payload = ideaChatPayload()
    payload.idea.grill_md = null
    payload.idea.plan_md = ''
    payload.chat.questions = []
    const text = renderIdeaChatUserMessage(IdeaChatPayloadSchema.parse(payload))
    expect(text).not.toContain('## Grill')
    expect(text).not.toContain('## Plan')
    expect(text).not.toContain('## Kaartvragen')
  })

  it('answers the pending message after coalescing, not the one before the last assistant reply', () => {
    const payload = ideaChatPayload({
      messages: [
        { id: 'a', role: 'USER', kind: 'TEXT', content: 'Vraag A', created_at: '2026-09-26T10:00:00.000Z' },
        { id: 'b', role: 'USER', kind: 'TEXT', content: 'Vraag B', created_at: '2026-09-26T10:00:05.000Z' },
        { id: 'c', role: 'ASSISTANT', kind: 'TEXT', content: 'Antwoord A', created_at: '2026-09-26T10:00:30.000Z' },
      ],
      pending: ['b'],
    })
    const text = renderIdeaChatUserMessage(IdeaChatPayloadSchema.parse(payload))
    const pending = text.slice(text.indexOf('## Te beantwoorden'))
    expect(pending).toContain('Vraag B')
    expect(pending).not.toContain('Vraag A')
  })
})

describe('pendingUserMessages', () => {
  it('is empty when nothing is pending', () => {
    expect(pendingUserMessages(IdeaChatPayloadSchema.parse(ideaChatPayload({ pending: [] })))).toEqual([])
  })
})

describe('IDEA_CHAT_SYSTEM_PROMPT', () => {
  it('points at the pending section and forbids changes', () => {
    expect(IDEA_CHAT_SYSTEM_PROMPT).toContain('## Te beantwoorden')
    expect(IDEA_CHAT_SYSTEM_PROMPT).toMatch(/wijzigt niets/i)
    expect(IDEA_CHAT_SYSTEM_PROMPT).not.toMatch(/laatste ASSISTANT/i)
  })
})
