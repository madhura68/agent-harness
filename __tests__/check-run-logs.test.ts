import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.js'
import { checkRunLogs } from '../src/worker/check-run-logs.js'
import { WorkerConfigSchema } from '../src/worker/config.js'

// Obvious test values -- never a real secret.
const TOKEN = 'test-token-fake-0123456789abcdef'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `harness-${prefix}-`))
}

const baseConfig = WorkerConfigSchema.parse({
  model: { baseUrl: 'http://127.0.0.1:11434/v1', name: 'test-model' },
  mcp: { command: 'node', args: [] },
})

describe('checkRunLogs', () => {
  it('finds one occurrence of a configured secret in a run-log file', () => {
    const dir = tmp('crl')
    writeFileSync(join(dir, 'a.log'), `line one\nsecret leaked: ${TOKEN}\nline three\n`)
    const { checked, results } = checkRunLogs(baseConfig, { X_TOKEN: TOKEN }, dir)
    expect(checked).toBe(1)
    expect(results).toContainEqual({ name: 'X_TOKEN', hits: 1, short: false })
  })

  it('reports zero hits when the secret does not appear in any file', () => {
    const dir = tmp('crl')
    writeFileSync(join(dir, 'a.log'), 'nothing secret in here\n')
    const { checked, results } = checkRunLogs(baseConfig, { X_TOKEN: TOKEN }, dir)
    expect(checked).toBe(1)
    expect(results).toContainEqual({ name: 'X_TOKEN', hits: 0, short: false })
  })

  it('checks zero secrets when the environment and config carry none', () => {
    const dir = tmp('crl')
    const { checked, results } = checkRunLogs(baseConfig, { HOME: '/home/agent', PATH: '/usr/bin' }, dir)
    expect(checked).toBe(0)
    expect(results).toEqual([])
  })

  it('checks a 5-character secret and marks it short', () => {
    const dir = tmp('crl')
    writeFileSync(join(dir, 'a.log'), 'x=ab1cd\n')
    const { results } = checkRunLogs(baseConfig, { X_TOKEN: 'ab1cd' }, dir)
    expect(results).toContainEqual({ name: 'X_TOKEN', hits: 1, short: true })
  })

  it('does not report an empty secret-like variable (no false alarm)', () => {
    const dir = tmp('crl')
    writeFileSync(join(dir, 'a.log'), 'irrelevant content\n')
    const { checked, results } = checkRunLogs(baseConfig, { EMPTY_TOKEN: '' }, dir)
    expect(checked).toBe(0)
    expect(results.some((r) => r.name === 'EMPTY_TOKEN')).toBe(false)
  })

  it('finds a URL password in decoded form, separately from the raw (still-encoded) form', () => {
    const dir = tmp('crl')
    // The log only ever shows the decoded value; the raw, percent-encoded form never appears anywhere.
    writeFileSync(join(dir, 'a.log'), 'connecting with password p@ss-word-9\n')
    const { results } = checkRunLogs(baseConfig, { DATABASE_URL: 'postgresql://app:p%40ss-word-9@db:5432/x' }, dir)
    expect(results).toContainEqual({ name: 'DATABASE_URL (url-wachtwoord)', hits: 0, short: false }) // raw form: absent
    expect(results).toContainEqual({ name: 'DATABASE_URL (url-wachtwoord)', hits: 1, short: false }) // decoded form: present
  })

  it('searches recursively, matching the real <dir>/<pool>/<instance>/runs/*.log layout', () => {
    const dir = tmp('crl')
    const nested = join(dir, 'harness', 'max2', 'runs')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, '20260928T120000Z.log'), `leak ${TOKEN}\n`)
    const { results } = checkRunLogs(baseConfig, { X_TOKEN: TOKEN }, dir)
    expect(results).toContainEqual({ name: 'X_TOKEN', hits: 1, short: false })
  })

  it('sums occurrences across multiple files', () => {
    const dir = tmp('crl')
    writeFileSync(join(dir, 'a.log'), `${TOKEN} appears twice: ${TOKEN}\n`)
    writeFileSync(join(dir, 'b.log'), `${TOKEN} again\n`)
    const { results } = checkRunLogs(baseConfig, { X_TOKEN: TOKEN }, dir)
    expect(results).toContainEqual({ name: 'X_TOKEN', hits: 3, short: false })
  })

  it('also checks a secret sourced from config.model.apiKey (not only process env)', () => {
    const dir = tmp('crl')
    const apiKey = 'model-api-key-fake-777777'
    writeFileSync(join(dir, 'a.log'), `key used: ${apiKey}\n`)
    const config = WorkerConfigSchema.parse({
      model: { baseUrl: 'http://127.0.0.1:11434/v1', name: 'test-model', apiKey },
      mcp: { command: 'node', args: [] },
    })
    const { results } = checkRunLogs(config, {}, dir)
    expect(results).toContainEqual({ name: 'MODEL_API_KEY', hits: 1, short: false })
  })
})

