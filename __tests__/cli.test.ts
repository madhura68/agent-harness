import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BenchCaseSchema } from '../src/bench/case.js'
import type { Manifest } from '../src/manifest.js'
import type { ServerSpec } from '../src/types.js'
import { TaskConfigSchema } from '../src/worker/config.js'
import { completion, startFakeModelServer } from './fakes/fake-model-server.js'
import { startFakeMcp } from './fakes/fake-mcp-server.js'
import { workerConfigInput } from './fakes/worker-config.js'
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

/** Runs main() (or the `run` given, for a freshly imported cli.ts) with stdout and stderr captured. */
async function runMain(args: string[], run: typeof main = main): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const code = await run(args)
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
  // Also the prefix of the tmp dir, which stdout prints in full. It must not end in a window of DUMMY_KEY: a name ending in
  // "-key-" did, and whenever mkdtemp's six random characters began with a Q, leakedFragments found "-key-Q" in stdout
  // (two tests scan stdout, so roughly 1 run in 30).
  const RUN_ID = 'cli-run-env'
  beforeEach(() => { process.env[KEY_VAR] = DUMMY_KEY })
  afterEach(() => { delete process.env[KEY_VAR] })

  function answerManifest(dir: string, baseUrl: string, model: Record<string, unknown> = {}, id = RUN_ID): string {
    return writeJson(dir, `${id}.json`, {
      id, profile: 'answer', prompt: 'p',
      model: { baseUrl, name: 'm', ...model },
      limits: { maxTurns: 1, maxOutputTokens: 64, maxWallSeconds: 30, maxToolErrors: 0 },
    })
  }
  const runDirText = (runDir: string) => allFiles(runDir).map((f) => readFileSync(f, 'utf8')).join('\n')

  it('sends the key from the environment as a Bearer header and keeps it out of the run dir and the output', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const dir = tmp(RUN_ID)
    const out = join(dir, 'runs')
    const { code, stdout, stderr } = await runMain(['run', answerManifest(dir, fake.baseUrl), '--out', out, '--api-key-env', KEY_VAR])
    expect(code).toBe(0)
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${DUMMY_KEY}`)
    const runDir = join(out, RUN_ID)
    // The premise of the scan below: both files exist and are part of the text it reads.
    expect(allFiles(runDir).map((f) => f.slice(runDir.length + 1))).toEqual(expect.arrayContaining(['result.json', 'trace.jsonl']))
    expect(leakedFragments(runDirText(runDir)), 'trace.jsonl and result.json').toEqual([])
    expect(leakedFragments(stdout), 'stdout').toEqual([])
    expect(leakedFragments(stderr), 'stderr').toEqual([])
  })

  it('never puts the key in the manifest that runManifest receives', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const dir = tmp(RUN_ID)
    const { code } = await runMain(['run', answerManifest(dir, fake.baseUrl), '--out', join(dir, 'runs'), '--api-key-env', KEY_VAR])
    expect(code).toBe(0)
    expect(manifestsRun).toHaveLength(1)
    expect(manifestsRun[0].model).not.toHaveProperty('apiKey')
    expect(leakedFragments(JSON.stringify(manifestsRun[0]))).toEqual([])
  })

  it('lets the flag win over a model.apiKey in the manifest, which stays as it was', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const dir = tmp(RUN_ID)
    const out = join(dir, 'runs')
    const { code } = await runMain(['run', answerManifest(dir, fake.baseUrl, { apiKey: MANIFEST_KEY }), '--out', out, '--api-key-env', KEY_VAR])
    expect(code).toBe(0)
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${DUMMY_KEY}`)
    expect(manifestsRun[0].model.apiKey).toBe(MANIFEST_KEY) // the flag only reaches the client
    expect(leakedFragments(runDirText(join(out, RUN_ID)), MANIFEST_KEY), 'the manifest key in the run dir').toEqual([])
  })

  it('still uses the model.apiKey of the manifest without the flag', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const dir = tmp(RUN_ID)
    const { code } = await runMain(['run', answerManifest(dir, fake.baseUrl, { apiKey: MANIFEST_KEY }), '--out', join(dir, 'runs')])
    expect(code).toBe(0)
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${MANIFEST_KEY}`)
  })

  it('sends model.extraBody with the request and records it in the trace, without the key', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: 'ok' }) }])
    const dir = tmp(RUN_ID)
    const out = join(dir, 'runs')
    const { code } = await runMain(['run', answerManifest(dir, fake.baseUrl, { extraBody }), '--out', out, '--api-key-env', KEY_VAR])
    expect(code).toBe(0)
    expect(fake.requests[0].body).toMatchObject({ model: 'm', stream: false, ...extraBody })
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${DUMMY_KEY}`)
    const runDir = join(out, RUN_ID)
    const start = readTrace(runDir)[0] as { manifest: { model: Record<string, unknown> } }
    expect(start.manifest.model.extraBody).toEqual(extraBody)
    expect(start.manifest.model).not.toHaveProperty('apiKey')
  })

  it('keeps the key out of trace.jsonl, result.json and the output when the server echoes it in an error', async () => {
    fake = await startFakeModelServer([{ status: 401, body: bodyWithKeyAt(190, (p) => JSON.stringify({ error: { message: p } })) }])
    const dir = tmp(RUN_ID)
    const out = join(dir, 'runs')
    const { code, stdout, stderr } = await runMain(['run', answerManifest(dir, fake.baseUrl), '--out', out, '--api-key-env', KEY_VAR])
    expect(code).toBe(1)
    const runDir = join(out, RUN_ID)
    expect(readFileSync(join(runDir, 'result.json'), 'utf8')).toContain('<redacted>') // the premise: the error did carry the key once
    expect(leakedFragments(runDirText(runDir)), 'trace.jsonl and result.json').toEqual([])
    expect(leakedFragments(stdout), 'stdout').toEqual([])
    expect(leakedFragments(stderr), 'stderr').toEqual([])
  })

  it('fails with an error naming the variable when it is not set, before any run dir or request', async () => {
    fake = await startFakeModelServer([])
    const dir = tmp(RUN_ID)
    const out = join(dir, 'runs')
    const unset = 'HARNESS_TEST_CERTAINLY_UNSET_VAR'
    delete process.env[unset]
    const { code, stderr } = await runMain(['run', answerManifest(dir, fake.baseUrl), '--out', out, '--api-key-env', unset])
    expect(code).toBe(1)
    expect(stderr).toContain(unset)
    expect(existsSync(join(out, RUN_ID))).toBe(false)
    expect(fake.requests).toHaveLength(0)
    expect(manifestsRun).toHaveLength(0)
  })

  it('refuses a manifest whose extraBody holds a reserved key, before any run dir or request', async () => {
    fake = await startFakeModelServer([])
    const dir = tmp(RUN_ID)
    const out = join(dir, 'runs')
    const { code, stderr } = await runMain(['run', answerManifest(dir, fake.baseUrl, { extraBody: { max_tokens: 1 } }), '--out', out, '--api-key-env', KEY_VAR])
    expect(code).toBe(1)
    expect(stderr).toContain('model.extraBody')
    expect(stderr).toContain('"max_tokens"')
    expect(existsSync(join(out, RUN_ID))).toBe(false)
    expect(fake.requests).toHaveLength(0)
  })

  // The flag carries things like the provider block. Ignoring it in silence would send the run without that block.
  it('refuses --extra-body-file as a usage error: it only applies to probe, before any run dir or request', async () => {
    fake = await startFakeModelServer([])
    const dir = tmp(RUN_ID)
    const out = join(dir, 'runs')
    const file = writeJson(dir, 'extra.json', extraBody)
    const { code, stderr } = await runMain(['run', answerManifest(dir, fake.baseUrl), '--out', out, '--extra-body-file', file])
    expect(code).toBe(1)
    expect(stderr).toContain('--extra-body-file only applies to harness probe')
    expect(stderr).toContain('put extraBody in the model block of the manifest')
    expect(stderr).toContain('Usage:') // printed by a UsageError, like every other wrong invocation
    expect(existsSync(join(out, RUN_ID))).toBe(false)
    expect(fake.requests).toHaveLength(0)
    expect(manifestsRun).toHaveLength(0)
  })
})

