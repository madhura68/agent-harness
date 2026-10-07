import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeDir } from '../src/probe.js'
import { createRegistryView } from '../src/tools/registry.js'
import { createControlChannel } from '../src/worker/control.js'
import { openRunLog } from '../src/worker/run-log.js'
import { runWorker, type WorkerDeps } from '../src/worker/worker.js'
import { completion, startFakeModelServer, type FakeTurn } from './fakes/fake-model-server.js'
import { startFakeScrum4meMcp, type ClaimStep } from './fakes/fake-scrum4me-mcp.js'
import { ideaChatPayload } from './fakes/idea-chat-payload.js'
import { seedProbe, seedProbes } from './fakes/probe-seed.js'
import { TEST_CONFIGURATION, testModelClients, testRunLogInit, testWorkerConfig } from './fakes/worker-config.js'
import { dirContains, jobRunDirs, readTrace, tmp } from './helpers.js'

type ModelFake = Awaited<ReturnType<typeof startFakeModelServer>>
type McpFake = Awaited<ReturnType<typeof startFakeScrum4meMcp>>
let model: ModelFake | undefined
let mcp: McpFake | undefined
afterEach(async () => {
  await model?.close()
  await mcp?.close()
  model = undefined
  mcp = undefined
})

const answer = (text: string, extra: { usage?: { prompt_tokens: number; completion_tokens: number } | null } = {}): FakeTurn =>
  ({ body: completion({ content: text, model: 'qwen3-coder:30b', ...extra }) })

type Setup = {
  claims: ClaimStep[]
  script?: FakeTurn[]
  once?: boolean
  limits?: Partial<{ maxTurns: number; maxOutputTokens: number; maxWallSeconds: number; maxToolErrors: number }>
  /** Replaces the configurations of the worker (the default is one local configuration, TEST_CONFIGURATION). */
  configurations?: Record<string, unknown>
  failUpdate?: Array<'running' | 'done' | 'failed'>
  signal?: AbortSignal
  apiKey?: string
  heartbeatMs?: number
  requestTimeoutMs?: number
}

async function setup(s: Setup) {
  model = await startFakeModelServer(s.script ?? [])
  mcp = await startFakeScrum4meMcp({ claims: s.claims, failUpdate: s.failUpdate })
  const config = testWorkerConfig(
    {
      limits: { maxTurns: 4, maxOutputTokens: 2048, maxWallSeconds: 30, maxToolErrors: 2, ...s.limits },
      waitSeconds: 1,
      ...(s.configurations ? { configurations: s.configurations } : {}),
    },
    model.baseUrl,
  )
  const out = tmp('worker')
  seedProbes(config, out) // every configuration has an accepted probe, unless a test takes it away (M45-2d T-2066)
  const runLogDir = tmp('runlog')
  const logs: string[] = []
  const client = mcp.client
  const deps: WorkerDeps = {
    control: createControlChannel(client, s.requestTimeoutMs ? { requestTimeoutMs: s.requestTimeoutMs } : {}),
    registryView: (signal) => createRegistryView(client, config.allow, signal),
    modelClients: testModelClients(config, s.apiKey),
    config,
    out,
    once: s.once ?? true,
    signal: s.signal ?? new AbortController().signal,
    heartbeatMs: s.heartbeatMs ?? 50,
    errorBackoffMs: 0,
    log: (line) => logs.push(line),
    // M4 Taak 5: every test drives a real run-log writer (spec §6.3 is best-effort, so this must never
    // change a job outcome); individual tests below override runLogFor for their own scenario.
    runLogFor: (claim) => openRunLog({ dir: runLogDir, pool: 'harness', instance: 'test' }, testRunLogInit(config, claim)),
  }
  return { deps, out, runLogDir, logs, mcp, model, run: () => runWorker(deps) }
}

const controlCalls = (m: McpFake) => m.calls.filter((c) => c.name === 'update_job_status').map((c) => c.args)
const job = (payload: unknown = ideaChatPayload()): ClaimStep => ({ job: payload })

// ---- run-log helpers (M4 Taak 5) ----

const runLogRunsDir = (dir: string): string => join(dir, 'harness', 'test', 'runs')

function runLogLines(dir: string): string[] {
  const runsDir = runLogRunsDir(dir)
  const files = readdirSync(runsDir).filter((f) => f.endsWith('.log'))
  expect(files).toHaveLength(1)
  return readFileSync(join(runsDir, files[0]), 'utf8').trim().split('\n')
}

function runLogJsonLines(dir: string): Array<Record<string, unknown> & { type: string }> {
  return runLogLines(dir)
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
}

describe('runWorker — a successful turn', () => {
  it('marks running, then done with the answer, model_id and tokens; writes the run dir', async () => {
    const t = await setup({ claims: [job()], script: [answer('Zie de worker-runbook.', { usage: { prompt_tokens: 120, completion_tokens: 30 } })] })
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'done' }], exitCode: 0 })
    expect(t.mcp.calls.map((c) => c.name).filter((n) => n !== 'job_heartbeat')).toEqual(['wait_for_job', 'update_job_status', 'update_job_status'])
    expect(controlCalls(t.mcp)).toEqual([
      { job_id: 'job1', status: 'running' },
      { job_id: 'job1', status: 'done', summary: 'Zie de worker-runbook.', model_id: 'qwen3-coder:30b', input_tokens: 120, output_tokens: 30 },
    ])
    const dirs = jobRunDirs(t.out)
    expect(dirs).toHaveLength(1)
    expect(dirs[0]).toMatch(/^job-job1-\d+$/)
    expect(existsSync(join(t.out, dirs[0], 'result.json'))).toBe(true)
    expect(readTrace(join(t.out, dirs[0]))[0]).toMatchObject({ type: 'run_start', job: { jobId: 'job1', ideaId: 'idea1' } })
  })

  it('gives the model the real product id, and a doc search with it succeeds', async () => {
    const t = await setup({
      claims: [job()],
      script: [
        { body: completion({ toolCalls: [{ id: 'c1', name: 'search_product_docs', arguments: { product_id: 'prod-harness', query: 'worker' } }] }) },
        answer('Er is een worker-runbook.'),
      ],
    })
    await t.run()
    expect(JSON.stringify(t.model.requests[0].body.messages)).toContain('Product-id (voor elke doc-tool): prod-harness')
    expect(t.mcp.calls.find((c) => c.name === 'search_product_docs')?.args).toEqual({ product_id: 'prod-harness', query: 'worker' })
    expect(controlCalls(t.mcp).at(-1)).toMatchObject({ status: 'done', summary: 'Er is een worker-runbook.' })
  })

  it('answers the pending message of a coalesced follow-up', async () => {
    const payload = ideaChatPayload({
      messages: [
        { id: 'a', role: 'USER', kind: 'TEXT', content: 'Vraag A', created_at: '2026-09-26T10:00:00.000Z' },
        { id: 'b', role: 'USER', kind: 'TEXT', content: 'Vraag B', created_at: '2026-09-26T10:00:05.000Z' },
        { id: 'c', role: 'ASSISTANT', kind: 'TEXT', content: 'Antwoord A', created_at: '2026-09-26T10:00:30.000Z' },
      ],
      pending: ['b'],
    })
    const t = await setup({ claims: [job(payload)], script: [answer('Antwoord B')] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('done')
    const user = t.model.requests[0].body.messages.find((m: { role: string }) => m.role === 'user').content as string
    expect(user.slice(user.indexOf('## Te beantwoorden'))).toContain('Vraag B')
  })

  it('handles the same job claimed twice in one out dir', async () => {
    const t = await setup({ claims: [job(), job()], script: [answer('een'), answer('twee')], once: false })
    const stop = new AbortController()
    t.deps.signal = stop.signal
    const origUpdate = t.deps.control.updateStatus.bind(t.deps.control)
    let done = 0
    t.deps.control = {
      ...t.deps.control,
      updateStatus: async (id, input) => {
        const r = await origUpdate(id, input)
        if (input.status === 'done' && ++done === 2) stop.abort()
        return r
      },
    }
    const r = await t.run()
    expect(r.jobs.map((j) => j.outcome)).toEqual(['done', 'done'])
    expect(jobRunDirs(t.out)).toHaveLength(2)
  })
})

