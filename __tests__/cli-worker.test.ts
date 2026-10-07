import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSpec } from '../src/types.js'
import { completion, startFakeModelServer } from './fakes/fake-model-server.js'
import { startFakeScrum4meMcp, type ClaimStep, type HealthSetup } from './fakes/fake-scrum4me-mcp.js'
import { ideaChatPayload } from './fakes/idea-chat-payload.js'
import { TEST_CONFIGURATION } from './fakes/worker-config.js'
import { dirContains, tmp } from './helpers.js'

const stdioCalls: ServerSpec[] = []
let claims: ClaimStep[] = []
let health: HealthSetup = {}
let fakeMcp: Awaited<ReturnType<typeof startFakeScrum4meMcp>> | undefined
// Set fresh on every connectStdioClient call: lets a test assert the harness itself closed the MCP
// child (Fix 2 / cmdWorker's `finally`), independent of this test file's own afterEach cleanup below.
let lastCloseSpy: ReturnType<typeof vi.fn> | undefined

vi.mock('../src/tools/registry.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/tools/registry.js')>()
  return {
    ...actual,
    connectStdioClient: vi.fn(async (server: ServerSpec) => {
      stdioCalls.push(server)
      fakeMcp = await startFakeScrum4meMcp({ claims, health })
      const closeSpy = vi.fn(fakeMcp.close)
      lastCloseSpy = closeSpy
      return { client: fakeMcp.client, close: closeSpy }
    }),
  }
})

const { main } = await import('../src/cli.js')

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let model: Fake | undefined
let stderr: string[] = []
beforeEach(() => {
  stdioCalls.length = 0
  claims = []
  health = {}
  stderr = []
  process.env.TEST_LITELLM_MASTER_KEY = 'test-master-key-0123456789' // `worker` needs --api-key-env; runWorkerCli passes it
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true })
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await model?.close()
  await fakeMcp?.close()
  model = undefined
  fakeMcp = undefined
  delete process.env.SCRUM4ME_TOKEN
  delete process.env.TEST_HARNESS_SECRET
  delete process.env.TEST_LITELLM_MASTER_KEY
})

/** A fake LiteLLM that lists `ids` as its models (by default exactly the configuration of workerConfig below). */
async function litellm(script: Parameters<typeof startFakeModelServer>[0] = [], ids: string[] = [TEST_CONFIGURATION]): Promise<Fake> {
  model = await startFakeModelServer(script, { ids })
  return model
}

function workerConfig(dir: string, baseUrl: string, over: Record<string, unknown> = {}) {
  const p = join(dir, 'worker.json')
  writeFileSync(p, JSON.stringify({
    litellm: { baseUrl, configPath: '/etc/agent-harness/litellm/config.yaml', composePath: '/etc/agent-harness/litellm/compose.yaml' },
    configurations: { [TEST_CONFIGURATION]: { costMode: 'local', contextTokens: 32768 } },
    mcp: { command: 'mcp-bin', args: ['--x'], env: { SCRUM4ME_TOKEN: '${SCRUM4ME_TOKEN}', SCRUM4ME_WORKER_CAPABILITIES: 'code_edit' } },
    waitSeconds: 1,
    ...over,
  }))
  return p
}

/** `harness worker` in a fresh dir against the config of workerConfig; `baseUrl` is the LiteLLM, `flags` come after the fixed ones. */
async function runWorkerCli(baseUrl: string, o: { flags?: string[]; config?: Record<string, unknown>; out?: string; withoutKey?: boolean } = {}) {
  const dir = tmp('cli-worker')
  const out = o.out ?? join(dir, 'runs')
  const flags = o.flags ?? ['--once']
  // `worker` requires --api-key-env: it is added unless the test names it itself or wants it left out.
  const withKey = o.withoutKey || flags.includes('--api-key-env') ? flags : [...flags, '--api-key-env', 'TEST_LITELLM_MASTER_KEY']
  const code = await main(['worker', '--config', workerConfig(dir, baseUrl, o.config), '--out', out, ...withKey])
  return { code, dir, out }
}

