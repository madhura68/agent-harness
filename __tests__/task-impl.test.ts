import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createModelClient } from '../src/model-client.js'
import { createRegistryView } from '../src/tools/registry.js'
import { WorkerConfigSchema } from '../src/worker/config.js'
import type { SpawnFn } from '../src/worker/containers.js'
import { createControlChannel } from '../src/worker/control.js'
import { commitAll, snapshotGitAdmin } from '../src/worker/host-git.js'
import { openRunLog } from '../src/worker/run-log.js'
import { buildSummary, renderTaskPrompt, TaskPayloadSchema } from '../src/worker/task-impl.js'
import { runWorker, type WorkerDeps } from '../src/worker/worker.js'
import { completion, startFakeModelServer, type FakeTurn } from './fakes/fake-model-server.js'
import { startFakeScrum4meMcp, type ClaimStep, type UpdateOutcomeOverride } from './fakes/fake-scrum4me-mcp.js'
import { ideaChatPayload } from './fakes/idea-chat-payload.js'
import { taskPayload } from './fakes/task-payload.js'
import { readTrace } from './helpers.js'

// Spies that call through: the tests assert that commitAll/snapshotGitAdmin are NOT called on some paths.
vi.mock('../src/worker/host-git.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/worker/host-git.js')>()
  return { ...orig, commitAll: vi.fn(orig.commitAll), snapshotGitAdmin: vi.fn(orig.snapshotGitAdmin) }
})

const execFileAsync = promisify(execFile)

// ---- git test setup (isolated from the developer's global/system config, as in host-git.test.ts) ----

let configDir: string
let globalConfigPath: string
const cleanupDirs: string[] = []

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'task-impl-cfg-'))
  globalConfigPath = join(configDir, 'gitconfig')
  writeFileSync(globalConfigPath, '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n')
})
afterAll(() => rmSync(configDir, { recursive: true, force: true }))

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `task-impl-${prefix}-`))
  cleanupDirs.push(dir)
  return dir
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: globalConfigPath, GIT_CONFIG_NOSYSTEM: '1' },
  })
  return stdout.trim()
}

/** Seed repo ← clone ← linked worktree on branch feature1 (the production shape). */
async function setupWorktree(): Promise<{ cloneDir: string; worktree: string }> {
  const root = tmp('repo')
  const seed = join(root, 'seed')
  mkdirSync(seed)
  await git(seed, ['init', '-q'])
  writeFileSync(join(seed, 'README.md'), 'hello\n')
  await git(seed, ['add', '-A'])
  await git(seed, ['commit', '-q', '-m', 'initial'])
  const cloneDir = join(root, 'clone')
  await git(root, ['clone', '-q', seed, cloneDir])
  const worktree = join(root, 'worktree1')
  await git(cloneDir, ['worktree', 'add', '-q', '-b', 'feature1', worktree])
  return { cloneDir, worktree }
}

// ---- fake docker ----

type RunSpec = { code?: number | null; out?: string; hang?: boolean; delayMs?: number; effect?: () => void }
type FakeChild = ReturnType<SpawnFn>

function fakeChild(spec: RunSpec): FakeChild {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let resolveDone!: (code: number | null) => void
  const done = new Promise<number | null>((r) => (resolveDone = r))
  let finished = false
  const finish = (code: number | null) => {
    if (finished) return
    finished = true
    let pending = 2
    const onEnd = () => {
      if (--pending === 0) resolveDone(code)
    }
    stdout.once('end', onEnd)
    stderr.once('end', onEnd)
    stdout.end(spec.out ?? '')
    stderr.end('')
    stdout.resume()
    stderr.resume()
  }
  if (!spec.hang) {
    const settle = () => {
      spec.effect?.()
      finish(spec.code === undefined ? 0 : spec.code)
    }
    if (spec.delayMs) setTimeout(settle, spec.delayMs)
    else setImmediate(settle)
  }
  return { stdout, stderr, done, kill: () => finish(null) }
}

type DockerOpts = {
  prepare?: RunSpec
  verify?: RunSpec[] // one per verify container, in order; exhausted = green
  killCode?: number
  /** `docker kill` answers only after this many ms (a slow, failing kill keeps the cleanup in flight). */
  killDelayMs?: number
  /** Output of `docker ps` for the leftover check at startup / before a task (one entry per call; exhausted = clean). */
  leftovers?: Array<{ code?: number; out?: string }>
  rmCode?: number
  onRun?: (kind: 'prepare' | 'verify', name: string) => void
}

function fakeDocker(o: DockerOpts = {}) {
  const calls: string[][] = []
  const verify = [...(o.verify ?? [])]
  const leftovers = [...(o.leftovers ?? [])]
  const spawn: SpawnFn = (_cmd, args) => {
    calls.push(args)
    switch (args[0]) {
      case 'run': {
        const name = args[args.indexOf('--name') + 1]
        const kind = name.includes('-prepare-') ? 'prepare' : 'verify'
        o.onRun?.(kind, name)
        return fakeChild(kind === 'prepare' ? (o.prepare ?? {}) : (verify.shift() ?? {}))
      }
      case 'kill':
        return fakeChild({ code: o.killCode ?? 0, delayMs: o.killDelayMs })
      case 'ps': {
        const filter = args[args.indexOf('--filter') + 1]
        if (filter === 'name=^harness-') {
          const step = leftovers.shift() ?? {}
          return fakeChild({ code: step.code ?? 0, out: step.out ?? '' })
        }
        return fakeChild({ code: 0, out: '' }) // the killed container is gone
      }
      case 'rm':
        return fakeChild({ code: o.rmCode ?? 0 })
      default:
        throw new Error(`onverwacht docker-subcommando: ${args[0]}`)
    }
  }
  return { spawn, calls, runs: () => calls.filter((a) => a[0] === 'run'), kills: () => calls.filter((a) => a[0] === 'kill') }
}

// ---- worker setup ----

type ModelFake = Awaited<ReturnType<typeof startFakeModelServer>>
type McpFake = Awaited<ReturnType<typeof startFakeScrum4meMcp>>
let model: ModelFake | undefined
let mcp: McpFake | undefined

