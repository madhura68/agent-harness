import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelClient } from '../src/model-client.js'
import { createRegistryView } from '../src/tools/registry.js'
import { createControlChannel } from '../src/worker/control.js'
import { WorkerConfigSchema } from '../src/worker/config.js'
import { runWorker, type WorkerDeps } from '../src/worker/worker.js'
import { completion, startFakeModelServer, type FakeTurn } from './fakes/fake-model-server.js'
import { startFakeScrum4meMcp, type ClaimStep } from './fakes/fake-scrum4me-mcp.js'
import { ideaChatPayload } from './fakes/idea-chat-payload.js'
import { dirContains, readTrace, tmp } from './helpers.js'

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
  failUpdate?: Array<'running' | 'done' | 'failed'>
  signal?: AbortSignal
  apiKey?: string
  heartbeatMs?: number
  requestTimeoutMs?: number
}

async function setup(s: Setup) {
  model = await startFakeModelServer(s.script ?? [])
  mcp = await startFakeScrum4meMcp({ claims: s.claims, failUpdate: s.failUpdate })
  const config = WorkerConfigSchema.parse({
    model: { baseUrl: model.baseUrl, name: 'qwen3-coder:30b', ...(s.apiKey ? { apiKey: s.apiKey } : {}) },
    mcp: { command: 'unused', args: [] },
    limits: { maxTurns: 4, maxOutputTokens: 2048, maxWallSeconds: 30, maxToolErrors: 2, ...s.limits },
    waitSeconds: 1,
  })
  const out = tmp('worker')
  const logs: string[] = []
  const client = mcp.client
  const deps: WorkerDeps = {
    control: createControlChannel(client, s.requestTimeoutMs ? { requestTimeoutMs: s.requestTimeoutMs } : {}),
    registryView: (signal) => createRegistryView(client, config.allow, signal),
    modelClient: createModelClient({ baseUrl: config.model.baseUrl, name: config.model.name, apiKey: config.model.apiKey }),
    config,
    out,
    once: s.once ?? true,
    signal: s.signal ?? new AbortController().signal,
    heartbeatMs: s.heartbeatMs ?? 50,
    errorBackoffMs: 0,
    log: (line) => logs.push(line),
  }
  return { deps, out, logs, mcp, model, run: () => runWorker(deps) }
}

const controlCalls = (m: McpFake) => m.calls.filter((c) => c.name === 'update_job_status').map((c) => c.args)
const job = (payload: unknown = ideaChatPayload()): ClaimStep => ({ job: payload })

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
    const dirs = readdirSync(t.out)
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
    expect(readdirSync(t.out)).toHaveLength(2)
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
    const dir = join(t.out, readdirSync(t.out)[0])
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
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'failed' }], exitCode: 1 })
    expect(t.mcp.calls.filter((c) => c.name === 'wait_for_job')).toHaveLength(1)
    expect(t.logs.join('\n')).toMatch(/claimfilter/i)
  })

  it('stops after a payload without pending_user_message_ids (MCP without M2)', async () => {
    const payload = ideaChatPayload() as unknown as { chat: Record<string, unknown> }
    delete payload.chat.pending_user_message_ids
    const t = await setup({ claims: [job(payload), job()], script: [answer('nee')], once: false })
    const r = await t.run()
    expect(r.exitCode).toBe(1)
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
