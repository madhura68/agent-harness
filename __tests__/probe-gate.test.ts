import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeDir } from '../src/probe.js'
import type { Configuration } from '../src/worker/config.js'
import { checkProbeForJob, configurationHash, litellmFileHashes, probeVerdict } from '../src/worker/probe-gate.js'
import { acceptedProbe, seedProbe } from './fakes/probe-seed.js'
import { TEST_CONFIGURATION, testWorkerConfig } from './fakes/worker-config.js'
import { tmp } from './helpers.js'

const FILES = { litellmConfigSha256: 'a'.repeat(64), litellmComposeSha256: 'b'.repeat(64) }
const BASE: Configuration & { name: string } = {
  name: 'qwen3.8-or',
  costMode: 'hosted',
  contextTokens: 32768,
  reasoningEffort: 'none',
  extraBody: { temperature: 0.2, provider: { order: ['deepinfra'], allow_fallbacks: false } },
}

describe('configurationHash', () => {
  it('is the sha256 of the canonical JSON: sorted keys at every level, no whitespace, v 1', () => {
    const canonical =
      '{"configuration":{"costMode":"hosted","extraBody":{"provider":{"allow_fallbacks":false,"order":["deepinfra"]},"temperature":0.2},' +
      '"name":"qwen3.8-or","reasoningEffort":"none"},"litellmComposeSha256":"' + 'b'.repeat(64) + '","litellmConfigSha256":"' + 'a'.repeat(64) + '","v":1}'
    expect(configurationHash(BASE, FILES)).toBe(createHash('sha256').update(canonical).digest('hex'))
  })

  it('does not change when the keys of the configuration or of extraBody come in another order', () => {
    const reordered: Configuration & { name: string } = {
      extraBody: { provider: { allow_fallbacks: false, order: ['deepinfra'] }, temperature: 0.2 },
      reasoningEffort: 'none',
      contextTokens: 32768,
      costMode: 'hosted',
      name: 'qwen3.8-or',
    }
    expect(configurationHash(reordered, { litellmComposeSha256: FILES.litellmComposeSha256, litellmConfigSha256: FILES.litellmConfigSha256 })).toBe(configurationHash(BASE, FILES))
  })

  it.each([
    ['the LiteLLM config file', BASE, { ...FILES, litellmConfigSha256: 'c'.repeat(64) }],
    ['the LiteLLM compose file', BASE, { ...FILES, litellmComposeSha256: 'c'.repeat(64) }],
    ['costMode', { ...BASE, costMode: 'local' as const }, FILES],
    ['reasoningEffort', { ...BASE, reasoningEffort: 'high' as const }, FILES],
    ['no reasoningEffort', { ...BASE, reasoningEffort: undefined }, FILES],
    ['extraBody', { ...BASE, extraBody: { ...BASE.extraBody, temperature: 0.3 } }, FILES],
    ['no extraBody', { ...BASE, extraBody: undefined }, FILES],
    ['the name', { ...BASE, name: 'qwen3.8-or2' }, FILES],
  ])('changes with %s', (_what, cfg, files) => {
    expect(configurationHash(cfg, files)).not.toBe(configurationHash(BASE, FILES))
  })

  it('does not change with contextTokens', () => {
    expect(configurationHash({ ...BASE, contextTokens: 4096 }, FILES)).toBe(configurationHash(BASE, FILES))
  })

  it('reads a missing reasoningEffort and extraBody as null', () => {
    const bare = { name: 'x', costMode: 'local' as const, contextTokens: 1 }
    const canonical = `{"configuration":{"costMode":"local","extraBody":null,"name":"x","reasoningEffort":null},"litellmComposeSha256":"${'b'.repeat(64)}","litellmConfigSha256":"${'a'.repeat(64)}","v":1}`
    expect(configurationHash(bare, FILES)).toBe(createHash('sha256').update(canonical).digest('hex'))
  })
})

