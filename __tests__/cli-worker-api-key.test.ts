import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSpec } from '../src/types.js'
import type { WorkerDeps } from '../src/worker/worker.js'
import { completion, startFakeModelServer } from './fakes/fake-model-server.js'
import { startFakeScrum4meMcp, type ClaimStep } from './fakes/fake-scrum4me-mcp.js'
import { ideaChatPayload } from './fakes/idea-chat-payload.js'
import { dirContains, tmp } from './helpers.js'

// `harness worker --api-key-env <VAR>`: the model key comes from the environment, beats model.apiKey in the worker config and
// reaches the model client only. A name or a value that the worker's redaction would not cover is refused before anything starts.
// The key values below are obviously fake. The MCP child is mocked the way __tests__/cli-worker.test.ts does it.

const stdioCalls: ServerSpec[] = []
const workerDeps: WorkerDeps[] = []
let claims: ClaimStep[] = []
let fakeMcp: Awaited<ReturnType<typeof startFakeScrum4meMcp>> | undefined

vi.mock('../src/tools/registry.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/tools/registry.js')>()
  return {
    ...actual,
    connectStdioClient: vi.fn(async (server: ServerSpec) => {
      stdioCalls.push(server)
      fakeMcp = await startFakeScrum4meMcp({ claims })
      return { client: fakeMcp.client, close: fakeMcp.close }
    }),
  }
})

// Pass-through that keeps what cmdWorker hands to runWorker, so a test can look at the config afterwards.
vi.mock('../src/worker/worker.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/worker/worker.js')>()
  return {
    ...actual,
    runWorker: vi.fn((deps: Parameters<typeof actual.runWorker>[0]) => {
      workerDeps.push(deps)
      return actual.runWorker(deps)
    }),
  }
})

const { main, resolveWorkerModel, UsageError } = await import('../src/cli.js')
const { probeDir } = await import('../src/probe.js')

const MODEL = 'qwen3-coder:30b'
const KEY_VAR = 'LITELLM_MASTER_KEY' // ends in _KEY, so the redaction treats its value as a secret
const KEY = 'test-master-key-0123456789'
const CONFIG_KEY = 'test-config-key-9876543210'
const SHORT_KEY = 'zq7-x9k' // 7 characters: the redaction masks from 8 up
const MIN_KEY = 'zq7-x9k2' // 8 characters: the shortest value it masks

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let model: Fake | undefined
let output: string[] = []

// The developer's shell may hold a real LITELLM_MASTER_KEY, so every variable a test touches is put back as it was.
const savedEnv = new Map<string, string | undefined>()
function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  stdioCalls.length = 0
  workerDeps.length = 0
  claims = []
  output = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { output.push(String(chunk)); return true })
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { output.push(String(chunk)); return true })
  setEnv('SCRUM4ME_TOKEN', 'x')
  setEnv(KEY_VAR, undefined)
  setEnv('LITELLM', undefined)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await model?.close()
  await fakeMcp?.close()
  model = undefined
  fakeMcp = undefined
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  savedEnv.clear()
})

function workerConfig(dir: string, baseUrl: string, over: Record<string, unknown> = {}) {
  const p = join(dir, 'worker.json')
  writeFileSync(p, JSON.stringify({
    model: { baseUrl, name: MODEL },
    mcp: { command: 'mcp-bin', args: ['--x'], env: { SCRUM4ME_TOKEN: '${SCRUM4ME_TOKEN}', SCRUM4ME_WORKER_CAPABILITIES: 'code_edit' } },
    waitSeconds: 1,
    workerLog: { dir: join(dir, 'worker-logs'), pool: 'harness', instance: 'max2' },
    ...over,
  }))
  return p
}

function writeProbe(out: string, baseUrl: string) {
  const d = probeDir(out, MODEL)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'probe.json'), JSON.stringify({ baseUrl, model: MODEL, tool_calling: 'reliable' }))
}

/** `harness worker --once` in a fresh dir, with a reliable probe for `baseUrl` unless `probe: false`. */
async function harnessWorker(o: { baseUrl?: string; config?: Record<string, unknown>; flags?: string[]; probe?: boolean } = {}) {
  const baseUrl = o.baseUrl ?? 'http://127.0.0.1:1/v1'
  const dir = tmp('cli-worker-key')
  const out = join(dir, 'runs')
  if (o.probe !== false) writeProbe(out, baseUrl)
  const code = await main(['worker', '--config', workerConfig(dir, baseUrl, o.config), '--out', out, '--once', ...(o.flags ?? [])])
  return { code, out, logDir: join(dir, 'worker-logs'), text: output.join('') }
}

async function answeringModel(content = 'Hier is je antwoord.'): Promise<Fake> {
  model = await startFakeModelServer([{ body: completion({ content, model: MODEL }) }])
  return model
}

/** The text of every run-log the worker wrote (one file per claimed job). */
function runLogText(logDir: string): string {
  const runsDir = join(logDir, 'harness', 'max2', 'runs')
  return readdirSync(runsDir).filter((f) => f.endsWith('.log')).map((f) => readFileSync(join(runsDir, f), 'utf8')).join('\n')
}

