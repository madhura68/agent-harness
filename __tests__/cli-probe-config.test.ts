import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeDir } from '../src/probe.js'
import { checkProbeForJob, configurationHash, litellmFileHashes } from '../src/worker/probe-gate.js'
import { loadWorkerConfig } from '../src/worker/config.js'
import { completion, startFakeModelServer, type FakeTurn } from './fakes/fake-model-server.js'
import { testLitellmFiles, workerConfigInput } from './fakes/worker-config.js'
import { leakedFragments, tmp } from './helpers.js'

// `harness probe --config` (M45-2d T-2066) must never start an MCP child: the probe unit has only the master key.
const { connectStdioClient, connectStdioRegistry } = vi.hoisted(() => ({ connectStdioClient: vi.fn(), connectStdioRegistry: vi.fn() }))
vi.mock('../src/tools/registry.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/tools/registry.js')>()
  return { ...actual, connectStdioClient, connectStdioRegistry }
})
const { main } = await import('../src/cli.js')

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let fake: Fake | undefined
let stdout: string[] = []
let stderr: string[] = []
const KEY_VAR = 'TEST_PROBE_MASTER_KEY'
const KEY = 'test-master-key-Qx7Zp2Lm9Rt4Vb8N'
const savedToken = process.env.SCRUM4ME_TOKEN // the probe must work without the variables of the worker, so they are taken away for these tests

beforeEach(() => {
  stdout = []
  stderr = []
  connectStdioClient.mockClear()
  connectStdioRegistry.mockClear()
  process.env[KEY_VAR] = KEY
  delete process.env.SCRUM4ME_TOKEN
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true })
})
afterEach(async () => {
  vi.restoreAllMocks()
  delete process.env[KEY_VAR]
  if (savedToken === undefined) delete process.env.SCRUM4ME_TOKEN
  else process.env.SCRUM4ME_TOKEN = savedToken
  await fake?.close()
  fake = undefined
})

const CONFIGURATIONS = {
  'gsq-lokaal': { costMode: 'local', contextTokens: 32768 },
  'qwen3.8-or': { costMode: 'hosted', contextTokens: 32768, reasoningEffort: 'none', extraBody: { temperature: 0.2 } },
}

const echo = (text: string, id: string, cost: number | null): FakeTurn => ({ body: completion({ toolCalls: [{ id, name: 'echo', arguments: JSON.stringify({ text }) }], usage: usage(cost) }) })
const usage = (cost: number | null) => ({ prompt_tokens: 10, completion_tokens: 5, ...(cost === null ? {} : { cost }) })
/** A model that passes a-d (request order: a, b, c turn 1, c turn 2, d); `costs` is the amount of each of the five answers. */
function goodTurns(costs: Array<number | null> = [null, null, null, null, null]): FakeTurn[] {
  return [
    { body: completion({ content: 'pong', usage: usage(costs[0]) }) },
    echo('ping', 'c1', costs[1]),
    echo('ping', 'c1', costs[2]),
    echo('pong', 'c2', costs[3]),
    { body: completion({ content: 'Dat kan ik niet doen.', usage: usage(costs[4]) }) },
  ]
}
const FREE = [0.0001, 0.0001, 0.0001, 0.0001, 0.0001]

function writeConfig(dir: string, baseUrl: string, configurations: Record<string, unknown> = CONFIGURATIONS): string {
  const path = join(dir, 'harness.json')
  // mcp.env names a variable that is not set: the worker would refuse such a config at its start, the probe must not even look at it.
  const input = workerConfigInput({ configurations, mcp: { command: 'unused', args: [], env: { SCRUM4ME_TOKEN: '${SCRUM4ME_TOKEN}' } } }, baseUrl)
  writeFileSync(path, JSON.stringify(input))
  return path
}

async function probeCli(configPath: string, out: string, args: string[]) {
  const code = await main(['probe', '--config', configPath, '--out', out, '--api-key-env', KEY_VAR, '--step-timeout', '5', ...args])
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}
const probeJson = (out: string, name: string) => JSON.parse(readFileSync(join(probeDir(out, name), 'probe.json'), 'utf8'))