describe('runWorker — ownership and failures', () => {
  it('abandons without a model call when running is refused', async () => {
    const t = await setup({ claims: [job()], script: [answer('nee')], failUpdate: ['running'] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('abandoned')
    expect(t.model.requests).toHaveLength(0)
    expect(controlCalls(t.mcp).map((c) => c.status)).toEqual(['running'])
  })

  it('never lets a model call to update_job_status reach the server', async () => {
    const t = await setup({
      claims: [job()],
      script: [
        { body: completion({ toolCalls: [{ id: 'c1', name: 'update_job_status', arguments: { job_id: 'job1', status: 'done', summary: 'gehackt' } }] }) },
        answer('Toch een antwoord.'),
      ],
    })
    await t.run()
    expect(controlCalls(t.mcp)).toHaveLength(2)
    expect(controlCalls(t.mcp).map((c) => c.summary)).not.toContain('gehackt')
    const dir = join(t.out, jobRunDirs(t.out)[0])
    expect(readTrace(dir).find((e) => e.type === 'tool_result')).toMatchObject({ errorCode: 'UNKNOWN_TOOL' })
  })

  it('fails with timed_out when the model is slower than maxWallSeconds', async () => {
    const t = await setup({ claims: [job()], script: [{ ...answer('te laat'), delayMs: 3000 }], limits: { maxWallSeconds: 1 } })
    await t.run()
    expect(controlCalls(t.mcp).at(-1)).toMatchObject({ status: 'failed' })
    expect(String(controlCalls(t.mcp).at(-1)?.error)).toMatch(/^timed_out:/)
  })

  it('fails with MODEL_ERROR on HTTP 500', async () => {
    const t = await setup({ claims: [job()], script: [{ status: 500, body: { error: { message: 'boom' } } }] })
    await t.run()
    expect(String(controlCalls(t.mcp).at(-1)?.error)).toContain('MODEL_ERROR')
  })

  it('fails on a whitespace-only answer', async () => {
    const t = await setup({ claims: [job()], script: [answer('   \n')] })
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'failed' }], exitCode: 1 })
    expect(controlCalls(t.mcp).at(-1)).toEqual({ job_id: 'job1', status: 'failed', error: 'leeg antwoord van qwen3-coder:30b' })
  })

  it('fails without a model call when nothing is pending', async () => {
    const t = await setup({ claims: [job(ideaChatPayload({ pending: [] }))], script: [answer('nee')] })
    await t.run()
    expect(t.model.requests).toHaveLength(0)
    expect(controlCalls(t.mcp)).toEqual([{ job_id: 'job1', status: 'failed', error: 'geen onbeantwoord USER-bericht' }])
  })

  it('fails an unsupported kind without a model call', async () => {
    const t = await setup({ claims: [job({ ...ideaChatPayload(), kind: 'PR_REVIEW' })], script: [answer('nee')] })
    await t.run()
    expect(t.model.requests).toHaveLength(0)
    expect(controlCalls(t.mcp)).toEqual([{ job_id: 'job1', status: 'failed', error: 'kind PR_REVIEW niet ondersteund door agent-harness' }])
  })

  it('fails an invalid payload without a model call', async () => {
    const payload = ideaChatPayload() as unknown as { chat: Record<string, unknown> }
    delete payload.chat.pending_user_message_ids
    const t = await setup({ claims: [job(payload)], script: [answer('nee')] })
    await t.run()
    expect(t.model.requests).toHaveLength(0)
    expect(String(controlCalls(t.mcp).at(-1)?.error)).toMatch(/^payload ongeldig: /)
  })

  it('abandons when a heartbeat reports lost ownership during a slow turn', async () => {
    const t = await setup({ claims: [job()], script: [{ ...answer('te laat'), delayMs: 2000 }], heartbeatMs: 30 })
    t.mcp.state.heartbeatOk = false
    const started = Date.now()
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('abandoned')
    expect(Date.now() - started).toBeLessThan(1500)
    expect(controlCalls(t.mcp).map((c) => c.status)).toEqual(['running'])
  })

  it('sends heartbeats during a long run', async () => {
    const t = await setup({ claims: [job()], script: [{ ...answer('klaar'), delayMs: 300 }], heartbeatMs: 50 })
    await t.run()
    expect(t.mcp.calls.filter((c) => c.name === 'job_heartbeat').length).toBeGreaterThanOrEqual(2)
    expect(t.mcp.calls.find((c) => c.name === 'job_heartbeat')?.args).toEqual({ job_id: 'job1' })
  })

  it('logs a failing done update and still returns', async () => {
    const t = await setup({ claims: [job()], script: [answer('antwoord')], failUpdate: ['done'] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('done')
    expect(t.logs.join('\n')).toMatch(/update_job_status\(done\).*already terminal/)
    expect(controlCalls(t.mcp).filter((c) => c.status === 'done')).toHaveLength(1)
  })

  it('fails with "worker gestopt" when stopped during a job', async () => {
    const stop = new AbortController()
    const t = await setup({ claims: [job()], script: [{ ...answer('te laat'), delayMs: 3000 }], signal: stop.signal })
    setTimeout(() => stop.abort(), 150)
    const r = await t.run()
    expect(r.exitCode).toBe(0)
    expect(controlCalls(t.mcp).at(-1)).toEqual({ job_id: 'job1', status: 'failed', error: 'worker gestopt' })
  })

  it('truncates an answer above 4000 characters with a visible marker', async () => {
    const t = await setup({ claims: [job()], script: [answer('x'.repeat(5000))] })
    await t.run()
    const summary = String(controlCalls(t.mcp).at(-1)?.summary)
    expect(summary.length).toBeLessThanOrEqual(4000)
    expect(summary.endsWith('_[antwoord afgekapt]_')).toBe(true)
  })

  it('keeps the api key out of the run dir', async () => {
    const t = await setup({ claims: [job()], script: [answer('ok')], apiKey: 'sk-test-secret' })
    await t.run()
    expect(t.model.requests[0].headers.authorization).toBe('Bearer sk-test-secret')
    expect(dirContains(t.out, 'sk-test-secret')).toBe(false)
    expect(t.logs.join('\n')).not.toContain('sk-test-secret')
  })
})

