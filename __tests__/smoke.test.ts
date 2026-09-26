import { parseArgs } from 'node:util'
import { describe, expect, it } from 'vitest'
import { cliArgsConfig } from '../src/cli.js'

describe('cli args', () => {
  it('parses a subcommand positional together with --help', () => {
    const { values, positionals } = parseArgs({ ...cliArgsConfig, args: ['probe', '--help'] })
    expect(positionals[0]).toBe('probe')
    expect(values.help).toBe(true)
  })
})
