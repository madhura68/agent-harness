import { describe, expect, it } from 'vitest'
import { testWorkerConfig } from './fakes/worker-config.js'
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
  const config = testWorkerConfig({ mcp: { command: 'node', args: ['server.js'], env: { MCP_SECRET_TOKEN: '${MCP_SECRET_TOKEN}' } } })
  const processEnv = {
    PROCESS_ENV_TOKEN: 'process-env-secret-0123456789',
    MCP_SECRET_TOKEN: 'mcp-secret-token-0123456789',
    LITELLM_MASTER_KEY: 'litellm-master-key-0123456789',
  }

  it('provides a value from each of the sources (process.env, workerMcpEnv, the --api-key-env key)', () => {
    const values = collectSecretValues(...workerSecretSources(config, processEnv, 'LITELLM_MASTER_KEY'))

    expect(values).toContain('process-env-secret-0123456789') // process.env
    expect(values).toContain('mcp-secret-token-0123456789') // workerMcpEnv
    expect(values).toContain('litellm-master-key-0123456789') // the key of --api-key-env
  })

  it('counts the key of --api-key-env as MODEL_API_KEY, whatever its variable is called', () => {
    const entries = collectSecretEntries(...workerSecretSources(config, { MCP_SECRET_TOKEN: 'mcp-secret-token-0123456789', LITELLM: 'litellm-master-key-0123456789' }, 'LITELLM'))
    expect(entries).toContainEqual({ name: 'MODEL_API_KEY', value: 'litellm-master-key-0123456789' })
  })

  it('takes the key from the env it is given, and nothing when the variable is not in it', () => {
    const mcpOnly = { MCP_SECRET_TOKEN: 'mcp-secret-token-0123456789' }
    expect(collectSecretValues(...workerSecretSources(config, { ...mcpOnly, LITELLM: 'litellm-master-key-0123456789' }, 'LITELLM'))).toContain('litellm-master-key-0123456789')
    expect(collectSecretValues(...workerSecretSources(config, mcpOnly, 'LITELLM'))).not.toContain('litellm-master-key-0123456789')
    expect(collectSecretValues(...workerSecretSources(config, { ...mcpOnly, LITELLM: 'litellm-master-key-0123456789' }))).not.toContain('litellm-master-key-0123456789') // no option, no key
  })
})
