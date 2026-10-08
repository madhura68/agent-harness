// The probe of a configuration and the gate per job (M45-2d, spec §4.2). `harness probe --config` probes a configuration of the worker
// config through LiteLLM and writes `<out>/probe-<name>/probe.json` with a hash over everything that decides what the configuration
// is: the two LiteLLM files and the configuration itself. The worker reads that file again for every job and refuses a job whose
// configuration has no accepted probe of the hash it has now: `CONFIGURATION_NOT_PROBED`, for that job only.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeDir, type ProbeResult, type ProbeStep } from '../probe.js'
import type { Configuration, WorkerConfig } from './config.js'
import { shown, type JobFailure } from './job-configuration.js'

export const CONFIGURATION_NOT_PROBED = 'CONFIGURATION_NOT_PROBED'

const PROBE_STEPS: readonly ProbeStep[] = ['a_plain', 'b_single_tool', 'c_two_tools', 'd_nonexistent_tool']
const REASONS_LIMIT = 300

/** The sha256 (hex) of the bytes of the two LiteLLM files a configuration is served by. */
export type LitellmFileHashes = { litellmConfigSha256: string; litellmComposeSha256: string }

/** A configuration under its name: what the hash covers is its name, cost mode, reasoning effort and extra body, not its context window. */
export type NamedConfiguration = Configuration & { name: string }

/** JSON with the keys of every object sorted and no whitespace, so equal values give equal text. A key that holds undefined is left out. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    const parts = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(value)
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

/**
 * The hash of a configuration: the sha256 (hex) of the canonical JSON of `{ v: 1, litellmConfigSha256, litellmComposeSha256,
 * configuration: { name, costMode, reasoningEffort, extraBody } }`, a missing reasoningEffort or extraBody as null. It changes when
 * either LiteLLM file or one of those four fields changes, and not with the context window: that does not change what is probed.
 */
export function configurationHash(cfg: NamedConfiguration, files: LitellmFileHashes): string {
  return sha256(
    canonicalJson({
      v: 1,
      litellmConfigSha256: files.litellmConfigSha256,
      litellmComposeSha256: files.litellmComposeSha256,
      configuration: { name: cfg.name, costMode: cfg.costMode, reasoningEffort: cfg.reasoningEffort ?? null, extraBody: cfg.extraBody ?? null },
    }),
  )
}

function readLitellmFile(path: string): Buffer {
  try {
    return readFileSync(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new Error(`LiteLLM-bestand ${path} onleesbaar (${code ?? 'leesfout'})`)
  }
}

/** The hashes of the two LiteLLM files, read now. A file that cannot be read throws: a read error is never an empty file. */
export function litellmFileHashes(litellm: Pick<WorkerConfig['litellm'], 'configPath' | 'composePath'>): LitellmFileHashes {
  return { litellmConfigSha256: sha256(readLitellmFile(litellm.configPath)), litellmComposeSha256: sha256(readLitellmFile(litellm.composePath)) }
}

/** What the verdict needs of a probe result; a probe.json read back from disk is held to the same shape. */
export type ProbeEvidence = Pick<ProbeResult, 'tool_calling'> & { steps: Record<ProbeStep, { costsUsd?: unknown }> }

export type Verdict = { accepted: boolean; reasons: string[] }

/**
 * Accepts a probe only when tool calling is reliable and the cost facts fit the cost mode: for `hosted` every answer of every step has
 * an amount (0 is an amount), for `local` no answer has an amount above 0. A probe without costs per answer proves neither, so it is
 * not accepted. Every reason is listed.
 */
export function probeVerdict(probe: ProbeEvidence, cfg: Pick<Configuration, 'costMode'>): Verdict {
  const reasons: string[] = []
  if (probe.tool_calling !== 'reliable') reasons.push(`tool_calling is ${String(probe.tool_calling)}, niet reliable`)
  for (const step of PROBE_STEPS) {
    const costs = probe.steps?.[step]?.costsUsd
    if (!Array.isArray(costs)) {
      reasons.push(`stap ${step}: de probe heeft geen kosten per antwoord`)
      continue
    }
    costs.forEach((cost: unknown, index) => {
      const answer = `stap ${step}: antwoord ${index + 1}`
      const amount = typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined
      if (cfg.costMode === 'hosted') {
        if (amount === undefined) reasons.push(`${answer} heeft geen bedrag (costMode hosted)`)
        else if (amount < 0) reasons.push(`${answer} meldt een negatief bedrag (${amount})`)
      } else if (amount !== undefined) {
        if (amount > 0) reasons.push(`${answer} meldt een bedrag (${amount}) bij costMode local`)
      } else if (cost !== null) {
        reasons.push(`${answer} heeft een ongeldig bedrag (costMode local)`)
      }
    })
  }
  return { accepted: reasons.length === 0, reasons }
}

export type ProbeGateResult = { ok: true } | { ok: false; failure: JobFailure }

const notProbed = (detail: string): ProbeGateResult => ({ ok: false, failure: { code: CONFIGURATION_NOT_PROBED, detail } })

/**
 * The gate of one job: reads `<out>/probe-<name>/probe.json` and works out the hash again from the two LiteLLM files and the
 * configuration, as they are now. Passes only for a probe that is made for this configuration, accepted, and of that same hash.
 * Everything else is CONFIGURATION_NOT_PROBED with the reason; a file that is there but cannot be read says so, and is not called missing.
 */
export function checkProbeForJob(config: WorkerConfig, out: string, name: string): ProbeGateResult {
  if (!Object.hasOwn(config.configurations, name)) return notProbed(`geen configuratie ${shown(name)} in de worker-config`)
  const file = join(probeDir(out, name), 'probe.json')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return notProbed(`geen probe-uitslag (${file}); draai harness probe --configuration ${name}`)
    return notProbed(`probe-uitslag onleesbaar (${file}): ${code ?? 'leesfout'}`)
  }
  let probe: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return notProbed(`probe-uitslag onleesbaar (${file}): geen JSON-object`)
    probe = parsed as Record<string, unknown>
  } catch {
    return notProbed(`probe-uitslag onleesbaar (${file}): geen geldige JSON`)
  }
  if (probe.configuration !== name) return notProbed(`probe-uitslag is gemaakt voor ${shown(probe.configuration)}, niet voor ${name}`)
  if (probe.accepted !== true) {
    const reasons = Array.isArray(probe.reasons) ? probe.reasons.filter((r): r is string => typeof r === 'string').join('; ') : ''
    return notProbed(`probe niet aanvaard: ${reasons.slice(0, REASONS_LIMIT) || 'geen reden vastgelegd'}`)
  }
  let expected: string
  try {
    expected = configurationHash({ name, ...config.configurations[name] }, litellmFileHashes(config.litellm))
  } catch (err) {
    return notProbed(err instanceof Error ? err.message : String(err))
  }
  if (probe.hash !== expected) {
    return notProbed(`hash klopt niet: de LiteLLM-bestanden of de configuratie zijn veranderd sinds de probe; draai harness probe --configuration ${name} opnieuw`)
  }
  return { ok: true }
}