describe('litellmFileHashes', () => {
  it('is the sha256 of the bytes of each of the two files', () => {
    const dir = tmp('litellm-files')
    const configPath = join(dir, 'config.yaml')
    const composePath = join(dir, 'compose.yaml')
    writeFileSync(configPath, 'een\n')
    writeFileSync(composePath, 'twee\n')
    expect(litellmFileHashes({ configPath, composePath })).toEqual({
      litellmConfigSha256: createHash('sha256').update('een\n').digest('hex'),
      litellmComposeSha256: createHash('sha256').update('twee\n').digest('hex'),
    })
  })

  it('throws when a file cannot be read: a read error is never an empty file', () => {
    expect(() => litellmFileHashes({ configPath: join(tmp('litellm-files'), 'weg.yaml'), composePath: join(tmp('litellm-files'), 'weg2.yaml') })).toThrow(/weg\.yaml/)
  })
})

// ---- probeVerdict: the cost facts of a probe ----

type Costs = Array<number | null>
const STEPS = ['a_plain', 'b_single_tool', 'c_two_tools', 'd_nonexistent_tool'] as const
/** A probe result with these costs per step (a step has one answer, c_two_tools two), unless `over` gives more. */
function probeOf(over: Partial<Record<(typeof STEPS)[number], Costs | undefined>> = {}, tool_calling: 'reliable' | 'unreliable' | 'none' = 'reliable') {
  const costs: Record<(typeof STEPS)[number], Costs | undefined> = { a_plain: [0.001], b_single_tool: [0.001], c_two_tools: [0.001, 0.002], d_nonexistent_tool: [0.001], ...over }
  return { tool_calling, steps: Object.fromEntries(STEPS.map((s) => [s, { pass: true, reason: '', raw: null, ...(costs[s] === undefined ? {} : { costsUsd: costs[s] }) }])) } as Parameters<typeof probeVerdict>[0]
}
const HOSTED = { costMode: 'hosted' } as const
const LOCAL = { costMode: 'local' } as const

describe('probeVerdict', () => {
  it('accepts a reliable hosted probe in which every answer has an amount, also a free one', () => {
    expect(probeVerdict(probeOf(), HOSTED)).toEqual({ accepted: true, reasons: [] })
    expect(probeVerdict(probeOf({ b_single_tool: [0] }), HOSTED)).toEqual({ accepted: true, reasons: [] })
  })

  it.each([
    ['step a', { a_plain: [null] }, 'a_plain'],
    ['step b', { b_single_tool: [null] }, 'b_single_tool'],
    ['turn 1 of c_two_tools', { c_two_tools: [null, 0.002] }, 'c_two_tools'],
    ['turn 2 of c_two_tools only', { c_two_tools: [0.001, null] }, 'c_two_tools'],
    ['step d', { d_nonexistent_tool: [null] }, 'd_nonexistent_tool'],
  ])('does not accept a hosted probe without an amount in %s', (_what, over, step) => {
    const verdict = probeVerdict(probeOf(over), HOSTED)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons).toHaveLength(1)
    expect(verdict.reasons[0]).toContain(step)
  })

  it('does not accept a hosted probe from a file without costs per answer (the shape before M45-2d)', () => {
    expect(probeVerdict(probeOf({ c_two_tools: undefined }), HOSTED).accepted).toBe(false)
  })

  it('accepts a reliable local probe without amounts, or with an amount of 0', () => {
    expect(probeVerdict(probeOf({ a_plain: [null], b_single_tool: [null], c_two_tools: [null, null], d_nonexistent_tool: [null] }), LOCAL)).toEqual({ accepted: true, reasons: [] })
    expect(probeVerdict(probeOf({ a_plain: [0], b_single_tool: [null], c_two_tools: [0, null], d_nonexistent_tool: [null] }), LOCAL).accepted).toBe(true)
  })

  it.each([
    ['step a', { a_plain: [0.0001] }, 'a_plain'],
    ['turn 1 of c_two_tools only', { c_two_tools: [0.0001, null] }, 'c_two_tools'],
    ['turn 2 of c_two_tools only', { c_two_tools: [null, 0.0001] }, 'c_two_tools'],
    ['step d', { d_nonexistent_tool: [0.0001] }, 'd_nonexistent_tool'],
  ])('does not accept a local probe with an amount above 0 in %s', (_what, over, step) => {
    const base = { a_plain: [null], b_single_tool: [null], c_two_tools: [null, null], d_nonexistent_tool: [null] }
    const verdict = probeVerdict(probeOf({ ...base, ...over }), LOCAL)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons[0]).toContain(step)
  })

  it('does not accept a local probe from a file without costs per answer either: no figure is not "no cost"', () => {
    expect(probeVerdict(probeOf({ b_single_tool: undefined }), LOCAL).accepted).toBe(false)
  })

  it.each(['unreliable', 'none'] as const)('does not accept a probe whose tool calling is %s, whatever the costs', (verdict) => {
    const r = probeVerdict(probeOf({}, verdict), HOSTED)
    expect(r.accepted).toBe(false)
    expect(r.reasons[0]).toContain(verdict)
  })

  it('names every reason, not only the first', () => {
    const r = probeVerdict(probeOf({ a_plain: [null], d_nonexistent_tool: [null] }, 'unreliable'), HOSTED)
    expect(r.reasons).toHaveLength(3)
  })
})

