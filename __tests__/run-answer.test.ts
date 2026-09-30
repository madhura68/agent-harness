import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Manifest } from '../src/manifest.js'
import { createModelClient } from '../src/model-client.js'
import { runManifest, type AfterAnswerResult } from '../src/run.js'
import { openTrace } from '../src/trace.js'
import { completion, startFakeModelServer, type FakeTurn } from './fakes/fake-model-server.js'
import { allFiles, bodyWithKeyAt, dirContains, DUMMY_KEY, leakedFragments, readTrace, tmp } from './helpers.js'

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let fake: Fake | undefined
afterEach(async () => { await fake?.close(); fake = undefined })

const limits = { maxTurns: 3, maxOutputTokens: 512, maxWallSeconds: 30, maxToolErrors: 0 }
function manifest(baseUrl: string, over: Partial<Manifest> = {}): Manifest {
  return { id: 'answer-test', profile: 'answer', prompt: 'Wat is een sprint?', model: { baseUrl, name: 'm' }, limits, ...over }
}

async function run(script: FakeTurn[], over: (baseUrl: string) => Partial<Manifest> = () => ({})) {
  fake = await startFakeModelServer(script)
  const m = manifest(fake.baseUrl, over(fake.baseUrl))
  const trace = openTrace(tmp('run'), m.id)
  const connectRegistry = vi.fn(async () => { throw new Error('must not be called for answer') })
  const result = await runManifest(m, { client: createModelClient({ baseUrl: m.model.baseUrl, name: m.model.name, apiKey: m.model.apiKey }), trace, connectRegistry })
  return { result, trace, connectRegistry, requests: fake.requests }
}

