#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { fetch } from 'undici'
import type { ZodType } from 'zod'
import { BenchCaseSchema } from './bench/case.js'
import { DocsetError, runDocServer } from './bench/doc-server.js'
import { assertExtraBody, loadManifest, ManifestError, ModelSpecSchema, resolveServerEnv } from './manifest.js'
import { createModelClient, type ModelClient } from './model-client.js'
import { probeDir, runProbe, type ProbeResult } from './probe.js'
import { runManifest } from './run.js'
import { connectStdioClient, connectStdioRegistry, createRegistryView } from './tools/registry.js'
import { openTrace } from './trace.js'
import type { ToolRegistry } from './types.js'
import { checkRunLogs } from './worker/check-run-logs.js'
import { loadWorkerConfig, TaskConfigSchema, workerMcpEnv, type WorkerConfig } from './worker/config.js'
import { checkHarnessRuntime, createControlChannel } from './worker/control.js'
import { capDocArgs } from './worker/doc-tools.js'
import { EXIT_NO_RESTART, EXIT_RESTART, EXIT_STOPPED, type ExitCode } from './worker/exit-codes.js'
import { runLogConfiguration, shown } from './worker/job-configuration.js'
import { configurationHash, litellmFileHashes, probeVerdict } from './worker/probe-gate.js'
import { collectSecretEntries, collectSecretValues, workerSecretSources } from './worker/redact.js'
import { openRunLog } from './worker/run-log.js'
import { runWorker } from './worker/worker.js'

const USAGE = `harness — agent-harness v0

Usage:
  harness probe --base-url <url> --model <name> [--out <runs-dir>] [--api-key-env <VAR>] [--step-timeout <sec>] [--extra-body-file <json>]
  harness probe --config <harness.json> (--configuration <name> | --all) [--out <runs-dir>] [--api-key-env <VAR>] [--step-timeout <sec>]
  harness run <manifest.json> --out <dir> [--skip-probe] [--api-key-env <VAR>]
  harness worker --config <worker.json> --api-key-env <VAR> [--out <runs-dir>] [--once]
  harness check-run-logs --config <worker.json> --dir <run-logs-dir> [--api-key-env <VAR>]
  harness doc-server --dir <docset-dir> --product-id <id>
  harness task-bench --case <json> --model-config <json> --task-config <json> --label <label> --out <dir> [--api-key-env <VAR>] [--retry-transient]
  harness task-bench --check-case --case <json> --task-config <json> --out <dir>
`

// allowPositionals is required: without it Node throws ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL on the subcommand.
export const cliArgsConfig = {
  allowPositionals: true,
  strict: true,
  options: {
    help: { type: 'boolean' },
    'base-url': { type: 'string' },
    model: { type: 'string' },
    out: { type: 'string' },
    'api-key-env': { type: 'string' },
    'step-timeout': { type: 'string' },
    'extra-body-file': { type: 'string' },
    'skip-probe': { type: 'boolean' },
    config: { type: 'string' },
    configuration: { type: 'string' },
    all: { type: 'boolean' },
    once: { type: 'boolean' },
    dir: { type: 'string' },
    'product-id': { type: 'string' },
    case: { type: 'string' },
    'model-config': { type: 'string' },
    'task-config': { type: 'string' },
    label: { type: 'string' },
    'retry-transient': { type: 'boolean' },
    'check-case': { type: 'boolean' },
  },
} satisfies ParseArgsConfig

type Values = ReturnType<typeof parseArgs<typeof cliArgsConfig>>['values']

export class UsageError extends Error {}

function readApiKey(varName: string | undefined): string | undefined {
  if (!varName) return undefined
  const v = process.env[varName]
  if (!v) throw new UsageError(`--api-key-env: environment variable ${varName} is not set`)
  return v
}

/**
 * --extra-body-file is a probe option. run and worker take extraBody from the model block, and task-bench from its
 * --model-config file; ignoring the flag in silence would send every request without the fields it was meant to carry,
 * such as the provider block.
 */