describe('harness check-run-logs (CLI)', () => {
  let stdout: string[] = []
  let stderr: string[] = []

  beforeEach(() => {
    stdout = []
    stderr = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.CHECK_RUN_LOGS_TEST_TOKEN
  })

  function writeConfig(dir: string): string {
    const p = join(dir, 'worker.json')
    writeFileSync(p, JSON.stringify({ model: { baseUrl: 'http://127.0.0.1:11434/v1', name: 'test-model' }, mcp: { command: 'node', args: [] } }))
    return p
  }

  it('exits 1 and reports the name with 1 hit when a run-log contains the secret', async () => {
    const dir = tmp('crl-cli')
    const logsDir = join(dir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(join(logsDir, 'a.log'), `leaked: ${TOKEN}\n`)
    process.env.CHECK_RUN_LOGS_TEST_TOKEN = TOKEN
    const code = await main(['check-run-logs', '--config', writeConfig(dir), '--dir', logsDir])
    expect(code).toBe(1)
    const out = stdout.join('')
    expect(out).toContain('CHECK_RUN_LOGS_TEST_TOKEN')
    expect(out).toMatch(/CHECK_RUN_LOGS_TEST_TOKEN[^\n]*\b1\b/)
  })

  it('exits 0 when the configured secret appears nowhere under --dir', async () => {
    const dir = tmp('crl-cli')
    const logsDir = join(dir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(join(logsDir, 'a.log'), 'nothing secret in this file\n')
    process.env.CHECK_RUN_LOGS_TEST_TOKEN = TOKEN
    const code = await main(['check-run-logs', '--config', writeConfig(dir), '--dir', logsDir])
    expect(code).toBe(0)
  })

  it('exits 1 when zero secrets were checked (a controlled, empty environment)', async () => {
    const dir = tmp('crl-cli')
    const logsDir = join(dir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(join(logsDir, 'a.log'), 'nothing secret in this file\n')
    // Neutralize the ambient shell environment (e.g. a real FORGEJO_TOKEN from ~/.zshenv) for the
    // duration of this one assertion, so "zero checked" is deterministic rather than incidental.
    const saved = { ...process.env }
    for (const k of Object.keys(process.env)) delete process.env[k]
    try {
      const code = await main(['check-run-logs', '--config', writeConfig(dir), '--dir', logsDir])
      expect(code).toBe(1)
      expect(stdout.join('')).toMatch(/^0\b/)
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })

  it('never writes the secret value itself to stdout or stderr', async () => {
    const dir = tmp('crl-cli')
    const logsDir = join(dir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    // Distinctive enough that it could never appear in the output by accident.
    const canary = 'zzq-canary-8492716-should-never-print-xk'
    writeFileSync(join(logsDir, 'a.log'), `leaked value: ${canary}\n`)
    process.env.CHECK_RUN_LOGS_TEST_TOKEN = canary
    const code = await main(['check-run-logs', '--config', writeConfig(dir), '--dir', logsDir])
    expect(code).toBe(1)
    const everything = [...stdout, ...stderr].join('')
    expect(everything).toContain('CHECK_RUN_LOGS_TEST_TOKEN') // proves the run really happened and found the hit
    expect(everything).not.toContain(canary)
  })
})