describe('runWorker — the claim loop', () => {
  it('exits 0 after a timeout with --once', async () => {
    const t = await setup({ claims: [{ timeout: true }] })
    expect(await t.run()).toEqual({ jobs: [], exitCode: 0 })
  })

  it('exits 1 on a wait_for_job tool error with --once', async () => {
    const t = await setup({ claims: [{ error: 'Job claimed but context fetch failed' }] })
    const r = await t.run()
    expect(r.exitCode).toBe(1)
    expect(t.logs.join('\n')).toContain('Job claimed but context fetch failed')
  })

  it('carries on after a tool error without --once', async () => {
    const stop = new AbortController()
    const t = await setup({ claims: [{ error: 'Job claimed but context fetch failed' }, job()], script: [answer('ok')], once: false, signal: stop.signal })
    const orig = t.deps.control.updateStatus.bind(t.deps.control)
    t.deps.control = { ...t.deps.control, updateStatus: async (id, input) => { const r = await orig(id, input); if (input.status === 'done') stop.abort(); return r } }
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'done' }], exitCode: 0 })
  })

  it('stops a closed connection as broken after one attempt', async () => {
    const t = await setup({ claims: [job()], once: false })
    await t.mcp.client.close()
    const spy = vi.spyOn(t.mcp.client, 'callTool')
    const r = await t.run()
    expect(r.exitCode).toBe(1)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(t.logs.join('\n')).toMatch(/MCP-verbinding/)
  })

  it('stops as broken on a request timeout while the handler still runs, without a second wait_for_job', async () => {
    const t = await setup({ claims: [{ hangMs: 1500 }, job()], once: false, requestTimeoutMs: 100 })
    const r = await t.run()
    expect(r.exitCode).toBe(1)
    expect(t.mcp.calls.filter((c) => c.name === 'wait_for_job')).toHaveLength(1)
  })

  it('stops cleanly when the signal fires while wait_for_job is pending', async () => {
    const stop = new AbortController()
    const t = await setup({ claims: [{ hangMs: 1500 }], once: false, signal: stop.signal })
    const spy = vi.spyOn(t.mcp.client, 'callTool')
    setTimeout(() => stop.abort(), 100)
    const r = await t.run()
    expect(r).toEqual({ jobs: [], exitCode: 0 })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(t.logs.join('\n')).not.toMatch(/MCP-verbinding/)
  })
})

/**
 * Stops the worker after `n` wait_for_job attempts, so a worker that wrongly keeps looping fails its test instead of hanging it
 * (an in-memory MCP answers without ever yielding to a timer, so a time-based stop would never fire).
 */
function stopAfterWaits(t: { deps: WorkerDeps }, n: number): void {
  const stop = new AbortController()
  let waits = 0
  const wait = t.deps.control.waitForJob.bind(t.deps.control)
  t.deps.signal = stop.signal
  t.deps.control = { ...t.deps.control, waitForJob: async (seconds, signal) => { if (++waits > n) stop.abort(); return wait(seconds, signal) } }
}

describe('runWorker — runtime mismatch (M45-2d)', () => {
  it('exits 78 on a RUNTIME_MISMATCH tool error of wait_for_job, touches no job and does not wait again', async () => {
    const t = await setup({ claims: [{ runtimeMismatch: true }, job()], script: [answer('nee')], once: false })
    stopAfterWaits(t, 3)
    const r = await t.run()
    expect(r).toEqual({ jobs: [], exitCode: 78 })
    expect(controlCalls(t.mcp)).toEqual([])
    expect(t.mcp.calls.filter((c) => c.name === 'wait_for_job')).toHaveLength(1)
    expect(t.model.requests).toHaveLength(0)
    expect(t.logs.join('\n')).toContain('RUNTIME_MISMATCH')
  })

  it('treats another tool error that merely contains the text as an ordinary tool error', async () => {
    const t = await setup({ claims: [{ error: 'Worktree creation failed: RUNTIME_MISMATCH in de naam' }], once: true })
    const r = await t.run()
    expect(r.exitCode).toBe(1)
  })

  it('exits 78 on a claimed payload with config.runtime CLAUDE, without update_job_status or a model call', async () => {
    const t = await setup({ claims: [job(ideaChatPayload({ runtime: 'CLAUDE' })), job()], script: [answer('nee')], once: false })
    stopAfterWaits(t, 3)
    const r = await t.run()
    expect(r.exitCode).toBe(78)
    expect(controlCalls(t.mcp)).toEqual([])
    expect(t.mcp.calls.filter((c) => c.name === 'wait_for_job')).toHaveLength(1)
    expect(t.model.requests).toHaveLength(0)
    expect(t.logs.join('\n')).toContain('RUNTIME_MISMATCH (eigen controle)')
  })

  it('reads a payload without config.runtime as a mismatch too, never as HARNESS', async () => {
    const payload = ideaChatPayload() as unknown as { config: Record<string, unknown> }
    delete payload.config.runtime
    const t = await setup({ claims: [job(payload)], script: [answer('nee')], once: false })
    stopAfterWaits(t, 3)
    const r = await t.run()
    expect(r.exitCode).toBe(78)
    expect(controlCalls(t.mcp)).toEqual([])
  })

  it('does not write a run-log for the refused claim', async () => {
    const t = await setup({ claims: [job(ideaChatPayload({ runtime: 'CLAUDE' }))], once: false })
    stopAfterWaits(t, 3)
    await t.run()
    expect(existsSync(runLogRunsDir(t.runLogDir))).toBe(false)
  })
})

