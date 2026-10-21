import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeDir } from '../src/probe.js'
import { main, TASK_BENCH_STOP_MESSAGE } from '../src/cli.js'
import { benchTmp, cleanupBenchFixtures } from './fakes/bench-repo.js'
import { completion, startFakeModelServer } from './fakes/fake-model-server.js'
import { seedProbesForConfigFile } from './fakes/probe-seed.js'
import { TEST_CONFIGURATION, workerConfigInput } from './fakes/worker-config.js'
import { makeCase, type MadeCase } from './fixtures/review-bench/make-case.js'
import { bodyWithKeyAt, DUMMY_KEY, leakedFragments } from './helpers.js'

// `harness review-bench` (M8 spec §4.1, AC7) and the proof that task-bench did not change (review-record round 2, C-m6). The key is a
// dummy. The model is a local http server, so these runs go through the real model client; only the stop tests replace the bench.

const KEY_VAR = 'LITELLM_MASTER_KEY' // ends in _KEY, so the worker's redaction treats its value as a secret
const REVIEW_FLAGS = ['--case', '--config', '--configuration', '--probe-dir', '--label', '--out'] as const

type Fake = Awaited<ReturnType<typeof startFakeModelServer>>
let fake: Fake | undefined

beforeEach(() => {
  vi.stubEnv(KEY_VAR, DUMMY_KEY)
})
afterEach(async () => {
  vi.doUnmock('../src/bench/review-bench.js')
  vi.doUnmock('../src/bench/task-bench.js')
  vi.resetModules()
  await fake?.close()
  fake = undefined
  cleanupBenchFixtures() // also puts the stubbed env back
})

/** Runs main() (or the `run` given, for a freshly imported cli.ts) with stdout and stderr captured. */
async function runMain(args: string[], run: typeof main = main): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const code = await run(args)
    // Read the calls before mockRestore, which resets them.
    return { code, stdout: out.mock.calls.map((c) => String(c[0])).join(''), stderr: err.mock.calls.map((c) => String(c[0])).join('') }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

/** A fresh cli.ts whose bench modules, when given, are those stand-ins. */
async function freshMain(mocks: { reviewBench?: () => unknown; taskBench?: () => unknown } = {}): Promise<typeof main> {
  vi.resetModules()
  if (mocks.reviewBench) vi.doMock('../src/bench/review-bench.js', mocks.reviewBench)
  if (mocks.taskBench) vi.doMock('../src/bench/task-bench.js', mocks.taskBench)
  return (await import('../src/cli.js')).main
}

const firstLine = (text: string): string => text.split('\n')[0]

// ---- the files of one call ----

type Files = { made: MadeCase; dir: string; config: string; probes: string; out: string }

/**
 * A case, a worker config that points at `baseUrl`, and an accepted probe for its configuration, in one tmp dir. The config is written
 * before the probe is seeded: the probe holds the hash of the config and its LiteLLM address.
 */
function setup(baseUrl: string): Files {
  const dir = benchTmp('cli-review')
  const made = makeCase()
  const config = join(dir, 'harness.json')
  writeFileSync(config, JSON.stringify(workerConfigInput({}, baseUrl)))
  const probes = join(dir, 'probes')
  seedProbesForConfigFile(config, probes)
  // The premise of a run that gets past the gate: seedProbesForConfigFile leaves a config that does not load alone, in silence.
  expect(existsSync(join(probeDir(probes, TEST_CONFIGURATION), 'probe.json'))).toBe(true)
  return { made, dir, config, probes, out: join(dir, 'runs') }
}

/** The review-bench arguments; `without` leaves one flag out, `label` and `extra` change or add. */
function args(f: Files, o: { without?: string; label?: string; configuration?: string; extra?: string[]; keyVar?: string | null } = {}): string[] {
  const flags: Array<[string, string]> = [
    ['--case', f.made.dir],
    ['--config', f.config],
    ['--configuration', o.configuration ?? TEST_CONFIGURATION],
    ['--probe-dir', f.probes],
    ['--label', o.label ?? 'dummy-or'],
    ['--out', f.out],
  ]
  const key: Array<[string, string]> = o.keyVar === null ? [] : [['--api-key-env', o.keyVar ?? KEY_VAR]]
  return ['review-bench', ...[...flags, ...key].filter(([flag]) => flag !== o.without).flat(), ...(o.extra ?? [])]
}

/** The one run dir under `out`, and its name. */
function onlyRunDir(out: string): { dir: string; name: string } {
  const names = readdirSync(out)
  expect(names).toHaveLength(1)
  return { dir: join(out, names[0]), name: names[0] }
}