describe('harness worker', () => {
  it('rejects a config with a forbidden tool before starting the MCP', async () => {
    const m = await litellm()
    process.env.SCRUM4ME_TOKEN = 'x'
    const { code } = await runWorkerCli(m.baseUrl, { config: { allow: ['update_job_status'] } })
    expect(code).toBe(78)
    expect(stderr.join('')).toContain('update_job_status')
    expect(stdioCalls).toHaveLength(0)
  })

  it('rejects an unset ${VAR} before starting the MCP', async () => {
    const m = await litellm()
    const { code } = await runWorkerCli(m.baseUrl)
    expect(code).toBe(78)
    expect(stderr.join('')).toContain('SCRUM4ME_TOKEN')
    expect(stdioCalls).toHaveLength(0)
  })

  it('forces HARNESS without a capability into the MCP env and exits 0 on a timeout with --once', async () => {
    const m = await litellm()
    process.env.SCRUM4ME_TOKEN = 'x'
    claims = [{ timeout: true }]
    const { code } = await runWorkerCli(m.baseUrl)
    expect(code).toBe(0)
    expect(stdioCalls).toHaveLength(1)
    expect(stdioCalls[0]).toEqual({
      command: 'mcp-bin', args: ['--x'],
      env: { SCRUM4ME_TOKEN: 'x', SCRUM4ME_WORKER_CAPABILITIES: '', SCRUM4ME_WORKER_RUNTIME: 'HARNESS' },
    })
  })

  it('runs one job with the expanded token only in the MCP env, never in the run dir or output', async () => {
    const m = await litellm([{ body: completion({ content: 'Hier is je antwoord.', model: 'qwen3-coder:30b' }) }])
    process.env.SCRUM4ME_TOKEN = 'sk-test-secret'
    claims = [{ job: ideaChatPayload() }]
    const { code, out } = await runWorkerCli(m.baseUrl)
    expect(code).toBe(0)
    expect(stdioCalls[0].env?.SCRUM4ME_TOKEN).toBe('sk-test-secret')
    expect(fakeMcp?.calls.filter((c) => c.name === 'update_job_status').map((c) => c.args.status)).toEqual(['running', 'done'])
    expect(readdirSync(out).some((n) => n.startsWith('job-job1-'))).toBe(true)
    expect(dirContains(out, 'sk-test-secret')).toBe(false)
    expect(stderr.join('')).not.toContain('sk-test-secret')
  })

  it('writes a run-log under <dir>/harness/max2/runs/ with the package.json version, when workerLog is configured (M4 Taak 5)', async () => {
    const m = await litellm([{ body: completion({ content: 'Hier is je antwoord.', model: 'qwen3-coder:30b' }) }])
    process.env.SCRUM4ME_TOKEN = 'sk-test-secret'
    claims = [{ job: ideaChatPayload() }]
    const dir = tmp('cli-worker-log')
    const logDir = join(dir, 'worker-logs')
    const { code } = await runWorkerCli(m.baseUrl, { config: { workerLog: { dir: logDir, pool: 'harness', instance: 'max2' } } })
    expect(code).toBe(0)
    const runsDir = join(logDir, 'harness', 'max2', 'runs')
    const files = readdirSync(runsDir).filter((f) => f.endsWith('.log'))
    expect(files).toHaveLength(1)
    const lines = readFileSync(join(runsDir, files[0]), 'utf8').trim().split('\n')
    const runStart = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).find((j) => j.type === 'harness.run_start')
    const pkgVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
    expect(runStart.version).toBe(`agent-harness@${pkgVersion}`)
  })

  it('writes the configuration, cost mode, ceiling and LiteLLM address of the job in the config line, and the configuration as the model of harness.run_start', async () => {
    const m = await litellm([{ body: completion({ content: 'Hier is je antwoord.', model: 'qwen3-coder:30b' }) }])
    process.env.SCRUM4ME_TOKEN = 'x'
    claims = [{ job: ideaChatPayload({ config: { runtime: 'HARNESS', model: TEST_CONFIGURATION, max_cost_usd: '0.50' } }) }]
    const logDir = join(tmp('cli-worker-log'), 'worker-logs')
    const { code } = await runWorkerCli(m.baseUrl, { config: { workerLog: { dir: logDir, pool: 'harness', instance: 'max2' } } })
    expect(code).toBe(0)
    const runsDir = join(logDir, 'harness', 'max2', 'runs')
    const lines = readFileSync(join(runsDir, readdirSync(runsDir).filter((f) => f.endsWith('.log'))[0]), 'utf8').trim().split('\n')
    expect(lines[1]).toMatch(new RegExp(`^\\S+ \\[harness\\] config job_id=job1 runtime=HARNESS kind=IDEA_CHAT model=${TEST_CONFIGURATION} configuration=${TEST_CONFIGURATION} cost_mode=local max_cost_usd=0\\.50 base_url=${m.baseUrl.replace(/[.]/g, '\\.')}$`))
    const runStart = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).find((j) => j.type === 'harness.run_start')
    expect(runStart).toMatchObject({ model: TEST_CONFIGURATION, baseUrl: m.baseUrl })
  })

  it('still logs a job of an unknown configuration, with the name it asked for and a marked cost mode', async () => {
    const m = await litellm()
    process.env.SCRUM4ME_TOKEN = 'x'
    claims = [{ job: ideaChatPayload({ config: { runtime: 'HARNESS', model: 'nope' } }) }]
    const logDir = join(tmp('cli-worker-log'), 'worker-logs')
    const { code } = await runWorkerCli(m.baseUrl, { config: { workerLog: { dir: logDir, pool: 'harness', instance: 'max2' } } })
    expect(code).toBe(1)
    const runsDir = join(logDir, 'harness', 'max2', 'runs')
    const lines = readFileSync(join(runsDir, readdirSync(runsDir).filter((f) => f.endsWith('.log'))[0]), 'utf8').trim().split('\n')
    expect(lines[1]).toMatch(/ config job_id=job1 runtime=HARNESS kind=IDEA_CHAT model=nope configuration=nope cost_mode=onbekend max_cost_usd=ontbrekend base_url=/)
  })

  it('redacts a process-env secret, the expanded MCP token and the --api-key-env key from the run-log, leaving *** in their place (M4 Taak 5; a baseUrl password is covered by the Taak 3/4 tests instead, since the model call never reaches a turn)', async () => {
    const envSecret = 'proc-env-secret-fake-9001'
    const tokenSecret = 'mcp-env-token-fake-9002'
    const apiKeySecret = 'model-api-key-fake-9003'
    process.env.TEST_HARNESS_SECRET = envSecret
    process.env.SCRUM4ME_TOKEN = tokenSecret
    process.env.TEST_LITELLM_MASTER_KEY = apiKeySecret
    const m = await litellm([
      {
        body: {
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model: 'qwen3-coder:30b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `antwoord met ${envSecret} en ${tokenSecret} en ${apiKeySecret}`, reasoning: `denkt aan ${envSecret}, ${tokenSecret} en ${apiKeySecret}` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      },
    ])
    claims = [{ job: ideaChatPayload() }]
    const logDir = join(tmp('cli-worker-log'), 'worker-logs')
    const { code } = await runWorkerCli(m.baseUrl, { flags: ['--once', '--api-key-env', 'TEST_LITELLM_MASTER_KEY'], config: { workerLog: { dir: logDir, pool: 'harness', instance: 'max2' } } })
    expect(code).toBe(0)
    const runsDir = join(logDir, 'harness', 'max2', 'runs')
    const files = readdirSync(runsDir).filter((f) => f.endsWith('.log'))
    expect(files).toHaveLength(1)
    const text = readFileSync(join(runsDir, files[0]), 'utf8')
    expect(text).not.toContain(envSecret)
    expect(text).not.toContain(tokenSecret)
    expect(text).not.toContain(apiKeySecret)
    expect(text).toContain('***')
  })

  it('closes the MCP connection itself before returning, so systemd stop does not have to (Fix 2)', async () => {
    const m = await litellm()
    process.env.SCRUM4ME_TOKEN = 'x'
    claims = [{ timeout: true }]
    const { code } = await runWorkerCli(m.baseUrl)
    expect(code).toBe(0)
    // Asserted immediately after main() returns, before this file's afterEach ever touches fakeMcp —
    // proves cmdWorker's own `finally` (src/cli.ts) called conn.close(), not test cleanup.
    expect(lastCloseSpy).toHaveBeenCalledTimes(1)
  })

  it('passes the reasoningEffort and the extraBody of the configuration of the job to the model request, under the name of the configuration', async () => {
    const m = await litellm([{ body: completion({ content: 'Antwoord.', model: 'qwen3-coder:30b' }) }])
    process.env.SCRUM4ME_TOKEN = 'x'
    claims = [{ job: ideaChatPayload() }]
    const configurations = { [TEST_CONFIGURATION]: { costMode: 'local', contextTokens: 32768, reasoningEffort: 'none', extraBody: { temperature: 0.2 } } }
    const { code } = await runWorkerCli(m.baseUrl, { config: { configurations } })
    expect(code).toBe(0)
    expect(m.requests[0].body).toMatchObject({ model: TEST_CONFIGURATION, reasoning_effort: 'none', temperature: 0.2 })
  })

  it('caps max_chars of get_product_doc at 12 000 on its way to the MCP (ISS-1)', async () => {
    const m = await litellm([
      { body: completion({ toolCalls: [{ id: 'c1', name: 'get_product_doc', arguments: JSON.stringify({ doc_id: 'doc1', max_chars: 40_000 }) }], model: 'qwen3-coder:30b' }) },
      { body: completion({ content: 'Antwoord.', model: 'qwen3-coder:30b' }) },
    ])
    process.env.SCRUM4ME_TOKEN = 'x'
    claims = [{ job: ideaChatPayload() }]
    const { code } = await runWorkerCli(m.baseUrl)
    expect(code).toBe(0)
    expect(fakeMcp?.calls.filter((c) => c.name === 'get_product_doc').map((c) => c.args)).toEqual([{ doc_id: 'doc1', max_chars: 12_000 }])
  })
})