beforeEach(() => vi.clearAllMocks())
afterEach(async () => {
  await model?.close()
  await mcp?.close()
  model = undefined
  mcp = undefined
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop() as string, { recursive: true, force: true })
})

const PUSHED: UpdateOutcomeOverride = { status: 'done', branch: 'feat/story-1', pushed_at: '2026-09-28T10:00:00.000Z' }

type Setup = {
  claims?: (worktree: string) => ClaimStep[]
  script?: FakeTurn[]
  docker?: DockerOpts
  verifyResult?: 'aligned' | 'partial' | 'empty' | 'divergent'
  doneOutcome?: UpdateOutcomeOverride
  failUpdate?: Array<'running' | 'done' | 'failed'>
  signal?: AbortSignal
  heartbeatMs?: number
  noTask?: boolean
  maxVerifyRepairs?: number
  once?: boolean
  /** Container timeouts in seconds; default 0.05 (fast timeouts). */
  timeouts?: { prepare?: number; verify?: number }
  /** Overrides task.limits.maxWallSeconds after parse (the schema wants whole seconds). */
  maxWallSeconds?: number
}

async function setup(s: Setup = {}) {
  const { cloneDir, worktree } = await setupWorktree()
  const baseSha = await git(cloneDir, ['rev-parse', 'feature1'])
  model = await startFakeModelServer(s.script ?? [])
  mcp = await startFakeScrum4meMcp({
    claims: s.claims ? s.claims(worktree) : [{ job: taskPayload({ worktree }) }],
    failUpdate: s.failUpdate,
    verifyResult: s.verifyResult,
    updateOutcome: { done: s.doneOutcome ?? PUSHED },
  })
  const config = WorkerConfigSchema.parse({
    model: { baseUrl: model.baseUrl, name: 'qwen3-coder:30b' },
    mcp: { command: 'unused', args: [] },
    limits: { maxTurns: 4, maxOutputTokens: 2048, maxWallSeconds: 30, maxToolErrors: 2 },
    waitSeconds: 1,
    ...(s.noTask
      ? {}
      : {
          task: {
            limits: { maxTurns: 10, maxOutputTokens: 20000, maxWallSeconds: 30, maxToolErrors: 3 },
            image: 'node:24-bookworm',
            uid: 1000,
            gid: 1000,
            npmCacheDir: '/tmp/npm-cache',
            maxVerifyRepairs: s.maxVerifyRepairs ?? 3,
            recipes: [{ repoUrl: 'https://git.example/repo', prepare: ['npm ci'], verify: 'npm test' }],
          },
        }),
  })
  // Sub-second container timeouts (the schema wants whole seconds; the runner just multiplies by 1000).
  if (config.task) {
    config.task.prepareTimeoutSeconds = s.timeouts?.prepare ?? 0.05
    config.task.verifyTimeoutSeconds = s.timeouts?.verify ?? 0.05
    if (s.maxWallSeconds !== undefined) config.task.limits.maxWallSeconds = s.maxWallSeconds
  }
  const docker = fakeDocker(s.docker)
  const out = tmp('out')
  const runLogDir = tmp('runlog')
  const logs: string[] = []
  const client = mcp.client
  const deps: WorkerDeps = {
    control: createControlChannel(client),
    registryView: (signal) => createRegistryView(client, config.allow, signal),
    modelClient: createModelClient({ baseUrl: config.model.baseUrl, name: config.model.name }),
    config,
    out,
    once: s.once ?? true,
    signal: s.signal ?? new AbortController().signal,
    heartbeatMs: s.heartbeatMs ?? 50,
    errorBackoffMs: 0,
    log: (line) => logs.push(line),
    taskDeps: { spawn: docker.spawn, killGraceMs: 20, cleanupTimeoutMs: 500 },
    // M4 Taak 5: a real run-log writer on every test (best-effort — spec §6.3 — so it must never change a
    // job outcome). Taak 6 adds the task-job-specific run-log assertions; this task only wires it through.
    runLogFor: (claim) =>
      openRunLog({ dir: runLogDir, pool: 'harness', instance: 'test' }, { jobId: claim.jobId, kind: claim.kind, model: config.model, version: 'agent-harness@test', secrets: [] }),
  }
  const branchSha = () => git(cloneDir, ['rev-parse', 'feature1'])
  return { deps, out, runLogDir, logs, mcp, model, docker, worktree, cloneDir, baseSha, branchSha, run: () => runWorker(deps) }
}

const write = (path: string, content: string, id = 'w1'): FakeTurn => ({
  body: completion({ toolCalls: [{ id, name: 'write_file', arguments: { path, content } }], model: 'qwen3-coder:30b' }),
})
const runTests = (id = 'rt1'): FakeTurn => ({ body: completion({ toolCalls: [{ id, name: 'run_tests', arguments: {} }], model: 'qwen3-coder:30b' }) })
const answer = (text: string): FakeTurn => ({
  body: completion({ content: text, model: 'qwen3-coder:30b', usage: { prompt_tokens: 200, completion_tokens: 40 } }),
})
const RED = (out = 'FAIL greet.test.ts'): RunSpec => ({ code: 1, out })

/** Control calls in order, heartbeats and wait_for_job left out, as short labels. */
function controlTrail(m: McpFake): string[] {
  return m.calls
    .filter((c) => c.name !== 'job_heartbeat' && c.name !== 'wait_for_job')
    .map((c) => {
      if (c.name === 'update_job_status' || c.name === 'update_task_status' || c.name === 'log_test_result') return `${c.name} ${String(c.args.status)}`
      return c.name
    })
}
const jobUpdates = (m: McpFake) => m.calls.filter((c) => c.name === 'update_job_status').map((c) => c.args)
const lastJobUpdate = (m: McpFake) => jobUpdates(m).at(-1)
const taskUpdates = (m: McpFake) => m.calls.filter((c) => c.name === 'update_task_status').map((c) => c.args.status)
const traceOf = (out: string) => readTrace(join(out, readdirSync(out)[0]))

// ---- run-log helpers (M4 Taak 6), mirroring worker.test.ts's ----

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

// ---------------------------------------------------------------------------------------------------

