import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
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

vi.mock('../src/tools/registry.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/tools/registry.js')>()
  return {
    ...actual,
    connectStdioClient: vi.fn(async (server: ServerSpec) => {
      stdioCalls.push(server)
      fakeMcp = await startFakeScrum4meMcp({ claims })
      return { client: fakeMcp.client, close: fakeMcp.close }
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