const waitCalls = () => fakeMcp?.calls.filter((c) => c.name === 'wait_for_job').length ?? 0

describe('harness worker — start check and exit codes (M45-2d)', () => {
  async function start(extra: string[] = ['--once'], over: Record<string, unknown> = {}, script: Parameters<typeof startFakeModelServer>[0] = []) {
    const m = await litellm(script)
    process.env.SCRUM4ME_TOKEN = 'x'
    return (await runWorkerCli(m.baseUrl, { flags: extra, config: over })).code
  }

  it.each([
    ['without HARNESS in health.runtimes', { runtimes: ['CLAUDE', 'CODEX'] }, '["CLAUDE","CODEX"]'],
    ['with a health reply without a runtimes field', { runtimes: null }, 'ontbrekend'],
    ['without a health tool', { noTool: true }, 'ontbrekend'],
    ['with a health tool error', { error: 'database down' }, 'ontbrekend'],
  ])('exits 78 before any claim %s', async (_what, setup, shown) => {
    health = setup
    claims = [{ job: ideaChatPayload() }]
    const code = await start()
    expect(code).toBe(78)
    expect(waitCalls()).toBe(0)
    expect(fakeMcp?.calls.map((c) => c.name).filter((n) => n !== 'health')).toEqual([])
    expect(stderr.join('')).toContain(`STARTCHECK_FAILED: de MCP kent HARNESS niet (health.runtimes=${shown})`)
    expect(lastCloseSpy).toHaveBeenCalledTimes(1) // the MCP child does not outlive the refusal
  })

  it('calls health once before the first wait_for_job when runtimes contains HARNESS, and the loop starts', async () => {
    claims = [{ timeout: true }]
    const code = await start()
    expect(code).toBe(0)
    expect(fakeMcp?.calls.map((c) => c.name)).toEqual(['health', 'wait_for_job'])
    expect(stderr.join('')).not.toContain('STARTCHECK_FAILED')
  })

  it('exits 1 when the MCP closes while the worker waits for a job', async () => {
    claims = [{ hangMs: 5000 }]
    const exited = start([])
    await vi.waitFor(() => expect(waitCalls()).toBe(1))
    await fakeMcp?.close()
    expect(await exited).toBe(1)
    expect(waitCalls()).toBe(1)
  })

  it('exits 1 at once when the MCP closes during a job, leaves the job and claims nothing new', async () => {
    claims = [{ job: ideaChatPayload() }, { job: ideaChatPayload({ jobId: 'job2' }) }]
    const started = Date.now()
    const exited = start([], {}, [{ delayMs: 4000, body: completion({ content: 'te laat', model: 'qwen3-coder:30b' }) }])
    await vi.waitFor(() => expect(model?.requests).toHaveLength(1))
    await fakeMcp?.close()
    expect(await exited).toBe(1)
    expect(Date.now() - started).toBeLessThan(3000) // the pending model call did not run to its end
    expect(waitCalls()).toBe(1)
    expect(stderr.join('')).toMatch(/MCP-verbinding verloren/)
  })

  it('does not count its own close as a lost connection', async () => {
    claims = [{ timeout: true }]
    const code = await start()
    expect(code).toBe(0)
    expect(stderr.join('')).not.toMatch(/MCP-verbinding verloren/)
  })

  // Spec acceptance 7: a valid start, the child gone (1), a new start against an MCP without the runtimes field (78, no claim).
  it('restarts after a lost child with exit 1 but not against an MCP that does not know HARNESS: 78, no claim, nothing prepared', async () => {
    claims = [{ hangMs: 5000 }]
    const first = start([])
    await vi.waitFor(() => expect(waitCalls()).toBe(1))
    await fakeMcp?.close()
    expect(await first).toBe(1)

    health = { runtimes: null }
    claims = [{ job: ideaChatPayload() }]
    await model?.close()
    const second = await start()
    expect(second).toBe(78)
    expect(stdioCalls).toHaveLength(2)
    expect(fakeMcp?.calls.map((c) => c.name)).toEqual(['health']) // no wait_for_job, so no claim and no worktree
  })
})

