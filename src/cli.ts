#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { loadManifest, ManifestError, resolveServerEnv } from './manifest.js'
import { createModelClient } from './model-client.js'
import { probeDir, runProbe } from './probe.js'
import { runManifest } from './run.js'
import { connectStdioClient, connectStdioRegistry, createRegistryView } from './tools/registry.js'
import { openTrace } from './trace.js'
import type { ToolRegistry } from './types.js'
import { loadWorkerConfig, workerMcpEnv } from './worker/config.js'
import { createControlChannel } from './worker/control.js'
import { collectSecretValues, workerSecretSources } from './worker/redact.js'
import { openRunLog } from './worker/run-log.js'
import { runWorker } from './worker/worker.js'

const USAGE = `harness — agent-harness v0

Usage:
  harness probe --base-url <url> --model <name> [--out <runs-dir>] [--api-key-env <VAR>] [--step-timeout <sec>]
  harness run <manifest.json> --out <dir> [--skip-probe]
  harness worker --config <worker.json> [--out <runs-dir>] [--once] [--skip-probe]
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
    'skip-probe': { type: 'boolean' },
    config: { type: 'string' },
    once: { type: 'boolean' },
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

async function cmdProbe(values: Values): Promise<number> {
  const baseUrl = values['base-url']
  const model = values.model
  if (!baseUrl || !model) throw new UsageError('probe needs --base-url and --model')
  const stepTimeoutSec = Number(values['step-timeout'] ?? '120')
  if (!Number.isFinite(stepTimeoutSec) || stepTimeoutSec <= 0) throw new UsageError('--step-timeout must be a positive number of seconds')
  const apiKey = readApiKey(values['api-key-env'])
  const client = createModelClient({ baseUrl, name: model, apiKey })
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
  const out = values.out ?? 'runs'
  const manifest = loadManifest(manifestPath)
  const skipProbe = values['skip-probe'] === true

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
  const client = createModelClient(manifest.model)
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
      registryView: (signal) => createRegistryView(client, config.allow, signal),
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
      default:
        process.stderr.write(`${positionals[0]}: not implemented\n`)
        return 1
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n${USAGE}`)
      return 1
    }
    if (err instanceof ManifestError) {
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
