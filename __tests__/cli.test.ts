import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSpec } from '../src/types.js'
import { completion, startFakeModelServer } from './fakes/fake-model-server.js'
import { startFakeMcp } from './fakes/fake-mcp-server.js'
import { bodyWithKeyAt, dirContains, DUMMY_KEY, leakedFragments, readTrace, tmp } from './helpers.js'

const stdioCalls: Array<{ server: ServerSpec; allow: string[] }> = []
const open: Array<{ close(): Promise<void> }> = []

vi.mock('../src/tools/registry.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/tools/registry.js')>()
  return {
    ...actual,
    connectStdioRegistry: vi.fn(async (server: ServerSpec, allow: string[]) => {
      stdioCalls.push({ server, allow })
      const mcp = await startFakeMcp()
      open.push(mcp)
      return actual.connectRegistry(mcp.client, allow)
    }),
  }
})

const { main } = await import('../src/cli.js')
const { probeDir } = await import('../src/probe.js')

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let fake: Fake | undefined
beforeEach(() => { stdioCalls.length = 0 })
afterEach(async () => {
  await fake?.close()
  fake = undefined
  for (const o of open.splice(0)) await o.close().catch(() => undefined)
  delete process.env.SCRUM4ME_TOKEN
})

function toolsManifest(dir: string, baseUrl: string, allow = ['echo']) {
  const p = join(dir, 'tools.json')
  writeFileSync(p, JSON.stringify({
    id: 'cli-tools', profile: 'tools', prompt: 'p',
    model: { baseUrl, name: 'qwen3-coder:30b' },
    tools: { server: { command: 'mcp-bin', args: ['--x'], env: { SCRUM4ME_TOKEN: '${SCRUM4ME_TOKEN}', FIXED: 'y' } }, allow },
    limits: { maxTurns: 3, maxOutputTokens: 256, maxWallSeconds: 30, maxToolErrors: 1 },
  }))
  return p
}

function writeProbe(out: string, baseUrl: string, verdict = 'reliable', model = 'qwen3-coder:30b') {
  const d = probeDir(out, model)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'probe.json'), JSON.stringify({ baseUrl, model, tool_calling: verdict }))
}