const readResult = (runDir: string) => JSON.parse(readFileSync(join(runDir, 'bench-result.json'), 'utf8')) as Record<string, unknown>

const VALID_RESULT = JSON.parse(readFileSync(new URL('./fixtures/review-bench/valid-result.json', import.meta.url), 'utf8')) as Record<string, unknown>

describe('harness review-bench — usage', () => {
  it('is in the usage text', async () => {
    const { code, stdout } = await runMain(['--help'])
    expect(code).toBe(0)
    expect(stdout).toContain(
      'harness review-bench --case <dir> --config <harness.json> --configuration <name> --probe-dir <dir> --label <label> --out <dir> --api-key-env <VAR>',
    )
  })

  it.each(REVIEW_FLAGS)('needs %s: a usage error with the exact text, exit 1, no request and no run dir', async (flag) => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    const { code, stdout, stderr } = await runMain(args(f, { without: flag }))
    expect(code).toBe(1)
    expect(firstLine(stderr)).toBe(`review-bench needs ${flag}`)
    expect(stderr).toContain('Usage:')
    expect(stdout).toBe('')
    expect(fake.requests).toHaveLength(0)
    expect(existsSync(f.out)).toBe(false)
  })

  it('needs --api-key-env', async () => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    const { code, stdout, stderr } = await runMain(args(f, { keyVar: null }))
    expect(code).toBe(1)
    expect(firstLine(stderr)).toBe('review-bench needs --api-key-env')
    expect(stderr).toContain('Usage:')
    expect(stdout).toBe('')
    expect(fake.requests).toHaveLength(0)
    expect(existsSync(f.out)).toBe(false)
  })

  it('holds the key to the rules of the worker: a name that is no secret name is refused, so is a variable that is not set', async () => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    vi.stubEnv('HARNESS_PLAIN', DUMMY_KEY)
    const plain = await runMain(args(f, { keyVar: 'HARNESS_PLAIN' }))
    expect(plain.code).toBe(1)
    expect(plain.stderr).toContain('--api-key-env: HARNESS_PLAIN does not look like a secret name')
    const unset = await runMain(args(f, { keyVar: 'HARNESS_UNSET_MASTER_KEY' }))
    expect(unset.code).toBe(1)
    expect(unset.stderr).toContain('--api-key-env: environment variable HARNESS_UNSET_MASTER_KEY is not set or empty')
    expect(fake.requests).toHaveLength(0)
    expect(existsSync(f.out)).toBe(false)
  })

  it('refuses a label that is not one plain path segment, with the message of task-bench, before any request or run dir', async () => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    const { code, stdout, stderr } = await runMain(args(f, { label: 'a/b' }))
    expect(code).toBe(1)
    expect(firstLine(stderr)).toBe(`--label must be one plain path segment (letters, digits, '.', '_' and '-'): "a/b"`)
    expect(stderr).toContain('Usage:')
    expect(stdout).toBe('')
    expect(fake.requests).toHaveLength(0)
    expect(existsSync(f.out)).toBe(false)
  })

  it('refuses --extra-body-file and points at the configuration in --config', async () => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    const { code, stderr } = await runMain(args(f, { extra: ['--extra-body-file', join(f.dir, 'extra.json')] }))
    expect(code).toBe(1)
    expect(firstLine(stderr)).toBe(
      '--extra-body-file only applies to harness probe; for harness review-bench put extraBody in the configuration in --config (extraBody)',
    )
    expect(stderr).toContain('Usage:')
    expect(fake.requests).toHaveLength(0)
    expect(existsSync(f.out)).toBe(false)
  })

  it('exits 1 with the message when the config cannot be read, and makes no run dir', async () => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    const missing = join(f.dir, 'missing.json')
    const argv = args(f)
    argv[argv.indexOf(f.config)] = missing
    const { code, stderr } = await runMain(argv)
    expect(code).toBe(1)
    expect(stderr).toContain(`cannot read worker config ${missing}`)
    expect(fake.requests).toHaveLength(0)
    expect(existsSync(f.out)).toBe(false)
  })
})