describe('runManifest — answer profile', () => {
  it('completes with the answer, usage and a full result.json', async () => {
    const { result, trace, connectRegistry, requests } = await run([{ body: completion({ content: 'Een sprint is…', usage: { prompt_tokens: 20, completion_tokens: 7 }, model: 'qwen' }) }], () => ({ system: 'Wees kort.' }))
    expect(result).toMatchObject({
      runId: 'answer-test', status: 'completed', answer: 'Een sprint is…',
      model: { name: 'm', reported: 'qwen' },
      usage: { source: 'provider_reported', inputTokens: 20, outputTokens: 7, turns: 1, toolCalls: 0, toolErrors: 0 },
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.toolSnapshotHash).toBeUndefined()
    expect(JSON.parse(readFileSync(join(trace.dir, 'result.json'), 'utf8'))).toEqual(result)
    expect(readTrace(trace.dir).map((e) => e.type)).toEqual(['run_start', 'model_request', 'model_response', 'run_end'])
    expect(requests[0].body.messages).toEqual([{ role: 'system', content: 'Wees kort.' }, { role: 'user', content: 'Wat is een sprint?' }])
    expect(requests[0].body.max_tokens).toBe(512)
    expect(requests[0].body.tools).toBeUndefined()
    expect(connectRegistry).not.toHaveBeenCalled()
  })

  it('completes with an empty answer when content is empty', async () => {
    const { result } = await run([{ body: completion({ content: null }) }])
    expect(result.status).toBe('completed')
    expect(result.answer).toBe('')
  })

  it('reports missing usage honestly', async () => {
    const { result } = await run([{ body: completion({ content: 'x', usage: null }) }])
    expect(result.usage).toMatchObject({ source: 'missing', inputTokens: 0, outputTokens: 0 })
  })

  it('fails with MODEL_ERROR on HTTP 500 and still writes run_end', async () => {
    const { result, trace } = await run([{ status: 500, body: { error: { message: 'boom' } } }])
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('MODEL_ERROR')
    const events = readTrace(trace.dir)
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'failed', error: { code: 'MODEL_ERROR' } })
  })

  it('times out on a model call that outlives maxWallSeconds, after exactly one request', async () => {
    const started = Date.now()
    const { result, requests } = await run([{ delayMs: 3000, body: completion({ content: 'late' }) }], () => ({ limits: { ...limits, maxWallSeconds: 1 } }))
    expect(result.status).toBe('timed_out')
    expect(requests).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('treats finish_reason length without tool calls as budget_exceeded', async () => {
    const { result } = await run([{ body: completion({ content: 'half an ans', finishReason: 'length' }) }])
    expect(result.status).toBe('budget_exceeded')
  })

  it('treats reported output tokens above the budget as budget_exceeded', async () => {
    const { result } = await run([{ body: completion({ content: 'x', usage: { prompt_tokens: 1, completion_tokens: 600 } }) }])
    expect(result.status).toBe('budget_exceeded')
  })

  it('stops at maxTurns without an extra request when the model keeps inventing tools', async () => {
    const call = { body: completion({ toolCalls: [{ id: 'x', name: 'nope', arguments: '{}' }] }) }
    const { result, requests, trace } = await run([call, call, call, call], () => ({ limits: { ...limits, maxTurns: 2, maxToolErrors: 5 } }))
    expect(result.status).toBe('budget_exceeded')
    expect(requests).toHaveLength(2)
    expect(result.usage).toMatchObject({ turns: 2, toolCalls: 2, toolErrors: 2 })
    const toolResults = readTrace(trace.dir).filter((e) => e.type === 'tool_result')
    expect(toolResults.every((e) => e.errorCode === 'UNKNOWN_TOOL')).toBe(true)
    // the second request carries the UNKNOWN_TOOL tool message
    const tm = requests[1].body.messages.at(-1)
    expect(tm.role).toBe('tool')
    expect(JSON.parse(tm.content)).toMatchObject({ ok: false, errorCode: 'UNKNOWN_TOOL' })
  })

  it('fails with TOO_MANY_TOOL_ERRORS when an answer model invents a tool and maxToolErrors is 0', async () => {
    const { result, requests } = await run([{ body: completion({ toolCalls: [{ id: 'x', name: 'nope', arguments: '{}' }] }) }])
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('TOO_MANY_TOOL_ERRORS')
    expect(requests).toHaveLength(1)
  })

  it('keeps the apiKey out of every file in the run dir', async () => {
    const { trace, requests } = await run([{ body: completion({ content: 'x' }) }], (b) => ({ model: { baseUrl: b, name: 'm', apiKey: 'sk-test-secret' } }))
    expect(requests[0].headers.authorization).toBe('Bearer sk-test-secret')
    expect(dirContains(trace.dir, 'sk-test-secret')).toBe(false)
  })

  it('keeps the apiKey out of the error message, run_end and result.json when the server echoes it', async () => {
    const echo = { status: 401, body: bodyWithKeyAt(190, (p) => JSON.stringify({ error: { message: p } })) }
    const { result, trace } = await run([echo], (b) => ({ model: { baseUrl: b, name: 'm', apiKey: DUMMY_KEY } }))
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('MODEL_ERROR')
    expect(result.error?.message).toContain('<redacted>')
    expect(leakedFragments(result.error?.message ?? '')).toEqual([])
    const runEnd = readTrace(trace.dir).at(-1)
    expect(runEnd).toMatchObject({ type: 'run_end', status: 'failed', error: { code: 'MODEL_ERROR' } })
    expect(JSON.stringify(runEnd)).toContain('<redacted>')
    expect(leakedFragments(JSON.stringify(runEnd))).toEqual([])
    // Every file of the run (trace.jsonl, result.json, …), not just the two places named above.
    const written = allFiles(trace.dir).map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(leakedFragments(written)).toEqual([])
  })

  it('leaves usage.cachedTokens absent when no response reported it', async () => {
    const { result } = await run([{ body: completion({ content: 'x', usage: { prompt_tokens: 5, completion_tokens: 2 } }) }])
    expect(result.usage.cachedTokens).toBeUndefined()
  })

  it('carries reasoning, durationMs and systemFingerprint on model_response, and sums cachedTokens across turns', async () => {
    fake = await startFakeModelServer([
      { body: readFileSync(join('__tests__', 'fixtures', 'ollama-v1-reasoning.json'), 'utf8') },
      { body: readFileSync(join('__tests__', 'fixtures', 'ollama-v1-cached.json'), 'utf8') },
    ])
    const m = manifest(fake.baseUrl)
    const trace = openTrace(tmp('run'), m.id)
    const afterAnswer = vi.fn<(answer: string, signal: AbortSignal) => Promise<AfterAnswerResult>>()
      .mockResolvedValueOnce({ kind: 'retry', message: 'Nog een keer.' })
      .mockResolvedValueOnce({ kind: 'accept' })
    const result = await runManifest(m, {
      client: createModelClient({ baseUrl: m.model.baseUrl, name: m.model.name }),
      trace,
      connectRegistry: async () => { throw new Error('unused') },
      afterAnswer,
    })
    expect(result.status).toBe('completed')
    expect(result.usage.cachedTokens).toBe(22) // 0 (first turn) + 22 (second turn)
    const responses = readTrace(trace.dir).filter((e) => e.type === 'model_response')
    expect(responses).toHaveLength(2)
    for (const r of responses) {
      expect(r.systemFingerprint).toBe('fp_ollama')
      expect(typeof r.reasoning).toBe('string')
      expect(typeof r.durationMs).toBe('number')
    }
  })
})

describe('runManifest — history', () => {
  type History = NonNullable<Manifest['history']>
  const system = { role: 'system', content: 'Wees kort.' }
  const prompt = { role: 'user', content: 'Wat is een sprint?' }
  const two: History = [
    { role: 'user', content: 'Wat is een PBI?' },
    { role: 'assistant', content: 'Een product backlog item.' },
  ]
  const four: History = [
    ...two,
    { role: 'user', content: 'En een story?' },
    { role: 'assistant', content: 'Een verfijning van een PBI.' },
  ]

  it('sends [system, user] when history is absent', async () => {
    const { requests } = await run([{ body: completion({ content: 'ok' }) }], () => ({ system: system.content }))
    expect(requests[0].body.messages).toEqual([system, prompt])
  })

  it('sends [system, user] when history is empty', async () => {
    const { requests } = await run([{ body: completion({ content: 'ok' }) }], () => ({ system: system.content, history: [] }))
    expect(requests[0].body.messages).toEqual([system, prompt])
  })

  it('puts a history of two messages between the system message and the prompt', async () => {
    const { result, requests } = await run([{ body: completion({ content: 'ok' }) }], () => ({ system: system.content, history: two }))
    expect(result.status).toBe('completed')
    expect(requests).toHaveLength(1)
    expect(requests[0].body.messages).toEqual([system, ...two, prompt])
  })

  it('puts a history of four messages in the given order, before the prompt', async () => {
    const { requests } = await run([{ body: completion({ content: 'ok' }) }], () => ({ system: system.content, history: four }))
    expect(requests[0].body.messages).toEqual([system, ...four, prompt])
  })

  it('starts with the history when there is no system message', async () => {
    const { requests } = await run([{ body: completion({ content: 'ok' }) }], () => ({ history: two }))
    expect(requests[0].body.messages).toEqual([...two, prompt])
  })
})

describe('runManifest — cost, reasoning tokens and provider', () => {
  const fixtureText = (name: string) => readFileSync(join('__tests__', 'fixtures', name), 'utf8')
  // The real OpenRouter response from the first contact (Task 2). Every call gives a fresh copy, so a test can bend it.
  const real = () => JSON.parse(fixtureText('openrouter-chat-completion.json'))
  // The kind of answer Ollama gives: usage with tokens, but no cost, reasoning-token count or provider.
  const plainUsage = { prompt_tokens: 30, completion_tokens: 6 }
  const plain = () => completion({ content: '51', usage: plainUsage })
  // The same two responses in both orders, so that neither a first nor a last response can hide a fault.
  const ORDERS: Array<[label: string, order: <T>(reported: T, unreported: T) => T[]]> = [
    ['the reporting response first', (reported, unreported) => [reported, unreported]],
    ['the reporting response last', (reported, unreported) => [unreported, reported]],
  ]

  /**
   * One run with a response per body. Every answer but the last is sent back with a retry, so all bodies are used
   * within the one run; maxTurns follows the number of bodies.
   */
  async function runBodies(bodies: unknown[]) {
    fake = await startFakeModelServer(bodies.map((body) => ({ body })))
    const m = manifest(fake.baseUrl, { limits: { ...limits, maxTurns: bodies.length } })
    const trace = openTrace(tmp('run'), m.id)
    let answers = 0
    const afterAnswer = async (): Promise<AfterAnswerResult> => (++answers < bodies.length ? { kind: 'retry', message: 'Nog een keer.' } : { kind: 'accept' })
    const result = await runManifest(m, {
      client: createModelClient({ baseUrl: m.model.baseUrl, name: m.model.name }),
      trace,
      connectRegistry: async () => { throw new Error('unused') },
      afterAnswer,
    })
    expect(result.status).toBe('completed')
    expect(result.usage.turns).toBe(bodies.length)
    return { result, trace, responses: readTrace(trace.dir).filter((e) => e.type === 'model_response') }
  }

  it('carries costUsd, reasoningTokens and provider from the real OpenRouter response into the trace and result.json', async () => {
    const file = real()
    const cost = file.usage.cost
    const reasoning = file.usage.completion_tokens_details.reasoning_tokens
    // The premise: the file holds all three. Without it the asserts below would also hold for three undefineds.
    expect(typeof cost).toBe('number')
    expect(typeof reasoning).toBe('number')
    expect(file.provider).toMatch(/\S/)
    const { result, trace, responses } = await runBodies([fixtureText('openrouter-chat-completion.json')])
    expect(result.usage.costUsd).toBe(cost)
    expect(result.usage.reasoningTokens).toBe(reasoning)
    expect(responses).toHaveLength(1)
    expect(responses[0].provider).toBe(file.provider)
    expect(responses[0].usage).toMatchObject({ costUsd: cost, reasoningTokens: reasoning })
    expect(JSON.parse(readFileSync(join(trace.dir, 'result.json'), 'utf8'))).toEqual(result)
  })

  it.each([
    ['a body with usage but no cost', () => plain()],
    ['a real Ollama response', () => fixtureText('ollama-v1-reasoning.json')],
  ])('leaves costUsd, reasoningTokens and provider out of the trace and result.json when the response has none: %s', async (_label, body) => {
    const { result, trace, responses } = await runBodies([body()])
    expect(result.usage).not.toHaveProperty('costUsd')
    expect(result.usage).not.toHaveProperty('reasoningTokens')
    expect(responses[0]).not.toHaveProperty('provider')
    expect(responses[0].usage).not.toHaveProperty('costUsd')
    expect(responses[0].usage).not.toHaveProperty('reasoningTokens')
    const written = JSON.parse(readFileSync(join(trace.dir, 'result.json'), 'utf8'))
    expect(written.usage).not.toHaveProperty('costUsd')
    expect(written.usage).not.toHaveProperty('reasoningTokens')
  })

  it('gives each model_response the provider of its own response', async () => {
    const file = real()
    const other = real()
    other.provider = 'DeepInfra'
    expect(other.provider).not.toBe(file.provider)
    const { responses } = await runBodies([file, other])
    expect(responses.map((r) => r.provider)).toEqual([file.provider, 'DeepInfra'])
  })

  it.each(ORDERS)('does not hand a provider on to a response that names none: %s', async (_label, order) => {
    const file = real()
    const { responses } = await runBodies(order<unknown>(file, plain()))
    expect(responses.map((r) => r.provider)).toEqual(order<unknown>(file.provider, undefined))
    for (const r of responses.filter((r) => r.provider === undefined)) expect(r).not.toHaveProperty('provider')
  })

  // Review Focus 4: a response without usage.cost (Ollama) next to one with.
  it.each(ORDERS)('counts only what was reported when one response has a cost and one has none: %s', async (_label, order) => {
    const file = real()
    const { result } = await runBodies(order<unknown>(file, plain()))
    expect(result.usage.costUsd).toBe(file.usage.cost) // the unreported one counts for nothing, not for NaN or a fault
    expect(result.usage.reasoningTokens).toBe(file.usage.completion_tokens_details.reasoning_tokens)
    // Both responses still count for the tokens they did report.
    expect(result.usage.source).toBe('provider_reported')
    expect(result.usage.inputTokens).toBe(file.usage.prompt_tokens + plainUsage.prompt_tokens)
    expect(result.usage.outputTokens).toBe(file.usage.completion_tokens + plainUsage.completion_tokens)
  })

  it('adds up the costs and the reasoning tokens of every response that reported them', async () => {
    const first = real()
    const second = real()
    second.usage.cost = 0.0001234
    second.usage.completion_tokens_details.reasoning_tokens = 100
    const { result } = await runBodies([first, second])
    expect(result.usage.costUsd).toBeCloseTo(first.usage.cost + second.usage.cost, 12) // a float sum: compare within rounding
    expect(result.usage.costUsd).toBeGreaterThan(first.usage.cost)
    expect(result.usage.reasoningTokens).toBe(first.usage.completion_tokens_details.reasoning_tokens + 100)
  })

  it('reports a cost of 0 as 0, not as absent: a free model did report it', async () => {
    const free = real()
    free.usage.cost = 0
    free.usage.completion_tokens_details.reasoning_tokens = 0
    const { result } = await runBodies([free])
    expect(result.usage).toHaveProperty('costUsd', 0)
    expect(result.usage).toHaveProperty('reasoningTokens', 0)
  })

  // A response can say what it cost without giving the token counts (source 'missing'). Its cost still counts: the run's
  // costUsd is the sum the runner checks its spending cap against, and a billed amount must not vanish.
  describe('a response without token counts', () => {
    it.each(ORDERS)('adds its cost and reasoning tokens to the sums, next to a normal response: %s', async (_label, order) => {
      const file = real()
      const countlessCost = 0.0004321
      const countlessReasoning = 9
      const countless = real()
      countless.usage = { cost: countlessCost, completion_tokens_details: { reasoning_tokens: countlessReasoning } }
      const { result, trace, responses } = await runBodies(order<unknown>(file, countless))
      const written = JSON.parse(readFileSync(join(trace.dir, 'result.json'), 'utf8'))
      for (const usage of [result.usage, written.usage]) {
        expect(usage.costUsd).toBeCloseTo(file.usage.cost + countlessCost, 12) // a float sum: compare within rounding
        expect(usage.costUsd).toBeGreaterThan(file.usage.cost)
        expect(usage.reasoningTokens).toBe(file.usage.completion_tokens_details.reasoning_tokens + countlessReasoning)
      }
      // The counts are what is missing, and the run says so; the tokens of the response that has them still count.
      expect(result.usage.source).toBe('missing')
      expect(result.usage.inputTokens).toBe(file.usage.prompt_tokens)
      expect(result.usage.outputTokens).toBe(file.usage.completion_tokens)
      // The trace shows the countless response as it came.
      const event = responses.find((r) => (r.usage as { source: string }).source === 'missing')
      expect(event?.usage).toStrictEqual({
        source: 'missing', inputTokens: 0, outputTokens: 0, costUsd: countlessCost, reasoningTokens: countlessReasoning,
      })
    })

    it('keeps the cost of a run whose only response has no token counts', async () => {
      const file = real()
      const cost = file.usage.cost
      file.usage = { cost }
      const { result, trace } = await runBodies([file])
      expect(result.usage).toMatchObject({ source: 'missing', inputTokens: 0, outputTokens: 0, costUsd: cost })
      expect(result.usage).not.toHaveProperty('reasoningTokens')
      expect(JSON.parse(readFileSync(join(trace.dir, 'result.json'), 'utf8'))).toEqual(result)
    })
  })
})

const execFileP = promisify(execFile)
async function cli(args: string[]) {
  try {
    const r = await execFileP(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: process.cwd() })
    return { code: 0, stdout: r.stdout, stderr: r.stderr }
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string }
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }
  }
}

