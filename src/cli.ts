#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import type { ZodType } from 'zod'
import { BenchCaseSchema } from './bench/case.js'
import { DocsetError, runDocServer } from './bench/doc-server.js'
import { assertExtraBody, loadManifest, ManifestError, ModelSpecSchema, resolveServerEnv } from './manifest.js'
import { createModelClient } from './model-client.js'
import { probeDir, runProbe } from './probe.js'
import { runManifest } from './run.js'
import { connectStdioClient, connectStdioRegistry, createRegistryView } from './tools/registry.js'
import { openTrace } from './trace.js'
import type { ToolRegistry } from './types.js'
import { checkRunLogs } from './worker/check-run-logs.js'
import { loadWorkerConfig, TaskConfigSchema, workerMcpEnv } from './worker/config.js'
import { createControlChannel } from './worker/control.js'
import { capDocArgs } from './worker/doc-tools.js'
import { collectSecretValues, workerSecretSources } from './worker/redact.js'
import { openRunLog } from './worker/run-log.js'
import { runWorker } from './worker/worker.js'

const USAGE = `harness — agent-harness v0

Usage:
  harness probe --base-url <url> --model <name> [--out <runs-dir>] [--api-key-env <VAR>] [--step-timeout <sec>] [--extra-body-file <json>]
  harness run <manifest.json> --out <dir> [--skip-probe] [--api-key-env <VAR>]
  harness worker --config <worker.json> [--out <runs-dir>] [--once] [--skip-probe]
  harness check-run-logs --config <worker.json> --dir <run-logs-dir>
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

class UsageError extends Error {}

function readApiKey(varName: string | undefined): string | undefined {
  if (!varName) return undefined
  const v = process.env[varName]
  if (!v) throw new UsageError(`--api-key-env: environment variable ${varName} is not set`)
  return v
}

/**
 * --extra-body-file is a probe option. run and worker take extraBody from the model block, and ignoring the flag in
 * silence would send every request without the fields it was meant to carry, such as the provider block.
 */
function rejectExtraBodyFile(values: Values, command: 'run' | 'worker'): void {
  if (values['extra-body-file'] === undefined) return
  const block = command === 'run' ? 'the model block of the manifest' : 'the model block of the worker config'
  throw new UsageError(`--extra-body-file only applies to harness probe; for harness ${command} put extraBody in ${block} (model.extraBody)`)
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

async function cmdProbe(values: Values): Promise<number> {
  const baseUrl = values['base-url']
  const model = values.model
  if (!baseUrl || !model) throw new UsageError('probe needs --base-url and --model')
  const stepTimeoutSec = Number(values['step-timeout'] ?? '120')
  if (!Number.isFinite(stepTimeoutSec) || stepTimeoutSec <= 0) throw new UsageError('--step-timeout must be a positive number of seconds')
  const extraBodyFile = values['extra-body-file']
  const extraBody = extraBodyFile === undefined ? undefined : readExtraBodyFile(extraBodyFile)
  const apiKey = readApiKey(values['api-key-env'])
  const client = createModelClient({ baseUrl, name: model, apiKey, extraBody })
  const result = await runProbe(client, { baseUrl, model, stepTimeoutMs: stepTimeoutSec * 1000 })
  const dir = probeDir(values.out ?? 'runs', model)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'probe.json')
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n')
  for (const [name, s] of Object.entries(result.steps)) {
    process.stdout.write(`${s.pass ? 'PASS' : 'FAIL'} ${name}: ${s.reason}\n`)
  }
  process.stdout.write(`tool_calling: ${result.tool_calling} (usage_reported: ${result.usage_reported}) → ${file}\n`)
  return result.tool_calling === 'reliable' ? 0 : 1
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

async function cmdWorker(values: Values): Promise<number> {
  if (!values.config) throw new UsageError('worker needs --config')
  rejectExtraBodyFile(values, 'worker')
  const out = values.out ?? 'runs'
  const config = loadWorkerConfig(values.config)
  if (values['skip-probe'] !== true && !passesProbeGate(config.model, out)) return 1
  // Expand ${VAR} before anything starts; the values only travel to the MCP child process.
  const env = workerMcpEnv(config)
  // Computed once per worker run, not per job: the version never changes mid-run, and re-scanning every
  // secret source on every claim would be wasted work.
  const version = harnessVersion()
  const secrets = collectSecretValues(...workerSecretSources(config, process.env))

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
  try {
    conn = await connectStdioClient({ ...config.mcp, env }, stop.signal)
    const client = conn.client
    const { exitCode, jobs } = await runWorker({
      control: createControlChannel(client),
      registryView: async (signal) => capDocArgs(await createRegistryView(client, config.allow, signal)),
      modelClient: createModelClient(config.model),
      config,
      out,
      once: values.once === true,
      signal: stop.signal,
      runLogFor: (claim) => openRunLog(config.workerLog, { jobId: claim.jobId, kind: claim.kind, model: config.model, version, secrets }),
    })
    process.stdout.write(`worker klaar — ${jobs.length} job(s): ${jobs.map((j) => `${j.jobId}=${j.outcome}`).join(', ') || 'geen'}\n`)
    return exitCode
  } finally {
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
  const { checked, results } = checkRunLogs(config, process.env, values.dir)
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
  const [casePath, modelPath, taskPath, label, out] = requiredValues(values, TASK_BENCH_FLAGS)
  if (!BENCH_LABEL.test(label)) throw new UsageError(`--label must be one plain path segment (letters, digits, '.', '_' and '-'): ${JSON.stringify(label)}`)
  const benchCase = readJsonConfig(casePath, BenchCaseSchema, 'case')
  const model = readJsonConfig(modelPath, ModelSpecSchema, 'model config')
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