describe('harness task-bench — texts stay byte-equal (C-m6)', () => {
  const TASK_FLAGS = ['--case', '--model-config', '--task-config', '--label', '--out'] as const
  const flagArgs = (without?: string): string[] =>
    ['task-bench', ...TASK_FLAGS.filter((flag) => flag !== without).flatMap((flag) => [flag, 'x'])]

  it('keeps the stop message exactly as it was', () => {
    expect(TASK_BENCH_STOP_MESSAGE).toBe('task-bench stopt: containers worden opgeruimd (nogmaals Ctrl-C = direct afbreken)\n')
  })

  it.each(TASK_FLAGS)('answers a missing %s with exactly "task-bench needs <flag>"', async (flag) => {
    const { code, stdout, stderr } = await runMain(flagArgs(flag))
    expect(code).toBe(1)
    expect(firstLine(stderr)).toBe(`task-bench needs ${flag}`)
    expect(stderr).toContain('Usage:')
    expect(stdout).toBe('')
  })

  it('answers a task-bench without --case with exactly "task-bench needs --case", also without any other flag', async () => {
    const { code, stderr } = await runMain(['task-bench'])
    expect(code).toBe(1)
    expect(firstLine(stderr)).toBe('task-bench needs --case')
  })

  it('keeps the message of --check-case, which shares requiredValues', async () => {
    const { code, stderr } = await runMain(['task-bench', '--check-case', '--task-config', 'x', '--out', 'x'])
    expect(code).toBe(1)
    expect(firstLine(stderr)).toBe('task-bench needs --case')
  })

  // The files of a task-bench call, valid enough to reach the (replaced) bench. The same content as in __tests__/cli.test.ts.
  function taskBenchFiles(): { case: string; model: string; task: string; out: string } {
    const dir = benchTmp('cli-task-bench')
    const write = (name: string, content: unknown): string => {
      const p = join(dir, name)
      writeFileSync(p, JSON.stringify(content))
      return p
    }
    return {
      case: write('case.json', {
        id: 'AH-01',
        repo_url: 'https://example.invalid/agent-harness.git',
        base_commit: 'a1b2c3d4e5'.repeat(4),
        ref_commit: 'f6e5d4c3b2'.repeat(4),
        task: { code: 'T-42', title: 'feat: voeg greet() toe', description: 'Voeg een functie greet toe.', implementation_plan: null },
        story: { title: 'Begroeting', description: null, acceptance_criteria: null },
        hidden_tests: ['__tests__/greet.test.ts'],
        lines: 42,
        kind: 'feat',
      }),
      model: write('model.json', { baseUrl: 'http://127.0.0.1:11434/v1', name: 'qwen3.8-test' }),
      task: write('task.json', {
        limits: { maxTurns: 40, maxOutputTokens: 80000, maxWallSeconds: 2400, maxToolErrors: 8, contextTokens: 65536 },
        image: 'node:24-bookworm',
        uid: 1000,
        gid: 1000,
        npmCacheDir: '/var/lib/agent-harness/npm-cache',
        recipes: [{ repoUrl: 'https://example.invalid/agent-harness.git', prepare: ['npm ci'], verify: 'npm test' }],
      }),
      out: join(dir, 'runs'),
    }
  }

  // The handler is the CLI's own: the test calls it directly, and leaves the ones of the test runner alone.
  it.each([
    ['a run', (f: ReturnType<typeof taskBenchFiles>) => ['task-bench', '--case', f.case, '--model-config', f.model, '--task-config', f.task, '--label', 'test', '--out', f.out]],
    ['a --check-case', (f: ReturnType<typeof taskBenchFiles>) => ['task-bench', '--check-case', '--case', f.case, '--task-config', f.task, '--out', f.out]],
  ])('writes exactly the old stop message on SIGINT during %s', async (_name, build) => {
    const f = taskBenchFiles()
    let release!: () => void
    const finish = new Promise<void>((resolve) => (release = resolve))
    let seen: AbortSignal | undefined
    const stopped = async (o: { signal: AbortSignal }) => {
      seen = o.signal
      await finish
      return { caseId: 'AH-01', runId: 'AH-01-test-0a1b2c3d', status: 'benchfout', ok: true, problems: [] }
    }
    const run = await freshMain({ taskBench: () => ({ runTaskBench: stopped, checkCase: stopped }) })
    const before = new Set(process.listeners('SIGINT'))
    const running = runMain(build(f), run)
    await vi.waitFor(() => expect(seen).toBeDefined())
    const mine = process.listeners('SIGINT').filter((l) => !before.has(l))
    expect(mine).toHaveLength(1)
    mine[0]('SIGINT')
    expect(seen?.aborted).toBe(true)
    release()
    const { stderr } = await running
    expect(stderr).toBe('task-bench stopt: containers worden opgeruimd (nogmaals Ctrl-C = direct afbreken)\n')
  })
})

