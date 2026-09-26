#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs, type ParseArgsConfig } from 'node:util'

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
  },
} satisfies ParseArgsConfig

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ ...cliArgsConfig, args: argv })
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE)
    return values.help ? 0 : 1
  }
  process.stderr.write(`${positionals[0]}: not implemented\n`)
  return 1
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
