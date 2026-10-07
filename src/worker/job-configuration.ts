// What a claimed HARNESS job asks for (M45-2d): the configuration it runs under and the cost ceiling it may spend. Both come from the
// payload's `config`, which the MCP resolves at claim: `{ runtime: 'HARNESS', model: <configuration name>, max_cost_usd: <decimal string> }`.
// A job that asks for something this worker cannot do fails on its own, before it runs (spec §4); the worker goes on with the next one.

import type { Manifest } from '../manifest.js'
import type { ModelClient } from '../model-client.js'
import type { Configuration, WorkerConfig } from './config.js'
import type { ControlChannel } from './control.js'
import type { RunLog } from './run-log.js'

export type JobConfiguration = { name: string; configuration: Configuration; maxCostUsd: string }

/** Why a job cannot run. `code` is the first word of the job's error text and of the run-log's ERROR line. */
export type JobFailure = { code: string; detail: string }

export type JobConfigurationResult = { ok: true; job: JobConfiguration } | { ok: false; failure: JobFailure }

const SHOWN_LIMIT = 80
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit)
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head // no half surrogate pair
}

/** A payload value as it appears in an error text: as it is when plain, as JSON when it holds anything else, and cut. */
function shown(value: unknown): string {
  if (value === undefined) return 'ontbrekend'
  if (typeof value === 'string' && PRINTABLE_ASCII.test(value)) return cut(value, SHOWN_LIMIT)
  return cut(JSON.stringify(value) ?? String(value), SHOWN_LIMIT)
}

/** The `config` object of a claimed payload; anything that is no object counts as an empty one. */
function claimedConfig(payload: unknown): Record<string, unknown> {
  const config = (payload as { config?: unknown } | null | undefined)?.config
  return config !== null && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {}
}

/**
 * The ceiling as a validated decimal string: digits, optionally a point and digits, and not zero. No number is made of it, so
 * nothing rounds (the nano-dollar parser that counts with it comes with the cost reporting). Anything else is no ceiling at all.
 */
function parseMaxCostUsd(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && /[1-9]/.test(value) ? value : undefined
}

/**
 * Looks the job's configuration up in the worker config and validates its ceiling. An unknown configuration (also a name that is no
 * string, or an inherited property such as `constructor`) is UNKNOWN_CONFIGURATION; a ceiling that is missing or invalid is
 * COST_LIMIT_MISSING. The configuration is checked first.
 */
export function resolveJobConfiguration(config: WorkerConfig, payload: unknown): JobConfigurationResult {
  const claimed = claimedConfig(payload)
  const name = claimed.model
  if (typeof name !== 'string' || !Object.hasOwn(config.configurations, name)) {
    return { ok: false, failure: { code: 'UNKNOWN_CONFIGURATION', detail: shown(name) } }
  }
  const maxCostUsd = parseMaxCostUsd(claimed.max_cost_usd)
  if (maxCostUsd === undefined) return { ok: false, failure: { code: 'COST_LIMIT_MISSING', detail: shown(claimed.max_cost_usd) } }
  return { ok: true, job: { name, configuration: config.configurations[name], maxCostUsd } }
}

/**
 * The configuration of a job as the run-log's config line shows it. It is written when the claim comes in, so it also describes a job
 * that is about to fail: the name it asked for, a cost mode that is `onbekend` for an unknown configuration, and a ceiling that is
 * `ontbrekend` when there is none.
 */
export function runLogConfiguration(config: WorkerConfig, payload: unknown): { model: { name: string; baseUrl: string }; costMode: string; maxCostUsd: string } {
  const claimed = claimedConfig(payload)
  const name = claimed.model
  const known = typeof name === 'string' && Object.hasOwn(config.configurations, name)
  return {
    model: { name: shown(name), baseUrl: config.litellm.baseUrl },
    costMode: known ? config.configurations[name].costMode : 'onbekend',
    maxCostUsd: parseMaxCostUsd(claimed.max_cost_usd) ?? 'ontbrekend',
  }
}

/** The model block of the run manifest: the configuration under its name, at LiteLLM. The key is not in it; only the model client has it. */
export function modelSpecFor(config: WorkerConfig, job: JobConfiguration): Manifest['model'] {
  const { reasoningEffort, extraBody } = job.configuration
  return {
    baseUrl: config.litellm.baseUrl,
    name: job.name,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(extraBody !== undefined ? { extraBody } : {}),
  }
}

/** The limits of a run under this job's configuration: its context window decides when the history is compacted. */
export function limitsFor(base: Omit<Manifest['limits'], 'contextTokens'>, job: JobConfiguration): Manifest['limits'] {
  return { ...base, contextTokens: job.configuration.contextTokens }
}

/** The model client of a configuration; there is one per configuration, built at the start. A missing one is a bug, not a job error. */
export function modelClientFor(clients: Readonly<Record<string, ModelClient>>, name: string): ModelClient {
  if (!Object.hasOwn(clients, name)) throw new Error(`geen model-client voor configuratie ${name}`)
  return clients[name]
}

/**
 * Fails a claimed job that is not going to run (nothing was marked running, nothing was started): the run-log gets the reason, the
 * job a `failed` update with the error `<code>: <detail>` and a cost that says there is no figure. A failed update that the MCP
 * refuses is logged, not thrown; the worker goes on with the next job either way.
 */
export async function failBeforeRunning(
  deps: { control: ControlChannel; log?: (line: string) => void },
  jobId: string,
  runLog: RunLog | null,
  failure: JobFailure,
): Promise<'failed'> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  runLog?.fail(failure.code, failure.detail)
  const res = await deps.control.updateStatus(jobId, {
    status: 'failed',
    error: `${failure.code}: ${failure.detail}`,
    cost: { reported_cost_usd: null, cost_source: 'none' },
  })
  if (!res.ok) log(`job ${jobId}: update_job_status(failed) mislukt: ${res.message ?? 'onbekend'}`)
  runLog?.step('job_status failed')
  log(`job ${jobId}: failed (${failure.code})`)
  return 'failed'
}