// ---- checkProbeForJob: the gate of one job ----

function gateSetup() {
  const out = tmp('probe-gate-out')
  const dir = tmp('probe-gate-litellm')
  const configPath = join(dir, 'config.yaml')
  const composePath = join(dir, 'compose.yaml')
  writeFileSync(configPath, 'model_list: []\n')
  writeFileSync(composePath, 'services: {}\n')
  const config = testWorkerConfig({
    litellm: { baseUrl: 'http://127.0.0.1:4000/v1', configPath, composePath },
    configurations: {
      [TEST_CONFIGURATION]: { costMode: 'local', contextTokens: 32768 },
      'deep-hosted': { costMode: 'hosted', contextTokens: 32768, reasoningEffort: 'high', extraBody: { temperature: 0.7 } },
    },
  })
  return { out, config, configPath, composePath }
}
const failure = (reason: string | RegExp) => ({ ok: false, failure: { code: 'CONFIGURATION_NOT_PROBED', detail: typeof reason === 'string' ? reason : expect.stringMatching(reason) } })

describe('checkProbeForJob', () => {
  it('passes a configuration with an accepted probe of the same hash', () => {
    const g = gateSetup()
    seedProbe(g.config, g.out, TEST_CONFIGURATION)
    seedProbe(g.config, g.out, 'deep-hosted')
    expect(checkProbeForJob(g.config, g.out, TEST_CONFIGURATION)).toEqual({ ok: true })
    expect(checkProbeForJob(g.config, g.out, 'deep-hosted')).toEqual({ ok: true })
  })

  it('refuses a configuration without a probe file, and names the file', () => {
    const g = gateSetup()
    const r = checkProbeForJob(g.config, g.out, TEST_CONFIGURATION)
    expect(r).toMatchObject(failure(/geen probe-uitslag.*probe-qwen3-coder-30b[/\\]probe\.json/))
  })

  it('refuses a probe that was not accepted, with the reasons the probe gave', () => {
    const g = gateSetup()
    seedProbe(g.config, g.out, TEST_CONFIGURATION, { accepted: false, reasons: ['stap c_two_tools: antwoord 2 heeft geen bedrag'] })
    expect(checkProbeForJob(g.config, g.out, TEST_CONFIGURATION)).toMatchObject(failure(/niet aanvaard.*antwoord 2 heeft geen bedrag/))
  })

  it('refuses a probe in which accepted is not the boolean true', () => {
    const g = gateSetup()
    seedProbe(g.config, g.out, TEST_CONFIGURATION, { accepted: 'true' })
    expect(checkProbeForJob(g.config, g.out, TEST_CONFIGURATION)).toMatchObject(failure(/niet aanvaard/))
  })

  it.each([
    ['the LiteLLM config file', 'configPath'],
    ['the LiteLLM compose file', 'composePath'],
  ] as const)('refuses when %s changed after the probe: another hash', (_what, which) => {
    const g = gateSetup()
    seedProbe(g.config, g.out, TEST_CONFIGURATION)
    writeFileSync(g[which], 'veranderd\n')
    expect(checkProbeForJob(g.config, g.out, TEST_CONFIGURATION)).toMatchObject(failure(/hash klopt niet/))
  })

  it('refuses when the configuration changed after the probe: another hash', () => {
    const g = gateSetup()
    seedProbe(g.config, g.out, 'deep-hosted')
    g.config.configurations['deep-hosted'].extraBody = { temperature: 0.9 }
    expect(checkProbeForJob(g.config, g.out, 'deep-hosted')).toMatchObject(failure(/hash klopt niet/))
  })

  it('keeps passing when only contextTokens changed', () => {
    const g = gateSetup()
    seedProbe(g.config, g.out, 'deep-hosted')
    g.config.configurations['deep-hosted'].contextTokens = 1000
    expect(checkProbeForJob(g.config, g.out, 'deep-hosted')).toEqual({ ok: true })
  })

  it('refuses a probe file that is not JSON, naming a read problem and not a missing file', () => {
    const g = gateSetup()
    const file = seedProbe(g.config, g.out, TEST_CONFIGURATION)
    writeFileSync(file, '{ dit is geen json')
    const r = checkProbeForJob(g.config, g.out, TEST_CONFIGURATION)
    expect(r).toMatchObject(failure(/onleesbaar/))
    expect(JSON.stringify(r)).not.toContain('geen probe-uitslag')
    expect(JSON.stringify(r)).not.toContain('dit is geen json')
  })

  it.each([['null', 'null'], ['an array', '[]'], ['a string', '"x"']])('refuses a probe file that holds %s', (_what, text) => {
    const g = gateSetup()
    writeFileSync(seedProbe(g.config, g.out, TEST_CONFIGURATION), text)
    expect(checkProbeForJob(g.config, g.out, TEST_CONFIGURATION)).toMatchObject(failure(/onleesbaar/))
  })

  it('refuses a probe.json that cannot be read as a file (a directory), as onleesbaar and not as missing', () => {
    const g = gateSetup()
    const file = seedProbe(g.config, g.out, TEST_CONFIGURATION)
    rmSync(file)
    mkdirSync(file)
    const r = checkProbeForJob(g.config, g.out, TEST_CONFIGURATION)
    expect(r).toMatchObject(failure(/onleesbaar/))
    expect(JSON.stringify(r)).not.toContain('geen probe-uitslag')
  })

  it('refuses a probe that was made for another configuration', () => {
    const g = gateSetup()
    seedProbe(g.config, g.out, TEST_CONFIGURATION, { configuration: 'deep-hosted' })
    expect(checkProbeForJob(g.config, g.out, TEST_CONFIGURATION)).toMatchObject(failure(/gemaakt voor deep-hosted/))
  })

  it('refuses when a LiteLLM file cannot be read for the hash, and says which one', () => {
    const g = gateSetup()
    seedProbe(g.config, g.out, TEST_CONFIGURATION)
    rmSync(g.composePath)
    expect(checkProbeForJob(g.config, g.out, TEST_CONFIGURATION)).toMatchObject(failure(/compose\.yaml/))
  })

  it('refuses a probe without hash', () => {
    const g = gateSetup()
    const probe = acceptedProbe(g.config, TEST_CONFIGURATION)
    delete probe.hash
    writeFileSync(seedProbe(g.config, g.out, TEST_CONFIGURATION), JSON.stringify(probe))
    expect(checkProbeForJob(g.config, g.out, TEST_CONFIGURATION)).toMatchObject(failure(/hash klopt niet/))
  })

  it('does not look at the probe of another configuration', () => {
    const g = gateSetup()
    seedProbe(g.config, g.out, 'deep-hosted')
    expect(checkProbeForJob(g.config, g.out, TEST_CONFIGURATION)).toMatchObject(failure(/geen probe-uitslag/))
    expect(readFileSync(join(probeDir(g.out, 'deep-hosted'), 'probe.json'), 'utf8')).toContain('"accepted": true')
  })

  it('refuses a name that is not a configuration of the worker', () => {
    const g = gateSetup()
    expect(checkProbeForJob(g.config, g.out, 'constructor')).toMatchObject(failure(/geen configuratie/))
  })
})