describe('pure helpers', () => {
  it('buildSummary stays within 4000 and always ends on the verify suffix', () => {
    for (const len of [3990, 4000, 10_000]) {
      const s = buildSummary('a'.repeat(len), 'npm test')
      expect(s.length).toBeLessThanOrEqual(4000)
      expect(s.endsWith('\n\nVerify: groen (npm test)')).toBe(true)
    }
    expect(buildSummary('kort', 'npm test')).toBe('kort\n\nVerify: groen (npm test)')
    expect(buildSummary('a'.repeat(10_000), 'npm test')).toContain('_[antwoord afgekapt]_')
  })

  it('accepts null description, plan, repo_url and acceptance criteria and leaves those headings out', () => {
    const payload = TaskPayloadSchema.parse(
      taskPayload({ description: null, plan: null, repoUrl: null, productRepoUrl: 'https://git.example/repo.git', storyDescription: null, acceptance: null }),
    )
    const prompt = renderTaskPrompt(payload)
    expect(prompt).toContain('## Taak')
    expect(prompt).not.toContain('## Plan')
    expect(prompt).not.toContain('Acceptatiecriteria')
    expect(prompt).not.toContain('null')
    expect(prompt).toContain('https://git.example/repo.git')
    expect(prompt).toContain('product_id: `prod-harness`')
  })

  it('renders task, plan, story, acceptance criteria, product id and repository', () => {
    const prompt = renderTaskPrompt(TaskPayloadSchema.parse(taskPayload()))
    for (const part of ['## Taak', 'feat: voeg greet() toe', '## Plan', 'Schrijf src/greet.ts', '## Story', 'Begroeting', 'Acceptatiecriteria', 'greet("x")', '## Product', '## Repository', 'feat/story-1']) {
      expect(prompt).toContain(part)
    }
  })
})

describe('runTaskJob — green path', () => {
  it('runs prepare, the model loop with gate, commits and closes in the fixed order', async () => {
    const t = await setup({ script: [write('src/greet.ts', 'export const greet = (n: string) => `hallo ${n}`\n'), answer('src/greet.ts toegevoegd; tests groen.')] })
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'done' }], exitCode: 0 })
    expect(controlTrail(t.mcp)).toEqual([
      'update_job_status running',
      'update_task_status in_progress',
      'log_implementation',
      'verify_task_against_plan',
      'log_commit',
      'log_test_result PASSED',
      'update_job_status done',
      'update_task_status review',
    ])
    expect(await git(t.worktree, ['show', '--name-only', '--format=%an|%s', 'HEAD'])).toBe('agent-harness|feat: voeg greet() toe\n\nsrc/greet.ts')
    const done = lastJobUpdate(t.mcp)
    expect(done).toMatchObject({ status: 'done', model_id: 'qwen3-coder:30b', input_tokens: 210, output_tokens: 45 })
    expect(String(done?.summary)).toBe('src/greet.ts toegevoegd; tests groen.\n\nVerify: groen (npm test)')
    const commit = t.mcp.calls.find((c) => c.name === 'log_commit')?.args
    expect(commit).toMatchObject({ commit_hash: await git(t.worktree, ['rev-parse', 'HEAD']), commit_message: 'feat: voeg greet() toe', task_id: 'task-1', story_id: 'story-1' })
    expect(t.mcp.calls.find((c) => c.name === 'log_implementation')?.args.content).toBe('lokaal model start: qwen3-coder:30b, recept https://git.example/repo.git')
    expect(t.docker.runs().map((a) => a[a.indexOf('--name') + 1])).toEqual(['harness-job1-prepare-1', 'harness-job1-verify-2'])
    const containers = traceOf(t.out).filter((e) => e.type === 'container')
    expect(containers.map((e) => [e.kind, e.source])).toEqual([['prepare', 'prepare'], ['verify', 'gate']])
  })

  it('captures each container run under containers/<n>.txt with n and outputBytes on the event', async () => {
    const t = await setup({
      script: [write('src/greet.ts', 'export const greet = (n: string) => `hallo ${n}`\n'), answer('klaar')],
      docker: { prepare: { out: 'npm ci: up to date' }, verify: [{ out: 'PASS greet.test.ts' }] },
    })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('done')
    const containers = traceOf(t.out).filter((e) => e.type === 'container')
    expect(containers.map((e) => [e.n, e.outputBytes])).toEqual([
      [1, Buffer.byteLength('npm ci: up to date')],
      [2, Buffer.byteLength('PASS greet.test.ts')],
    ])
    const runDir = join(t.out, readdirSync(t.out)[0])
    expect(readFileSync(join(runDir, 'containers', '1.txt'), 'utf8')).toBe('npm ci: up to date')
    expect(readFileSync(join(runDir, 'containers', '2.txt'), 'utf8')).toBe('PASS greet.test.ts')
  })

  it('red → repair → green: the retry message reaches the model', async () => {
    const t = await setup({
      script: [write('src/greet.ts', 'fout\n'), answer('klaar'), write('src/greet.ts', 'goed\n', 'w2'), answer('nu echt klaar')],
      docker: { verify: [RED('FAIL: verwacht hallo x')] },
    })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('done')
    const retry = JSON.stringify(t.model.requests[2].body.messages)
    expect(retry).toContain('Verify faalt (poging 1 van 3): ')
    expect(retry).toContain('FAIL: verwacht hallo x')
    expect(readFileSync(join(t.worktree, 'src/greet.ts'), 'utf8')).toBe('goed\n')
    expect(lastJobUpdate(t.mcp)).toMatchObject({ status: 'done' })
  })

  it('a completed answer larger than 4000 characters is accepted by the (4000-capped) fake MCP', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('x'.repeat(10_000))] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('done')
    const summary = String(lastJobUpdate(t.mcp)?.summary)
    expect(summary.length).toBeLessThanOrEqual(4000)
    expect(summary.endsWith('Verify: groen (npm test)')).toBe(true)
    expect(taskUpdates(t.mcp)).toEqual(['in_progress', 'review'])
  })

  it('names the payload product_id in the prompt, and a model doc search with it succeeds', async () => {
    const t = await setup({
      claims: (wt) => [{ job: taskPayload({ worktree: wt, productId: 'prod-scrum4me', repoUrl: 'https://git.example/repo.git', description: 'Pas de MCP aan.', plan: 'Wijzig de tool.' }) }],
      script: [
        { body: completion({ toolCalls: [{ id: 'd1', name: 'search_product_docs', arguments: { product_id: 'prod-scrum4me', query: 'job flow' } }] }) },
        write('x.txt', 'x\n'),
        answer('klaar'),
      ],
    })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('done')
    const user = t.model.requests[0].body.messages.find((m: { role: string }) => m.role === 'user').content as string
    expect(user).toContain('product_id: `prod-scrum4me` — gebruik exact dit id voor search_product_docs en list_product_docs')
    expect(t.mcp.calls.find((c) => c.name === 'search_product_docs')?.args).toEqual({ product_id: 'prod-scrum4me', query: 'job flow' })
    const tools = (t.model.requests[0].body.tools as Array<{ function: { name: string } }>).map((x) => x.function.name).sort()
    expect(tools).toEqual(['edit_file', 'get_product_doc', 'list_files', 'list_product_docs', 'read_file', 'related_product_docs', 'run_tests', 'search', 'search_product_docs', 'write_file'])
  })
})

