import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeTurn = { status?: number; body?: unknown; delayMs?: number }
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- captured JSON bodies are inspected ad hoc in tests
export type CapturedRequest = { method: string; url: string; headers: IncomingHttpHeaders; body: any }

/**
 * Scripted chat-completions server. It understands nothing: request N gets script[N].
 * A request beyond the script gets HTTP 599 so an unexpected extra call is visible.
 */
export async function startFakeModelServer(script: FakeTurn[]) {
  const requests: CapturedRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body: unknown = raw
      try { body = JSON.parse(raw) } catch { /* keep raw */ }
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      const turn = script[requests.length - 1]
      const send = () => {
        if (res.destroyed) return
        if (!turn) {
          res.writeHead(599, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'script exhausted' } }))
          return
        }
        res.writeHead(turn.status ?? 200, { 'content-type': 'application/json' })
        res.end(typeof turn.body === 'string' ? turn.body : JSON.stringify(turn.body ?? {}))
      }
      if (turn?.delayMs) setTimeout(send, turn.delayMs)
      else send()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** Helper: an OpenAI-style chat completion body. */
export function completion(opts: {
  content?: string | null
  toolCalls?: Array<{ id?: string; name: string; arguments?: unknown }>
  finishReason?: string
  usage?: { prompt_tokens: number; completion_tokens: number } | null
  model?: string
}) {
  const message: Record<string, unknown> = { role: 'assistant', content: opts.content ?? null }
  if (opts.toolCalls) {
    message.tool_calls = opts.toolCalls.map((c) => ({
      ...(c.id === undefined ? {} : { id: c.id }),
      type: 'function',
      function: { name: c.name, ...(c.arguments === undefined ? {} : { arguments: c.arguments }) },
    }))
  }
  const body: Record<string, unknown> = {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    model: opts.model ?? 'fake-model',
    choices: [{ index: 0, message, finish_reason: opts.finishReason ?? (opts.toolCalls ? 'tool_calls' : 'stop') }],
  }
  if (opts.usage !== null) body.usage = opts.usage ?? { prompt_tokens: 10, completion_tokens: 5 }
  return body
}