function rejectExtraBodyFile(values: Values, command: 'run' | 'worker' | 'task-bench'): void {
  if (values['extra-body-file'] === undefined) return
  const where = {
    run: 'the model block of the manifest (model.extraBody)',
    worker: 'a configuration of the worker config (configurations.<name>.extraBody)',
    'task-bench': 'the --model-config file (extraBody)',
  }[command]
  throw new UsageError(`--extra-body-file only applies to harness probe; for harness ${command} put extraBody in ${where}`)
}

/** The JSON object in --extra-body-file, held to the same rules as `model.extraBody` in a manifest. */
function readExtraBodyFile(path: string): Record<string, unknown> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ManifestError(`cannot read --extra-body-file ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError(`invalid --extra-body-file ${path}: moet een JSON-object zijn`)
  }
  const extraBody = raw as Record<string, unknown>
  try {
    // The probe has no reasoningEffort, so a reasoning_effort in the file cannot clash with one.
    assertExtraBody(extraBody)
  } catch (err) {
    throw new ManifestError(`invalid --extra-body-file ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return extraBody
}

function readStepTimeoutMs(values: Values): number {
  const stepTimeoutSec = Number(values['step-timeout'] ?? '120')
  if (!Number.isFinite(stepTimeoutSec) || stepTimeoutSec <= 0) throw new UsageError('--step-timeout must be a positive number of seconds')
  return stepTimeoutSec * 1000
}

function printProbeSteps(result: ProbeResult, label = ''): void {
  for (const [name, s] of Object.entries(result.steps)) {
    process.stdout.write(`${label}${s.pass ? 'PASS' : 'FAIL'} ${name}: ${s.reason}\n`)
  }
}

async function cmdProbe(values: Values): Promise<number> {
  if (values.config !== undefined) return cmdProbeConfigurations(values, values.config)
  if (values.configuration !== undefined || values.all === true) throw new UsageError('probe: --configuration and --all need --config')
  const baseUrl = values['base-url']
  const model = values.model
  if (!baseUrl || !model) throw new UsageError('probe needs --base-url and --model')
  const stepTimeoutMs = readStepTimeoutMs(values)
  const extraBodyFile = values['extra-body-file']
  const extraBody = extraBodyFile === undefined ? undefined : readExtraBodyFile(extraBodyFile)
  const apiKey = readApiKey(values['api-key-env'])
  const client = createModelClient({ baseUrl, name: model, apiKey, extraBody })
  const result = await runProbe(client, { baseUrl, model, stepTimeoutMs })
  const dir = probeDir(values.out ?? 'runs', model)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'probe.json')
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n')
  printProbeSteps(result)
  process.stdout.write(`tool_calling: ${result.tool_calling} (usage_reported: ${result.usage_reported}) → ${file}\n`)
  return result.tool_calling === 'reliable' ? 0 : 1
}

/**
 * `harness probe --config <harness.json> (--configuration <name> | --all)`: probes configurations of the worker config through LiteLLM,
 * each under its own name with its own request fields, and writes `<out>/probe-<name>/probe.json` with the hash, the verdict and the cost
 * of every answer (spec §4.2). It reads the config and the two LiteLLM files and nothing else: no environment is expanded and no MCP child
 * starts, so a probe unit runs with the master key alone. Exit 0 only when every probed configuration is accepted.
 */
