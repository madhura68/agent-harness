import { describe, expect, it } from 'vitest'
import { WorkerConfigSchema } from '../src/worker/config.js'
import { collectSecretEntries, collectSecretValues, redactDeep, REDACTED, redactText, workerSecretSources } from '../src/worker/redact.js'

// Obvious test values -- never a real secret.
const TOKEN = 'test-token-0123456789abcdef0123456789'

describe('collectSecretValues', () => {
  it('catches secret-like keys and leaves ordinary values alone', () => {
    const s = collectSecretValues({
      FORGEJO_TOKEN: TOKEN,
      OPS_AGENT_SECRET: 'secret-value-123',
      HOME: '/home/agent',
      PATH: '/usr/local/bin:/usr/bin',
      SHORT_TOKEN: 'abc',
    })
    expect(s).toContain(TOKEN)
    expect(s).toContain('secret-value-123')
    expect(s).not.toContain('/home/agent')
    expect(s).not.toContain('abc')
  })

  it('pulls the password out of a URL value, also under a non-secret key, decoded too', () => {
    const s = collectSecretValues({ DATABASE_URL: 'postgresql://app:p%40ss-word-9@db:5432/x' })
    expect(s).toContain('p%40ss-word-9')
    expect(s).toContain('p@ss-word-9')
  })

  it('combines multiple environments and sorts longest first', () => {
    const s = collectSecretValues({ A_TOKEN: 'short-token' }, { B_TOKEN: 'short-token-but-longer' })
    expect(s[0]).toBe('short-token-but-longer')
  })

  it('finds a password in a URL under the MODEL_BASE_URL key', () => {
    const s = collectSecretValues({ MODEL_BASE_URL: 'https://user:model-base-secret-01@example.com/v1' })
    expect(s).toContain('model-base-secret-01')
  })
})

describe('redactText', () => {
  it('masks multiple different secrets on one line', () => {
    expect(redactText(`x=${TOKEN} y=second-secret`, [TOKEN, 'second-secret'])).toBe(`x=${REDACTED} y=${REDACTED}`)
  })

  it('leaves text without secrets byte-identical', () => {
    const text = '{"type":"result","is_error":false}\nline two\n'
    expect(redactText(text, [TOKEN])).toBe(text)
  })
})

describe('redactDeep', () => {
  it('redacts every string in nested objects and arrays, leaving other values alone', () => {
    const value = {
      a: TOKEN,
      list: ['x', TOKEN, { nested: TOKEN, n: 42 }],
      n: 42,
      bool: true,
      nil: null,
    }
    expect(redactDeep(value, [TOKEN])).toEqual({
      a: REDACTED,
      list: ['x', REDACTED, { nested: REDACTED, n: 42 }],
      n: 42,
      bool: true,
      nil: null,
    })
  })
})

describe('collectSecretEntries', () => {
  it('keeps short values together with their names, and drops empty values', () => {
    const entries = collectSecretEntries({ SHORT_TOKEN: 'abc', EMPTY_SECRET: '', MISSING_TOKEN: undefined, HOME: '/home/agent' })
    expect(entries).toContainEqual({ name: 'SHORT_TOKEN', value: 'abc' })
    expect(entries.some((e) => e.name === 'EMPTY_SECRET')).toBe(false)
    expect(entries.some((e) => e.name === 'MISSING_TOKEN')).toBe(false)
    expect(entries.some((e) => e.name === 'HOME')).toBe(false)
  })

  it('names a URL-password entry "<KEY> (url-wachtwoord)", both raw and decoded', () => {
    const entries = collectSecretEntries({ DATABASE_URL: 'postgresql://app:p%40ss-word-9@db:5432/x' })
    expect(entries).toContainEqual({ name: 'DATABASE_URL (url-wachtwoord)', value: 'p%40ss-word-9' })
    expect(entries).toContainEqual({ name: 'DATABASE_URL (url-wachtwoord)', value: 'p@ss-word-9' })
  })

  it('keeps parity with collectSecretValues: every value it redacts also shows up here', () => {
    const envs = [{ FORGEJO_TOKEN: TOKEN, DATABASE_URL: 'postgresql://app:p%40ss-word-9@db:5432/x', HOME: '/home/agent', SHORT_TOKEN: 'abc' }]
    const values = collectSecretValues(...envs)
    const entryValues = collectSecretEntries(...envs).map((e) => e.value)
    for (const v of values) expect(entryValues).toContain(v)
  })
})

describe('workerSecretSources', () => {
  it('provides a value from each of the four sources (process.env, workerMcpEnv, MODEL_API_KEY, MODEL_BASE_URL)', () => {
    const config = WorkerConfigSchema.parse({
      model: { baseUrl: 'https://user:model-base-secret-01@example.com/v1', name: 'test-model', apiKey: 'model-api-key-0123456789' },
      mcp: { command: 'node', args: ['server.js'], env: { MCP_SECRET_TOKEN: '${MCP_SECRET_TOKEN}' } },
    })
    const processEnv = { PROCESS_ENV_TOKEN: 'process-env-secret-0123456789', MCP_SECRET_TOKEN: 'mcp-secret-token-0123456789' }

    const values = collectSecretValues(...workerSecretSources(config, processEnv))

    expect(values).toContain('process-env-secret-0123456789') // process.env
    expect(values).toContain('mcp-secret-token-0123456789') // workerMcpEnv
    expect(values).toContain('model-api-key-0123456789') // MODEL_API_KEY
    expect(values).toContain('model-base-secret-01') // password embedded in MODEL_BASE_URL
  })
})
