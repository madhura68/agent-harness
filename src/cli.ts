#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { loadManifest, ManifestError, resolveServerEnv, type Manifest } from './manifest.js'
import { createModelClient } from './model-client.js'
import { probeDir, runProbe } from './probe.js'
import { runManifest } from './run.js'
import { connectStdioRegistry } from './tools/registry.js'
import { openTrace } from './trace.js'
import type { ToolRegistry } from './types.js'

const USAGE = `harness — agent-harness v0

Usage:
  harness probe --base-url <url> --model <name> [--out <runs-dir>] [--api-key-env <VAR>] [--step-timeout <sec>]
  harness run <manifest.json> --out <dir> [--skip-probe]
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
function probeGate(manifest: Manifest, out: string): string | undefined {
  const file = join(probeDir(out, manifest.model.name), 'probe.json')
  let probe: { baseUrl?: unknown; model?: unknown; tool_calling?: unknown }
  try {
    probe = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return `no probe result at ${file}`
  }
  if (probe.baseUrl !== manifest.model.baseUrl || probe.model !== manifest.model.name) {
    return `${file} was made for ${String(probe.model)} at ${String(probe.baseUrl)}`
  }
  if (probe.tool_calling !== 'reliable') return `${file} rates tool calling as ${String(probe.tool_calling)}`
  return undefined
}

async function cmdRun(values: Values, manifestPath: string | undefined): Promise<number> {
  if (!manifestPath) throw new UsageError('run needs a manifest path')
  const out = values.out ?? 'runs'
  const manifest = loadManifest(manifestPath)
  const skipProbe = values['skip-probe'] === true

  let connectRegistry = async (): Promise<ToolRegistry> => {
    throw new Error('connectRegistry is only available for profile tools')
  }
  if (manifest.profile === 'tools' && manifest.tools) {
    if (!skipProbe) {
      const reason = probeGate(manifest, out)
      if (reason) {
        process.stderr.write(
          `PROBE_REQUIRED: ${reason}. Draai eerst harness probe --base-url ${manifest.model.baseUrl} --model ${manifest.model.name} --out ${out}` +
            ` (of gebruik --skip-probe).\n`,
        )
        return 1
      }
    }
    // Expand ${VAR} here, before the run dir exists; the expanded values only travel to the MCP child process.
    const server = { ...manifest.tools.server, env: resolveServerEnv(manifest) }
    const allow = manifest.tools.allow
    connectRegistry = () => connectStdioRegistry(server, allow)
  }

  const trace = openTrace(out, manifest.id)
  const client = createModelClient({ baseUrl: manifest.model.baseUrl, name: manifest.model.name, apiKey: manifest.model.apiKey })
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