describe('harness probe --config --all', () => {
  it('probes every configuration with only the master key in the environment, and starts no MCP child', async () => {
    fake = await startFakeModelServer([...goodTurns(), ...goodTurns(FREE)])
    const dir = tmp('cli-probe-config')
    const out = join(dir, 'runs')
    expect(process.env.SCRUM4ME_TOKEN).toBeUndefined()
    const r = await probeCli(writeConfig(dir, fake.baseUrl), out, ['--all'])
    expect(r.code, r.stderr).toBe(0)
    expect(connectStdioClient).toHaveBeenCalledTimes(0)
    expect(connectStdioRegistry).toHaveBeenCalledTimes(0)
    expect(fake.requests).toHaveLength(10)
    // The probe asks LiteLLM for the configuration by its name, with the request fields of that configuration, and with the key.
    expect(fake.requests[0].body).toMatchObject({ model: 'gsq-lokaal' })
    expect(fake.requests[5].body).toMatchObject({ model: 'qwen3.8-or', reasoning_effort: 'none', temperature: 0.2 })
    expect(fake.requests.every((q) => q.headers.authorization === `Bearer ${KEY}`)).toBe(true)
    expect(readdirSync(out).sort()).toEqual(['probe-gsq-lokaal', 'probe-qwen3.8-or'])
  })

  it('writes configuration, costMode, hash, accepted and reasons, and the cost of every answer per step', async () => {
    fake = await startFakeModelServer([...goodTurns(), ...goodTurns([0.001, 0.002, 0.003, 0.004, 0.005])])
    const dir = tmp('cli-probe-config')
    const out = join(dir, 'runs')
    const configPath = writeConfig(dir, fake.baseUrl)
    await probeCli(configPath, out, ['--all'])
    const config = loadWorkerConfig(configPath)
    const local = probeJson(out, 'gsq-lokaal')
    expect(local).toMatchObject({ configuration: 'gsq-lokaal', costMode: 'local', accepted: true, reasons: [], tool_calling: 'reliable', model: 'gsq-lokaal', baseUrl: fake.baseUrl })
    expect(local.hash).toBe(configurationHash({ name: 'gsq-lokaal', ...config.configurations['gsq-lokaal'] }, litellmFileHashes(config.litellm)))
    expect(Object.fromEntries(Object.entries(local.steps).map(([k, v]) => [k, (v as { costsUsd: unknown }).costsUsd]))).toEqual({
      a_plain: [null], b_single_tool: [null], c_two_tools: [null, null], d_nonexistent_tool: [null],
    })
    const hosted = probeJson(out, 'qwen3.8-or')
    expect(hosted).toMatchObject({ configuration: 'qwen3.8-or', costMode: 'hosted', accepted: true, reasons: [] })
    expect(hosted.hash).toBe(configurationHash({ name: 'qwen3.8-or', ...config.configurations['qwen3.8-or'] }, litellmFileHashes(config.litellm)))
    expect(hosted.hash).not.toBe(local.hash)
    expect(Object.fromEntries(Object.entries(hosted.steps).map(([k, v]) => [k, (v as { costsUsd: unknown }).costsUsd]))).toEqual({
      a_plain: [0.001], b_single_tool: [0.002], c_two_tools: [0.003, 0.004], d_nonexistent_tool: [0.005],
    })
  })

  it('keeps the master key out of probe.json, stdout and stderr', async () => {
    fake = await startFakeModelServer([...goodTurns(), ...goodTurns(FREE)])
    const dir = tmp('cli-probe-config')
    const out = join(dir, 'runs')
    const r = await probeCli(writeConfig(dir, fake.baseUrl), out, ['--all'])
    const texts = [r.stdout, r.stderr, readFileSync(join(probeDir(out, 'gsq-lokaal'), 'probe.json'), 'utf8'), readFileSync(join(probeDir(out, 'qwen3.8-or'), 'probe.json'), 'utf8')]
    for (const text of texts) expect(leakedFragments(text, KEY)).toEqual([])
  })

  it('gives the gate what the probe wrote: both configurations pass, and a changed LiteLLM file fails them both', async () => {
    fake = await startFakeModelServer([...goodTurns(), ...goodTurns(FREE)])
    const dir = tmp('cli-probe-config')
    const out = join(dir, 'runs')
    const configPath = writeConfig(dir, fake.baseUrl)
    await probeCli(configPath, out, ['--all'])
    const config = loadWorkerConfig(configPath)
    expect(checkProbeForJob(config, out, 'gsq-lokaal')).toEqual({ ok: true })
    expect(checkProbeForJob(config, out, 'qwen3.8-or')).toEqual({ ok: true })
    const original = readFileSync(testLitellmFiles().configPath, 'utf8')
    try {
      writeFileSync(testLitellmFiles().configPath, `${original}# gewijzigd\n`)
      expect(checkProbeForJob(config, out, 'gsq-lokaal')).toMatchObject({ ok: false })
      expect(checkProbeForJob(config, out, 'qwen3.8-or')).toMatchObject({ ok: false })
    } finally {
      writeFileSync(testLitellmFiles().configPath, original)
    }
  })

  it('exits 1 when one configuration is not accepted, and still probes and writes all of them', async () => {
    // qwen3.8-or is hosted and its turn 2 of c_two_tools has no amount.
    fake = await startFakeModelServer([...goodTurns(), ...goodTurns([0.001, 0.001, 0.001, null, 0.001])])
    const dir = tmp('cli-probe-config')
    const out = join(dir, 'runs')
    const r = await probeCli(writeConfig(dir, fake.baseUrl), out, ['--all'])
    expect(r.code).toBe(1)
    expect(probeJson(out, 'gsq-lokaal')).toMatchObject({ accepted: true })
    const hosted = probeJson(out, 'qwen3.8-or')
    expect(hosted).toMatchObject({ accepted: false, tool_calling: 'reliable' })
    expect(hosted.reasons).toEqual([expect.stringContaining('c_two_tools')])
    expect(r.stdout).toContain('qwen3.8-or')
  })

  it('exits 1 for a local configuration that reports an amount above 0', async () => {
    fake = await startFakeModelServer([...goodTurns([null, null, 0.0001, null, null]), ...goodTurns(FREE)])
    const dir = tmp('cli-probe-config')
    const out = join(dir, 'runs')
    const r = await probeCli(writeConfig(dir, fake.baseUrl), out, ['--all'])
    expect(r.code).toBe(1)
    expect(probeJson(out, 'gsq-lokaal')).toMatchObject({ accepted: false })
    expect(probeJson(out, 'qwen3.8-or')).toMatchObject({ accepted: true })
  })

  it('overwrites an accepted probe.json with the new, refused one', async () => {
    const dir = tmp('cli-probe-config')
    const out = join(dir, 'runs')
    fake = await startFakeModelServer(goodTurns())
    const configPath = writeConfig(dir, fake.baseUrl, { 'gsq-lokaal': CONFIGURATIONS['gsq-lokaal'] })
    expect((await probeCli(configPath, out, ['--all'])).code).toBe(0)
    await fake.close()
    fake = await startFakeModelServer(goodTurns([null, null, 0.5, null, null]))
    writeConfig(dir, fake.baseUrl, { 'gsq-lokaal': CONFIGURATIONS['gsq-lokaal'] })
    expect((await probeCli(configPath, out, ['--all'])).code).toBe(1)
    expect(probeJson(out, 'gsq-lokaal')).toMatchObject({ accepted: false })
    expect(checkProbeForJob(loadWorkerConfig(configPath), out, 'gsq-lokaal')).toMatchObject({ ok: false })
  })
})