describe('harness run CLI', () => {
  it('exits 0 on completed and prints a summary', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const dir = tmp('cli')
    const mf = join(dir, 'm.json')
    writeFileSync(mf, JSON.stringify(manifest(fake.baseUrl)))
    const r = await cli(['run', mf, '--out', join(dir, 'runs')])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/completed/)
    expect(existsSync(join(dir, 'runs', 'answer-test', 'result.json'))).toBe(true)
  })

  it('exits 1 on a non-completed status', async () => {
    fake = await startFakeModelServer([{ status: 500, body: { error: { message: 'boom' } } }])
    const dir = tmp('cli')
    const mf = join(dir, 'm.json')
    writeFileSync(mf, JSON.stringify(manifest(fake.baseUrl)))
    const r = await cli(['run', mf, '--out', join(dir, 'runs')])
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/failed/)
  })

  it('exits 1 on an invalid manifest or an existing run dir', async () => {
    const dir = tmp('cli')
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ id: 'x' }))
    expect((await cli(['run', bad, '--out', join(dir, 'runs')])).code).toBe(1)
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const mf = join(dir, 'm.json')
    writeFileSync(mf, JSON.stringify(manifest(fake.baseUrl)))
    expect((await cli(['run', mf, '--out', join(dir, 'runs')])).code).toBe(0)
    const again = await cli(['run', mf, '--out', join(dir, 'runs')])
    expect(again.code).toBe(1)
    expect(again.stderr).toMatch(/already exists/)
  })
})