describe('createControlChannel', () => {
  it('passes a request timeout of at least waitSeconds + 30 s and the signal', async () => {
    mcp = await startFakeScrum4meMcp({ claims: [{ timeout: true }] })
    const spy = vi.spyOn(mcp.client, 'callTool')
    const signal = new AbortController().signal
    const r = await createControlChannel(mcp.client).waitForJob(20, signal)
    expect(r).toEqual({ type: 'timeout' })
    expect(spy).toHaveBeenCalledWith({ name: 'wait_for_job', arguments: { wait_seconds: 20 } }, undefined, expect.objectContaining({ signal }))
    expect((spy.mock.calls[0][2] as { timeout: number }).timeout).toBeGreaterThanOrEqual(50_000)
  })

  it('maps an SDK rejection to broken and a server error to error', async () => {
    mcp = await startFakeScrum4meMcp({ claims: [{ error: 'kapot' }] })
    const control = createControlChannel(mcp.client)
    expect(await control.waitForJob(1, new AbortController().signal)).toEqual({ type: 'error', message: 'kapot' })
    vi.spyOn(mcp.client, 'callTool').mockRejectedValueOnce(new McpError(ErrorCode.RequestTimeout, 'Request timed out'))
    expect(await control.waitForJob(1, new AbortController().signal)).toMatchObject({ type: 'broken' })
  })

  it('returns the job with id, kind and payload', async () => {
    mcp = await startFakeScrum4meMcp({ claims: [job()] })
    const r = await createControlChannel(mcp.client).waitForJob(1, new AbortController().signal)
    expect(r).toMatchObject({ type: 'job', jobId: 'job1', kind: 'IDEA_CHAT' })
  })

  it('updateStatus returns the real outcome (status/branch/pushedAt/error), not just ok', async () => {
    mcp = await startFakeScrum4meMcp({ updateOutcome: { done: { status: 'failed', error: 'push failed' } } })
    const control = createControlChannel(mcp.client)
    const r = await control.updateStatus('job1', { status: 'done', summary: 'klaar' })
    expect(r).toEqual({ ok: true, status: 'failed', branch: null, pushedAt: null, error: 'push failed' })
  })

  it('updateStatus keeps working for callers that only read ok (idea-chat)', async () => {
    mcp = await startFakeScrum4meMcp()
    const control = createControlChannel(mcp.client)
    const r = await control.updateStatus('job1', { status: 'running' })
    expect(r.ok).toBe(true)
  })

  it('updateStatus classifies a thrown call (a timeout) as unknown, not a definite refusal (Fix 3 / P12)', async () => {
    mcp = await startFakeScrum4meMcp()
    const control = createControlChannel(mcp.client)
    vi.spyOn(mcp.client, 'callTool').mockRejectedValueOnce(new McpError(ErrorCode.RequestTimeout, 'Request timed out'))
    const r = await control.updateStatus('job1', { status: 'done', summary: 'klaar' })
    expect(r.ok).toBe(false)
    expect(r.unknown).toBe(true)
    expect(r.message).toMatch(/timed out/i)
  })

  it('updateStatus keeps an isError refusal distinct from unknown (no unknown flag)', async () => {
    mcp = await startFakeScrum4meMcp()
    const control = createControlChannel(mcp.client)
    vi.spyOn(mcp.client, 'callTool').mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'Job already terminal' }] })
    const r = await control.updateStatus('job1', { status: 'done', summary: 'klaar' })
    expect(r).toEqual({ ok: false, message: 'Job already terminal' })
  })

  it('gives a done update an explicit 300s request timeout, unlike running/failed (Fix 3 / P12)', async () => {
    mcp = await startFakeScrum4meMcp()
    const control = createControlChannel(mcp.client)
    const spy = vi.spyOn(mcp.client, 'callTool')
    await control.updateStatus('job1', { status: 'done', summary: 'klaar' })
    expect(spy).toHaveBeenCalledWith({ name: 'update_job_status', arguments: expect.objectContaining({ status: 'done' }) }, undefined, expect.objectContaining({ timeout: 300_000 }))
    spy.mockClear()
    await control.updateStatus('job1', { status: 'running' })
    const runningOpts = spy.mock.calls[0]?.[2] as { timeout?: number } | undefined
    expect(runningOpts?.timeout).not.toBe(300_000)
    spy.mockClear()
    await control.updateStatus('job1', { status: 'failed', error: 'x' })
    const failedOpts = spy.mock.calls[0]?.[2] as { timeout?: number } | undefined
    expect(failedOpts?.timeout).not.toBe(300_000)
  })

  it('updateTaskStatus sends task_id and status to update_task_status', async () => {
    mcp = await startFakeScrum4meMcp()
    const control = createControlChannel(mcp.client)
    const r = await control.updateTaskStatus('task-1', 'in_progress')
    expect(r).toEqual({ ok: true })
    expect(mcp.calls.filter((c) => c.name === 'update_task_status')).toEqual([{ name: 'update_task_status', args: { task_id: 'task-1', status: 'in_progress' } }])
  })

  it('updateTaskStatus reports a tool error as ok:false', async () => {
    mcp = await startFakeScrum4meMcp()
    const control = createControlChannel(mcp.client)
    vi.spyOn(mcp.client, 'callTool').mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'task niet gevonden' }] })
    const r = await control.updateTaskStatus('task-1', 'review')
    expect(r).toEqual({ ok: false, message: 'task niet gevonden' })
  })

  it('verifyTaskAgainstPlan sends task_id and worktree_path and parses the result', async () => {
    mcp = await startFakeScrum4meMcp({ verifyResult: 'partial' })
    const control = createControlChannel(mcp.client)
    const r = await control.verifyTaskAgainstPlan('task-1', '/var/lib/agent-harness/worktrees/task-1')
    expect(r).toEqual({ ok: true, result: 'partial' })
    expect(mcp.calls.filter((c) => c.name === 'verify_task_against_plan')).toEqual([
      { name: 'verify_task_against_plan', args: { task_id: 'task-1', worktree_path: '/var/lib/agent-harness/worktrees/task-1' } },
    ])
  })

  it('verifyTaskAgainstPlan reports a tool error as ok:false', async () => {
    mcp = await startFakeScrum4meMcp()
    const control = createControlChannel(mcp.client)
    vi.spyOn(mcp.client, 'callTool').mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'geen plan' }] })
    const r = await control.verifyTaskAgainstPlan('task-1', '/wt')
    expect(r).toEqual({ ok: false, message: 'geen plan' })
  })

  it('verifyTaskAgainstPlan classifies a thrown call as unknown too (Fix 3 / P12)', async () => {
    mcp = await startFakeScrum4meMcp()
    const control = createControlChannel(mcp.client)
    vi.spyOn(mcp.client, 'callTool').mockRejectedValueOnce(new McpError(ErrorCode.RequestTimeout, 'Request timed out'))
    const r = await control.verifyTaskAgainstPlan('task-1', '/wt')
    expect(r.ok).toBe(false)
    expect(r.unknown).toBe(true)
  })

  it('gives verify_task_against_plan an explicit 300s request timeout (Fix 3 / P12)', async () => {
    mcp = await startFakeScrum4meMcp()
    const control = createControlChannel(mcp.client)
    const spy = vi.spyOn(mcp.client, 'callTool')
    await control.verifyTaskAgainstPlan('task-1', '/wt')
    expect(spy).toHaveBeenCalledWith(
      { name: 'verify_task_against_plan', arguments: { task_id: 'task-1', worktree_path: '/wt' } },
      undefined,
      expect.objectContaining({ timeout: 300_000 }),
    )
  })

  it('log sends the right argument names for implementation, commit and test', async () => {
    mcp = await startFakeScrum4meMcp()
    const control = createControlChannel(mcp.client)
    await control.log('implementation', { storyId: 'story-1', taskId: 'task-1', content: 'gestart' })
    await control.log('commit', { storyId: 'story-1', taskId: 'task-1', content: 'commit', commitHash: 'abc123', commitMessage: 'feat: iets' })
    await control.log('test', { storyId: 'story-1', taskId: 'task-1', content: 'groen', status: 'PASSED' })
    expect(mcp.calls.filter((c) => c.name === 'log_implementation')).toEqual([{ name: 'log_implementation', args: { story_id: 'story-1', task_id: 'task-1', content: 'gestart' } }])
    expect(mcp.calls.filter((c) => c.name === 'log_commit')).toEqual([
      { name: 'log_commit', args: { story_id: 'story-1', task_id: 'task-1', content: 'commit', commit_hash: 'abc123', commit_message: 'feat: iets' } },
    ])
    expect(mcp.calls.filter((c) => c.name === 'log_test_result')).toEqual([
      { name: 'log_test_result', args: { story_id: 'story-1', task_id: 'task-1', content: 'groen', status: 'PASSED' } },
    ])
  })

  it('log is best-effort: a tool error or a rejected call never throws and never writes to the console', async () => {
    mcp = await startFakeScrum4meMcp()
    const control = createControlChannel(mcp.client)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(mcp.client, 'callTool').mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'kapot' }] })
    await expect(control.log('implementation', { storyId: 'story-1', taskId: 'task-1', content: 'x' })).resolves.toEqual({ ok: false, message: 'log_implementation mislukt: kapot' })
    vi.spyOn(mcp.client, 'callTool').mockRejectedValueOnce(new Error('verbinding weg'))
    await expect(control.log('commit', { storyId: 'story-1', taskId: 'task-1', content: 'x', commitHash: 'a', commitMessage: 'm' })).resolves.toEqual({ ok: false, message: 'log_commit mislukt: verbinding weg' })
    expect(await control.log('test', { storyId: 'story-1', taskId: 'task-1', content: 'x', status: 'PASSED' })).toEqual({ ok: true })
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})

