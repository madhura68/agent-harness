import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Manifest } from '../src/manifest.js'
import type { ServerSpec } from '../src/types.js'
import { completion, startFakeModelServer } from './fakes/fake-model-server.js'
import { startFakeMcp } from './fakes/fake-mcp-server.js'
import { allFiles, bodyWithKeyAt, dirContains, DUMMY_KEY, leakedFragments, readTrace, tmp } from './helpers.js'

const stdioCalls: Array<{ server: ServerSpec; allow: string[] }> = []
const manifestsRun: Manifest[] = []
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

// Pass-through that keeps the manifest object `harness run` hands to runManifest, so a test can look at it afterwards.
vi.mock('../src/run.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/run.js')>()
  return {
    ...actual,
    runManifest: vi.fn((manifest: Manifest, deps: Parameters<typeof actual.runManifest>[1]) => {
      manifestsRun.push(manifest)
      return actual.runManifest(manifest, deps)
    }),
  }
})

const { main } = await import('../src/cli.js')
const { probeDir } = await import('../src/probe.js')

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let fake: Fake | undefined
beforeEach(() => { stdioCalls.length = 0; manifestsRun.length = 0 })
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

/** Runs main() with stdout and stderr captured. */
async function runMain(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const code = await main(args)
    // Read the calls before mockRestore, which resets them.
    return { code, stdout: out.mock.calls.map((c) => String(c[0])).join(''), stderr: err.mock.calls.map((c) => String(c[0])).join('') }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

function writeJson(dir: string, name: string, content: unknown): string {
  const p = join(dir, name)
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content))
  return p
}

// The fields the comparison runner adds for an OpenRouter model; `reasoning` is the nested object, not reasoning_effort.
const extraBody = { temperature: 0.7, seed: 1, provider: { data_collection: 'deny', require_parameters: true }, reasoning: { effort: 'none' } }

describe('harness probe — --extra-body-file', () => {
  const echoCall = (text: string, id = 'c1') => ({ body: completion({ toolCalls: [{ id, name: 'echo', arguments: JSON.stringify({ text }) }] }) })
  // A model that passes every probe step, in request order: a, b, c-turn1, c-turn2, d.
  const reliableModel = () => [
    { body: completion({ content: 'pong' }) },
    echoCall('ping'),
    echoCall('ping'),
    echoCall('pong', 'c2'),
    { body: completion({ content: 'Dat kan ik niet doen.' }) },
  ]
  const probeArgs = (baseUrl: string, out: string, file: string) =>
    ['probe', '--base-url', baseUrl, '--model', 'm', '--out', out, '--step-timeout', '5', '--extra-body-file', file]

  it('sends the fields of the file with every probe request and leaves the fixed probe prompts alone', async () => {
    fake = await startFakeModelServer(reliableModel())
    const dir = tmp('cli-probe-extra')
    const { code } = await runMain(probeArgs(fake.baseUrl, join(dir, 'runs'), writeJson(dir, 'extra.json', extraBody)))
    expect(code).toBe(0)
    expect(fake.requests).toHaveLength(5)
    for (const r of fake.requests) expect(r.body).toMatchObject({ model: 'm', stream: false, ...extraBody })
    expect(fake.requests[0].body.messages).toEqual([{ role: 'user', content: 'Antwoord met precies één woord: pong.' }])
    expect(fake.requests[1].body.tools[0].function.name).toBe('echo')
  })

  it('sends nothing extra without the flag', async () => {
    fake = await startFakeModelServer(reliableModel())
    const { code } = await runMain(['probe', '--base-url', fake.baseUrl, '--model', 'm', '--out', join(tmp('cli-probe-extra'), 'runs'), '--step-timeout', '5'])
    expect(code).toBe(0)
    for (const r of fake.requests) {
      for (const field of Object.keys(extraBody)) expect(r.body, field).not.toHaveProperty(field)
    }
  })

  it('combines with --api-key-env: the key goes in the header only, the fields in the body, and the key stays out of probe.json', async () => {
    fake = await startFakeModelServer(reliableModel())
    const dir = tmp('cli-probe-extra')
    const out = join(dir, 'runs')
    process.env.HARNESS_TEST_KEY = DUMMY_KEY
    let result: Awaited<ReturnType<typeof runMain>>
    try {
      result = await runMain([...probeArgs(fake.baseUrl, out, writeJson(dir, 'extra.json', extraBody)), '--api-key-env', 'HARNESS_TEST_KEY'])
    } finally {
      delete process.env.HARNESS_TEST_KEY
    }
    expect(result.code).toBe(0)
    for (const r of fake.requests) {
      expect(r.headers.authorization).toBe(`Bearer ${DUMMY_KEY}`)
      expect(r.body).toMatchObject(extraBody)
      expect(leakedFragments(JSON.stringify(r.body))).toEqual([]) // the key stays out of the request body
    }
    const probeJson = readFileSync(join(probeDir(out, 'm'), 'probe.json'), 'utf8')
    expect(leakedFragments(probeJson), 'probe.json').toEqual([])
    expect(leakedFragments(result.stdout + result.stderr), 'output').toEqual([])
  })

  it('takes reasoning_effort from the file: the probe has no reasoningEffort to clash with', async () => {
    fake = await startFakeModelServer(reliableModel())
    const dir = tmp('cli-probe-extra')
    const { code } = await runMain(probeArgs(fake.baseUrl, join(dir, 'runs'), writeJson(dir, 'extra.json', { reasoning_effort: 'low' })))
    expect(code).toBe(0)
    for (const r of fake.requests) expect(r.body.reasoning_effort).toBe('low')
  })

  it.each(['model', 'messages', 'tools', 'stream', 'max_tokens', 'max_completion_tokens', 'n'])(
    'refuses a file with the reserved key %s before any request, naming the key and the file',
    async (key) => {
      fake = await startFakeModelServer([])
      const dir = tmp('cli-probe-extra')
      const out = join(dir, 'runs')
      const file = writeJson(dir, 'extra.json', { ...extraBody, [key]: 1 })
      const { code, stderr } = await runMain(probeArgs(fake.baseUrl, out, file))
      expect(code).toBe(1)
      expect(stderr).toContain(`bevatten: "${key}"`)
      expect(stderr).toContain(file)
      expect(fake.requests).toHaveLength(0)
      expect(existsSync(probeDir(out, 'm'))).toBe(false)
    },
  )

  it.each([
    ['is missing', undefined, /cannot read/],
    ['is not JSON', '{ nope', /cannot read/],
    ['holds a list', [{ temperature: 0.7 }], /moet een JSON-object zijn/],
    ['holds null', 'null', /moet een JSON-object zijn/],
  ])('refuses a file that %s, naming the file', async (_label, content, reason) => {
    fake = await startFakeModelServer([])
    const dir = tmp('cli-probe-extra')
    const out = join(dir, 'runs')
    const file = content === undefined ? join(dir, 'missing.json') : writeJson(dir, 'extra.json', content)
    const { code, stderr } = await runMain(probeArgs(fake.baseUrl, out, file))
    expect(code).toBe(1)
    expect(stderr).toContain(file)
    expect(stderr).toMatch(reason)
    expect(fake.requests).toHaveLength(0)
    expect(existsSync(probeDir(out, 'm'))).toBe(false)
  })
})