// Rows 2 and 3 of the T-2065 table: what is wrong before the MCP child exists costs no child, and says whether a restart can help.
describe('harness worker — the LiteLLM check and the start errors (M45-2d T-2065)', () => {
  beforeEach(() => {
    process.env.SCRUM4ME_TOKEN = 'x'
  })

  describe('against the models of LiteLLM', () => {
    it.each([
      ['a configuration that LiteLLM does not know', ['other-model'], ['other-model']],
      ['a LiteLLM model without a configuration', [TEST_CONFIGURATION, 'extra-model'], ['extra-model']],
      ['an empty model list', [], []],
    ])('exits 78 with %s, naming both lists, and starts no MCP child', async (_what, ids, shown) => {
      const m = await litellm([], ids)
      claims = [{ job: ideaChatPayload() }]
      const { code } = await runWorkerCli(m.baseUrl)
      expect(code).toBe(78)
      expect(stdioCalls).toHaveLength(0)
      const text = stderr.join('')
      expect(text).toContain('LITELLM_MODELS_MISMATCH')
      expect(text).toContain(`configuraties=${JSON.stringify([TEST_CONFIGURATION])}`)
      expect(text).toContain(`litellm=${JSON.stringify(ids)}`)
      for (const name of shown) expect(text).toContain(name)
    })

    it('exits 1 when LiteLLM cannot be reached, and starts no MCP child', async () => {
      const { code } = await runWorkerCli('http://127.0.0.1:1/v1')
      expect(code).toBe(1)
      expect(stdioCalls).toHaveLength(0)
      expect(stderr.join('')).toContain('LITELLM_UNREACHABLE')
    })

    it.each([
      ['an HTTP error', { status: 500, body: { error: 'kapot' } }],
      ['an answer that is no JSON', { body: 'geen json' }],
      ['an answer without a model list', { body: { object: 'list' } }],
      ['a model list with an entry without an id', { body: { data: [{ object: 'model' }] } }],
    ])('exits 1 on %s, and starts no MCP child', async (_what, answer) => {
      model = await startFakeModelServer([], answer)
      const { code } = await runWorkerCli(model.baseUrl)
      expect(code).toBe(1)
      expect(stdioCalls).toHaveLength(0)
      expect(stderr.join('')).toContain('LITELLM_UNREACHABLE')
    })

    it('asks once for GET <baseUrl>/models, and then starts the MCP child when the lists agree', async () => {
      const m = await litellm()
      claims = [{ timeout: true }]
      const { code } = await runWorkerCli(m.baseUrl)
      expect(code).toBe(0)
      expect(m.modelsRequests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /v1/models'])
      expect(stdioCalls).toHaveLength(1)
    })

    it('sends the key of --api-key-env as a Bearer header', async () => {
      const key = 'test-master-key-0123456789'
      process.env.TEST_LITELLM_MASTER_KEY = key
      const m = await litellm()
      claims = [{ timeout: true }]
      expect((await runWorkerCli(m.baseUrl, { flags: ['--once', '--api-key-env', 'TEST_LITELLM_MASTER_KEY'] })).code).toBe(0)
      expect(m.modelsRequests[0].headers.authorization).toBe(`Bearer ${key}`)
    })

    it('requires --api-key-env: without it exit 78 with the usage text, no request to LiteLLM and no MCP child', async () => {
      const m = await litellm()
      claims = [{ timeout: true }]
      const { code } = await runWorkerCli(m.baseUrl, { withoutKey: true })
      expect(code).toBe(78)
      expect(stderr.join('')).toContain('--api-key-env')
      expect(stderr.join('')).toContain('Usage:')
      expect(m.modelsRequests).toHaveLength(0)
      expect(stdioCalls).toHaveLength(0)
    })

    it.each([401, 403])('exits 78 on HTTP %i from /models (the key is wrong and a restart repeats it), with LITELLM_AUTH_FAILED and no MCP child', async (status) => {
      const key = 'test-master-key-0123456789'
      process.env.TEST_LITELLM_MASTER_KEY = key
      model = await startFakeModelServer([], { status, body: { error: `invalid key ${key}` } })
      const { code } = await runWorkerCli(model.baseUrl)
      expect(code).toBe(78)
      expect(stderr.join('')).toContain('LITELLM_AUTH_FAILED')
      expect(stderr.join('')).toContain(`HTTP ${status}`)
      expect(stderr.join('')).not.toContain(key)
      expect(stdioCalls).toHaveLength(0)
    })

    it.each([500, 502, 503, 404])('keeps HTTP %i from /models at exit 1 (LiteLLM may come up), as LITELLM_UNREACHABLE', async (status) => {
      model = await startFakeModelServer([], { status, body: { error: 'kapot' } })
      const { code } = await runWorkerCli(model.baseUrl)
      expect(code).toBe(1)
      expect(stderr.join('')).toContain('LITELLM_UNREACHABLE')
      expect(stdioCalls).toHaveLength(0)
    })

    it('never prints the key, also not when LiteLLM echoes it in an error', async () => {
      const key = 'test-master-key-0123456789'
      process.env.TEST_LITELLM_MASTER_KEY = key
      model = await startFakeModelServer([], { status: 401, body: { error: `invalid key ${key}` } })
      const { code } = await runWorkerCli(model.baseUrl, { flags: ['--once', '--api-key-env', 'TEST_LITELLM_MASTER_KEY'] })
      expect(code).toBe(78)
      expect(stderr.join('')).not.toContain(key)
      expect(stdioCalls).toHaveLength(0)
    })

    it('checks the models after the config and the key, so those errors never reach LiteLLM', async () => {
      delete process.env.TEST_LITELLM_MASTER_KEY
      const m = await litellm()
      const { code } = await runWorkerCli(m.baseUrl, { flags: ['--once', '--api-key-env', 'TEST_LITELLM_MASTER_KEY'] })
      expect(code).toBe(78)
      expect(m.modelsRequests).toHaveLength(0)
    })
  })

  describe('a litellm.baseUrl with credentials', () => {
    const PASSWORD = 'pw-fake-0123456789'

    it('is refused by the config (78, no MCP child, no request), and nothing of the password reaches stdout or stderr', async () => {
      const m = await litellm()
      const withCredentials = m.baseUrl.replace('http://', `http://litellm:${PASSWORD}@`)
      const { code } = await runWorkerCli(withCredentials)
      expect(code).toBe(78)
      expect(stdioCalls).toHaveLength(0)
      expect(m.modelsRequests).toHaveLength(0)
      const text = stderr.join('')
      expect(text).toContain('litellm.baseUrl')
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain('litellm:')
    })

    it('also when only a username is given', async () => {
      const m = await litellm()
      const { code } = await runWorkerCli(m.baseUrl.replace('http://', 'http://litellm@'))
      expect(code).toBe(78)
      expect(stderr.join('')).toContain('litellm.baseUrl')
    })

    // The schema keeps such a URL out, but the check must not depend on that: undici refuses a credentialed URL with a message that holds it.
    it('checkLitellmModels itself prints no URL credentials and no raw error message when the request fails', async () => {
      const { checkLitellmModels } = await import('../src/cli.js')
      const config = { litellm: { baseUrl: `http://litellm:${PASSWORD}@127.0.0.1:1/v1` }, configurations: { [TEST_CONFIGURATION]: {} } } as unknown as Parameters<typeof checkLitellmModels>[0]
      const result = await checkLitellmModels(config, 'test-master-key-0123456789')
      expect(result.ok).toBe(false)
      const line = result.ok ? '' : result.line
      expect(line).toContain('LITELLM_UNREACHABLE')
      expect(line).not.toContain(PASSWORD)
      expect(line).not.toContain('litellm:')
      expect(line).not.toContain('@')
    })

    it('checkLitellmModels prints no URL credentials when the connection is refused either', async () => {
      const { checkLitellmModels } = await import('../src/cli.js')
      const config = { litellm: { baseUrl: 'http://127.0.0.1:1/v1' }, configurations: { [TEST_CONFIGURATION]: {} } } as unknown as Parameters<typeof checkLitellmModels>[0]
      const result = await checkLitellmModels(config, undefined)
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.line).toMatch(/^LITELLM_UNREACHABLE: GET http:\/\/127\.0\.0\.1:1\/v1\/models mislukt \(TypeError( [A-Z_]+)?\)$/)
    })
  })

  describe('a start error that a restart cannot cure exits 78 with no MCP child', () => {
    it('an invalid worker config (ManifestError): the old model block', async () => {
      const m = await litellm()
      const { code } = await runWorkerCli(m.baseUrl, { config: { model: { baseUrl: m.baseUrl, name: 'x' } } })
      expect(code).toBe(78)
      expect(stdioCalls).toHaveLength(0)
      expect(stderr.join('')).toContain('invalid worker config')
    })

    it('an unreadable worker config (ManifestError)', async () => {
      const code = await main(['worker', '--config', join(tmp('cli-worker'), 'bestaat-niet.json'), '--once'])
      expect(code).toBe(78)
      expect(stdioCalls).toHaveLength(0)
    })

    it.each([
      ['unset', undefined],
      ['empty', ''],
    ])('a --api-key-env variable that is %s (UsageError, with the usage text)', async (_what, value) => {
      if (value === undefined) delete process.env.TEST_LITELLM_MASTER_KEY
      else process.env.TEST_LITELLM_MASTER_KEY = value
      const m = await litellm()
      const { code } = await runWorkerCli(m.baseUrl, { flags: ['--once', '--api-key-env', 'TEST_LITELLM_MASTER_KEY'] })
      expect(code).toBe(78)
      expect(stdioCalls).toHaveLength(0)
      expect(stderr.join('')).toContain('TEST_LITELLM_MASTER_KEY')
      expect(stderr.join('')).toContain('Usage:')
    })

    it('a missing --config (UsageError)', async () => {
      const code = await main(['worker', '--once'])
      expect(code).toBe(78)
      expect(stdioCalls).toHaveLength(0)
    })

    it('an unset ${VAR} in mcp.env', async () => {
      delete process.env.SCRUM4ME_TOKEN
      const m = await litellm()
      const { code } = await runWorkerCli(m.baseUrl)
      expect(code).toBe(78)
      expect(stdioCalls).toHaveLength(0)
    })
  })

  it('leaves the exit code of the other commands as it was: a UsageError of harness run is still 1', async () => {
    const code = await main(['run'])
    expect(code).toBe(1)
  })
})