async function cmdProbeConfigurations(values: Values, configPath: string): Promise<number> {
  const one = values.configuration
  if ((one !== undefined) === (values.all === true)) throw new UsageError('probe --config needs exactly one of --configuration <name> and --all')
  for (const flag of ['base-url', 'model', 'extra-body-file'] as const) {
    if (values[flag] !== undefined) {
      throw new UsageError(
        flag === 'extra-body-file'
          ? '--extra-body-file does not apply to probe --config: the extraBody of a configuration is probed as it is (configurations.<name>.extraBody)'
          : `--${flag} does not apply to probe --config: the configuration names the model and LiteLLM is its base URL`,
      )
    }
  }
  const stepTimeoutMs = readStepTimeoutMs(values)
  const config = loadWorkerConfig(configPath)
  if (one !== undefined && !Object.hasOwn(config.configurations, one)) {
    throw new UsageError(`--configuration ${shown(one)} is not a configuration of ${configPath} (it has: ${Object.keys(config.configurations).join(', ')})`)
  }
  const names = one !== undefined ? [one] : Object.keys(config.configurations)
  const apiKey = readApiKey(values['api-key-env'])
  let files: ReturnType<typeof litellmFileHashes>
  try {
    files = litellmFileHashes(config.litellm)
  } catch (err) {
    throw new ManifestError(err instanceof Error ? err.message : String(err))
  }
  const out = values.out ?? 'runs'
  let allAccepted = true
  for (const name of names) {
    const configuration = config.configurations[name]
    const result = await runProbe(createConfigurationClient(config, name, apiKey), { baseUrl: config.litellm.baseUrl, model: name, stepTimeoutMs })
    const verdict = probeVerdict(result, configuration)
    const dir = probeDir(out, name)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'probe.json')
    const hash = configurationHash({ name, ...configuration }, files)
    writeFileSync(file, JSON.stringify({ ...result, configuration: name, costMode: configuration.costMode, hash, accepted: verdict.accepted, reasons: verdict.reasons }, null, 2) + '\n')
    printProbeSteps(result, `${name}: `)
    process.stdout.write(`${name}: tool_calling: ${result.tool_calling} (usage_reported: ${result.usage_reported}), ${verdict.accepted ? 'accepted' : 'NOT accepted'} → ${file}\n`)
    for (const reason of verdict.reasons) process.stdout.write(`${name}: ${reason}\n`)
    if (!verdict.accepted) allAccepted = false
  }
  return allAccepted ? 0 : 1
}

/** Spec §7: a tools run needs a reliable probe for the same baseUrl + model, unless --skip-probe. */
function probeGate(model: { baseUrl: string; name: string }, out: string): string | undefined {
  const file = join(probeDir(out, model.name), 'probe.json')
  let probe: { baseUrl?: unknown; model?: unknown; tool_calling?: unknown }
  try {
    probe = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return `no probe result at ${file}`
  }
  if (probe.baseUrl !== model.baseUrl || probe.model !== model.name) {
    return `${file} was made for ${String(probe.model)} at ${String(probe.baseUrl)}`
  }
  if (probe.tool_calling !== 'reliable') return `${file} rates tool calling as ${String(probe.tool_calling)}`
  return undefined
}

function passesProbeGate(model: { baseUrl: string; name: string }, out: string): boolean {
  const reason = probeGate(model, out)
  if (!reason) return true
  process.stderr.write(
    `PROBE_REQUIRED: ${reason}. Draai eerst harness probe --base-url ${model.baseUrl} --model ${model.name} --out ${out}` +
      ` (of gebruik --skip-probe).\n`,
  )
  return false
}

async function cmdRun(values: Values, manifestPath: string | undefined): Promise<number> {
  if (!manifestPath) throw new UsageError('run needs a manifest path')
  rejectExtraBodyFile(values, 'run')
  const out = values.out ?? 'runs'
  const manifest = loadManifest(manifestPath)
  const skipProbe = values['skip-probe'] === true
  // Read before anything else starts, so an unset variable fails with no run dir and no MCP process.
  const apiKey = readApiKey(values['api-key-env'])

  let connectRegistry = async (_signal: AbortSignal): Promise<ToolRegistry> => {
    throw new Error('connectRegistry is only available for profile tools')
  }
  if (manifest.profile === 'tools' && manifest.tools) {
    if (!skipProbe) {
      if (!passesProbeGate(manifest.model, out)) return 1
    }
    // Expand ${VAR} here, before the run dir exists; the expanded values only travel to the MCP child process.
    const server = { ...manifest.tools.server, env: resolveServerEnv(manifest) }
    const allow = manifest.tools.allow
    connectRegistry = (signal: AbortSignal) => connectStdioRegistry(server, allow, signal)
  }

  const trace = openTrace(out, manifest.id)
  // The key from --api-key-env beats a model.apiKey in the manifest, but only here: the manifest object that goes to
  // runManifest (and from there into the trace) is never given it.
  const client = createModelClient(apiKey ? { ...manifest.model, apiKey } : manifest.model)
  const result = await runManifest(manifest, { client, trace, connectRegistry, ...(skipProbe && manifest.profile === 'tools' ? { probeSkipped: true } : {}) })
  const u = result.usage
  process.stdout.write(
    `${result.status}${result.error ? ` (${result.error.code}: ${result.error.message})` : ''} — turns ${u.turns}, ` +
      `tokens in/out ${u.inputTokens}/${u.outputTokens} (${u.source}), tool calls ${u.toolCalls}, tool errors ${u.toolErrors}, ` +
      `${result.durationMs} ms → ${join(trace.dir, 'result.json')}\n`,
  )
  if (result.status === 'completed') process.stdout.write(`\n${result.answer}\n`)
  return result.status === 'completed' ? 0 : 1
}