describe('runManifest with an external abort signal', () => {
  it('stops a slow model turn within 500 ms as failed/HARNESS_ERROR, with exactly one request', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'te laat' }), delayMs: 5000 }])
    const m = manifest(fake.baseUrl)
    const trace = openTrace(tmp('run'), m.id)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    const result = await runManifest(m, {
      client: createModelClient({ baseUrl: m.model.baseUrl, name: m.model.name }),
      trace,
      connectRegistry: async () => { throw new Error('unused') },
      signal: controller.signal,
    })
    expect(Date.now() - started).toBeLessThan(500)
    expect(result.status).toBe('failed')
    expect(result.error).toEqual({ code: 'HARNESS_ERROR', message: 'aborted' })
    expect(fake.requests).toHaveLength(1)
  })

  it('makes no model call when the signal is already aborted', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'nee' }) }])
    const m = manifest(fake.baseUrl)
    const trace = openTrace(tmp('run'), m.id)
    const result = await runManifest(m, {
      client: createModelClient({ baseUrl: m.model.baseUrl, name: m.model.name }),
      trace,
      connectRegistry: async () => { throw new Error('unused') },
      signal: AbortSignal.abort(),
    })
    expect(result.error).toEqual({ code: 'HARNESS_ERROR', message: 'aborted' })
    expect(fake.requests).toHaveLength(0)
  })

  it('records runStartExtra as job on run_start', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const m = manifest(fake.baseUrl)
    const trace = openTrace(tmp('run'), m.id)
    await runManifest(m, {
      client: createModelClient({ baseUrl: m.model.baseUrl, name: m.model.name }),
      trace,
      connectRegistry: async () => { throw new Error('unused') },
      runStartExtra: { jobId: 'job1', ideaId: 'idea1' },
    })
    expect(readTrace(trace.dir)[0]).toMatchObject({ type: 'run_start', job: { jobId: 'job1', ideaId: 'idea1' } })
  })
})