describe('harness review-bench — the stop message and the signal', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('aborts the signal of the run on %s, says so in its own words, and removes its handlers', async (name) => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    let release!: () => void
    const finish = new Promise<void>((resolve) => (release = resolve))
    let seen: AbortSignal | undefined
    const runReviewBench = vi.fn(async (o: { signal: AbortSignal }) => {
      seen = o.signal
      await finish
      return { status: 'benchfout', runId: 'synthetic-review-dummy-or-0a1b2c3d' }
    })
    const run = await freshMain({ reviewBench: () => ({ runReviewBench }) })
    const before = new Set(process.listeners(name))
    const running = runMain(args(f), run)
    await vi.waitFor(() => expect(seen).toBeDefined())
    const mine = process.listeners(name).filter((l) => !before.has(l))
    expect(mine).toHaveLength(1)
    expect(seen?.aborted).toBe(false)

    mine[0](name)
    expect(seen?.aborted).toBe(true)
    release()
    const { code, stdout, stderr } = await running
    expect(code).toBe(0)
    expect(stderr).toBe('review-bench stopt: de run wordt afgebroken (nogmaals Ctrl-C = direct afbreken)\n')
    expect(stdout).toBe(`benchfout ${join(f.out, 'synthetic-review-dummy-or-0a1b2c3d')}\n`)
    expect(process.listeners(name).filter((l) => !before.has(l))).toHaveLength(0)
  })

  it('hands the bench what the flags say: the loaded config, the configuration, the probe dir, the label, the out dir and the key', async () => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    const runReviewBench = vi.fn(async (_o: unknown) => ({ status: 'beoordeeld', runId: 'synthetic-review-dummy-or-0a1b2c3d' }))
    const run = await freshMain({ reviewBench: () => ({ runReviewBench }) })
    const { code, stdout } = await runMain(args(f), run)
    expect(code).toBe(0)
    expect(stdout).toBe(`beoordeeld ${join(f.out, 'synthetic-review-dummy-or-0a1b2c3d')}\n`)
    expect(runReviewBench.mock.calls[0][0]).toMatchObject({
      caseDir: f.made.dir,
      configuration: TEST_CONFIGURATION,
      probeDir: f.probes,
      label: 'dummy-or',
      out: f.out,
      apiKey: DUMMY_KEY,
      config: { litellm: { baseUrl: fake.baseUrl } },
    })
  })

  it('does not swallow a failure of the run itself: there is no result file, so main throws', async () => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    const run = await freshMain({ reviewBench: () => ({ runReviewBench: vi.fn(async () => Promise.reject(new Error('run dir already exists: x'))) }) })
    const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') }
    await expect(runMain(args(f), run)).rejects.toThrow('run dir already exists: x')
    expect({ SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') }).toEqual(before)
  })
})