describe('harness worker — --extra-body-file', () => {
  it('refuses it as a usage error: it only applies to probe, before the LiteLLM check and before any request', async () => {
    fake = await startFakeModelServer([])
    const dir = tmp('cli-worker-extra')
    const config = writeJson(dir, 'worker.json', workerConfigInput({ mcp: { command: 'mcp-bin', args: [] } }, fake.baseUrl))
    const file = writeJson(dir, 'extra.json', extraBody)
    const { code, stderr } = await runMain(['worker', '--config', config, '--out', join(dir, 'runs'), '--once', '--extra-body-file', file])
    expect(code).toBe(78) // a usage error of `worker` comes before the MCP child, and no restart cures it
    expect(stderr).toContain('--extra-body-file only applies to harness probe')
    expect(stderr).toContain('put extraBody in a configuration of the worker config')
    expect(stderr).toContain('Usage:')
    expect(fake.requests).toHaveLength(0)
    expect(fake.modelsRequests).toHaveLength(0)
  })
})

describe('harness task-bench', () => {
  const KEY_VAR = 'HARNESS_TEST_BENCH_KEY'
  afterEach(() => {
    delete process.env[KEY_VAR]
    vi.doUnmock('../src/bench/task-bench.js')
    vi.doUnmock('../src/bench/task-prompt.js')
    vi.resetModules()
  })

  // A host that cannot resolve (RFC 2606): if a regression ever let one of these tests run the real bench, it would end at the clone
  // and never reach the network or docker.
  const REPO = 'https://example.invalid/agent-harness.git'
  const validCase = {
    id: 'AH-01',
    repo_url: REPO,
    base_commit: 'a1b2c3d4e5'.repeat(4),
    ref_commit: 'f6e5d4c3b2'.repeat(4),
    task: { code: 'T-42', title: 'feat: voeg greet() toe', description: 'Voeg een functie greet toe.', implementation_plan: null },
    story: { title: 'Begroeting', description: null, acceptance_criteria: null },
    hidden_tests: ['__tests__/greet.test.ts'],
    lines: 42,
    kind: 'feat',
  }
  const validModel = { baseUrl: 'http://127.0.0.1:11434/v1', name: 'qwen3.8-test' }
  const validTask = {
    limits: { maxTurns: 40, maxOutputTokens: 80000, maxWallSeconds: 2400, maxToolErrors: 8, contextTokens: 65536 },
    image: 'node:24-bookworm',
    uid: 1000,
    gid: 1000,
    npmCacheDir: '/var/lib/agent-harness/npm-cache',
    recipes: [{ repoUrl: REPO, prepare: ['npm ci'], verify: 'npm test' }],
  }

  type Files = { case: string; model: string; task: string; out: string }
  /** The three config files of a call, valid unless `over` breaks one of them (a string is written as it is). */
  function benchFiles(over: { case?: unknown; model?: unknown; task?: unknown } = {}): Files {
    const dir = tmp('cli-task-bench')
    return {
      case: writeJson(dir, 'case.json', over.case ?? validCase),
      model: writeJson(dir, 'model.json', over.model ?? validModel),
      task: writeJson(dir, 'task.json', over.task ?? validTask),
      out: join(dir, 'runs'),
    }
  }
  /** The task-bench arguments; `without` leaves one flag out, `extra` adds more. */
  function benchArgs(f: Files, o: { without?: string; label?: string; extra?: string[] } = {}): string[] {
    const flags: Array<[string, string]> = [['--case', f.case], ['--model-config', f.model], ['--task-config', f.task], ['--label', o.label ?? 'test'], ['--out', f.out]]
    return ['task-bench', ...flags.filter(([flag]) => flag !== o.without).flat(), ...(o.extra ?? [])]
  }

  /** A fresh cli.ts whose task-bench module, when one is given, is that stand-in. */
  async function freshMain(bench?: { runTaskBench?: (o: never) => Promise<unknown>; checkCase?: (o: never) => Promise<unknown> }): Promise<typeof main> {
    vi.resetModules()
    if (bench) vi.doMock('../src/bench/task-bench.js', () => bench)
    return (await import('../src/cli.js')).main
  }
  const resultOf = (status: string) => ({ caseId: 'AH-01', label: 'test', runId: 'AH-01-test-0a1b2c3d', status })

  it('is in the usage text', async () => {
    const { code, stdout } = await runMain(['--help'])
    expect(code).toBe(0)
    expect(stdout).toContain(
      'harness task-bench --case <json> --model-config <json> --task-config <json> --label <label> --out <dir> [--api-key-env <VAR>] [--retry-transient]',
    )
  })

  it.each(['--case', '--model-config', '--task-config', '--label', '--out'])('needs %s: a usage error, exit 1, and no run dir', async (flag) => {
    const f = benchFiles()
    const { code, stdout, stderr } = await runMain(benchArgs(f, { without: flag }))
    expect(code).toBe(1)
    expect(stderr).toContain(`task-bench needs ${flag}`)
    expect(stderr).toContain('Usage:')
    expect(stdout).toBe('')
    expect(existsSync(f.out)).toBe(false)
  })

  it.each(['../escape', 'a/b', '.verborgen', 'met spatie'])('refuses the label %j, which would not be one path segment of the run dir', async (label) => {
    const f = benchFiles()
    const { code, stderr } = await runMain(benchArgs(f, { label }))
    expect(code).toBe(1)
    expect(stderr).toContain('--label')
    expect(stderr).toContain('Usage:')
    expect(existsSync(f.out)).toBe(false)
  })

  it('refuses a case that BenchCaseSchema rejects, with the field in the message, and creates no run dir', async () => {
    const f = benchFiles({ case: { ...validCase, base_commit: 'abc', hidden_tests: [] } })
    const { code, stderr } = await runMain(benchArgs(f))
    expect(code).toBe(1)
    expect(stderr).toContain(f.case)
    expect(stderr).toContain('base_commit')
    expect(stderr).toContain('hidden_tests')
    expect(existsSync(f.out)).toBe(false)
  })

  it('refuses a model config with an apiKey in it, without printing the key', async () => {
    const f = benchFiles({ model: { ...validModel, apiKey: DUMMY_KEY } })
    const { code, stdout, stderr } = await runMain(benchArgs(f))
    expect(code).toBe(1)
    expect(stderr).toContain('apiKey')
    expect(stderr).toContain('--api-key-env')
    expect(leakedFragments(stdout + stderr)).toEqual([])
    expect(existsSync(f.out)).toBe(false)
  })

  // --extra-body-file belongs to probe. harness run and harness worker refuse it; task-bench used to read it into nothing, so every
  // request could go out without the provider block (no 16-bit pin, no data_collection: deny) while the operator thought it was there.
  it('refuses --extra-body-file as a usage error: it only applies to probe, before the bench is loaded and before anything is created', async () => {
    const f = benchFiles()
    const file = writeJson(join(f.out, '..'), 'extra.json', extraBody)
    const runTaskBench = vi.fn(async (_o: unknown) => resultOf('geslaagd'))
    const run = await freshMain({ runTaskBench })
    const { code, stdout, stderr } = await runMain(benchArgs(f, { extra: ['--extra-body-file', file] }), run)
    expect(code).toBe(1)
    expect(stderr).toContain('--extra-body-file only applies to harness probe')
    expect(stderr).toContain('for harness task-bench put extraBody in the --model-config file (extraBody)')
    expect(stderr).toContain('Usage:') // printed by a UsageError, like every other wrong invocation
    expect(stdout).toBe('')
    expect(runTaskBench).not.toHaveBeenCalled()
    expect(existsSync(f.out)).toBe(false)
  })

  // The schema of the model block strips a key it does not know. A typo such as extra_body would silently send every request without
  // the provider block, so task-bench reads its model config strictly. The shared schema is not strict: run and worker are unchanged.
  it.each(['extra_body', 'extrabody', 'reasoning_effort', 'temperature', 'model'])(
    'refuses the key %s in the model config, which the model spec does not know, naming the file and the key',
    async (key) => {
      const f = benchFiles({ model: { ...validModel, [key]: { provider: { data_collection: 'deny' } } } })
      const runTaskBench = vi.fn(async (_o: unknown) => resultOf('geslaagd'))
      const run = await freshMain({ runTaskBench })
      const { code, stderr } = await runMain(benchArgs(f), run)
      expect(code).toBe(1)
      expect(stderr).toContain(f.model)
      expect(stderr).toContain(`"${key}"`)
      expect(runTaskBench).not.toHaveBeenCalled()
      expect(existsSync(f.out)).toBe(false)
    },
  )

  it('names every unknown key of the model config at once', async () => {
    const f = benchFiles({ model: { ...validModel, extra_body: {}, temperature: 0 } })
    const { code, stderr } = await runMain(benchArgs(f))
    expect(code).toBe(1)
    expect(stderr).toContain('"extra_body"')
    expect(stderr).toContain('"temperature"')
  })

  it('still takes every key of the model spec: baseUrl, name, reasoningEffort and extraBody reach the bench as they are', async () => {
    const model = {
      ...validModel,
      reasoningEffort: 'low',
      extraBody: { provider: { data_collection: 'deny', require_parameters: true, quantizations: ['bf16', 'fp16'] }, reasoning: { effort: 'medium' } },
    }
    const f = benchFiles({ model })
    const runTaskBench = vi.fn(async (_o: unknown) => resultOf('geslaagd'))
    const run = await freshMain({ runTaskBench })
    const { code } = await runMain(benchArgs(f), run)
    expect(code).toBe(0)
    expect(runTaskBench.mock.calls[0][0]).toMatchObject({ model })
  })

  it('still refuses the rules of extraBody under the strict read: a reserved key in it is refused with its path', async () => {
    const f = benchFiles({ model: { ...validModel, extraBody: { max_tokens: 1 } } })
    const { code, stderr } = await runMain(benchArgs(f))
    expect(code).toBe(1)
    expect(stderr).toContain(f.model)
    expect(stderr).toContain('extraBody')
    expect(stderr).toContain('"max_tokens"')
  })

  it.each([
    ['the model config', 'model', { baseUrl: 'geen url', name: '' }, ['baseUrl', 'name']],
    ['the task config', 'task', { ...validTask, uid: -1, recipes: [] }, ['uid', 'recipes']],
  ] as const)('refuses %s that its schema rejects, naming the fields', async (_what, which, content, fields) => {
    const f = benchFiles({ [which]: content })
    const { code, stderr } = await runMain(benchArgs(f))
    expect(code).toBe(1)
    expect(stderr).toContain(f[which])
    for (const field of fields) expect(stderr).toContain(field)
    expect(existsSync(f.out)).toBe(false)
  })

  it.each([
    ['is missing', undefined],
    ['is not JSON', '{ nope'],
  ])('refuses a case file that %s, naming the file', async (_what, content) => {
    const f = benchFiles()
    const file = content === undefined ? join(f.out, '..', 'ontbreekt.json') : writeJson(join(f.out, '..'), 'kapot.json', content)
    const { code, stderr } = await runMain(benchArgs({ ...f, case: file }))
    expect(code).toBe(1)
    expect(stderr).toContain(file)
    expect(stderr).toContain('cannot read')
    expect(existsSync(f.out)).toBe(false)
  })

  it.each([
    ['an empty variable', ''],
    ['an unset variable', undefined],
  ])('exits 1 without a run dir for --api-key-env with %s', async (_what, value) => {
    const f = benchFiles()
    if (value !== undefined) process.env[KEY_VAR] = value
    const { code, stderr } = await runMain(benchArgs(f, { extra: ['--api-key-env', KEY_VAR] }))
    expect(code).toBe(1)
    expect(stderr).toContain(KEY_VAR)
    expect(existsSync(f.out)).toBe(false)
  })

  describe('the call to the bench', () => {
    it('hands the parsed files, the label, the key from the environment and a signal to runTaskBench, and prints one line', async () => {
      const f = benchFiles()
      process.env[KEY_VAR] = DUMMY_KEY
      const runTaskBench = vi.fn(async (_o: unknown) => resultOf('geslaagd'))
      const run = await freshMain({ runTaskBench })

      const { code, stdout, stderr } = await runMain(benchArgs(f, { extra: ['--api-key-env', KEY_VAR, '--retry-transient'] }), run)

      expect(code).toBe(0)
      expect(runTaskBench).toHaveBeenCalledTimes(1)
      expect(runTaskBench).toHaveBeenCalledWith({
        case: BenchCaseSchema.parse(validCase),
        model: validModel,
        label: 'test',
        task: TaskConfigSchema.parse(validTask),
        out: f.out,
        apiKey: DUMMY_KEY,
        retryTransient: true,
        signal: expect.any(AbortSignal),
      })
      expect(stdout).toBe(`geslaagd — AH-01-test-0a1b2c3d → ${join(f.out, 'AH-01-test-0a1b2c3d', 'bench-result.json')}\n`)
      expect(leakedFragments(stdout + stderr)).toEqual([]) // the key never appears in the output
    })

    it('runs without a key and without retries by default', async () => {
      const f = benchFiles()
      const runTaskBench = vi.fn(async (_o: unknown) => resultOf('limiet'))
      const run = await freshMain({ runTaskBench })
      const { code } = await runMain(benchArgs(f), run)
      expect(code).toBe(0)
      expect(runTaskBench.mock.calls[0][0]).toMatchObject({ apiKey: undefined, retryTransient: false })
    })

    it.each(['verify_rood', 'benchfout', 'geen_wijzigingen'])('exits 0 for the status %s: the result file is there, whatever the status', async (status) => {
      const f = benchFiles()
      const run = await freshMain({ runTaskBench: vi.fn(async () => resultOf(status)) })
      const { code, stdout } = await runMain(benchArgs(f), run)
      expect(code).toBe(0)
      expect(stdout).toContain(`${status} — AH-01-test-0a1b2c3d → `)
    })

    it('does not swallow a failure of the run itself: there is no result file, so main throws', async () => {
      const f = benchFiles()
      const run = await freshMain({ runTaskBench: vi.fn(async () => Promise.reject(new Error('run dir already exists: x'))) })
      const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') }
      await expect(runMain(benchArgs(f), run)).rejects.toThrow('run dir already exists: x')
      expect({ SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') }).toEqual(before) // its handlers went away
    })

    // The handlers are the CLI's own: the test calls them directly, and leaves the ones of the test runner alone.
    it.each(['SIGINT', 'SIGTERM'] as const)('aborts the signal of the run on %s, waits for the run to finish, and then removes its handlers', async (name) => {
      const f = benchFiles()
      let release!: () => void
      const finish = new Promise<void>((resolve) => (release = resolve))
      let seen: AbortSignal | undefined
      const runTaskBench = vi.fn(async (o: { signal: AbortSignal }) => {
        seen = o.signal
        await finish
        return resultOf('benchfout')
      })
      const before = new Set(process.listeners(name))
      const run = await freshMain({ runTaskBench })
      let exited: number | undefined
      const running = runMain(benchArgs(f), run).then((r) => {
        exited = r.code
        return r
      })

      await vi.waitFor(() => expect(seen).toBeDefined())
      const mine = process.listeners(name).filter((l) => !before.has(l))
      expect(mine).toHaveLength(1)
      expect(seen?.aborted).toBe(false)

      mine[0](name)
      expect(seen?.aborted).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(exited).toBeUndefined() // it waits for the run, which is cleaning up

      release()
      const { code, stderr } = await running
      expect(code).toBe(0)
      expect(stderr).toContain('stopt')
      expect(process.listeners(name).filter((l) => !before.has(l))).toHaveLength(0)
    })
  })

  describe('the bench is loaded only when the command runs', () => {
    const guard = 'de laadguard van task-prompt sloeg aan'
    const tripGuard = () => vi.doMock('../src/bench/task-prompt.js', () => { throw new Error(guard) })

    // src/bench/task-prompt.ts throws on load when the worker prompt lost its doc-tools clause. If cli.ts reached it by a static
    // import, that would stop `harness worker` at startup: the production worker must not depend on the bench.
    it('loads cli.ts and its other commands even when task-prompt.ts throws on load', async () => {
      vi.resetModules()
      tripGuard()
      const fresh = (await import('../src/cli.js')).main
      const { code, stdout } = await runMain(['--help'], fresh)
      expect(code).toBe(0)
      expect(stdout).toContain('harness worker')
    })

    it('trips that guard only for the task-bench command itself, and only when it has got as far as running it', async () => {
      const f = benchFiles()
      vi.resetModules()
      tripGuard()
      const fresh = (await import('../src/cli.js')).main
      // an argument error comes first, and does not load the bench…
      expect((await runMain(benchArgs(f, { without: '--case' }), fresh)).code).toBe(1)
      // …the command that runs does. (vitest wraps what a mock factory throws, and keeps it as the cause.)
      const error = await runMain(benchArgs(f), fresh).then(() => undefined, (e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect(String((error as Error).cause)).toContain(guard)
      expect(existsSync(f.out)).toBe(false)
    })
  })

  describe('--check-case', () => {
    const checked = (ok: boolean, problems: string[] = []) => ({ caseId: 'AH-01', ok, problems })
    /** The --check-case arguments; `without` leaves one flag out, `extra` adds more. */
    function checkArgs(f: Files, o: { without?: string; extra?: string[] } = {}): string[] {
      const flags: Array<[string, string]> = [['--case', f.case], ['--task-config', f.task], ['--out', f.out]]
      return ['task-bench', '--check-case', ...flags.filter(([flag]) => flag !== o.without).flat(), ...(o.extra ?? [])]
    }
    /** Where the evidence of the check lies: the dir name ends in a random part, so the CLI can only name the pattern. */
    const evidence = (f: Files) => join(f.out, 'AH-01-check-*', 'case-check.json')

    it('is in the usage text, with the three flags it needs', async () => {
      const { code, stdout } = await runMain(['--help'])
      expect(code).toBe(0)
      expect(stdout).toContain('harness task-bench --check-case --case <json> --task-config <json> --out <dir>')
    })

    it.each(['--case', '--task-config', '--out'])('needs %s: a usage error, exit 1, and no run dir', async (flag) => {
      const f = benchFiles()
      const checkCase = vi.fn(async (_o: unknown) => checked(true))
      const run = await freshMain({ checkCase })
      const { code, stdout, stderr } = await runMain(checkArgs(f, { without: flag }), run)
      expect(code).toBe(1)
      expect(stderr).toContain(`task-bench needs ${flag}`)
      expect(stderr).toContain('Usage:')
      expect(stdout).toBe('')
      expect(existsSync(f.out)).toBe(false)
      expect(checkCase).not.toHaveBeenCalled()
    })

    it('needs no model config, no label and no key: it hands the parsed case and task config, the out dir and a signal to checkCase, and starts no bench run', async () => {
      const f = benchFiles()
      const checkCase = vi.fn(async (_o: unknown) => checked(true))
      const runTaskBench = vi.fn(async (_o: unknown) => resultOf('geslaagd'))
      const run = await freshMain({ checkCase, runTaskBench })

      const { code, stdout, stderr } = await runMain(checkArgs(f), run)

      expect(code).toBe(0)
      expect(checkCase).toHaveBeenCalledTimes(1)
      expect(checkCase).toHaveBeenCalledWith({
        case: BenchCaseSchema.parse(validCase),
        task: TaskConfigSchema.parse(validTask),
        out: f.out,
        signal: expect.any(AbortSignal),
      })
      expect(runTaskBench).not.toHaveBeenCalled()
      expect(stdout).toBe(`ok — AH-01 → ${evidence(f)}\n`)
      expect(stderr).toBe('')
    })

    it('exits 1 when the case is not ok, and prints each problem', async () => {
      const f = benchFiles()
      const run = await freshMain({ checkCase: vi.fn(async () => checked(false, ['verify rood op base_commit', 'ref_commit wijzigt de runnerconfig'])) })
      const { code, stdout } = await runMain(checkArgs(f), run)
      expect(code).toBe(1)
      expect(stdout).toBe(`niet ok — AH-01 → ${evidence(f)}\n  - verify rood op base_commit\n  - ref_commit wijzigt de runnerconfig\n`)
    })

    it('refuses a case that BenchCaseSchema rejects, with the field in the message, and creates no run dir', async () => {
      const f = benchFiles({ case: { ...validCase, base_commit: 'abc' } })
      const checkCase = vi.fn(async (_o: unknown) => checked(true))
      const run = await freshMain({ checkCase })
      const { code, stderr } = await runMain(checkArgs(f), run)
      expect(code).toBe(1)
      expect(stderr).toContain(f.case)
      expect(stderr).toContain('base_commit')
      expect(existsSync(f.out)).toBe(false)
      expect(checkCase).not.toHaveBeenCalled()
    })

    it('refuses a task config that its schema rejects, naming the fields', async () => {
      const f = benchFiles({ task: { ...validTask, uid: -1, recipes: [] } })
      const run = await freshMain({ checkCase: vi.fn(async () => checked(true)) })
      const { code, stderr } = await runMain(checkArgs(f), run)
      expect(code).toBe(1)
      expect(stderr).toContain(f.task)
      expect(stderr).toContain('uid')
      expect(stderr).toContain('recipes')
      expect(existsSync(f.out)).toBe(false)
    })

    it('does not swallow a failure of the check itself: there is no result file, so main throws, and its handlers go away', async () => {
      const f = benchFiles()
      const run = await freshMain({ checkCase: vi.fn(async () => Promise.reject(new Error('run dir already exists: x'))) })
      const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') }
      await expect(runMain(checkArgs(f), run)).rejects.toThrow('run dir already exists: x')
      expect({ SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') }).toEqual(before)
    })

    // The handlers are the CLI's own: the test calls them directly, and leaves the ones of the test runner alone.
    it.each(['SIGINT', 'SIGTERM'] as const)('aborts the signal of the check on %s, waits for it to finish, exits 1 on its afgebroken result, and removes its handlers', async (name) => {
      const f = benchFiles()
      let release!: () => void
      const finish = new Promise<void>((resolve) => (release = resolve))
      let seen: AbortSignal | undefined
      const checkCase = vi.fn(async (o: { signal: AbortSignal }) => {
        seen = o.signal
        await finish
        return checked(false, ['afgebroken'])
      })
      const before = new Set(process.listeners(name))
      const run = await freshMain({ checkCase })
      let exited: number | undefined
      const running = runMain(checkArgs(f), run).then((r) => {
        exited = r.code
        return r
      })

      await vi.waitFor(() => expect(seen).toBeDefined())
      const mine = process.listeners(name).filter((l) => !before.has(l))
      expect(mine).toHaveLength(1)
      expect(seen?.aborted).toBe(false)

      mine[0](name)
      expect(seen?.aborted).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(exited).toBeUndefined() // it waits for the check, which is cleaning up its containers

      release()
      const { code, stdout, stderr } = await running
      expect(code).toBe(1)
      expect(stdout).toContain('niet ok — AH-01')
      expect(stdout).toContain('  - afgebroken')
      expect(stderr).toContain('stopt')
      expect(process.listeners(name).filter((l) => !before.has(l))).toHaveLength(0)
    })

    it('loads the bench only when the command runs: the guard of task-prompt.ts trips for --check-case only after the arguments are right', async () => {
      const f = benchFiles()
      vi.resetModules()
      vi.doMock('../src/bench/task-prompt.js', () => { throw new Error('de laadguard van task-prompt sloeg aan') })
      const fresh = (await import('../src/cli.js')).main
      expect((await runMain(checkArgs(f, { without: '--case' }), fresh)).code).toBe(1)
      const error = await runMain(checkArgs(f), fresh).then(() => undefined, (e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect(String((error as Error).cause)).toContain('de laadguard van task-prompt sloeg aan')
      expect(existsSync(f.out)).toBe(false)
    })
  })
})