describe('runTaskJob — failures', () => {
  it('3× red ⇒ failed with VERIFY_FAILED, log_test_result FAILED, no commit, no review', async () => {
    const t = await setup({
      script: [write('a.txt', 'a\n'), answer('klaar 1'), answer('klaar 2'), answer('klaar 3')],
      docker: { verify: [RED('rood-1'), RED('rood-2'), RED('rood-3')] },
    })
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'failed' }], exitCode: 1 })
    expect(t.model.requests).toHaveLength(4)
    expect(JSON.stringify(t.model.requests[3].body.messages)).toContain('Verify faalt (poging 2 van 3)')
    const update = lastJobUpdate(t.mcp)
    expect(update?.status).toBe('failed')
    expect(String(update?.error)).toContain('VERIFY_FAILED')
    expect(String(update?.error)).toMatch(/git-administratie ongewijzigd$/)
    expect(String(update?.error).length).toBeLessThanOrEqual(2000)
    expect(t.mcp.calls.find((c) => c.name === 'log_test_result')?.args).toMatchObject({ status: 'FAILED' })
    expect(await t.branchSha()).toBe(t.baseSha)
    expect(commitAll).not.toHaveBeenCalled()
    expect(taskUpdates(t.mcp)).toEqual(['in_progress'])
  })

  it('no task-config ⇒ failed without touching the task', async () => {
    const t = await setup({ noTask: true, script: [answer('nee')] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(jobUpdates(t.mcp)).toEqual([{ job_id: 'job1', status: 'failed', error: 'worker heeft geen task-config' }])
    expect(taskUpdates(t.mcp)).toEqual([])
    expect(t.model.requests).toHaveLength(0)
    expect(t.docker.calls).toEqual([])
  })

  it('no recipe ⇒ failed without touching the task', async () => {
    const t = await setup({ claims: (wt) => [{ job: taskPayload({ worktree: wt, repoUrl: 'https://git.example/ander.git' }) }] })
    await t.run()
    expect(jobUpdates(t.mcp)).toEqual([{ job_id: 'job1', status: 'failed', error: 'geen recept voor https://git.example/ander.git' }])
    expect(taskUpdates(t.mcp)).toEqual([])
    expect(t.docker.runs()).toEqual([])
  })

  it('an invalid payload ⇒ failed, the task untouched, and the worker does not stop', async () => {
    const t = await setup({ claims: () => [{ job: { job_id: 'job1', kind: 'TASK_IMPLEMENTATION', config: { runtime: 'HARNESS' } } }, { job: ideaChatPayload({ jobId: 'job2' }) }], script: [answer('ok')], once: false })
    const stop = new AbortController()
    t.deps.signal = stop.signal
    const orig = t.deps.control.updateStatus.bind(t.deps.control)
    t.deps.control = { ...t.deps.control, updateStatus: async (id, u) => { const r = await orig(id, u); if (id === 'job2' && u.status === 'done') stop.abort(); return r } }
    const r = await t.run()
    expect(r.jobs).toEqual([{ jobId: 'job1', outcome: 'failed' }, { jobId: 'job2', outcome: 'done' }])
    expect(String(jobUpdates(t.mcp)[0].error)).toMatch(/^payload ongeldig: /)
    expect(taskUpdates(t.mcp)).toEqual([])
  })

  it('an unreadable worktree ⇒ failed "git-administratie niet te scannen", task untouched', async () => {
    const t = await setup({ claims: (wt) => [{ job: taskPayload({ worktree: join(wt, 'bestaat-niet') }) }] })
    await t.run()
    expect(String(lastJobUpdate(t.mcp)?.error)).toMatch(/^git-administratie niet te scannen: /)
    expect(taskUpdates(t.mcp)).toEqual([])
  })

  it('prepare fails ⇒ failed with the output tail, no model call, a prepare container event in the trace', async () => {
    const t = await setup({ script: [answer('nee')], docker: { prepare: { code: 1, out: 'x'.repeat(5000) + 'npm ERR! kapot' } } })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(t.model.requests).toHaveLength(0)
    const error = String(lastJobUpdate(t.mcp)?.error)
    expect(error).toMatch(/^prepare faalde \(exitcode 1\): /)
    expect(error).toContain('npm ERR! kapot')
    expect(error).toMatch(/; git-administratie ongewijzigd$/)
    expect(error.length).toBeLessThanOrEqual(2000)
    expect(traceOf(t.out).find((e) => e.type === 'container')).toMatchObject({ kind: 'prepare', source: 'prepare', exitCode: 1 })
    expect(taskUpdates(t.mcp)).toEqual(['in_progress'])
  })

  it('the model changes nothing ⇒ failed "model produceerde geen wijzigingen", never done', async () => {
    const t = await setup({ script: [answer('alles was al goed')] })
    await t.run()
    expect(String(lastJobUpdate(t.mcp)?.error)).toMatch(/^model produceerde geen wijzigingen/)
    expect(t.docker.runs().filter((a) => a.some((x) => x.includes('-verify-')))).toHaveLength(1) // the gate still ran verify
    expect(jobUpdates(t.mcp).map((u) => u.status)).toEqual(['running', 'failed'])
  })

  it('divergent ⇒ failed with that reason, no review', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')], verifyResult: 'divergent' })
    await t.run()
    expect(String(lastJobUpdate(t.mcp)?.error)).toMatch(/divergent/)
    expect(taskUpdates(t.mcp)).toEqual(['in_progress'])
  })

  it('done refused ⇒ failed with the refusal text, no review', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')], failUpdate: ['done'] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(jobUpdates(t.mcp).map((u) => u.status)).toEqual(['running', 'done', 'failed'])
    expect(String(lastJobUpdate(t.mcp)?.error)).toContain('already terminal')
    expect(taskUpdates(t.mcp)).toEqual(['in_progress'])
  })

  it('done times out (a thrown call, not a refusal) ⇒ abandoned, no second terminal update, no review (Fix 3 / P12)', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')] })
    const orig = t.mcp.client.callTool.bind(t.mcp.client)
    vi.spyOn(t.mcp.client, 'callTool').mockImplementation(async (params: { name: string; arguments?: Record<string, unknown> }, schema?: unknown, opts?: unknown) => {
      if (params.name === 'update_job_status' && params.arguments?.status === 'done') {
        throw new McpError(ErrorCode.RequestTimeout, 'Request timed out')
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (orig as any)(params, schema, opts)
    })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('abandoned')
    // The 'done' call never reached the MCP (it was rejected client-side): only 'running' was recorded,
    // and — critically — no second terminal update ('failed') was sent after the unknown outcome.
    expect(jobUpdates(t.mcp).map((u) => u.status)).toEqual(['running'])
    expect(taskUpdates(t.mcp)).toEqual(['in_progress'])
    expect(t.logs.join('\n')).toMatch(/uitkomst van done onbekend.*geen tweede terminale update/)
  })

  it('done comes back as failed (push) ⇒ no review and no second terminal update', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')], doneOutcome: { status: 'failed', error: 'push failed', pushed_at: null } })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(jobUpdates(t.mcp).map((u) => u.status)).toEqual(['running', 'done'])
    expect(taskUpdates(t.mcp)).toEqual(['in_progress'])
  })

  it('a gitlink bent by the container ⇒ failed "git-administratie gewijzigd", no commitAll', async () => {
    let wt = ''
    const t = await setup({
      script: [write('a.txt', 'a\n'), answer('klaar')],
      docker: { verify: [{ code: 0, effect: () => writeFileSync(join(wt, '.git'), 'gitdir: /tmp/evil\n') }] },
    })
    wt = t.worktree
    await t.run()
    expect(String(lastJobUpdate(t.mcp)?.error)).toBe('git-administratie gewijzigd: changed: .git')
    expect(commitAll).not.toHaveBeenCalled()
    expect(await t.branchSha()).toBe(t.baseSha)
  })
})