/**
 * `agent-harness@<version>` from package.json (run-log spec §5.4). The relative path resolves both from
 * `src/cli.ts` (tsx, vitest) and from the built `dist/cli.js`, since both sit one level under the repo root.
 */
function harnessVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
  return `agent-harness@${typeof pkg.version === 'string' ? pkg.version : '0'}`
}

/**
 * The master key of LiteLLM for `harness worker`: the value of the variable that --api-key-env names, or no key without the option.
 * It goes to the model clients and to the check of the LiteLLM models, and nowhere else: the worker config has no place for a key.
 *
 * The worker masks secrets in a run-log by what process.env holds (workerSecretSources): the value of a variable with a
 * secret-like name, from 8 characters up. `harness check-run-logs` picks its secrets the same way and counts a shorter one as a
 * hit. A key under another name would stand unmasked and unchecked wherever the model or a tool repeats it, and a shorter one
 * unmasked, so both are refused. The checks call the redaction's own functions, because a copy of its name pattern or its
 * minimum length could drift away from it.
 */
export function resolveWorkerApiKey(apiKeyEnv: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (apiKeyEnv === undefined) return undefined
  // An empty name (a shell variable that expanded to nothing) is no reason to run without a key.
  if (apiKeyEnv === '') throw new UsageError('--api-key-env needs the name of an environment variable')
  const apiKey = env[apiKeyEnv]
  if (!apiKey) throw new UsageError(`--api-key-env: environment variable ${apiKeyEnv} is not set or empty`)
  // The entry must carry the variable's own name: a value that is a URL also yields one for its password, named `<NAME> (url-wachtwoord)`.
  if (!collectSecretEntries({ [apiKeyEnv]: apiKey }).some((entry) => entry.name === apiKeyEnv)) {
    throw new UsageError(
      `--api-key-env: ${apiKeyEnv} does not look like a secret name, so the worker's redaction would not mask its value in a run-log; use a name such as MODEL_API_KEY`,
    )
  }
  if (!collectSecretValues({ [apiKeyEnv]: apiKey }).includes(apiKey)) {
    throw new UsageError(`--api-key-env: the value of ${apiKeyEnv} is shorter than 8 characters, which the worker's redaction does not mask`)
  }
  return apiKey
}

/** The model client of one configuration: LiteLLM's address, the configuration's name as the model, its own request fields, the shared key. */
function createConfigurationClient(config: WorkerConfig, name: string, apiKey: string | undefined): ModelClient {
  const c = config.configurations[name]
  return createModelClient({ baseUrl: config.litellm.baseUrl, name, apiKey, reasoningEffort: c.reasoningEffort, extraBody: c.extraBody })
}

/** One model client per configuration of the worker config. */
function createConfigurationClients(config: WorkerConfig, apiKey: string | undefined): Record<string, ModelClient> {
  return Object.fromEntries(Object.keys(config.configurations).map((name) => [name, createConfigurationClient(config, name, apiKey)]))
}

const LITELLM_MODELS_TIMEOUT_MS = 15_000

/** A URL for a log line: without any credentials it carries. */
function plainUrl(url: string): string {
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    return u.toString()
  } catch {
    return '<ongeldige url>'
  }
}

type ModelsCheck = { ok: true } | { ok: false; exitCode: ExitCode; line: string }

