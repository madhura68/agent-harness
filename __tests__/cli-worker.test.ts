import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSpec } from '../src/types.js'
import { completion, startFakeModelServer } from './fakes/fake-model-server.js'
import { startFakeScrum4meMcp, type ClaimStep } from './fakes/fake-scrum4me-mcp.js'
import { ideaChatPayload } from './fakes/idea-chat-payload.js'
import { dirContains, tmp } from './helpers.js'

const stdioCalls: ServerSpec[] = []
let claims: ClaimStep[] = []
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
      fakeMcp = await startFakeScrum4meMcp({ claims })
      const closeSpy = vi.fn(fakeMcp.close)
      lastCloseSpy = closeSpy
      return { client: fakeMcp.client, close: closeSpy }
    }),
  }
})

const { main } = await import('../src/cli.js')
const { probeDir } = await import('../src/probe.js')

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let model: Fake | undefined
let stderr: string[] = []
beforeEach(() => {
  stdioCalls.length = 0
  claims = []
  stderr = []
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
})

function workerConfig(dir: string, baseUrl: string, over: Record<string, unknown> = {}) {
  const p = join(dir, 'worker.json')
  writeFileSync(p, JSON.stringify({
    model: { baseUrl, name: 'qwen3-coder:30b' },
    mcp: { command: 'mcp-bin', args: ['--x'], env: { SCRUM4ME_TOKEN: '${SCRUM4ME_TOKEN}', SCRUM4ME_WORKER_CAPABILITIES: 'code_edit' } },
    waitSeconds: 1,
    ...over,
  }))
  return p
}

function writeProbe(out: string, baseUrl: string) {
  const d = probeDir(out, 'qwen3-coder:30b')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'probe.json'), JSON.stringify({ baseUrl, model: 'qwen3-coder:30b', tool_calling: 'reliable' }))
}