const UNCERTAIN = /^container harness-job1-(prepare|verify)-\d+ niet aantoonbaar gestopt; worker gestopt, systemd herstart hem en de start ruimt achtergebleven containers op$/

describe('runTaskJob — stopping', () => {
  it('heartbeat lost during prepare ⇒ docker kill, no updates, abandoned, the worker carries on', async () => {
    const t = await setup({
      claims: (wt) => [{ job: taskPayload({ worktree: wt }) }, { job: ideaChatPayload({ jobId: 'job2' }) }],
      script: [answer('idee-antwoord')],
      docker: { prepare: { hang: true } },
      timeouts: { prepare: 10 },
      heartbeatMs: 20,
      once: false,
    })
    const stop = new AbortController()
    t.deps.signal = stop.signal
    const control = t.deps.control
    t.deps.control = {
      ...control,
      heartbeat: async (id) => (id === 'job1' ? false : control.heartbeat(id)),
      updateStatus: async (id, u) => { const r = await control.updateStatus(id, u); if (id === 'job2' && u.status === 'done') stop.abort(); return r },
    }
    const r = await t.run()
    expect(r.jobs).toEqual([{ jobId: 'job1', outcome: 'abandoned' }, { jobId: 'job2', outcome: 'done' }])
    expect(t.docker.kills()).toEqual([['kill', 'harness-job1-prepare-1']])
    expect(jobUpdates(t.mcp).filter((u) => u.job_id === 'job1').map((u) => u.status)).toEqual(['running'])
    expect(t.mcp.calls.filter((c) => c.name === 'log_test_result')).toEqual([])
    expect(t.model.requests).toHaveLength(1) // only the idea-chat turn
    expect(commitAll).not.toHaveBeenCalled()
  }, 10_000)

  it('SIGINT during verify ⇒ docker kill, failed "worker gestopt", no git', async () => {
    const stop = new AbortController()
    const t = await setup({
      script: [write('a.txt', 'a\n'), answer('klaar')],
      docker: { verify: [{ hang: true }], onRun: (kind) => { if (kind === 'verify') setTimeout(() => stop.abort(), 20) } },
      timeouts: { verify: 10 },
      signal: stop.signal,
    })
    const r = await t.run()
    expect(r.exitCode).toBe(0)
    expect(t.docker.kills()).toEqual([['kill', 'harness-job1-verify-2']])
    expect(String(lastJobUpdate(t.mcp)?.error)).toBe('worker gestopt; git-administratie ongewijzigd')
    expect(commitAll).not.toHaveBeenCalled()
    expect(t.mcp.calls.filter((c) => c.name === 'log_test_result')).toEqual([])
    expect(taskUpdates(t.mcp)).toEqual(['in_progress'])
  }, 10_000)

  it('SIGINT after the commit ⇒ the green completion still runs to done and review', async () => {
    const stop = new AbortController()
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')], signal: stop.signal })
    const control = t.deps.control
    t.deps.control = { ...control, verifyTaskAgainstPlan: async (id, wt) => { stop.abort(); return control.verifyTaskAgainstPlan(id, wt) } }
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'done' }], exitCode: 0 })
    expect(taskUpdates(t.mcp)).toEqual(['in_progress', 'review'])
    expect(commitAll).toHaveBeenCalledTimes(1)
  })
})