/**
 * The start check against LiteLLM (spec §4.1): `GET <litellm.baseUrl>/models` with the master key, and the model names it serves must be
 * exactly the configurations of the worker. Not reachable, or no usable answer (a network error, a 5xx): 1, because a restart may
 * find LiteLLM up. A refused key (401, 403), a configuration LiteLLM does not know, or a LiteLLM model without a configuration: 78,
 * because the same files give the same refusal at every restart. The line to print comes with the refusal; it holds both lists and never the key.
 */
export async function checkLitellmModels(config: WorkerConfig, apiKey: string | undefined): Promise<ModelsCheck> {
  const url = `${config.litellm.baseUrl.replace(/\/+$/, '')}/models`
  // The reason is a status or an error name and code, never an error message: undici's messages can quote the URL, credentials included.
  const unreachable = (why: string): ModelsCheck => ({ ok: false, exitCode: EXIT_RESTART, line: `LITELLM_UNREACHABLE: GET ${plainUrl(url)} mislukt (${why})` })
  let served: string[]
  try {
    const res = await fetch(url, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(LITELLM_MODELS_TIMEOUT_MS) })
    // A refused key is refused again at every restart, so 78; the body is not shown, because it may echo the key.
    if (res.status === 401 || res.status === 403) {
      return { ok: false, exitCode: EXIT_NO_RESTART, line: `LITELLM_AUTH_FAILED: GET ${plainUrl(url)} gaf HTTP ${res.status}; controleer de masterkey van --api-key-env` }
    }
    if (!res.ok) return unreachable(`HTTP ${res.status}`)
    const body: unknown = await res.json().catch(() => undefined)
    const data = (body as { data?: unknown } | null | undefined)?.data
    if (!Array.isArray(data) || data.some((m) => typeof (m as { id?: unknown } | null)?.id !== 'string')) return unreachable('antwoord is geen modellijst')
    served = data.map((m: { id: string }) => m.id)
  } catch (err) {
    const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code
    return unreachable(`${err instanceof Error ? err.name : 'fout'}${typeof code === 'string' ? ` ${code}` : ''}`)
  }
  const configured = Object.keys(config.configurations)
  const notInLitellm = configured.filter((name) => !served.includes(name))
  const withoutConfiguration = served.filter((id) => !configured.includes(id))
  if (notInLitellm.length === 0 && withoutConfiguration.length === 0) return { ok: true }
  return {
    ok: false,
    exitCode: EXIT_NO_RESTART,
    line:
      `LITELLM_MODELS_MISMATCH: configuraties=${JSON.stringify(configured)}; litellm=${JSON.stringify(served)}; ` +
      `niet in litellm: ${JSON.stringify(notInLitellm)}; zonder configuratie: ${JSON.stringify(withoutConfiguration)}`,
  }
}

/**
 * Everything a worker start needs before the MCP child exists: the config, the key, the env of the child, the LiteLLM check. Nothing here
 * starts a process or registers a worker, so a refusal leaves nothing behind. Returns an exit code instead of a start when LiteLLM refuses.
 */
async function prepareWorker(values: Values) {
  if (!values.config) throw new UsageError('worker needs --config')
  // The per-job probe gate (src/worker/probe-gate.ts) has no bypass, so this worker has no such option; an unknown option is a usage error.
  if (values['skip-probe'] !== undefined) throw new UsageError("Unknown option '--skip-probe' for harness worker: the probe gate per job cannot be skipped")
  rejectExtraBodyFile(values, 'worker')
  const out = values.out ?? 'runs'
  const config = loadWorkerConfig(values.config)
  // Read before anything starts, like harness run, so a bad --api-key-env fails with no MCP process.
  // Only the model clients and the LiteLLM check get the key: `config` never holds it, so the run-log, the manifest and the trace never carry it.
  // The master key is required: without it LiteLLM answers 401 at every start.
  if (values['api-key-env'] === undefined) throw new UsageError('worker needs --api-key-env (the variable that holds the master key of LiteLLM)')
  const apiKey = resolveWorkerApiKey(values['api-key-env'], process.env)
  // Expand ${VAR} before anything starts; the values only travel to the MCP child process.
  const env = workerMcpEnv(config)
  const refusal = await checkLitellmModels(config, apiKey)
  if (!refusal.ok) {
    process.stderr.write(`${refusal.line}\n`)
    return refusal.exitCode
  }
  return { out, config, apiKey, env }
}