describe('harness worker --api-key-env', () => {
  it('is in the usage text', async () => {
    const code = await main(['--help'])
    expect(code).toBe(0)
    expect(output.join('')).toContain('harness worker --config <worker.json> [--out <runs-dir>] [--once] [--skip-probe] [--api-key-env <VAR>]')
  })

  describe('with a usable variable', () => {
    it('sends its value to the model as a Bearer header', async () => {
      const m = await answeringModel()
      setEnv(KEY_VAR, KEY)
      claims = [{ job: ideaChatPayload() }]
      const { code } = await harnessWorker({ baseUrl: m.baseUrl, flags: ['--api-key-env', KEY_VAR] })
      expect(code).toBe(0)
      expect(m.requests).toHaveLength(1)
      expect(m.requests[0].headers.authorization).toBe(`Bearer ${KEY}`)
    })

    it('lets the key win over a model.apiKey in the worker config, which stays as it was loaded', async () => {
      const m = await answeringModel()
      setEnv(KEY_VAR, KEY)
      claims = [{ job: ideaChatPayload() }]
      const config = { model: { baseUrl: m.baseUrl, name: MODEL, apiKey: CONFIG_KEY } }
      const { code } = await harnessWorker({ baseUrl: m.baseUrl, config, flags: ['--api-key-env', KEY_VAR] })
      expect(code).toBe(0)
      expect(m.requests[0].headers.authorization).toBe(`Bearer ${KEY}`)
      expect(workerDeps[0].config.model.apiKey).toBe(CONFIG_KEY) // the flag only reaches the client
    })

    it('hands the key to the model client only: not to the config of the worker, the run dir, the run-log or the output', async () => {
      const m = await answeringModel()
      setEnv(KEY_VAR, KEY)
      claims = [{ job: ideaChatPayload() }]
      const { code, out, logDir, text } = await harnessWorker({ baseUrl: m.baseUrl, flags: ['--api-key-env', KEY_VAR] })
      expect(code).toBe(0)
      // The premises of the scans below: the key was used, and the run-log exists.
      expect(m.requests[0].headers.authorization).toBe(`Bearer ${KEY}`)
      const runLog = runLogText(logDir)
      expect(runLog).toContain('config job_id=job1')
      expect(workerDeps).toHaveLength(1)
      expect(workerDeps[0].config.model).not.toHaveProperty('apiKey')
      expect(JSON.stringify(workerDeps[0].config)).not.toContain(KEY)
      expect(runLog).not.toContain(KEY)
      expect(dirContains(out, KEY), 'trace.jsonl and the other files of the run dir').toBe(false)
      expect(text).not.toContain(KEY)
    })

    // Why a name and a length are demanded at all: the worker picks its secrets from process.env by name, from 8 characters up.
    it('masks the key in the run-log when the model repeats it', async () => {
      const m = await answeringModel(`antwoord met ${KEY}`)
      setEnv(KEY_VAR, KEY)
      claims = [{ job: ideaChatPayload() }]
      const { code, logDir } = await harnessWorker({ baseUrl: m.baseUrl, flags: ['--api-key-env', KEY_VAR] })
      expect(code).toBe(0)
      expect(m.requests[0].headers.authorization).toBe(`Bearer ${KEY}`) // the premise: the key was in use
      const runLog = runLogText(logDir)
      expect(runLog).not.toContain(KEY)
      expect(runLog).toContain('antwoord met ***')
    })
  })

  describe('refuses with a usage error before anything starts', () => {
    it.each([
      ['unset', undefined],
      ['empty', ''],
    ])('a variable that is %s, naming it', async (_what, value) => {
      setEnv(KEY_VAR, value)
      claims = [{ timeout: true }]
      const { code, text } = await harnessWorker({ flags: ['--api-key-env', KEY_VAR] })
      expect(code).toBe(1)
      expect(text).toContain(KEY_VAR)
      expect(text).toContain('Usage:') // only a UsageError prints the usage
      expect(stdioCalls).toHaveLength(0)
    })

    it('ahead of the probe gate: the variable is reported even where no probe exists', async () => {
      const { code, text } = await harnessWorker({ probe: false, flags: ['--api-key-env', KEY_VAR] })
      expect(code).toBe(1)
      expect(text).toContain(KEY_VAR)
      expect(text).not.toContain('PROBE_REQUIRED')
      expect(stdioCalls).toHaveLength(0)
    })

    // The second name has KEY inside it, not at the end: the redaction does not cover that either.
    it.each(['LITELLM', 'LITELLM_KEY_FILE'])('a name the redaction does not treat as secret: %s', async (name) => {
      setEnv(name, KEY)
      claims = [{ timeout: true }]
      const { code, text } = await harnessWorker({ flags: ['--api-key-env', name] })
      expect(code).toBe(1)
      expect(text).toContain(name)
      expect(text).toContain('Usage:')
      expect(text).not.toContain(KEY)
      expect(stdioCalls).toHaveLength(0)
    })

    it('a value shorter than 8 characters, without printing it', async () => {
      setEnv(KEY_VAR, SHORT_KEY)
      claims = [{ timeout: true }]
      const { code, text } = await harnessWorker({ flags: ['--api-key-env', KEY_VAR] })
      expect(code).toBe(1)
      expect(text).toContain(KEY_VAR)
      expect(text).toContain('Usage:')
      expect(text).not.toContain(SHORT_KEY)
      expect(stdioCalls).toHaveLength(0)
    })
  })
})