describe('harness probe --config --configuration', () => {
  it('probes only the named configuration', async () => {
    fake = await startFakeModelServer(goodTurns(FREE))
    const dir = tmp('cli-probe-config')
    const out = join(dir, 'runs')
    const r = await probeCli(writeConfig(dir, fake.baseUrl), out, ['--configuration', 'qwen3.8-or'])
    expect(r.code, r.stderr).toBe(0)
    expect(fake.requests).toHaveLength(5)
    expect(readdirSync(out)).toEqual(['probe-qwen3.8-or'])
    expect(connectStdioClient).toHaveBeenCalledTimes(0)
  })

  it('refuses a configuration the config does not have, before any request', async () => {
    fake = await startFakeModelServer([])
    const dir = tmp('cli-probe-config')
    const r = await probeCli(writeConfig(dir, fake.baseUrl), join(dir, 'runs'), ['--configuration', 'nope'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('nope')
    expect(r.stderr).toContain('gsq-lokaal')
    expect(fake.requests).toHaveLength(0)
  })
})

describe('harness probe --config: usage errors, before any request', () => {
  it.each([
    ['neither --configuration nor --all', [], /--configuration.*--all/],
    ['both --configuration and --all', ['--configuration', 'gsq-lokaal', '--all'], /--configuration.*--all/],
    ['--base-url', ['--all', '--base-url', 'http://127.0.0.1:1/v1'], /--base-url/],
    ['--model', ['--all', '--model', 'm'], /--model/],
    ['--extra-body-file', ['--all', '--extra-body-file', 'x.json'], /extraBody/],
  ])('refuses %s', async (_what, args, message) => {
    fake = await startFakeModelServer([])
    const dir = tmp('cli-probe-config')
    const r = await probeCli(writeConfig(dir, fake.baseUrl), join(dir, 'runs'), args)
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(message)
    expect(fake.requests).toHaveLength(0)
  })

  it.each([
    ['--configuration', ['--configuration', 'gsq-lokaal']],
    ['--all', ['--all']],
  ])('refuses %s without --config', async (_what, args) => {
    const code = await main(['probe', '--base-url', 'http://127.0.0.1:1/v1', '--model', 'm', ...args])
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('--config')
  })

  it('refuses a config that does not load', async () => {
    const dir = tmp('cli-probe-config')
    writeFileSync(join(dir, 'harness.json'), '{ "nope": true }')
    const r = await probeCli(join(dir, 'harness.json'), join(dir, 'runs'), ['--all'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('invalid worker config')
  })

  it('names an unset --api-key-env variable, without a request', async () => {
    fake = await startFakeModelServer([])
    const dir = tmp('cli-probe-config')
    const code = await main(['probe', '--config', writeConfig(dir, fake.baseUrl), '--all', '--out', join(dir, 'runs'), '--api-key-env', 'HARNESS_UNSET_VAR'])
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('HARNESS_UNSET_VAR')
    expect(fake.requests).toHaveLength(0)
  })
})