/** The exit code of a start error that comes before the MCP child: a bad config, flag or variable is the same at every restart, so 78 (not 1). */
function startErrorExit(err: unknown): ExitCode {
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n${USAGE}`)
    return EXIT_NO_RESTART
  }
  if (err instanceof ManifestError) {
    process.stderr.write(`${err.message}\n`)
    return EXIT_NO_RESTART
  }
  throw err
}

async function cmdWorker(values: Values): Promise<number> {
  let prepared: Awaited<ReturnType<typeof prepareWorker>>
  try {
    prepared = await prepareWorker(values)
  } catch (err) {
    return startErrorExit(err)
  }
  if (typeof prepared === 'number') return prepared
  const { out, config, apiKey, env } = prepared
  const modelClients = createConfigurationClients(config, apiKey)
  // Computed once per worker run, not per job: the version never changes mid-run, and re-scanning every
  // secret source on every claim would be wasted work.
  const version = harnessVersion()
  const secrets = collectSecretValues(...workerSecretSources(config, process.env, values['api-key-env']))

  const stop = new AbortController()
  let interrupts = 0
  const onSignal = () => {
    interrupts++
    if (interrupts > 1) process.exit(130)
    process.stderr.write('worker stopt na de lopende stap (nogmaals Ctrl-C = direct afbreken)\n')
    stop.abort()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  let conn: Awaited<ReturnType<typeof connectStdioClient>> | undefined
  // The MCP child is lost when its connection closes and the harness did not close it itself. Nothing can be reported to it any more,
  // so the loop stops (a running job is left) and the worker exits 1: a restart brings a new child, and a new start check.
  let closing = false
  let mcpLost = false
  const onMcpClosed = () => {
    if (closing || mcpLost) return
    mcpLost = true
    process.stderr.write('MCP-verbinding verloren: het MCP-kindproces is weg; een lopende job wordt verlaten. Worker stopt.\n')
    stop.abort()
  }
  try {
    // Every step that can fail without an MCP child comes before this line (config, the key, the LiteLLM check: prepareWorker). Then no
    // child exists and nothing is registered in claude_workers.
    conn = await connectStdioClient({ ...config.mcp, env }, stop.signal)
    const client = conn.client
    client.onclose = onMcpClosed
    // Start check before the first claim: an MCP release that does not know HARNESS would register this worker under a runtime it lacks.
    let startCheck: Awaited<ReturnType<typeof checkHarnessRuntime>>
    try {
      startCheck = await checkHarnessRuntime(client)
    } catch (err) {
      // A lost child is a case for a restart (1). Any other failure of the call itself is a refusal like a tool error: the same start fails the same way.
      if (mcpLost) return EXIT_RESTART
      startCheck = { ok: false, line: `STARTCHECK_FAILED: de MCP kent HARNESS niet (health.runtimes=ontbrekend): health-aanroep mislukt (${err instanceof Error ? err.message : String(err)})` }
    }
    if (!startCheck.ok) {
      process.stderr.write(`${startCheck.line}\n`)
      return EXIT_NO_RESTART
    }
    const { exitCode, jobs } = await runWorker({
      control: createControlChannel(client),
      registryView: async (signal) => capDocArgs(await createRegistryView(client, config.allow, signal)),
      modelClients,
      config,
      out,
      once: values.once === true,
      signal: stop.signal,
      runLogFor: (claim) => openRunLog(config.workerLog, { jobId: claim.jobId, kind: claim.kind, ...runLogConfiguration(config, claim.payload), version, secrets }),
    })
    process.stdout.write(`worker klaar — ${jobs.length} job(s): ${jobs.map((j) => `${j.jobId}=${j.outcome}`).join(', ') || 'geen'}\n`)
    // Lost child beats the loop's own result: the loop was stopped by the loss, which reads as a clean stop (0) to it.
    return mcpLost && exitCode === EXIT_STOPPED ? EXIT_RESTART : exitCode
  } finally {
    closing = true // the harness's own close below is no loss
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await conn?.close().catch(() => undefined)
  }
}

/**
 * Spec §10 criterion 4: scans --dir for the same secrets the redaction masks, without ever printing
 * a value. checkRunLogs (src/worker/check-run-logs.ts) stays pure and does the scanning; this only
 * prints and decides the exit code, matching the other cmd* handlers in this file.
 */
async function cmdCheckRunLogs(values: Values): Promise<number> {
  if (!values.config) throw new UsageError('check-run-logs needs --config')
  if (!values.dir) throw new UsageError('check-run-logs needs --dir')
  const config = loadWorkerConfig(values.config)
  // The master key of the worker counts as a secret too. A variable that is not set is an error and not "nothing to check", so it cannot pass in silence.
  const apiKeyEnv = values['api-key-env']
  if (apiKeyEnv !== undefined && !process.env[apiKeyEnv]) throw new UsageError(`--api-key-env: environment variable ${apiKeyEnv} is not set or empty`)
  const { checked, results } = checkRunLogs(config, process.env, values.dir, apiKeyEnv)
  process.stdout.write(`${checked} geheim(en) gecontroleerd in ${values.dir}\n`)
  for (const r of results) process.stdout.write(`  ${r.name}: treffers=${r.hits} kort=${r.short}\n`)
  // Exit 1 on any hit, and also when nothing was checked at all: that usually means this ran without
  // the service's own environment, which would silently pass every check instead of failing loud.
  return checked === 0 || results.some((r) => r.hits > 0) ? 1 : 0
}

/**
 * M5: serves a frozen docset over stdio as the four doc tools of scrum4me-mcp (src/bench/doc-server.ts). Returns once
 * connected; the process lives until the client closes its stdin. stdout belongs to the MCP protocol, so nothing is printed there.
 */
async function cmdDocServer(values: Values): Promise<number> {
  if (!values.dir) throw new UsageError('doc-server needs --dir')
  if (!values['product-id']) throw new UsageError('doc-server needs --product-id')
  await runDocServer({ dir: values.dir, productId: values['product-id'] })
  return 0
}

/**
 * Runs `work` with a signal that SIGINT and SIGTERM trip (task-bench spec §4.1, "Stoppen"), and waits for it to finish. The signal only
 * says "stop": `work` aborts what it is doing, cleans up after itself (the containers!) and ends, and nothing here kills it. The
 * handlers are `once`: a second Ctrl-C finds none and ends the process at once.
 */
async function withStopSignals<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const stop = new AbortController()
  const onSignal = () => {
    process.stderr.write('task-bench stopt: containers worden opgeruimd (nogmaals Ctrl-C = direct afbreken)\n')
    stop.abort()
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    return await work(stop.signal)
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

/** Reads a JSON file and holds it to `schema`; the message names the file and, for a schema failure, every field. Like loadManifest. */
function readJsonConfig<T>(path: string, schema: ZodType<T>, what: string): T {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ManifestError(`cannot read ${what} ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
    throw new ManifestError(`invalid ${what} ${path}: ${issues}`)
  }
  return parsed.data
}