describe('runTaskJob — heartbeat lost on the green path', () => {
  it('lost during log_commit ⇒ no log_test_result, no done, abandoned', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')], heartbeatMs: 20 })
    let refuse = false
    const control = t.deps.control
    t.deps.control = {
      ...control,
      heartbeat: async (id) => (refuse ? false : control.heartbeat(id)),
      log: async (kind, args) => {
        const r = await control.log(kind, args)
        if (kind === 'commit') {
          refuse = true
          await new Promise((res) => setTimeout(res, 80)) // at least one refused beat lands
        }
        return r
      },
    }
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('abandoned')
    expect(t.mcp.calls.filter((c) => c.name === 'log_test_result')).toEqual([])
    expect(jobUpdates(t.mcp).map((u) => u.status)).toEqual(['running'])
    expect(taskUpdates(t.mcp)).toEqual(['in_progress'])
  })
})

describe('runTaskJob — container not provably stopped', () => {
  it('via prepare ⇒ failed with the uncertain message, no model call, no scan or commit, exit 1', async () => {
    const t = await setup({ script: [answer('nee')], docker: { prepare: { hang: true }, killCode: 1 } })
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'failed' }], exitCode: 1 })
    expect(String(lastJobUpdate(t.mcp)?.error)).toMatch(UNCERTAIN)
    expect(jobUpdates(t.mcp).map((u) => u.status)).toEqual(['running', 'failed'])
    expect(t.model.requests).toHaveLength(0)
    expect(t.docker.runs()).toHaveLength(1)
    expect(snapshotGitAdmin).toHaveBeenCalledTimes(1) // only the claim-time snapshot
    expect(commitAll).not.toHaveBeenCalled()
    expect(t.logs.join('\n')).toMatch(/niet aantoonbaar gestopt/)
  })

  it('via a run_tests call of the model ⇒ same, and no further model request', async () => {
    const t = await setup({ script: [runTests(), answer('nee')], docker: { verify: [{ hang: true }], killCode: 1 } })
    const r = await t.run()
    expect(r.exitCode).toBe(1)
    expect(String(lastJobUpdate(t.mcp)?.error)).toMatch(UNCERTAIN)
    expect(jobUpdates(t.mcp).map((u) => u.status)).toEqual(['running', 'failed'])
    expect(t.model.requests).toHaveLength(1)
    expect(t.docker.runs()).toHaveLength(2)
    expect(snapshotGitAdmin).toHaveBeenCalledTimes(1)
    expect(commitAll).not.toHaveBeenCalled()
  })

  it('via the afterAnswer gate ⇒ same', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar'), answer('nee')], docker: { verify: [{ hang: true }], killCode: 1 } })
    const r = await t.run()
    expect(r.exitCode).toBe(1)
    expect(String(lastJobUpdate(t.mcp)?.error)).toMatch(UNCERTAIN)
    expect(jobUpdates(t.mcp).map((u) => u.status)).toEqual(['running', 'failed'])
    expect(t.model.requests).toHaveLength(2)
    expect(t.docker.runs()).toHaveLength(2)
    expect(snapshotGitAdmin).toHaveBeenCalledTimes(1)
    expect(commitAll).not.toHaveBeenCalled()
    expect(await t.branchSha()).toBe(t.baseSha)
  })

  // Fix round 1: runManifest drops an aborted gate at once (raceAbort) while runInContainer is still killing.
  const SLOW_FAILING_KILL = { verify: [{ hang: true }], killCode: 1, killDelayMs: 300 }

  it('SIGINT during the gate verify with a slow failing kill ⇒ uncertain message, exit 1', async () => {
    const stop = new AbortController()
    const t = await setup({
      script: [write('a.txt', 'a\n'), answer('klaar')],
      docker: { ...SLOW_FAILING_KILL, onRun: (kind) => { if (kind === 'verify') setTimeout(() => stop.abort(), 20) } },
      timeouts: { verify: 10 },
      signal: stop.signal,
    })
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'failed' }], exitCode: 1 })
    expect(String(lastJobUpdate(t.mcp)?.error)).toMatch(UNCERTAIN)
    expect(jobUpdates(t.mcp).map((u) => u.status)).toEqual(['running', 'failed'])
    expect(snapshotGitAdmin).toHaveBeenCalledTimes(1)
    expect(commitAll).not.toHaveBeenCalled()
  }, 10_000)

  it('heartbeat lost during the gate verify with a slow failing kill ⇒ no update, exit 1, no next claim', async () => {
    let verifying = false
    const t = await setup({
      claims: (wt) => [{ job: taskPayload({ worktree: wt }) }, { job: ideaChatPayload({ jobId: 'job2' }) }],
      script: [write('a.txt', 'a\n'), answer('klaar'), answer('idee-antwoord')],
      docker: { ...SLOW_FAILING_KILL, onRun: (kind) => { if (kind === 'verify') verifying = true } },
      timeouts: { verify: 10 },
      heartbeatMs: 20,
      once: false,
    })
    // Ends the loop should job2 ever be claimed (the bug): without it the worker would keep polling forever.
    const stop = new AbortController()
    t.deps.signal = stop.signal
    const control = t.deps.control
    t.deps.control = {
      ...control,
      heartbeat: async (id) => (verifying ? false : control.heartbeat(id)),
      updateStatus: async (id, u) => { if (id === 'job2') stop.abort(); return control.updateStatus(id, u) },
    }
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'abandoned' }], exitCode: 1 })
    expect(jobUpdates(t.mcp).map((u) => u.status)).toEqual(['running'])
    expect(t.mcp.calls.filter((c) => c.name === 'wait_for_job')).toHaveLength(1)
    expect(commitAll).not.toHaveBeenCalled()
  }, 10_000)

  it('the wall deadline during the gate verify with a slow failing kill ⇒ uncertain message, exit 1', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')], docker: SLOW_FAILING_KILL, timeouts: { verify: 10 }, maxWallSeconds: 0.5 })
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'failed' }], exitCode: 1 })
    expect(String(lastJobUpdate(t.mcp)?.error)).toMatch(UNCERTAIN)
    expect(jobUpdates(t.mcp).map((u) => u.status)).toEqual(['running', 'failed'])
    expect(snapshotGitAdmin).toHaveBeenCalledTimes(1)
  }, 10_000)

  it('with the heartbeat lost as well ⇒ no update at all, still exit 1', async () => {
    const t = await setup({ docker: { prepare: { hang: true }, killCode: 1 }, timeouts: { prepare: 10 }, heartbeatMs: 20 })
    t.mcp.state.heartbeatOk = false
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'abandoned' }], exitCode: 1 })
    expect(jobUpdates(t.mcp).map((u) => u.status)).toEqual(['running'])
  }, 10_000)
})