describe('harness worker', () => {
  it('refuses with PROBE_REQUIRED and starts no MCP without a probe', async () => {
    const dir = tmp('cli-worker')
    process.env.SCRUM4ME_TOKEN = 'x'
    const code = await main(['worker', '--config', workerConfig(dir, 'http://127.0.0.1:1/v1'), '--out', join(dir, 'runs'), '--once'])
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('PROBE_REQUIRED')
    expect(stdioCalls).toHaveLength(0)
  })

  it('rejects a config with a forbidden tool before starting the MCP', async () => {
    const dir = tmp('cli-worker')
    const out = join(dir, 'runs')
    writeProbe(out, 'http://127.0.0.1:1/v1')
    const code = await main(['worker', '--config', workerConfig(dir, 'http://127.0.0.1:1/v1', { allow: ['update_job_status'] }), '--out', out, '--once'])
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('update_job_status')
    expect(stdioCalls).toHaveLength(0)
  })

  it('rejects an unset ${VAR} before starting the MCP', async () => {
    const dir = tmp('cli-worker')
    const out = join(dir, 'runs')
    writeProbe(out, 'http://127.0.0.1:1/v1')
    const code = await main(['worker', '--config', workerConfig(dir, 'http://127.0.0.1:1/v1'), '--out', out, '--once'])
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('SCRUM4ME_TOKEN')
    expect(stdioCalls).toHaveLength(0)
  })

  it('forces local_llm into the MCP env and exits 0 on a timeout with --once', async () => {
    const dir = tmp('cli-worker')
    const out = join(dir, 'runs')
    writeProbe(out, 'http://127.0.0.1:1/v1')
    process.env.SCRUM4ME_TOKEN = 'x'
    claims = [{ timeout: true }]
    const code = await main(['worker', '--config', workerConfig(dir, 'http://127.0.0.1:1/v1'), '--out', out, '--once'])
    expect(code).toBe(0)
    expect(stdioCalls).toHaveLength(1)
    expect(stdioCalls[0]).toEqual({
      command: 'mcp-bin', args: ['--x'],
      env: { SCRUM4ME_TOKEN: 'x', SCRUM4ME_WORKER_CAPABILITIES: 'local_llm', SCRUM4ME_WORKER_RUNTIME: 'CLAUDE' },
    })
  })

  it('runs one job with the expanded token only in the MCP env, never in the run dir or output', async () => {
    model = await startFakeModelServer([{ body: completion({ content: 'Hier is je antwoord.', model: 'qwen3-coder:30b' }) }])
    const dir = tmp('cli-worker')
    const out = join(dir, 'runs')
    writeProbe(out, model.baseUrl)
    process.env.SCRUM4ME_TOKEN = 'sk-test-secret'
    claims = [{ job: ideaChatPayload() }]
    const code = await main(['worker', '--config', workerConfig(dir, model.baseUrl), '--out', out, '--once'])
    expect(code).toBe(0)
    expect(stdioCalls[0].env?.SCRUM4ME_TOKEN).toBe('sk-test-secret')
    expect(fakeMcp?.calls.filter((c) => c.name === 'update_job_status').map((c) => c.args.status)).toEqual(['running', 'done'])
    expect(readdirSync(out).some((n) => n.startsWith('job-job1-'))).toBe(true)
    expect(dirContains(out, 'sk-test-secret')).toBe(false)
    expect(stderr.join('')).not.toContain('sk-test-secret')
  })

  it('writes a run-log under <dir>/harness/max2/runs/ with the package.json version, when workerLog is configured (M4 Taak 5)', async () => {
    model = await startFakeModelServer([{ body: completion({ content: 'Hier is je antwoord.', model: 'qwen3-coder:30b' }) }])
    const dir = tmp('cli-worker')
    const out = join(dir, 'runs')
    writeProbe(out, model.baseUrl)
    process.env.SCRUM4ME_TOKEN = 'sk-test-secret'
    claims = [{ job: ideaChatPayload() }]
    const logDir = join(dir, 'worker-logs')
    const code = await main(['worker', '--config', workerConfig(dir, model.baseUrl, { workerLog: { dir: logDir, pool: 'harness', instance: 'max2' } }), '--out', out, '--once'])
    expect(code).toBe(0)
    const runsDir = join(logDir, 'harness', 'max2', 'runs')
    const files = readdirSync(runsDir).filter((f) => f.endsWith('.log'))
    expect(files).toHaveLength(1)
    const lines = readFileSync(join(runsDir, files[0]), 'utf8').trim().split('\n')
    const runStart = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).find((j) => j.type === 'harness.run_start')
    const pkgVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
    expect(runStart.version).toBe(`agent-harness@${pkgVersion}`)
  })

  it('redacts a process-env secret, the expanded MCP token and model.apiKey from the run-log, leaving *** in their place (M4 Taak 5; a baseUrl password is covered by the Taak 3/4 tests instead, since the model call never reaches a turn)', async () => {
    const dir = tmp('cli-worker')
    const out = join(dir, 'runs')
    const envSecret = 'proc-env-secret-fake-9001'
    const tokenSecret = 'mcp-env-token-fake-9002'
    const apiKeySecret = 'model-api-key-fake-9003'
    process.env.TEST_HARNESS_SECRET = envSecret
    process.env.SCRUM4ME_TOKEN = tokenSecret
    model = await startFakeModelServer([
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
    writeProbe(out, model.baseUrl)
    claims = [{ job: ideaChatPayload() }]
    const logDir = join(dir, 'worker-logs')
    const code = await main([
      'worker',
      '--config',
      workerConfig(dir, model.baseUrl, {
        model: { baseUrl: model.baseUrl, name: 'qwen3-coder:30b', apiKey: apiKeySecret },
        workerLog: { dir: logDir, pool: 'harness', instance: 'max2' },
      }),
      '--out',
      out,
      '--once',
    ])
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
    const dir = tmp('cli-worker')
    const out = join(dir, 'runs')
    writeProbe(out, 'http://127.0.0.1:1/v1')
    process.env.SCRUM4ME_TOKEN = 'x'
    claims = [{ timeout: true }]
    const code = await main(['worker', '--config', workerConfig(dir, 'http://127.0.0.1:1/v1'), '--out', out, '--once'])
    expect(code).toBe(0)
    // Asserted immediately after main() returns, before this file's afterEach ever touches fakeMcp —
    // proves cmdWorker's own `finally` (src/cli.ts) called conn.close(), not test cleanup.
    expect(lastCloseSpy).toHaveBeenCalledTimes(1)
  })

  it('passes model.reasoningEffort to the model request', async () => {
    model = await startFakeModelServer([{ body: completion({ content: 'Antwoord.', model: 'qwen3-coder:30b' }) }])
    const dir = tmp('cli-worker')
    const out = join(dir, 'runs')
    writeProbe(out, model.baseUrl)
    process.env.SCRUM4ME_TOKEN = 'x'
    claims = [{ job: ideaChatPayload() }]
    const code = await main(['worker', '--config', workerConfig(dir, model.baseUrl, { model: { baseUrl: model.baseUrl, name: 'qwen3-coder:30b', reasoningEffort: 'none' } }), '--out', out, '--once'])
    expect(code).toBe(0)
    expect(model.requests[0].body.reasoning_effort).toBe('none')
  })
})