// The label becomes a part of the run dir name (`<case>-<label>-<hex>`), so it has to be one plain path segment.
const BENCH_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TASK_BENCH_FLAGS = ['case', 'model-config', 'task-config', 'label', 'out'] as const
// --check-case has no model and no key: it needs the case, the task config (the recipe and the container settings) and a place to write.
const CHECK_CASE_FLAGS = ['case', 'task-config', 'out'] as const

/** The value of every one of these flags; the first that is missing is a usage error, before anything else is read or started. */
function requiredValues(values: Values, flags: readonly (typeof TASK_BENCH_FLAGS)[number][]): string[] {
  return flags.map((flag) => {
    const value = values[flag]
    if (!value) throw new UsageError(`task-bench needs --${flag}`)
    return value
  })
}

/**
 * M7: one task-bench run (src/bench/task-bench.ts). The exit code says whether `bench-result.json` was written: 0 for every status,
 * the benchfout and afgebroken ones included; anything that stops it from being written is an error. The bench is imported only
 * here: its prompt module refuses to load when the worker prompt changed, and `harness worker` must never depend on that.
 * With `--check-case` it is the proof for a candidate case instead (`cmdCheckCase`).
 */
async function cmdTaskBench(values: Values): Promise<number> {
  if (values['check-case'] === true) return cmdCheckCase(values)
  rejectExtraBodyFile(values, 'task-bench')
  const [casePath, modelPath, taskPath, label, out] = requiredValues(values, TASK_BENCH_FLAGS)
  if (!BENCH_LABEL.test(label)) throw new UsageError(`--label must be one plain path segment (letters, digits, '.', '_' and '-'): ${JSON.stringify(label)}`)
  const benchCase = readJsonConfig(casePath, BenchCaseSchema, 'case')
  // Strict, unlike run and worker: the schema strips a key it does not know, and a typo such as `extra_body` would send every request
  // without the provider block (no 16-bit pin, no data_collection: deny). `.strict()` makes a copy; the shared schema stays as it is.
  const model = readJsonConfig(modelPath, ModelSpecSchema.strict(), 'model config')
  if (model.apiKey !== undefined) throw new ManifestError(`invalid model config ${modelPath}: apiKey: een sleutel hoort niet in een bestand; geef hem via --api-key-env`)
  const task = readJsonConfig(taskPath, TaskConfigSchema, 'task config')
  // Read before anything starts, so an unset variable fails with no run dir.
  const apiKey = readApiKey(values['api-key-env'])

  return withStopSignals(async (signal) => {
    const { runTaskBench } = await import('./bench/task-bench.js')
    const result = await runTaskBench({ case: benchCase, model, label, task, out, apiKey, retryTransient: values['retry-transient'] === true, signal })
    process.stdout.write(`${result.status} — ${result.runId} → ${join(out, result.runId, 'bench-result.json')}\n`)
    return 0
  })
}

