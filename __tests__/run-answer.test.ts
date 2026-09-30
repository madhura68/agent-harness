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