describe('runWorker — review fixes', () => {
  it('stops after an unsupported kind: a wrong claim filter must not drain the queue', async () => {
    const t = await setup({ claims: [job({ ...ideaChatPayload(), kind: 'PR_REVIEW' }), job()], script: [answer('nee')], once: false })
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'failed' }], exitCode: 78 })
    expect(t.mcp.calls.filter((c) => c.name === 'wait_for_job')).toHaveLength(1)
    expect(t.logs.join('\n')).toMatch(/claimfilter/i)
  })

  it('stops after a payload without pending_user_message_ids (MCP without M2)', async () => {
    const payload = ideaChatPayload() as unknown as { chat: Record<string, unknown> }
    delete payload.chat.pending_user_message_ids
    const t = await setup({ claims: [job(payload), job()], script: [answer('nee')], once: false })
    const r = await t.run()
    expect(r.exitCode).toBe(78)
    expect(t.mcp.calls.filter((c) => c.name === 'wait_for_job')).toHaveLength(1)
  })

  it('makes no model call when Ctrl-C lands before the running update returns', async () => {
    const stop = new AbortController()
    const t = await setup({ claims: [job()], script: [answer('te laat')], signal: stop.signal })
    const orig = t.deps.control.updateStatus.bind(t.deps.control)
    t.deps.control = { ...t.deps.control, updateStatus: async (id, input) => { const r = await orig(id, input); if (input.status === 'running') stop.abort(); return r } }
    const r = await t.run()
    expect(r.exitCode).toBe(0)
    expect(t.model.requests).toHaveLength(0)
    expect(controlCalls(t.mcp).at(-1)).toEqual({ job_id: 'job1', status: 'failed', error: 'worker gestopt' })
  })

  it('keeps a completed answer when Ctrl-C lands after the run finished', async () => {
    const stop = new AbortController()
    const t = await setup({ claims: [job()], script: [answer('op tijd')], signal: stop.signal })
    const model = t.deps.modelClient
    t.deps.modelClient = { complete: async (messages, options) => { const r = await model.complete(messages, options); stop.abort(); return r } }
    await t.run()
    expect(controlCalls(t.mcp).at(-1)).toMatchObject({ status: 'done', summary: 'op tijd' })
  })

  it('survives one heartbeat exception but abandons after two in a row', async () => {
    const t = await setup({ claims: [job()], script: [{ ...answer('klaar'), delayMs: 400 }], heartbeatMs: 50 })
    let n = 0
    t.deps.control = { ...t.deps.control, heartbeat: async () => { n++; if (n === 1) throw new Error('hik'); return true } }
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('done')

    const u = await setup({ claims: [job()], script: [{ ...answer('te laat'), delayMs: 2000 }], heartbeatMs: 30 })
    u.deps.control = { ...u.deps.control, heartbeat: async () => { throw new Error('weg') } }
    const r2 = await u.run()
    expect(r2.jobs[0].outcome).toBe('abandoned')
  })
})