describe('resolveWorkerModel', () => {
  const block = { baseUrl: 'http://127.0.0.1:4000/v1', name: 'qwen3.8-27b' }
  const env = { [KEY_VAR]: KEY }

  /** The message of the UsageError that `fn` throws; fails the test on any other outcome. */
  function usageErrorOf(fn: () => unknown): string {
    let thrown: unknown
    try {
      fn()
    } catch (err) {
      thrown = err
    }
    expect(thrown, 'the thrown error').toBeInstanceOf(UsageError)
    return (thrown as Error).message
  }

  describe('without --api-key-env', () => {
    it('returns the model block itself, a model.apiKey included', () => {
      expect(resolveWorkerModel(block, undefined, env)).toBe(block)
      const withKey = { ...block, apiKey: CONFIG_KEY }
      expect(resolveWorkerModel(withKey, undefined, env)).toBe(withKey)
    })
  })

  describe('with a usable variable', () => {
    it('returns a copy of the block that holds the key, and leaves the block it was given as it was', () => {
      const frozen = Object.freeze({ ...block })
      const resolved = resolveWorkerModel(frozen, KEY_VAR, env)
      expect(resolved).toEqual({ ...block, apiKey: KEY })
      expect(resolved).not.toBe(frozen)
      expect(frozen).not.toHaveProperty('apiKey')
    })

    it('lets the key win over a model.apiKey', () => {
      const withKey = Object.freeze({ ...block, apiKey: CONFIG_KEY })
      expect(resolveWorkerModel(withKey, KEY_VAR, env).apiKey).toBe(KEY)
      expect(withKey.apiKey).toBe(CONFIG_KEY)
    })

    it('keeps the other fields of the block', () => {
      const full = { ...block, reasoningEffort: 'none' as const, extraBody: { temperature: 0.2 } }
      expect(resolveWorkerModel(full, KEY_VAR, env)).toEqual({ ...full, apiKey: KEY })
    })

    it('reads the env it is given, not process.env', () => {
      setEnv(KEY_VAR, 'process-env-value-that-must-not-be-used')
      expect(resolveWorkerModel(block, KEY_VAR, env).apiKey).toBe(KEY)
    })

    it.each(['LITELLM_MASTER_KEY', 'OPENROUTER_API_KEY', 'litellm_master_key'])('accepts the secret-like name %s', (name) => {
      expect(resolveWorkerModel(block, name, { [name]: KEY }).apiKey).toBe(KEY)
    })

    it('accepts a value of exactly 8 characters', () => {
      expect(resolveWorkerModel(block, KEY_VAR, { [KEY_VAR]: MIN_KEY }).apiKey).toBe(MIN_KEY)
    })
  })

  describe('throws a UsageError that names the variable', () => {
    it.each([
      ['is unset', {}],
      ['is empty', { [KEY_VAR]: '' }],
    ])('when the variable %s', (_what, source) => {
      const message = usageErrorOf(() => resolveWorkerModel(block, KEY_VAR, source))
      expect(message).toContain(KEY_VAR)
      expect(message).toMatch(/not set/)
    })

    // A shell variable that expanded to nothing gives `--api-key-env ''`: no reason to run without a key.
    it('when the name of the variable is empty, instead of taking that for "no option"', () => {
      expect(usageErrorOf(() => resolveWorkerModel(block, '', env))).toMatch(/needs the name of an environment variable/)
    })

    it.each(['LITELLM', 'LITELLM_KEY_FILE', 'LITELLMKEY'])('when the name %s is not one the redaction treats as secret, without printing the value', (name) => {
      const message = usageErrorOf(() => resolveWorkerModel(block, name, { [name]: KEY }))
      expect(message).toContain(name)
      expect(message).toMatch(/does not look like a secret name/)
      expect(message).not.toContain(KEY)
    })

    // collectSecretEntries finds the password of a URL under any name, but as `<NAME> (url-wachtwoord)`: not the name itself.
    it('when the only secret in the value is a URL password under a name that is not secret-like', () => {
      const value = 'https://litellm:pw-fake-0123456789@gateway.example/v1'
      const message = usageErrorOf(() => resolveWorkerModel(block, 'LITELLM', { LITELLM: value }))
      expect(message).toMatch(/does not look like a secret name/)
      expect(message).not.toContain('pw-fake-0123456789')
    })

    it('when the value is shorter than 8 characters, without printing it', () => {
      const message = usageErrorOf(() => resolveWorkerModel(block, KEY_VAR, { [KEY_VAR]: SHORT_KEY }))
      expect(message).toContain(KEY_VAR)
      expect(message).toMatch(/shorter than 8 characters/)
      expect(message).not.toContain(SHORT_KEY)
    })
  })
})