describe('harness run — tools profile', () => {
  it('binds the closure to the manifest allowlist and the expanded env, never leaking the secret', async () => {
    fake = await startFakeModelServer([
      { body: completion({ toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"hoi"}' }] }) },
      { body: completion({ content: 'klaar' }) },
    ])
    const dir = tmp('cli-tools')
    const out = join(dir, 'runs')
    writeProbe(out, fake.baseUrl)
    process.env.SCRUM4ME_TOKEN = 'sk-test-secret'
    const code = await main(['run', toolsManifest(dir, fake.baseUrl), '--out', out])
    expect(code).toBe(0)
    expect(stdioCalls).toHaveLength(1)
    expect(stdioCalls[0].allow).toEqual(['echo'])
    expect(stdioCalls[0].server).toEqual({ command: 'mcp-bin', args: ['--x'], env: { SCRUM4ME_TOKEN: 'sk-test-secret', FIXED: 'y' } })
    const runDir = join(out, 'cli-tools')
    expect(dirContains(runDir, 'sk-test-secret')).toBe(false)
    expect(readTrace(runDir)[0]).toMatchObject({ type: 'run_start', manifest: { tools: { server: { env: { SCRUM4ME_TOKEN: '<redacted>' } } } } })
  })

  it('refuses with PROBE_REQUIRED and creates no run dir when probe.json is missing', async () => {
    const dir = tmp('cli-tools')
    const out = join(dir, 'runs')
    process.env.SCRUM4ME_TOKEN = 'x'
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await main(['run', toolsManifest(dir, 'http://127.0.0.1:1/v1'), '--out', out])
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('')
    stderr.mockRestore()
    expect(code).toBe(1)
    expect(printed).toMatch(/PROBE_REQUIRED/)
    expect(existsSync(join(out, 'cli-tools'))).toBe(false)
    expect(stdioCalls).toHaveLength(0)
  })

  it.each([
    ['an unreliable verdict', (out: string, b: string) => writeProbe(out, b, 'unreliable')],
    ['a different baseUrl', (out: string) => writeProbe(out, 'http://elsewhere:11434/v1')],
  ])('refuses with PROBE_REQUIRED on %s', async (_label, setup) => {
    const dir = tmp('cli-tools')
    const out = join(dir, 'runs')
    const baseUrl = 'http://127.0.0.1:1/v1'
    setup(out, baseUrl)
    process.env.SCRUM4ME_TOKEN = 'x'
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await main(['run', toolsManifest(dir, baseUrl), '--out', out])
    stderr.mockRestore()
    expect(code).toBe(1)
    expect(existsSync(join(out, 'cli-tools'))).toBe(false)
  })

  it('starts the run with --skip-probe and records probeSkipped', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const dir = tmp('cli-tools')
    const out = join(dir, 'runs')
    process.env.SCRUM4ME_TOKEN = 'x'
    const code = await main(['run', toolsManifest(dir, fake.baseUrl), '--out', out, '--skip-probe'])
    expect(code).toBe(0)
    expect(readTrace(join(out, 'cli-tools'))[0]).toMatchObject({ type: 'run_start', probeSkipped: true })
  })

  it('exits 1 with failed/TOOL_NOT_AVAILABLE after writing run_end and result.json', async () => {
    fake = await startFakeModelServer([])
    const dir = tmp('cli-tools')
    const out = join(dir, 'runs')
    process.env.SCRUM4ME_TOKEN = 'x'
    const code = await main(['run', toolsManifest(dir, fake.baseUrl, ['missing']), '--out', out, '--skip-probe'])
    expect(code).toBe(1)
    const runDir = join(out, 'cli-tools')
    expect(readTrace(runDir).at(-1)).toMatchObject({ type: 'run_end', status: 'failed', error: { code: 'TOOL_NOT_AVAILABLE' } })
    expect(existsSync(join(runDir, 'result.json'))).toBe(true)
  })

  it('exits 1 without a run dir when a ${VAR} in the server env is unset', async () => {
    const dir = tmp('cli-tools')
    const out = join(dir, 'runs')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await main(['run', toolsManifest(dir, 'http://127.0.0.1:1/v1'), '--out', out, '--skip-probe'])
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('')
    stderr.mockRestore()
    expect(code).toBe(1)
    expect(printed).toMatch(/SCRUM4ME_TOKEN/)
    expect(existsSync(join(out, 'cli-tools'))).toBe(false)
  })
})

describe('harness probe — a server that echoes the api key', () => {
  it('keeps the key out of probe.json, stdout and stderr', async () => {
    const echo = { status: 401, body: bodyWithKeyAt(190, (p) => JSON.stringify({ error: { message: p } })) }
    fake = await startFakeModelServer([echo, echo, echo, echo])
    const out = join(tmp('cli-probe'), 'runs')
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    process.env.DUMMY_KEY = DUMMY_KEY
    let code: number
    let printedOut = ''
    let printedErr = ''
    try {
      code = await main(['probe', '--base-url', fake.baseUrl, '--model', 'm', '--out', out, '--api-key-env', 'DUMMY_KEY', '--step-timeout', '5'])
    } finally {
      // Read the calls before mockRestore, which resets them.
      printedOut = stdout.mock.calls.map((c) => String(c[0])).join('')
      printedErr = stderr.mock.calls.map((c) => String(c[0])).join('')
      stdout.mockRestore()
      stderr.mockRestore()
      delete process.env.DUMMY_KEY
    }
    expect(code).toBe(1) // every step failed
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${DUMMY_KEY}`) // the CLI did send the key
    const probeJson = readFileSync(join(probeDir(out, 'm'), 'probe.json'), 'utf8')
    expect(probeJson).toContain('<redacted>')
    expect(printedOut).toContain('<redacted>')
    expect(leakedFragments(probeJson), 'probe.json').toEqual([])
    expect(leakedFragments(printedOut), 'stdout').toEqual([])
    expect(leakedFragments(printedErr), 'stderr').toEqual([])
  })
})

describe('harness run — answer profile', () => {
  it('never starts an MCP process', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const dir = tmp('cli-answer')
    const p = join(dir, 'a.json')
    writeFileSync(p, JSON.stringify({ id: 'cli-answer', profile: 'answer', prompt: 'p', model: { baseUrl: fake.baseUrl, name: 'm' }, limits: { maxTurns: 1, maxOutputTokens: 64, maxWallSeconds: 30, maxToolErrors: 0 } }))
    expect(await main(['run', p, '--out', join(dir, 'runs')])).toBe(0)
    expect(stdioCalls).toHaveLength(0)
  })
})