describe('runWorker — run-log (M4 Taak 5, spec §5.6/§6.4)', () => {
  it('idea-chat done: claimed, config, harness.run_start/turn/loop_end, and a closing block with outcome done, exit code=0 and the answer', async () => {
    const t = await setup({ claims: [job()], script: [answer('Zie de worker-runbook.', { usage: { prompt_tokens: 120, completion_tokens: 30 } })] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('done')
    const lines = runLogLines(t.runLogDir)
    expect(lines[0]).toMatch(/^\S+ \[harness\] claimed job_id=job1$/)
    expect(lines[1]).toMatch(/^\S+ \[harness\] config job_id=job1 runtime=HARNESS kind=IDEA_CHAT model=qwen3-coder-30b configuration=qwen3-coder-30b cost_mode=local max_cost_usd=0\.05 base_url=http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(lines).toContainEqual(expect.stringMatching(/^\S+ \[harness\] step job_status running$/))
    expect(lines).toContainEqual(expect.stringMatching(/^\S+ \[harness\] step job_status done$/))
    const jsonTypes = runLogJsonLines(t.runLogDir).map((j) => j.type)
    expect(jsonTypes).toEqual(expect.arrayContaining(['harness.run_start', 'harness.turn', 'harness.loop_end', 'harness.run_end']))
    const runEnd = runLogJsonLines(t.runLogDir).find((j) => j.type === 'harness.run_end')
    expect(runEnd).toMatchObject({ outcome: 'done', answer: 'Zie de worker-runbook.' })
    expect(lines.at(-1)).toBe(`${String(runEnd?.timestamp)} [harness] exit code=0`)
  })

  it('an empty answer writes ERROR JOB_FAILED in the closing block', async () => {
    const t = await setup({ claims: [job()], script: [answer('   \n')] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    const lines = runLogLines(t.runLogDir)
    expect(lines).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR JOB_FAILED: /))
    expect(lines.at(-1)).toMatch(/ exit code=1$/)
  })

  it('running refused writes ABANDONED', async () => {
    const t = await setup({ claims: [job()], script: [answer('nee')], failUpdate: ['running'] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('abandoned')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR ABANDONED: /))
  })

  it('a lost heartbeat writes ABANDONED', async () => {
    const t = await setup({ claims: [job()], script: [{ ...answer('te laat'), delayMs: 2000 }], heartbeatMs: 30 })
    t.mcp.state.heartbeatOk = false
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('abandoned')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR ABANDONED: /))
  })

  it('a stop mid-turn writes STOPPED', async () => {
    const stop = new AbortController()
    const t = await setup({ claims: [job()], script: [{ ...answer('te laat'), delayMs: 3000 }], signal: stop.signal })
    setTimeout(() => stop.abort(), 150)
    const r = await t.run()
    expect(r.exitCode).toBe(0)
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR STOPPED: worker gestopt$/))
  })

  it('an unsupported kind writes exactly one block with ERROR CLAIM_FILTER, and ClaimFilterError still reaches the worker loop', async () => {
    const t = await setup({ claims: [job({ ...ideaChatPayload(), kind: 'PR_REVIEW' }), job()], script: [answer('nee')], once: false })
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'failed' }], exitCode: 78 })
    const lines = runLogLines(t.runLogDir)
    expect(lines.filter((l) => l.includes('"type":"harness.run_end"'))).toHaveLength(1)
    expect(lines).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR CLAIM_FILTER: /))
  })

  it('an invalid payload (no pending_user_message_ids) writes exactly one block with ERROR CLAIM_FILTER, and ClaimFilterError still reaches the worker loop', async () => {
    const payload = ideaChatPayload() as unknown as { chat: Record<string, unknown> }
    delete payload.chat.pending_user_message_ids
    const t = await setup({ claims: [job(payload), job()], script: [answer('nee')], once: false })
    const r = await t.run()
    expect(r.exitCode).toBe(78)
    const lines = runLogLines(t.runLogDir)
    expect(lines.filter((l) => l.includes('"type":"harness.run_end"'))).toHaveLength(1)
    expect(lines).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR CLAIM_FILTER: /))
  })

  it('an injected unexpected error in the handler writes exactly one HARNESS_ERROR block, and the error keeps propagating unchanged', async () => {
    const t = await setup({ claims: [job()], script: [answer('ok')] })
    const boom = new Error('kapot onverwacht')
    const orig = t.deps.control.updateStatus.bind(t.deps.control)
    t.deps.control = {
      ...t.deps.control,
      updateStatus: async (id, input) => {
        if (input.status === 'done') throw boom
        return orig(id, input)
      },
    }
    await expect(t.run()).rejects.toThrow('kapot onverwacht')
    const lines = runLogLines(t.runLogDir)
    expect(lines.filter((l) => l.includes('"type":"harness.run_end"'))).toHaveLength(1)
    expect(lines).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR HARNESS_ERROR: kapot onverwacht$/))
    expect(lines.at(-1)).toMatch(/ exit code=1$/)
  })

  it('without runLogFor the worker behaves exactly as before: same outcome, and no run-log is written', async () => {
    const t = await setup({ claims: [job()], script: [answer('Zie de worker-runbook.')] })
    t.deps.runLogFor = undefined
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('done')
    expect(existsSync(runLogRunsDir(t.runLogDir))).toBe(false)
  })

  it('an unwritable run-log directory leaves the job outcome unchanged and logs exactly one line (Review Focus 4)', async () => {
    const t = await setup({ claims: [job()], script: [answer('ok')] })
    const blockerDir = tmp('runlog-blocker')
    const blockerFile = join(blockerDir, 'blocker') // a plain file where openRunLog expects a directory: mkdir fails
    writeFileSync(blockerFile, 'x')
    const runLogErrors: string[] = []
    t.deps.runLogFor = (claim) =>
      openRunLog(
        { dir: blockerFile, pool: 'harness', instance: 'test' },
        testRunLogInit(t.deps.config, claim, { log: (l: string) => runLogErrors.push(l) }),
      )
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('done')
    expect(runLogErrors).toHaveLength(1)
  })

  it('a runLogFor that throws gives the same outcome as no run-log at all, plus exactly one log line (Review F2)', async () => {
    const t = await setup({ claims: [job()], script: [answer('Zie de worker-runbook.')] })
    t.deps.runLogFor = () => {
      throw new Error('run-log kapot')
    }
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'done' }], exitCode: 0 }) // same as without runLogFor at all
    expect(t.logs.filter((l) => l.includes('run-log uitgeschakeld'))).toHaveLength(1)
    expect(t.logs.filter((l) => l.includes('run-log uitgeschakeld'))[0]).toMatch(/^run-log uitgeschakeld voor job job1: run-log kapot$/)
    expect(existsSync(runLogRunsDir(t.runLogDir))).toBe(false)
  })
})

// ---- the configuration and the cost ceiling of a job (M45-2d T-2065) ----

const harnessConfig = (model: unknown, maxCost: unknown = '0.05') => ({ runtime: 'HARNESS', model, max_cost_usd: maxCost })
const withoutCost = (model: unknown) => ({ runtime: 'HARNESS', model })
const COST_NONE = { reported_cost_usd: null, cost_source: 'none' }

