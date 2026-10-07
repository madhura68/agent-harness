type Msg = { id: string; role: string; kind?: string; content: string; created_at: string }

/** An IDEA_CHAT payload in the shape of the scrum4me-mcp wait_for_job IDEA_CHAT branch. */
export function ideaChatPayload(opts: { jobId?: string; kind?: string; runtime?: string; messages?: Msg[]; pending?: string[] } = {}) {
  const messages: Msg[] = opts.messages ?? [
    { id: 'm1', role: 'USER', kind: 'TEXT', content: 'Eerste vraag', created_at: '2026-09-26T09:00:00.000Z' },
    { id: 'm2', role: 'ASSISTANT', kind: 'TEXT', content: 'Eerste antwoord', created_at: '2026-09-26T09:00:20.000Z' },
    { id: 'm3', role: 'USER', kind: 'TEXT', content: 'Welke docs gaan over de worker?', created_at: '2026-09-26T09:01:00.000Z' },
  ]
  return {
    job_id: opts.jobId ?? 'job1',
    kind: opts.kind ?? 'IDEA_CHAT',
    source: 'SYSTEM',
    status: 'claimed',
    config: { runtime: opts.runtime ?? 'HARNESS', model: 'claude-sonnet-5' },
    doc_index: [],
    idea: {
      id: 'idea1',
      code: 'IDEA-7',
      title: 'Lokale LLM-worker',
      description: 'Laat Ollama chatberichten beantwoorden.',
      grill_md: 'Grill-inhoud' as string | null,
      plan_md: 'Plan-inhoud' as string | null,
      status: 'GRILLED',
      product_id: 'prod-harness',
    },
    product: { id: 'prod-harness', name: 'Agent-harness', repo_url: null, definition_of_done: '' },
    chat: {
      messages,
      cutoff_message_id: messages.at(-1)?.id ?? null,
      cutoff_at: messages.at(-1)?.created_at ?? null,
      questions: [{ id: 'q1', question: 'Welk model?', options: null, status: 'ANSWERED', answer: 'qwen3-coder:30b', created_at: '2026-09-26T08:00:00.000Z' }] as unknown[],
      pending_user_message_ids: opts.pending ?? ['m3'],
    },
    prompt_text: 'Claude-prompt die de harness negeert',
  }
}