describe('runWorker — leftover containers', () => {
  it('docker ps failing at startup does not keep the worker from answering an IDEA_CHAT job', async () => {
    const t = await setup({ claims: () => [{ job: ideaChatPayload() }], script: [answer('idee-antwoord')], docker: { leftovers: [{ code: 1 }] } })
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'done' }], exitCode: 0 })
    expect(t.docker.calls[0]).toEqual(['ps', '-aq', '--filter', 'name=^harness-'])
  })

  it('startup cleanup uncertain and still uncertain before the task ⇒ failed without any docker run or task update', async () => {
    const t = await setup({ script: [answer('nee')], docker: { leftovers: [{ out: 'abc123\n' }, { out: 'abc123\n' }], rmCode: 1 } })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(jobUpdates(t.mcp)).toEqual([{ job_id: 'job1', status: 'failed', error: 'achtergebleven harness-container niet aantoonbaar opgeruimd; geen taak uitgevoerd' }])
    expect(t.docker.runs()).toEqual([])
    expect(taskUpdates(t.mcp)).toEqual([])
    expect(t.model.requests).toHaveLength(0)
  })

  it('startup cleanup uncertain but the re-check before the task is clean ⇒ the task runs normally', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')], docker: { leftovers: [{ code: 1 }] } })
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'done' }], exitCode: 0 })
    expect(t.docker.calls.filter((a) => a[0] === 'ps' && a[3] === 'name=^harness-')).toHaveLength(3) // startup 1 + re-check 2
  })
})