describe('runWorker — the configuration of a job (M45-2d T-2065)', () => {
  const configurations = {
    'fast-local': { costMode: 'local', contextTokens: 32768, reasoningEffort: 'none' },
    'deep-hosted': { costMode: 'hosted', contextTokens: 32768, reasoningEffort: 'high', extraBody: { temperature: 0.7 } },
    tiny: { costMode: 'local', contextTokens: 1100 },
  }
  const manifestOf = (out: string, dirIndex: number) => {
    const dir = join(out, jobRunDirs(out).sort()[dirIndex])
    return readTrace(dir)[0] as { manifest: { model: Record<string, unknown>; limits: Record<string, unknown> } }
  }

  it('gives each job the model client, the reasoning effort and the context window of its own configuration', async () => {
    const t = await setup({
      claims: [job(ideaChatPayload({ jobId: 'a', config: harnessConfig('fast-local') })), job(ideaChatPayload({ jobId: 'b', config: harnessConfig('deep-hosted') })), job(ideaChatPayload({ jobId: 'c', config: harnessConfig('tiny') }))],
      script: [answer('een'), answer('twee'), answer('drie')],
      configurations,
      once: false,
    })
    stopAfterWaits(t, 3)
    const r = await t.run()
    expect(r.jobs).toEqual([{ jobId: 'a', outcome: 'done' }, { jobId: 'b', outcome: 'done' }, { jobId: 'c', outcome: 'failed' }])
    // Each request carries the name of its configuration, and that configuration's own request fields.
    expect(t.model.requests).toHaveLength(2)
    expect(t.model.requests[0].body).toMatchObject({ model: 'fast-local', reasoning_effort: 'none' })
    expect(t.model.requests[0].body).not.toHaveProperty('temperature')
    expect(t.model.requests[1].body).toMatchObject({ model: 'deep-hosted', reasoning_effort: 'high', temperature: 0.7 })
    // The manifest of each run names its configuration, the LiteLLM address and its context window.
    const base = t.deps.config.litellm.baseUrl
    expect(manifestOf(t.out, 0).manifest.model).toEqual({ baseUrl: base, name: 'fast-local', reasoningEffort: 'none' })
    expect(manifestOf(t.out, 0).manifest.limits).toMatchObject({ contextTokens: 32768, maxTurns: 4 })
    expect(manifestOf(t.out, 1).manifest.model).toEqual({ baseUrl: base, name: 'deep-hosted', reasoningEffort: 'high', extraBody: { temperature: 0.7 } })
    // The compaction of the third job works inside its own, small window: no request, CONTEXT_EXHAUSTED.
    expect(controlCalls(t.mcp).at(-1)).toMatchObject({ job_id: 'c', status: 'failed' })
    expect(String(controlCalls(t.mcp).at(-1)?.error)).toContain('contextTokens=1100')
    expect(manifestOf(t.out, 2).manifest.limits).toMatchObject({ contextTokens: 1100 })
  })

  it('reports the configuration name as model_id when the provider does not name a model', async () => {
    const noModel = { body: { ...completion({ content: 'Antwoord.' }), model: undefined } }
    const t = await setup({ claims: [job()], script: [noModel] })
    await t.run()
    expect(controlCalls(t.mcp).at(-1)).toMatchObject({ status: 'done', model_id: TEST_CONFIGURATION })
  })

  it('reports the model the provider named when it does', async () => {
    const t = await setup({ claims: [job()], script: [answer('Antwoord.')] })
    await t.run()
    expect(controlCalls(t.mcp).at(-1)).toMatchObject({ status: 'done', model_id: 'qwen3-coder:30b' })
  })

  it('fails an unknown configuration as UNKNOWN_CONFIGURATION with no running and no model call, and claims the next job', async () => {
    const t = await setup({ claims: [job(ideaChatPayload({ jobId: 'bad', config: harnessConfig('nope') })), job(ideaChatPayload({ jobId: 'good' }))], script: [answer('Antwoord.')], once: false })
    stopAfterWaits(t, 2)
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'bad', outcome: 'failed' }, { jobId: 'good', outcome: 'done' }], exitCode: 0 })
    expect(controlCalls(t.mcp)).toEqual([
      { job_id: 'bad', status: 'failed', error: 'UNKNOWN_CONFIGURATION: nope', cost: COST_NONE },
      { job_id: 'good', status: 'running' },
      expect.objectContaining({ job_id: 'good', status: 'done' }),
    ])
    expect(t.model.requests).toHaveLength(1)
    expect(t.logs.join('\n')).not.toMatch(/RUNTIME_MISMATCH|Worker stopt/)
  })

  it.each([
    ['a name that is no string', 42, 'UNKNOWN_CONFIGURATION: 42'],
    ['a missing name', undefined, 'UNKNOWN_CONFIGURATION: ontbrekend'],
    ['a name that is an Object.prototype member', 'constructor', 'UNKNOWN_CONFIGURATION: constructor'],
    ['__proto__', '__proto__', 'UNKNOWN_CONFIGURATION: __proto__'],
    ['a name with other case', 'QWEN3-CODER-30B', 'UNKNOWN_CONFIGURATION: QWEN3-CODER-30B'],
  ])('fails %s as UNKNOWN_CONFIGURATION', async (_what, name, error) => {
    const t = await setup({ claims: [job(ideaChatPayload({ config: harnessConfig(name) }))], script: [answer('nee')] })
    const r = await t.run()
    expect(r.jobs).toEqual([{ jobId: 'job1', outcome: 'failed' }])
    expect(controlCalls(t.mcp)).toEqual([{ job_id: 'job1', status: 'failed', error, cost: COST_NONE }])
    expect(t.model.requests).toHaveLength(0)
  })

  it('cuts a very long configuration name in the failure text', async () => {
    const t = await setup({ claims: [job(ideaChatPayload({ config: harnessConfig('x'.repeat(5000)) }))], script: [answer('nee')] })
    await t.run()
    const error = String(controlCalls(t.mcp).at(-1)?.error)
    expect(error.startsWith('UNKNOWN_CONFIGURATION: xxx')).toBe(true)
    expect(error.length).toBeLessThan(200)
  })

  it('writes the failure to the run-log as ERROR UNKNOWN_CONFIGURATION', async () => {
    const t = await setup({ claims: [job(ideaChatPayload({ config: harnessConfig('nope') }))], script: [answer('nee')] })
    await t.run()
    const lines = runLogLines(t.runLogDir)
    expect(lines).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR UNKNOWN_CONFIGURATION: nope$/))
    expect(lines.at(-1)).toMatch(/ exit code=1$/)
  })
})

describe('runWorker — the cost ceiling of a job (M45-2d T-2065)', () => {
  it.each([
    ['missing', withoutCost(TEST_CONFIGURATION), 'COST_LIMIT_MISSING: ontbrekend'],
    ["'0'", harnessConfig(TEST_CONFIGURATION, '0'), 'COST_LIMIT_MISSING: 0'],
    ["'0.00'", harnessConfig(TEST_CONFIGURATION, '0.00'), 'COST_LIMIT_MISSING: 0.00'],
    ["'abc'", harnessConfig(TEST_CONFIGURATION, 'abc'), 'COST_LIMIT_MISSING: abc'],
    ["'1e-2'", harnessConfig(TEST_CONFIGURATION, '1e-2'), 'COST_LIMIT_MISSING: 1e-2'],
    ['-1 as a number', harnessConfig(TEST_CONFIGURATION, -1), 'COST_LIMIT_MISSING: -1'],
    ["'-1'", harnessConfig(TEST_CONFIGURATION, '-1'), 'COST_LIMIT_MISSING: -1'],
    ['0.05 as a number, not a decimal string', harnessConfig(TEST_CONFIGURATION, 0.05), 'COST_LIMIT_MISSING: 0.05'],
    ['null', harnessConfig(TEST_CONFIGURATION, null), 'COST_LIMIT_MISSING: null'],
    ['empty', harnessConfig(TEST_CONFIGURATION, ''), 'COST_LIMIT_MISSING: '],
    ["'.5'", harnessConfig(TEST_CONFIGURATION, '.5'), 'COST_LIMIT_MISSING: .5'],
    ["'1.'", harnessConfig(TEST_CONFIGURATION, '1.'), 'COST_LIMIT_MISSING: 1.'],
    ["' 0.05'", harnessConfig(TEST_CONFIGURATION, ' 0.05'), 'COST_LIMIT_MISSING:  0.05'],
    ["'0.05\\n'", harnessConfig(TEST_CONFIGURATION, '0.05\n'), 'COST_LIMIT_MISSING: "0.05\\n"'],
    ["'Infinity'", harnessConfig(TEST_CONFIGURATION, 'Infinity'), 'COST_LIMIT_MISSING: Infinity'],
  ])('fails a ceiling that is %s as COST_LIMIT_MISSING, without running and without a model call', async (_what, config, error) => {
    const t = await setup({ claims: [job(ideaChatPayload({ config }))], script: [answer('nee')] })
    const r = await t.run()
    expect(r.jobs).toEqual([{ jobId: 'job1', outcome: 'failed' }])
    expect(controlCalls(t.mcp)).toEqual([{ job_id: 'job1', status: 'failed', error, cost: COST_NONE }])
    expect(t.model.requests).toHaveLength(0)
  })

  it('claims the next job after one without a ceiling', async () => {
    const t = await setup({ claims: [job(ideaChatPayload({ jobId: 'bad', config: withoutCost(TEST_CONFIGURATION) })), job(ideaChatPayload({ jobId: 'good' }))], script: [answer('Antwoord.')], once: false })
    stopAfterWaits(t, 2)
    const r = await t.run()
    expect(r.jobs).toEqual([{ jobId: 'bad', outcome: 'failed' }, { jobId: 'good', outcome: 'done' }])
  })

  it.each(['0.05', '0.50', '1', '10.25', '0.000001', '007.5'])('accepts the ceiling %s and runs the job', async (maxCost) => {
    const t = await setup({ claims: [job(ideaChatPayload({ config: harnessConfig(TEST_CONFIGURATION, maxCost) }))], script: [answer('Antwoord.')] })
    const r = await t.run()
    expect(r.jobs).toEqual([{ jobId: 'job1', outcome: 'done' }])
    expect(controlCalls(t.mcp).map((c) => c.status)).toEqual(['running', 'done'])
  })

  it('checks the configuration before the ceiling', async () => {
    const t = await setup({ claims: [job(ideaChatPayload({ config: withoutCost('nope') }))] })
    await t.run()
    expect(controlCalls(t.mcp).at(-1)).toMatchObject({ error: 'UNKNOWN_CONFIGURATION: nope' })
  })
})