describe('harness run — --api-key-env and model.extraBody', () => {
  const KEY_VAR = 'HARNESS_TEST_KEY'
  // No ordinary words in it: leakedFragments would otherwise match the word "manifest" in the trace.
  const MANIFEST_KEY = 'mk-Zk3Yq8Wn5Bv2Xc7Md1Lp4Ht9Rj6Sg0eUa'
  beforeEach(() => { process.env[KEY_VAR] = DUMMY_KEY })
  afterEach(() => { delete process.env[KEY_VAR] })

  function answerManifest(dir: string, baseUrl: string, model: Record<string, unknown> = {}, id = 'cli-key'): string {
    return writeJson(dir, `${id}.json`, {
      id, profile: 'answer', prompt: 'p',
      model: { baseUrl, name: 'm', ...model },
      limits: { maxTurns: 1, maxOutputTokens: 64, maxWallSeconds: 30, maxToolErrors: 0 },
    })
  }
  const runDirText = (runDir: string) => allFiles(runDir).map((f) => readFileSync(f, 'utf8')).join('\n')

  it('sends the key from the environment as a Bearer header and keeps it out of the run dir and the output', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const dir = tmp('cli-key')
    const out = join(dir, 'runs')
    const { code, stdout, stderr } = await runMain(['run', answerManifest(dir, fake.baseUrl), '--out', out, '--api-key-env', KEY_VAR])
    expect(code).toBe(0)
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${DUMMY_KEY}`)
    const runDir = join(out, 'cli-key')
    // The premise of the scan below: both files exist and are part of the text it reads.
    expect(allFiles(runDir).map((f) => f.slice(runDir.length + 1))).toEqual(expect.arrayContaining(['result.json', 'trace.jsonl']))
    expect(leakedFragments(runDirText(runDir)), 'trace.jsonl and result.json').toEqual([])
    expect(leakedFragments(stdout), 'stdout').toEqual([])
    expect(leakedFragments(stderr), 'stderr').toEqual([])
  })

  it('never puts the key in the manifest that runManifest receives', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const dir = tmp('cli-key')
    const { code } = await runMain(['run', answerManifest(dir, fake.baseUrl), '--out', join(dir, 'runs'), '--api-key-env', KEY_VAR])
    expect(code).toBe(0)
    expect(manifestsRun).toHaveLength(1)
    expect(manifestsRun[0].model).not.toHaveProperty('apiKey')
    expect(leakedFragments(JSON.stringify(manifestsRun[0]))).toEqual([])
  })

  it('lets the flag win over a model.apiKey in the manifest, which stays as it was', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const dir = tmp('cli-key')
    const out = join(dir, 'runs')
    const { code } = await runMain(['run', answerManifest(dir, fake.baseUrl, { apiKey: MANIFEST_KEY }), '--out', out, '--api-key-env', KEY_VAR])
    expect(code).toBe(0)
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${DUMMY_KEY}`)
    expect(manifestsRun[0].model.apiKey).toBe(MANIFEST_KEY) // the flag only reaches the client
    expect(leakedFragments(runDirText(join(out, 'cli-key')), MANIFEST_KEY), 'the manifest key in the run dir').toEqual([])
  })

  it('still uses the model.apiKey of the manifest without the flag', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const dir = tmp('cli-key')
    const { code } = await runMain(['run', answerManifest(dir, fake.baseUrl, { apiKey: MANIFEST_KEY }), '--out', join(dir, 'runs')])
    expect(code).toBe(0)
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${MANIFEST_KEY}`)
  })

  it('sends model.extraBody with the request and records it in the trace, without the key', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const dir = tmp('cli-key')
    const out = join(dir, 'runs')
    const { code } = await runMain(['run', answerManifest(dir, fake.baseUrl, { extraBody }), '--out', out, '--api-key-env', KEY_VAR])
    expect(code).toBe(0)
    expect(fake.requests[0].body).toMatchObject({ model: 'm', stream: false, ...extraBody })
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${DUMMY_KEY}`)
    const runDir = join(out, 'cli-key')
    const start = readTrace(runDir)[0] as { manifest: { model: Record<string, unknown> } }
    expect(start.manifest.model.extraBody).toEqual(extraBody)
    expect(start.manifest.model).not.toHaveProperty('apiKey')
  })

  it('keeps the key out of trace.jsonl, result.json and the output when the server echoes it in an error', async () => {
    fake = await startFakeModelServer([{ status: 401, body: bodyWithKeyAt(190, (p) => JSON.stringify({ error: { message: p } })) }])
    const dir = tmp('cli-key')
    const out = join(dir, 'runs')
    const { code, stdout, stderr } = await runMain(['run', answerManifest(dir, fake.baseUrl), '--out', out, '--api-key-env', KEY_VAR])
    expect(code).toBe(1)
    const runDir = join(out, 'cli-key')
    expect(readFileSync(join(runDir, 'result.json'), 'utf8')).toContain('<redacted>') // the premise: the error did carry the key once
    expect(leakedFragments(runDirText(runDir)), 'trace.jsonl and result.json').toEqual([])
    expect(leakedFragments(stdout), 'stdout').toEqual([])
    expect(leakedFragments(stderr), 'stderr').toEqual([])
  })

  it('fails with an error naming the variable when it is not set, before any run dir or request', async () => {
    fake = await startFakeModelServer([])
    const dir = tmp('cli-key')
    const out = join(dir, 'runs')
    const unset = 'HARNESS_TEST_CERTAINLY_UNSET_VAR'
    delete process.env[unset]
    const { code, stderr } = await runMain(['run', answerManifest(dir, fake.baseUrl), '--out', out, '--api-key-env', unset])
    expect(code).toBe(1)
    expect(stderr).toContain(unset)
    expect(existsSync(join(out, 'cli-key'))).toBe(false)
    expect(fake.requests).toHaveLength(0)
    expect(manifestsRun).toHaveLength(0)
  })

  it('refuses a manifest whose extraBody holds a reserved key, before any run dir or request', async () => {
    fake = await startFakeModelServer([])
    const dir = tmp('cli-key')
    const out = join(dir, 'runs')
    const { code, stderr } = await runMain(['run', answerManifest(dir, fake.baseUrl, { extraBody: { max_tokens: 1 } }), '--out', out, '--api-key-env', KEY_VAR])
    expect(code).toBe(1)
    expect(stderr).toContain('model.extraBody')
    expect(stderr).toContain('"max_tokens"')
    expect(existsSync(join(out, 'cli-key'))).toBe(false)
    expect(fake.requests).toHaveLength(0)
  })
})