describe('harness review-bench — runs (AC7)', () => {
  it('keeps the key out of stdout, stderr, trace.jsonl and bench-result.json when the server echoes it in an error body', async () => {
    fake = await startFakeModelServer([{ status: 400, body: bodyWithKeyAt(190, (p) => JSON.stringify({ error: { message: p } })) }])
    const f = setup(fake.baseUrl)
    const { code, stdout, stderr } = await runMain(args(f))

    // The premises: the run did reach the server, once (a 400 is not transient), with the key; it ended as a bench failure of the model call.
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${DUMMY_KEY}`)
    expect(code).toBe(0) // bench-result.json is written, whatever the status
    const { dir, name } = onlyRunDir(f.out)
    expect(stdout).toBe(`benchfout ${dir}\n`)
    const resultText = readFileSync(join(dir, 'bench-result.json'), 'utf8')
    const traceText = readFileSync(join(dir, 'trace.jsonl'), 'utf8')
    expect(readResult(dir)).toMatchObject({ status: 'benchfout', error: { code: 'MODEL_ERROR' } })
    expect(resultText).toContain('<redacted>') // the error did carry the key once
    expect(name).toMatch(/^synthetic-review-dummy-or-[0-9a-f]{8}$/)

    expect(leakedFragments(stdout), 'stdout').toEqual([])
    expect(leakedFragments(stderr), 'stderr').toEqual([])
    expect(leakedFragments(traceText), 'trace.jsonl').toEqual([])
    expect(leakedFragments(resultText), 'bench-result.json').toEqual([])
  })

  it('accepts a label with a dot, and runs the review end to end: a valid answer gives beoordeeld, exit 0 and the line "<status> <run-dir>"', async () => {
    fake = await startFakeModelServer([{ body: completion({ content: JSON.stringify(VALID_RESULT) }) }])
    const f = setup(fake.baseUrl)
    const { code, stdout, stderr } = await runMain(args(f, { label: 'claude-sonnet-5.5-or' }))
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(fake.requests).toHaveLength(1)
    const { dir, name } = onlyRunDir(f.out)
    expect(name).toMatch(/^synthetic-review-claude-sonnet-5\.5-or-[0-9a-f]{8}$/)
    expect(stdout).toBe(`beoordeeld ${dir}\n`)
    expect(readResult(dir)).toMatchObject({ status: 'beoordeeld', label: 'claude-sonnet-5.5-or', runId: name })
  })

  it('exits 0 for a run that the gate refused: the result file is there, whatever the status', async () => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    const { code, stdout } = await runMain(args(f, { configuration: 'no-such-configuration' }))
    expect(code).toBe(0)
    expect(fake.requests).toHaveLength(0)
    const { dir } = onlyRunDir(f.out)
    expect(stdout).toBe(`benchfout ${dir}\n`)
    expect(readResult(dir)).toMatchObject({ status: 'benchfout', benchError: expect.stringContaining('CONFIGURATION_NOT_PROBED') })
  })

  it('answers a case that cannot be used with the message on stderr and exit 1, before any request or run dir', async () => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    f.made.flipByte('sources/doc')
    const { code, stdout, stderr } = await runMain(args(f))
    expect(code).toBe(1)
    expect(stderr).toMatch(/^CASE_INVALID: sources\/doc: sha256 wijkt af/)
    expect(stderr).not.toContain('Usage:') // it is no wrong invocation
    expect(stdout).toBe('')
    expect(fake.requests).toHaveLength(0)
    expect(existsSync(f.out)).toBe(false)
  })

  it('masks the key in the line it prints on stdout: an out dir named like the key stays out of "<status> <run-dir>"', async () => {
    fake = await startFakeModelServer([{ status: 400, body: { error: { message: 'bad request' } } }])
    const f = setup(fake.baseUrl)
    // Only the CLI can mask this: the run dir holds the key in its path, not in anything the bench writes.
    const out = join(f.dir, DUMMY_KEY)
    const argv = args(f)
    argv[argv.indexOf(f.out)] = out
    const { code, stdout, stderr } = await runMain(argv)
    expect(code).toBe(0)
    const { dir } = onlyRunDir(out)
    expect(dir).toContain(DUMMY_KEY) // the premise: the real path holds the key
    expect(readResult(dir)).toMatchObject({ status: 'benchfout' })
    expect(stdout).toMatch(/^benchfout .*\*\*\*.*\n$/)
    expect(leakedFragments(stdout), 'stdout').toEqual([])
    expect(leakedFragments(stderr), 'stderr').toEqual([])
  })

  it('masks the key in the usage error of a rejected label: a label that holds the key and a "/" stays out of stderr', async () => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    const { code, stdout, stderr } = await runMain(args(f, { label: `${DUMMY_KEY}/x` }))
    expect(code).toBe(1)
    expect(firstLine(stderr)).toBe(`--label must be one plain path segment (letters, digits, '.', '_' and '-'): "***/x"`)
    expect(stderr).toContain('Usage:')
    expect(leakedFragments(stderr), 'stderr').toEqual([])
    expect(stdout).toBe('')
    expect(fake.requests).toHaveLength(0)
    expect(existsSync(f.out)).toBe(false)
  })

  it('masks the key in an error that main rethrows: an out dir named like the key that cannot be made stays out of its message', async () => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    // A file where the out dir has to be made: the run dir cannot be created, and the error of the file system names the path.
    const blocker = join(f.dir, 'blocker')
    writeFileSync(blocker, 'x')
    const argv = args(f)
    argv[argv.indexOf(f.out)] = join(blocker, DUMMY_KEY)
    const failure = await runMain(argv).then(
      () => undefined,
      (err: unknown) => err,
    )
    // The premises: main did not turn it into an exit code, and the error is the file system's, with the path in it.
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toMatch(/^[A-Z]+: .*\*\*\*/)
    expect(message).toContain(blocker)
    expect(leakedFragments(message), 'the message that the entrypoint prints').toEqual([])
    expect(fake.requests).toHaveLength(0)
  })

  it('masks the key in the message it prints on stderr: the name of a file that the case names stays out of CASE_INVALID', async () => {
    fake = await startFakeModelServer([])
    const f = setup(fake.baseUrl)
    f.made.editCase((c) => {
      c.prompt.file = DUMMY_KEY // a file that is not there: the message repeats the name
    })
    const { code, stdout, stderr } = await runMain(args(f))
    expect(code).toBe(1)
    expect(stderr).toMatch(/^CASE_INVALID: \*\*\*: /)
    expect(leakedFragments(stderr), 'stderr').toEqual([])
    expect(stdout).toBe('')
    expect(fake.requests).toHaveLength(0)
  })
})