// ---- the probe gate per job (M45-2d T-2066) ----

describe('runWorker — the probe gate per job (M45-2d T-2066)', () => {
  const configurations = {
    'fast-local': { costMode: 'local', contextTokens: 32768 },
    'deep-hosted': { costMode: 'hosted', contextTokens: 32768, reasoningEffort: 'high', extraBody: { temperature: 0.7 } },
  }
  const probeFile = (out: string, name: string) => join(probeDir(out, name), 'probe.json')

  // Each way a configuration stays unprobed; `ruin` spoils the seeded probe of `fast-local` and leaves `deep-hosted` alone.
  const ruins: Array<[string, (t: { deps: WorkerDeps; out: string }) => void, RegExp]> = [
    ['no probe file', (t) => rmSync(probeFile(t.out, 'fast-local')), /^CONFIGURATION_NOT_PROBED: geen probe-uitslag/],
    ['accepted: false', (t) => seedProbe(t.deps.config, t.out, 'fast-local', { accepted: false, reasons: ['stap b_single_tool: te traag'] }), /^CONFIGURATION_NOT_PROBED: probe niet aanvaard.*te traag/],
    ['another hash (a LiteLLM file or the configuration changed)', (t) => seedProbe(t.deps.config, t.out, 'fast-local', { hash: 'f'.repeat(64) }), /^CONFIGURATION_NOT_PROBED: hash klopt niet/],
    ['an unreadable probe file', (t) => writeFileSync(probeFile(t.out, 'fast-local'), '{ kapot'), /^CONFIGURATION_NOT_PROBED: .*onleesbaar/],
  ]

  it.each(ruins)('fails only the job of a configuration with %s: no running, no model call, no cost figure; the next job of the other configuration runs', async (_what, ruin, error) => {
    const t = await setup({
      claims: [job(ideaChatPayload({ jobId: 'bad', config: harnessConfig('fast-local') })), job(ideaChatPayload({ jobId: 'good', config: harnessConfig('deep-hosted') }))],
      script: [answer('Antwoord.')],
      configurations,
      once: false,
    })
    ruin(t)
    stopAfterWaits(t, 2)
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'bad', outcome: 'failed' }, { jobId: 'good', outcome: 'done' }], exitCode: 0 })
    const calls = controlCalls(t.mcp)
    expect(calls[0]).toEqual({ job_id: 'bad', status: 'failed', error: expect.stringMatching(error), cost: COST_NONE })
    expect(calls.slice(1).map((c) => [c.job_id, c.status])).toEqual([['good', 'running'], ['good', 'done']])
    expect(t.model.requests).toHaveLength(1)
    expect(t.model.requests[0].body).toMatchObject({ model: 'deep-hosted' })
    expect(t.logs.join('\n')).not.toMatch(/RUNTIME_MISMATCH|Worker stopt/)
  })

  it('never lets a job through on a configuration without a probe, also when it is the only one', async () => {
    const t = await setup({ claims: [job()], script: [answer('nee')] })
    rmSync(probeFile(t.out, TEST_CONFIGURATION))
    const r = await t.run()
    expect(r.jobs).toEqual([{ jobId: 'job1', outcome: 'failed' }])
    expect(controlCalls(t.mcp)).toEqual([{ job_id: 'job1', status: 'failed', error: expect.stringMatching(/^CONFIGURATION_NOT_PROBED: /), cost: COST_NONE }])
    expect(t.model.requests).toHaveLength(0)
  })

  it('reads the probe again at every job: a probe made while the worker runs lets the next job through', async () => {
    const t = await setup({
      claims: [job(ideaChatPayload({ jobId: 'first' })), job(ideaChatPayload({ jobId: 'second' }))],
      script: [answer('Antwoord.')],
      once: false,
    })
    rmSync(probeFile(t.out, TEST_CONFIGURATION))
    const orig = t.deps.control.updateStatus.bind(t.deps.control)
    t.deps.control = { ...t.deps.control, updateStatus: async (id, u) => { const res = await orig(id, u); if (id === 'first') seedProbe(t.deps.config, t.out, TEST_CONFIGURATION); return res } }
    stopAfterWaits(t, 2)
    const r = await t.run()
    expect(r.jobs).toEqual([{ jobId: 'first', outcome: 'failed' }, { jobId: 'second', outcome: 'done' }])
  })

  it('writes the failure to the run-log as ERROR CONFIGURATION_NOT_PROBED', async () => {
    const t = await setup({ claims: [job()], script: [answer('nee')] })
    rmSync(probeFile(t.out, TEST_CONFIGURATION))
    await t.run()
    const lines = runLogLines(t.runLogDir)
    expect(lines).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR CONFIGURATION_NOT_PROBED: geen probe-uitslag/))
    expect(lines.at(-1)).toMatch(/ exit code=1$/)
  })

  it('checks an unknown configuration and a missing ceiling before the probe', async () => {
    const t = await setup({
      claims: [job(ideaChatPayload({ jobId: 'a', config: harnessConfig('nope') })), job(ideaChatPayload({ jobId: 'b', config: withoutCost(TEST_CONFIGURATION) }))],
      once: false,
    })
    rmSync(probeFile(t.out, TEST_CONFIGURATION))
    stopAfterWaits(t, 2)
    await t.run()
    expect(controlCalls(t.mcp).map((c) => c.error)).toEqual(['UNKNOWN_CONFIGURATION: nope', 'COST_LIMIT_MISSING: ontbrekend'])
  })
})