/**
 * M7: the proof that a candidate task is a bench case (`checkCase`, src/bench/task-bench.ts), with real containers and without a model
 * or a key. The exit code is the verdict: 0 when the case is ok, 1 when it is not, a check that was stopped included (it still writes
 * its `case-check.json`). The name of the evidence dir ends in a random part, so the line names the pattern.
 */
async function cmdCheckCase(values: Values): Promise<number> {
  const [casePath, taskPath, out] = requiredValues(values, CHECK_CASE_FLAGS)
  const benchCase = readJsonConfig(casePath, BenchCaseSchema, 'case')
  const task = readJsonConfig(taskPath, TaskConfigSchema, 'task config')

  return withStopSignals(async (signal) => {
    const { checkCase } = await import('./bench/task-bench.js')
    const check = await checkCase({ case: benchCase, task, out, signal })
    process.stdout.write(`${check.ok ? 'ok' : 'niet ok'} — ${check.caseId} → ${join(out, `${check.caseId}-check-*`, 'case-check.json')}\n`)
    for (const problem of check.problems) process.stdout.write(`  - ${problem}\n`)
    return check.ok ? 0 : 1
  })
}

export async function main(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ ...cliArgsConfig, args: argv })
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`)
    return 1
  }
  const { values, positionals } = parsed
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE)
    return values.help ? 0 : 1
  }
  try {
    switch (positionals[0]) {
      case 'probe':
        return await cmdProbe(values)
      case 'run':
        return await cmdRun(values, positionals[1])
      case 'worker':
        return await cmdWorker(values)
      case 'check-run-logs':
        return await cmdCheckRunLogs(values)
      case 'doc-server':
        return await cmdDocServer(values)
      case 'task-bench':
        return await cmdTaskBench(values)
      default:
        process.stderr.write(`${positionals[0]}: not implemented\n`)
        return 1
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n${USAGE}`)
      return 1
    }
    if (err instanceof ManifestError || err instanceof DocsetError) {
      process.stderr.write(`${err.message}\n`)
      return 1
    }
    throw err
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    },
  )
}