describe('runTaskJob — run-log (M4 Taak 6, spec §5.6)', () => {
  it('green path: worktree path=, harness.run_start cwd=worktree, container blocks for prepare and gate, all steps, and a closing block with done', async () => {
    const t = await setup({ script: [write('src/greet.ts', 'export const greet = (n: string) => `hallo ${n}`\n'), answer('klaar')] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('done')
    const sha = await t.branchSha()
    const lines = runLogLines(t.runLogDir)
    expect(lines.some((l) => l.endsWith(`[harness] worktree path=${t.worktree}`))).toBe(true)
    expect(lines.some((l) => l.endsWith('[harness] step task_status in_progress'))).toBe(true)
    expect(lines.some((l) => l.endsWith(`[harness] step commit sha=${sha}`))).toBe(true)
    expect(lines.some((l) => l.endsWith('[harness] step plan_check aligned'))).toBe(true)
    expect(lines.some((l) => l.endsWith('[harness] step job_status done pushed_at=ja'))).toBe(true)
    expect(lines.some((l) => l.endsWith('[harness] step task_status review ok'))).toBe(true)
    const jsonLines = runLogJsonLines(t.runLogDir)
    expect(jsonLines.find((j) => j.type === 'harness.run_start')).toMatchObject({ cwd: t.worktree })
    const containers = jsonLines.filter((j) => j.type === 'harness.container')
    expect(containers.map((c) => [c.kind, c.source])).toEqual([['prepare', 'prepare'], ['verify', 'gate']])
    const runEnd = jsonLines.find((j) => j.type === 'harness.run_end')
    expect(runEnd).toMatchObject({ outcome: 'done' })
    expect(lines.at(-1)).toBe(`${String(runEnd?.timestamp)} [harness] exit code=0`)
  })

  it('no recipe ⇒ ERROR NO_RECIPE', async () => {
    const t = await setup({ claims: (wt) => [{ job: taskPayload({ worktree: wt, repoUrl: 'https://git.example/ander.git' }) }] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR NO_RECIPE: geen recept voor https:\/\/git\.example\/ander\.git$/))
  })

  it('prepare fails ⇒ ERROR PREPARE_FAILED', async () => {
    const t = await setup({ script: [answer('nee')], docker: { prepare: { code: 1, out: 'npm ERR! kapot' } } })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR PREPARE_FAILED: prepare faalde/))
  })

  it('3× red ⇒ ERROR VERIFY_FAILED survives closeFailed, exactly one closing block', async () => {
    const t = await setup({
      script: [write('a.txt', 'a\n'), answer('klaar 1'), answer('klaar 2'), answer('klaar 3')],
      docker: { verify: [RED('rood-1'), RED('rood-2'), RED('rood-3')] },
    })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    const lines = runLogLines(t.runLogDir)
    expect(lines.filter((l) => l.includes('"type":"harness.run_end"'))).toHaveLength(1)
    expect(lines).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR VERIFY_FAILED: /))
  })

  it('commitAll throwing ⇒ ERROR COMMIT_FAILED, outcome failed', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')] })
    vi.mocked(commitAll).mockRejectedValueOnce(new Error('commit kapot'))
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(String(lastJobUpdate(t.mcp)?.error)).toMatch(/^commit mislukt: commit kapot/)
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR COMMIT_FAILED: commit mislukt: commit kapot/))
  })

  it('plan check divergent ⇒ ERROR PLAN_CHECK_FAILED, outcome failed', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')], verifyResult: 'divergent' })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR PLAN_CHECK_FAILED: verify_task_against_plan: divergent/))
  })

  it('done refused ⇒ ERROR DONE_REFUSED, outcome failed', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')], failUpdate: ['done'] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR DONE_REFUSED: done geweigerd: /))
  })

  it('done outcome unknown (a thrown call) ⇒ ERROR DONE_UNKNOWN, outcome abandoned', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')] })
    const orig = t.mcp.client.callTool.bind(t.mcp.client)
    vi.spyOn(t.mcp.client, 'callTool').mockImplementation(async (params: { name: string; arguments?: Record<string, unknown> }, schema?: unknown, opts?: unknown) => {
      if (params.name === 'update_job_status' && params.arguments?.status === 'done') {
        throw new McpError(ErrorCode.RequestTimeout, 'Request timed out')
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (orig as any)(params, schema, opts)
    })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('abandoned')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR DONE_UNKNOWN: uitkomst van done onbekend: /))
  })

  it('a lost heartbeat after an earlier fail() still closes with ABANDONED (override wins)', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')], heartbeatMs: 20 })
    let refuse = false
    const control = t.deps.control
    t.deps.control = {
      ...control,
      heartbeat: async (id) => (refuse ? false : control.heartbeat(id)),
      log: async (kind, args) => {
        const r = await control.log(kind, args)
        if (kind === 'commit') {
          refuse = true
          await new Promise((res) => setTimeout(res, 80)) // at least one refused beat lands
        }
        return r
      },
    }
    // A synthetic "earlier fail" (not otherwise reachable in one run: every fail-recording branch returns
    // or throws at once) proves abandon() really passes override: true, not just that it fires first.
    const origRunLogFor = t.deps.runLogFor
    t.deps.runLogFor = (claim) => {
      const rl = origRunLogFor?.(claim) ?? null
      rl?.fail('EERDERE_TEST_CODE', 'eerdere fail, moet worden overschreven')
      return rl
    }
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('abandoned')
    const lines = runLogLines(t.runLogDir)
    expect(lines).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR ABANDONED: eigendom kwijt \(heartbeat geweigerd\)$/))
    expect(lines.join('\n')).not.toContain('EERDERE_TEST_CODE')
  })

  it('a container not provably stopped ⇒ ERROR CONTAINER_UNCERTAIN, exactly one closing block, and ContainerUncertainError still reaches the worker loop', async () => {
    const t = await setup({ script: [answer('nee')], docker: { prepare: { hang: true }, killCode: 1 } })
    const r = await t.run()
    expect(r).toEqual({ jobs: [{ jobId: 'job1', outcome: 'failed' }], exitCode: 1 })
    const lines = runLogLines(t.runLogDir)
    expect(lines.filter((l) => l.includes('"type":"harness.run_end"'))).toHaveLength(1)
    expect(lines).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR CONTAINER_UNCERTAIN: /))
  })

  it('a stop during the gate verify ⇒ ERROR STOPPED (Review Focus 3)', async () => {
    const stop = new AbortController()
    const t = await setup({
      script: [write('a.txt', 'a\n'), answer('klaar')],
      docker: { verify: [{ hang: true }], onRun: (kind) => { if (kind === 'verify') setTimeout(() => stop.abort(), 20) } },
      timeouts: { verify: 10 },
      signal: stop.signal,
    })
    const r = await t.run()
    expect(r.exitCode).toBe(0)
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR STOPPED: worker gestopt/))
  })

  // ---- Bonus coverage: the rest of the brief's code table, each reusing an existing production scenario ----

  it('no task-config ⇒ ERROR NO_TASK_CONFIG', async () => {
    const t = await setup({ noTask: true, script: [answer('nee')] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR NO_TASK_CONFIG: worker heeft geen task-config$/))
  })

  it('an unreadable worktree ⇒ ERROR GIT_SCAN_FAILED (the pre-loop snapshot)', async () => {
    const t = await setup({ claims: (wt) => [{ job: taskPayload({ worktree: join(wt, 'bestaat-niet') }) }] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR GIT_SCAN_FAILED: git-administratie niet te scannen: /))
  })

  it('leftover containers not provably clean ⇒ ERROR CONTAINERS_LEFTOVER', async () => {
    const t = await setup({ script: [answer('nee')], docker: { leftovers: [{ out: 'abc123\n' }, { out: 'abc123\n' }], rmCode: 1 } })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR CONTAINERS_LEFTOVER: achtergebleven harness-container niet aantoonbaar opgeruimd/))
  })

  it('running refused ⇒ ERROR ABANDONED', async () => {
    const t = await setup({ script: [answer('nee')], failUpdate: ['running'] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('abandoned')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR ABANDONED: niet \(meer\) van deze worker/))
  })

  it('update_task_status(in_progress) refused ⇒ ERROR JOB_FAILED', async () => {
    const t = await setup({ script: [answer('nee')] })
    const control = t.deps.control
    t.deps.control = { ...control, updateTaskStatus: async (id, status) => (status === 'in_progress' ? { ok: false, message: 'geweigerd' } : control.updateTaskStatus(id, status)) }
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR JOB_FAILED: update_task_status in_progress mislukt: geweigerd/))
  })

  it('the model changes nothing ⇒ ERROR NO_CHANGES', async () => {
    const t = await setup({ script: [answer('alles was al goed')] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR NO_CHANGES: model produceerde geen wijzigingen/))
  })

  it('a gitlink bent by the container ⇒ ERROR GIT_ADMIN_CHANGED', async () => {
    let wt = ''
    const t = await setup({
      script: [write('a.txt', 'a\n'), answer('klaar')],
      docker: { verify: [{ code: 0, effect: () => writeFileSync(join(wt, '.git'), 'gitdir: /tmp/evil\n') }] },
    })
    wt = t.worktree
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR GIT_ADMIN_CHANGED: git-administratie gewijzigd: changed: \.git$/))
  })

  it('done comes back as failed after a push error ⇒ ERROR DONE_ENDED_FAILED', async () => {
    const t = await setup({ script: [write('a.txt', 'a\n'), answer('klaar')], doneOutcome: { status: 'failed', error: 'push failed', pushed_at: null } })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR DONE_ENDED_FAILED: update_job_status\(done\) eindigde als failed \(push failed\)$/))
  })

  it('an invalid payload ⇒ ERROR PAYLOAD_INVALID', async () => {
    const t = await setup({ claims: () => [{ job: { job_id: 'job1', kind: 'TASK_IMPLEMENTATION', config: { runtime: 'HARNESS' } } }] })
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR PAYLOAD_INVALID: payload ongeldig: /))
  })

  it('openTrace throwing ⇒ ERROR HARNESS_ERROR', async () => {
    const t = await setup({ script: [answer('nee')] })
    const blockerDir = tmp('out-blocker')
    const blockerFile = join(blockerDir, 'blocker') // a plain file where openTrace expects a directory: mkdirSync fails
    writeFileSync(blockerFile, 'x')
    t.deps.out = blockerFile
    const r = await t.run()
    expect(r.jobs[0].outcome).toBe('failed')
    expect(runLogLines(t.runLogDir)).toContainEqual(expect.stringMatching(/^\S+ \[harness\] ERROR HARNESS_ERROR: harness: /))
  })
})
