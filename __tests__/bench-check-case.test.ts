import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BenchCaseSchema, type BenchCase } from '../src/bench/case.js'
import { hiddenCheckScript } from '../src/bench/hidden-check.js'
import { analyseRefDiff, checkCase, failsForReal, type CaseCheck } from '../src/bench/task-bench.js'
import { createWorkspace, restoreForHiddenCheck, type Workspace } from '../src/bench/workspace.js'
import type { TaskConfig } from '../src/worker/config.js'
import { buildScript, type SpawnFn } from '../src/worker/containers.js'
import type { VerifyRun } from '../src/worker/task-tools.js'
import { benchCaseFor, benchTaskConfigFor } from './fakes/bench-case.js'
import { benchTmp, cleanupBenchFixtures, createBenchRepo, disposeBenchRepo, fixtureGit, type BenchRepo } from './fakes/bench-repo.js'
import { fakeDocker, type DockerStep, type FakeDockerOptions } from './fakes/fake-docker.js'
import { allFiles, readTrace } from './helpers.js'

// The order of everything that touches a work tree: host git (the clones, the two diffs, the restore), the scans of the git
// administration, and the containers. `restoreForHiddenCheck` runs its own git inside workspace.ts, so a 'git ...' entry is a diff
// of checkCase and 'restore' is the whole restore.
const { timeline } = vi.hoisted(() => ({ timeline: [] as string[] }))
vi.mock('../src/bench/workspace.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/bench/workspace.js')>()
  const traced = <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    vi.fn((...args: A): R => {
      timeline.push(name)
      return fn(...args)
    })
  return {
    ...actual,
    createWorkspace: traced('clone', actual.createWorkspace),
    snapshotAdmin: traced('snapshot', actual.snapshotAdmin),
    assertAdminUnchanged: traced('scan', actual.assertAdminUnchanged),
    restoreForHiddenCheck: traced('restore', actual.restoreForHiddenCheck),
    git: vi.fn((ws: Workspace, args: string[]) => {
      timeline.push(`git ${args.slice(0, 3).join(' ')}`)
      return actual.git(ws, args)
    }),
  }
})

let standardRoot: string | undefined
beforeEach(() => {
  timeline.length = 0
  vi.clearAllMocks()
})
afterEach(() => cleanupBenchFixtures())
afterAll(() => {
  disposeBenchRepo()
  if (standardRoot) rmSync(standardRoot, { recursive: true, force: true })
})

// ---- what the fake containers do ----

const A_TEST = '__tests__/a.test.ts'
const B_TEST = '__tests__/b.test.ts'

/**
 * What vitest's JSON reporter writes for one test file. The shapes are those of a real vitest 5.0.2 run: a file that cannot be
 * imported (the hidden test of a new module, on the commit before the module existed) has status "failed" and no test at all.
 */
type Outcome = 'passed' | 'skipped' | 'assertion-failed' | 'import-error'
function fileResult(work: string, file: string, outcome: Outcome) {
  const name = join(work, file)
  switch (outcome) {
    case 'passed':
      return { name, status: 'passed', assertionResults: [{ status: 'passed' }] }
    case 'skipped':
      return { name, status: 'passed', assertionResults: [{ status: 'skipped' }] }
    case 'assertion-failed':
      return { name, status: 'failed', assertionResults: [{ status: 'failed' }, { status: 'passed' }] }
    case 'import-error':
      return { name, status: 'failed', assertionResults: [], message: `Cannot find module '../src/y.js' imported from ${name}` }
  }
}
function writeReport(work: string, content: unknown): void {
  mkdirSync(join(work, '.task-bench'), { recursive: true })
  writeFileSync(join(work, '.task-bench/hidden.json'), JSON.stringify(content))
}
/** A hidden-check container that ends with `code` and leaves a report with these outcomes per file. */
const hiddenStep = (code: number | null, outcomes: Record<string, Outcome>): DockerStep => ({
  code,
  effect: ({ work }) => writeReport(work, { testResults: Object.entries(outcomes).map(([file, outcome]) => fileResult(work, file, outcome)) }),
})

/** The case on A (with the tests of B): a.test.ts passes, b.test.ts cannot import src/y.ts. On B both pass. */
const ON_BASE = hiddenStep(1, { [A_TEST]: 'passed', [B_TEST]: 'import-error' })
const ON_REF = hiddenStep(0, { [A_TEST]: 'passed', [B_TEST]: 'passed' })
const VALID: FakeDockerOptions = { hidden: [ON_BASE, ON_REF] }
const RED: DockerStep = { code: 1, out: 'FAIL a.test.ts' }

/** What a hostile prepare or test run does: it points the git file of the submodule somewhere else. */
const rewritesPointer = (path: string): DockerStep => ({ effect: ({ work }) => writeFileSync(join(work, path, '.git'), 'gitdir: /elsewhere\n') })
/** A container that hangs until the stop comes, a moment after it started. */
const hangsUntil = (stop: AbortController): DockerStep => ({
  hang: true,
  onStart: () => {
    setTimeout(() => stop.abort(), 20)
  },
})
const quickTimeout = (task: TaskConfig) => {
  task.verifyTimeoutSeconds = 0.1 // only for a test that needs a time-out: any other container is done long before
}

// ---- origins ----

type Origin = Pick<BenchRepo, 'url' | 'a' | 'b'>

/** Commit A of the origins built here; the fixture repo's A, without its submodule. */
const A_FILES: Record<string, string> = {
  'src/x.ts': 'export const x = 1\n',
  [A_TEST]: "import { expect, it } from 'vitest'\nimport { x } from '../src/x.js'\n\nit('x is 1', () => {\n  expect(x).toBe(1)\n})\n",
  'vitest.config.ts': "import { defineConfig } from 'vitest/config'\n\nexport default defineConfig({})\n",
  'package.json': '{ "name": "origin" }\n',
  'tsconfig.json': '{}\n',
}
/** Commit B: what the fixture repo's B does (11 lines more), on top of A. */
const B_FILES: Record<string, string> = {
  'src/y.ts': 'export const y = 2\n',
  [A_TEST]: `${A_FILES[A_TEST]}\nit('x is not 2', () => {\n  expect(x).not.toBe(2)\n})\n`,
  [B_TEST]: "import { expect, it } from 'vitest'\nimport { y } from '../src/y.js'\n\nit('y is 2', () => {\n  expect(y).toBe(2)\n})\n",
}

/** A repo in `root` with commit A and commit B; `change` is applied to B (a string writes the file, null deletes it). Real git. */
async function buildOrigin(root: string, change: Record<string, string | null>): Promise<Origin> {
  mkdirSync(root, { recursive: true })
  const put = (files: Record<string, string | null>) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) rmSync(join(root, path), { force: true })
      else {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), content)
      }
    }
  }
  await fixtureGit(root, ['init', '-q'])
  put(A_FILES)
  await fixtureGit(root, ['add', '-A'])
  await fixtureGit(root, ['commit', '-q', '-m', 'A'])
  const a = await fixtureGit(root, ['rev-parse', 'HEAD'])
  put({ ...B_FILES, ...change })
  await fixtureGit(root, ['add', '-A'])
  await fixtureGit(root, ['commit', '-q', '-m', 'B'])
  const b = await fixtureGit(root, ['rev-parse', 'HEAD'])
  return { url: `file://${root}`, a, b }
}

let standard: Promise<Origin> | undefined
/**
 * The origin of most tests: the fixture repo without its submodule, built once per file. A check makes two clones, and a clone with
 * a submodule costs half as much again; only the tests about the submodule pointer need the real fixture.
 */
async function standardOrigin(): Promise<Origin> {
  await createBenchRepo() // stubs the git environment of this test (identity, `file` transport)
  standardRoot ??= mkdtempSync(join(tmpdir(), 'bench-check-origin-'))
  standard ??= buildOrigin(join(standardRoot, 'standard'), {})
  return standard
}
/** An origin of its own, for a test that needs another commit B. It goes with the test. */
async function originWith(change: Record<string, string | null>): Promise<Origin> {
  await createBenchRepo()
  return buildOrigin(benchTmp('origin'), change)
}

// ---- the check under test ----

type Setup = {
  /** An origin of its own. */
  origin?: Origin
  /** The shared fixture repo, with its submodule, instead of the standard origin. */
  fixture?: boolean
  case?: Partial<BenchCase>
  task?: Record<string, unknown>
  /** Applied to the parsed task config, for what the schema cannot say: a container timeout in fractions of a second. */
  tune?: (task: TaskConfig) => void
  docker?: FakeDockerOptions
  signal?: AbortSignal
}

/**
 * After the first container, host git may only be the restore, and only straight behind a scan of the git administration (plan,
 * "Host-git in de bench"). Every run through `start()` is held to this, whatever the test is about.
 */
function expectGitOnlyBehindTheScan(): void {
  const first = timeline.findIndex((entry) => entry.startsWith('docker '))
  if (first === -1) return
  const after = timeline.slice(first)
  after.forEach((entry, i) => {
    if (entry.startsWith('docker ') || entry === 'scan') return
    expect(entry, 'host git after a container').toBe('restore')
    expect(after[i - 1], 'the restore follows a scan, with no container in between').toBe('scan')
  })
}

/** Everything for one check, with the check itself still to be started: a test that stops it from outside needs the time in between. */
async function start(s: Setup = {}) {
  const fixture = await createBenchRepo()
  const repo: Origin = s.origin ?? (s.fixture ? fixture : await standardOrigin())
  const task = benchTaskConfigFor(repo as BenchRepo, s.task)
  s.tune?.(task)
  const docker = fakeDocker(s.docker ?? VALID)
  const spawn: SpawnFn = (cmd, args, opts) => {
    if (args[0] === 'run') {
      const name = (args[args.indexOf('--name') + 1] ?? '').replace(/^harness-[0-9a-f]{8}-/, '') // 'prepare-1'
      timeline.push(`docker ${name} ${basename(dirname(args[args.indexOf('-w') + 1] ?? ''))}`) // …and 'ws-base' or 'ws-ref'
    }
    return docker.spawn(cmd, args, opts)
  }
  const out = benchTmp('out')
  const benchCase = benchCaseFor(repo as BenchRepo, { hidden_tests: [A_TEST, B_TEST], ...s.case })
  const run = async () => {
    timeline.length = 0
    const result = await checkCase({
      case: benchCase,
      task,
      out,
      signal: s.signal,
      deps: { containerDeps: { spawn, killGraceMs: 20, cleanupTimeoutMs: 500, pollIntervalMs: 10 } },
    })
    expectGitOnlyBehindTheScan()
    return result
  }
  return { task, docker, out, benchCase, run }
}

/** The one check dir in `out`, its case-check.json as it lies on disk, and the hex8 of the container names. */
function savedCheck(out: string) {
  const names = readdirSync(out)
  expect(names).toHaveLength(1)
  const name = names[0] ?? ''
  const dir = join(out, name)
  return { dir, name, hex8: name.slice(-8), saved: JSON.parse(readFileSync(join(dir, 'case-check.json'), 'utf8')) as CaseCheck }
}

/** One check to the end. */
async function check(s: Setup = {}) {
  const t = await start(s)
  const result = await t.run()
  return { ...t, result, ...savedCheck(t.out) }
}

/** The containers a check started, as [purpose, work tree]. */
const containersOf = (t: { docker: ReturnType<typeof fakeDocker> }) => t.docker.runs.map((r) => [r.purpose, basename(dirname(r.work))])

describe('checkCase — a valid case', () => {
  // One run on the fixture repo, looked at from four sides. The dirs of a run go after the first test, so what the tests look at is
  // taken from the run here.
  type Valid = Awaited<ReturnType<typeof check>>
  let v: Valid
  let events: Array<Record<string, unknown>>
  let order: string[]
  const seen: Record<string, boolean> = {}
  beforeAll(async () => {
    const probe =
      (label: string): NonNullable<DockerStep['onStart']> =>
      ({ work }) => {
        seen[`${label}: the tests of B`] = existsSync(join(work, B_TEST))
        seen[`${label}: the source of B`] = existsSync(join(work, 'src/y.ts'))
      }
    v = await check({
      fixture: true,
      docker: { verify: [{ onStart: probe('verify on A') }], hidden: [{ ...ON_BASE, onStart: probe('hidden on A') }, { ...ON_REF, onStart: probe('hidden on B') }] },
    })
    events = readTrace(v.dir).filter((e) => e.type === 'container')
    order = [...timeline]
  })

  it('is ok: verify green on A, a hidden test that really fails on A, and passes on B', () => {
    expect(v.result).toMatchObject({ caseId: 'AH-01', ok: true, baseVerifyGreen: true, refChangesRunnerConfig: false, hiddenMatchesRef: true, lines: 11, problems: [] })
    // HiddenResult counts tests only: the file that fails to import has none, and its failure is only its status in vitest's JSON.
    expect(v.result.hiddenOnBase).toMatchObject({
      pass: false,
      files: [
        { file: A_TEST, ran: true, passed: 1, failed: 0, other: 0 },
        { file: B_TEST, ran: true, passed: 0, failed: 0, other: 0 },
      ],
    })
    expect(v.result.hiddenOnRef).toMatchObject({
      pass: true,
      files: [
        { file: A_TEST, ran: true, passed: 1, failed: 0, other: 0 },
        { file: B_TEST, ran: true, passed: 1, failed: 0, other: 0 },
      ],
    })
  })

  it('writes <out>/<case id>-check-<hex8>/case-check.json with exactly the fields of the contract, and returns the same object', () => {
    expect(v.name).toMatch(/^AH-01-check-[0-9a-f]{8}$/)
    expect(v.saved).toEqual(JSON.parse(JSON.stringify(v.result)))
    expect(Object.keys(v.saved).sort()).toEqual(
      ['baseVerifyGreen', 'caseId', 'hiddenMatchesRef', 'hiddenOnBase', 'hiddenOnRef', 'lines', 'ok', 'problems', 'refChangesRunnerConfig'].sort(),
    )
  })

  it('runs prepare and verify and the hidden check on A, then prepare and the hidden check on B, each on its own clone', () => {
    expect(containersOf(v)).toEqual([
      ['prepare', 'ws-base'],
      ['verify', 'ws-base'],
      ['hidden', 'ws-base'],
      ['prepare', 'ws-ref'],
      ['hidden', 'ws-ref'],
    ])
    expect(v.docker.runs.map((r) => r.name)).toEqual(['prepare-1', 'verify-2', 'verify-3', 'prepare-4', 'verify-5'].map((n) => `harness-${v.hex8}-${n}`))
    const hiddenScript = buildScript([hiddenCheckScript([A_TEST, B_TEST])])
    expect(v.docker.runs.map((r) => r.script)).toEqual([buildScript(['npm ci']), buildScript(['npm test']), hiddenScript, buildScript(['npm ci']), hiddenScript])
    expect(events.map((e) => [e.kind, e.source, e.n])).toEqual([
      ['prepare', 'prepare', 1],
      ['verify', 'gate', 2],
      ['verify', 'hidden_check', 3],
      ['prepare', 'prepare', 4],
      ['verify', 'hidden_check', 5],
    ])
  })

  it('does all its host git before the first container, except the restore behind its scan', () => {
    expect(order).toEqual([
      'clone',
      'snapshot', // right after the clone, before any container
      'git diff --no-renames --name-status',
      'git diff --no-renames --shortstat',
      'clone', // the second clone is made before the first container too
      'snapshot',
      'docker prepare-1 ws-base',
      'docker verify-2 ws-base',
      'scan',
      'restore',
      'docker verify-3 ws-base',
      'docker prepare-4 ws-ref',
      'scan',
      'docker verify-5 ws-ref',
    ])
  })

  it('puts the tests and runner config of B on A before the hidden check there, and nothing else of B', () => {
    expect(seen).toEqual({
      'verify on A: the tests of B': false, // A has no b.test.ts
      'verify on A: the source of B': false,
      'hidden on A: the tests of B': true, // restored from B
      'hidden on A: the source of B': false, // the solution itself is not
      'hidden on B: the tests of B': true,
      'hidden on B: the source of B': true,
    })
  })

  it('runs no prepare container when the recipe has no prepare commands', async () => {
    const repo = await standardOrigin()
    const t = await check({ task: { recipes: [{ repoUrl: repo.url, prepare: [], verify: 'npm test' }] } })
    expect(t.result.ok).toBe(true)
    expect(containersOf(t)).toEqual([
      ['verify', 'ws-base'],
      ['hidden', 'ws-base'],
      ['hidden', 'ws-ref'],
    ])
  })
})

describe('checkCase — A, the base commit', () => {
  it('is not ok when verify is red on A', async () => {
    const t = await check({ docker: { ...VALID, verify: [RED] } })
    expect(t.result).toMatchObject({ ok: false, baseVerifyGreen: false, problems: ['verify rood op base_commit'] })
    expect(containersOf(t)).toHaveLength(5) // the rest of the evidence is still gathered
  })

  it('is not ok when the hidden test already passes on A', async () => {
    const t = await check({ docker: { hidden: [hiddenStep(0, { [A_TEST]: 'passed', [B_TEST]: 'passed' }), ON_REF] } })
    expect(t.result).toMatchObject({ ok: false, problems: ['verborgen test slaagt al op base_commit'] })
    expect(t.result.hiddenOnBase.pass).toBe(true)
  })

  const NOT_REAL = 'verborgen toets op base_commit zonder echte testfout'
  it.each([
    ['a runner error: the container has no exit code', { code: null }, undefined, 'docker-proces eindigde zonder exitcode'],
    ['a time-out', { hang: true }, quickTimeout, 'geen exitcode'],
    ['a report in which no hidden file failed, next to an exit code of 1', hiddenStep(1, { [A_TEST]: 'passed', [B_TEST]: 'passed' }), undefined, undefined],
  ] as Array<[string, DockerStep, ((task: TaskConfig) => void) | undefined, string | undefined]>)(
    'is not ok when the hidden check on A shows no real test failure: %s',
    async (_what, step, tune, why) => {
      const t = await check({ docker: { hidden: [step, ON_REF] }, tune })
      expect(t.result).toMatchObject({ ok: false, baseVerifyGreen: true, problems: [NOT_REAL] })
      expect(t.result.hiddenOnBase.pass).toBe(false)
      if (why) expect(t.result.hiddenOnBase.reason).toContain(why) // the reason of the verdict says why the container was no good
    },
  )

  it('is not ok when the prepare is red on A, and then runs nothing else', async () => {
    const t = await check({ docker: { ...VALID, prepare: [{ code: 1, out: 'npm ERR! ECONNRESET' }] } })
    expect(t.result).toMatchObject({ ok: false, baseVerifyGreen: false, problems: ['prepare rood op base_commit (exitcode 1)'] })
    expect(containersOf(t)).toEqual([['prepare', 'ws-base']])
    expect(timeline).not.toContain('restore')
    expect(t.result.hiddenOnBase).toMatchObject({ pass: false, reason: 'niet gedraaid', files: [{ file: A_TEST, ran: false }, { file: B_TEST, ran: false }] })
  })
})

describe('checkCase — B, the ref commit', () => {
  it('is not ok when the hidden tests do not pass on B', async () => {
    const t = await check({ docker: { hidden: [ON_BASE, hiddenStep(1, { [A_TEST]: 'passed', [B_TEST]: 'assertion-failed' })] } })
    expect(t.result).toMatchObject({ ok: false, problems: ['verborgen toets slaagt niet op ref_commit'] })
    expect(t.result.hiddenOnRef).toMatchObject({ pass: false, files: [{ file: A_TEST, passed: 1 }, { file: B_TEST, passed: 1, failed: 1 }] })
  })

  it('is not ok when the prepare is red on B, keeps the evidence of A, and runs no hidden check on B', async () => {
    const t = await check({ docker: { ...VALID, prepare: [{}, { code: 1 }] } })
    expect(t.result).toMatchObject({ ok: false, baseVerifyGreen: true, problems: ['prepare rood op ref_commit (exitcode 1)'] })
    expect(t.result.hiddenOnBase.files[1]).toMatchObject({ file: B_TEST, ran: true })
    expect(t.result.hiddenOnRef).toMatchObject({ pass: false, reason: 'niet gedraaid' })
    expect(containersOf(t)).toEqual([
      ['prepare', 'ws-base'],
      ['verify', 'ws-base'],
      ['hidden', 'ws-base'],
      ['prepare', 'ws-ref'],
    ])
  })

  it('lists the problems of all three parts in the order the check finds them', async () => {
    const t = await check({
      docker: { verify: [RED], hidden: [hiddenStep(0, { [A_TEST]: 'passed', [B_TEST]: 'passed' }), hiddenStep(1, { [A_TEST]: 'passed', [B_TEST]: 'assertion-failed' })] },
      case: { hidden_tests: [B_TEST] }, // …and a hidden_tests that does not match B either
    })
    expect(t.result.ok).toBe(false)
    expect(t.result.problems).toEqual([
      expect.stringMatching(/^hidden_tests komt niet overeen met de testbestanden die ref_commit toevoegt of wijzigt/),
      'verify rood op base_commit',
      'verborgen test slaagt al op base_commit',
      'verborgen toets slaagt niet op ref_commit',
    ])
  })
})

describe('checkCase — the diff between A and B, from real git', () => {
  it.each([
    // B replaces one line of the file (1 line in, 1 out) on top of the 11 lines of the standard B
    ['vitest.config.ts', { 'vitest.config.ts': "import { defineConfig } from 'vitest/config'\n\nexport default defineConfig({ test: {} })\n" }, 13],
    ['package.json', { 'package.json': '{ "name": "origin", "version": "2" }\n' }, 13],
    // A has neither of these: B adds a file of one line. The hidden check installs the dependencies again from the lockfile and the
    // .npmrc of B (runTaskBench), so a B that changes them changes what is installed: no new dependency (criterion 6).
    ['package-lock.json', { 'package-lock.json': '{ "lockfileVersion": 3 }\n' }, 12],
    ['.npmrc', { '.npmrc': 'registry=https://registry.invalid/\n' }, 12],
  ])('is not ok when B changes %s, and still measures B in lines', async (_name, change, lines) => {
    const t = await check({ origin: await originWith(change) })
    expect(t.result).toMatchObject({ ok: false, refChangesRunnerConfig: true, hiddenMatchesRef: true, lines, problems: ['ref_commit wijzigt de runnerconfig'] })
  })

  it('is not bothered by config-like files below the root', async () => {
    const t = await check({
      origin: await originWith({ 'sub/package.json': '{}\n', 'packages/a/tsconfig.json': '{}\n', 'tsconfig.d/x.json': '{}\n', 'sub/package-lock.json': '{}\n', 'packages/a/.npmrc': 'a=b\n' }),
    })
    expect(t.result).toMatchObject({ ok: true, refChangesRunnerConfig: false })
  })

  it('is not ok when hidden_tests lacks a test file that B changes and names one that B does not touch', async () => {
    // B changes a.test.ts and adds b.test.ts
    const t = await check({ case: { hidden_tests: [B_TEST, '__tests__/c.test.ts'] } })
    expect(t.result).toMatchObject({ ok: false, hiddenMatchesRef: false })
    expect(t.result.problems[0]).toBe(
      `hidden_tests komt niet overeen met de testbestanden die ref_commit toevoegt of wijzigt (ontbreekt: ${A_TEST}; te veel: __tests__/c.test.ts)`,
    )
  })

  it('counts a rename as a delete and an add, and never takes the deleted file as a hidden test', async () => {
    // B moves a.test.ts to c.test.ts unchanged: git's own rename detection would report that as one rename, R100
    const origin = await originWith({ [B_TEST]: null, [A_TEST]: null, '__tests__/c.test.ts': A_FILES[A_TEST] ?? '' })
    const docker = { hidden: [hiddenStep(1, { '__tests__/c.test.ts': 'import-error' }), hiddenStep(0, { '__tests__/c.test.ts': 'passed' })] }
    const t = await check({ origin, docker, case: { hidden_tests: ['__tests__/c.test.ts'] } })
    expect(t.result).toMatchObject({ ok: true, hiddenMatchesRef: true })
    // the deleted a.test.ts as a hidden test: a mismatch (the hidden check on B then cannot run it either, which is a problem of its own)
    const deleted = await check({ origin, docker, case: { hidden_tests: ['__tests__/c.test.ts', A_TEST] } })
    expect(deleted.result.hiddenMatchesRef).toBe(false)
    expect(deleted.result.problems[0]).toBe(`hidden_tests komt niet overeen met de testbestanden die ref_commit toevoegt of wijzigt (te veel: ${A_TEST})`)
  })

  it('is not ok, with no container started, when ref_commit does not exist in the repository', async () => {
    const t = await check({ case: { ref_commit: 'e'.repeat(40) } })
    expect(t.result.ok).toBe(false)
    expect(t.result.problems).toHaveLength(1)
    expect(t.result.problems[0]).toMatch(/^verschil tussen base_commit en ref_commit niet te bepalen: /)
    expect(t.docker.runs).toHaveLength(0)
    expect(timeline.filter((entry) => entry === 'clone')).toHaveLength(1) // the second clone does not follow a diff that failed
  })
})

describe('analyseRefDiff', () => {
  const nul = (...parts: string[]) => parts.join('\0') + '\0'
  const analyse = (nameStatus: string, hiddenTests: string[] = [B_TEST], shortstat = '') => analyseRefDiff({ nameStatus, shortstat, hiddenTests })

  it('takes the test files that B adds or modifies as the hidden tests of B', () => {
    const r = analyse(nul('A', B_TEST, 'M', A_TEST, 'A', 'src/y.ts'), [A_TEST, B_TEST])
    expect(r).toMatchObject({ hiddenMatchesRef: true, missing: [], extra: [] })
  })

  it('compares hidden_tests as a set: the order and a repeated entry do not matter', () => {
    expect(analyse(nul('A', B_TEST, 'M', A_TEST), [B_TEST, A_TEST, B_TEST])).toMatchObject({ hiddenMatchesRef: true })
  })

  it.each([
    ['a deleted test', nul('D', A_TEST)],
    ['a type change', nul('T', A_TEST)],
  ])('does not take %s as a hidden test', (_what, nameStatus) => {
    expect(analyse(nameStatus, [A_TEST])).toMatchObject({ hiddenMatchesRef: false, missing: [], extra: [A_TEST] })
  })

  it.each([
    ['a helper', '__tests__/helpers.ts'],
    ['a test file outside __tests__/', 'src/x.test.ts'],
    ['a test file of another language', '__tests__/x.test.js'],
    ['a file called __tests__', '__tests__'],
  ])('does not take %s as a test', (_what, path) => {
    expect(analyse(nul('A', path), [B_TEST])).toMatchObject({ missing: [], extra: [B_TEST] })
  })

  it('agrees with BenchCaseSchema on what the path of a hidden test is', () => {
    const paths = [B_TEST, '__tests__/sub/deep.test.ts', '__tests__/x.test.tsx', '__tests__/x.test.js', '__tests__/helpers.ts', 'src/x.test.ts', 'x/__tests__/y.test.ts', '__tests__/.test.ts', '__tests__.test.ts']
    for (const path of paths) {
      const inSchema = BenchCaseSchema.shape.hidden_tests.safeParse([path]).success
      const inDiff = analyse(nul('A', path), []).missing.includes(path)
      expect(inDiff, path).toBe(inSchema)
    }
  })

  it('takes a test file in a subdirectory of __tests__/', () => {
    expect(analyse(nul('A', '__tests__/sub/deep.test.ts'), ['__tests__/sub/deep.test.ts'])).toMatchObject({ hiddenMatchesRef: true })
  })

  it('lists what is missing and what is too much, sorted', () => {
    const r = analyse(nul('A', '__tests__/z.test.ts', 'A', '__tests__/m.test.ts'), ['__tests__/q.test.ts', '__tests__/b.test.ts'])
    expect(r).toMatchObject({ hiddenMatchesRef: false, missing: ['__tests__/m.test.ts', '__tests__/z.test.ts'], extra: ['__tests__/b.test.ts', '__tests__/q.test.ts'] })
  })

  it.each(['A', 'M', 'D', 'T'])('sees a change of status %s to the runner config of the root', (status) => {
    for (const name of ['vitest.config.ts', 'vitest.config.mts', 'package.json', 'package-lock.json', '.npmrc', 'tsconfig.json', 'tsconfig.build.json']) {
      expect(analyse(nul(status, name)).refChangesRunnerConfig, `${status} ${name}`).toBe(true)
    }
  })

  it.each([
    'sub/package.json',
    'packages/a/vitest.config.ts',
    'tsconfig/x.json',
    'tsconfig.d/x.json',
    'sub/package-lock.json',
    'sub/.npmrc',
    'package-lock.json.bak',
    '.npmrc.bak',
    'x.npmrc',
    'package.json.bak',
    'src/vitest.config.ts',
    'xtsconfig.json',
  ])(
    'does not take %s for the runner config',
    (path) => {
      expect(analyse(nul('M', path)).refChangesRunnerConfig).toBe(false)
    },
  )

  it('reads a path with special characters as it is, because the listing is NUL-separated and never quoted', () => {
    // git without -z writes "__tests__/\303\274n\303\257.test.ts" for this one, with the quotes
    const path = '__tests__/ünï.test.ts'
    expect(analyse(nul('A', path), [path])).toMatchObject({ hiddenMatchesRef: true })
  })

  it('reads an empty listing as no change', () => {
    expect(analyse('', [B_TEST])).toMatchObject({ refChangesRunnerConfig: false, hiddenMatchesRef: false, missing: [], extra: [B_TEST] })
  })

  it('refuses a listing that is not pairs of a status and a path', () => {
    expect(() => analyse('A\0__tests__/b.test.ts\0M\0')).toThrow(/name-status/)
  })

  it.each([
    ['nothing', '', 0],
    ['insertions and deletions', ' 2 files changed, 10 insertions(+), 3 deletions(-)\n', 13],
    ['insertions only (git leaves the other part out)', ' 3 files changed, 11 insertions(+)\n', 11],
    ['deletions only', ' 1 file changed, 4 deletions(-)\n', 4],
    ['one of each, in the singular', ' 1 file changed, 1 insertion(+), 1 deletion(-)\n', 2],
    ['a change of mode or a binary file', ' 1 file changed, 0 insertions(+), 0 deletions(-)\n', 0],
    ['a translated text: only the (+) and (-) are the same', ' 3 bestanden gewijzigd, 12 invoegingen(+), 2 verwijderingen(-)\n', 14],
  ])('reads the size from the shortstat of %s', (_what, shortstat, lines) => {
    expect(analyse('', [B_TEST], shortstat).lines).toBe(lines)
  })

  it('refuses a shortstat it does not understand instead of calling the size 0', () => {
    expect(() => analyse('', [B_TEST], ' iets onverwachts\n')).toThrow(/shortstat/)
  })
})

describe('failsForReal', () => {
  const work = join(tmpdir(), 'bench-fails-for-real') // nothing is read from disk: the entries are named relative to it
  const FILES = [A_TEST, B_TEST]
  const exit = (over: Partial<VerifyRun> = {}): VerifyRun => ({ exitCode: 1, output: '', timedOut: false, ...over })
  const reportOf = (results: unknown[]) => ({ kind: 'report' as const, text: JSON.stringify({ testResults: results }) })
  const a = (outcome: Outcome) => fileResult(work, A_TEST, outcome)
  const b = (outcome: Outcome) => fileResult(work, B_TEST, outcome)

  it.each([
    ['a hidden file that cannot be imported: status failed, and no test at all', reportOf([a('passed'), b('import-error')])],
    ['a failed test', reportOf([a('passed'), b('assertion-failed')])],
    ['a failed test in a file that has no status of its own', reportOf([{ name: join(work, B_TEST), assertionResults: [{ status: 'failed' }] }])],
    ['one failing file of two is enough', reportOf([a('assertion-failed'), b('passed')])],
  ])('is true for %s', (_what, report) => {
    expect(failsForReal({ run: exit(), report }, work, FILES)).toBe(true)
  })

  it.each([
    ['every hidden file passed', reportOf([a('passed'), b('passed')])],
    ['only skipped tests', reportOf([a('skipped'), b('skipped')])],
    ['a failed file that is not a hidden file', reportOf([a('passed'), b('passed'), fileResult(work, '__tests__/other.test.ts', 'assertion-failed')])],
    ['an empty report', reportOf([])],
    ['a report that is not vitest JSON', { kind: 'report' as const, text: '{ "nope": true }' }],
    ['a report that is not JSON', { kind: 'report' as const, text: 'Segmentation fault' }],
    ['no report', { kind: 'none' as const }],
    ['an unsafe report', { kind: 'unsafe' as const, why: '.task-bench/hidden.json is een symlink, geen gewoon bestand' }],
  ])('is false for %s', (_what, report) => {
    expect(failsForReal({ run: exit(), report }, work, FILES)).toBe(false)
  })

  it.each([
    ['a runner error', { runnerError: 'docker kon niet starten: ENOENT', exitCode: null }],
    ['a time-out', { timedOut: true, exitCode: null }],
    ['no exit code, whatever else is said', { exitCode: null }],
    ['an exit code of 0, which a failed file cannot have', { exitCode: 0 }],
  ])('is false for a report with a failed hidden file after %s', (_what, over) => {
    expect(failsForReal({ run: exit(over), report: reportOf([a('passed'), b('import-error')]) }, work, FILES)).toBe(false)
  })
})

describe('checkCase — the scan of the git administration', () => {
  it('is not ok, with every path, when the prepare on A rewrote the git files, and then runs no restore or other host git', async () => {
    const repo = await createBenchRepo()
    const both: DockerStep = {
      effect: ({ work }) => {
        writeFileSync(join(work, '.git'), 'gitdir: /elsewhere\n')
        writeFileSync(join(work, repo.sub.path, '.git'), 'gitdir: /elsewhere\n')
      },
    }
    const t = await check({ fixture: true, docker: { ...VALID, prepare: [both] } })
    expect(t.result.ok).toBe(false)
    expect(t.result.problems).toEqual(['git-administratie gewijzigd: changed: .git, changed: vendor/sub/.git'])
    expect(timeline).not.toContain('restore')
    expect(timeline.at(-1)).toBe('scan') // the scan that found it is the last thing that touched the work trees
    expect(containersOf(t).some(([purpose]) => purpose === 'hidden')).toBe(false)
  })

  it('is not ok, with the path, when the verify on A rewrote the submodule pointer, which a scan after the prepare alone would miss', async () => {
    const repo = await createBenchRepo()
    const t = await check({ fixture: true, docker: { ...VALID, verify: [rewritesPointer(repo.sub.path)] } })
    expect(t.result.problems).toEqual(['git-administratie gewijzigd: changed: vendor/sub/.git'])
    expect(t.result.baseVerifyGreen).toBe(true) // what the verify said stays on record
    expect(timeline).not.toContain('restore')
  })

  it('is not ok, with the path, when the prepare on B rewrote it, and then runs no hidden check on B', async () => {
    const repo = await createBenchRepo()
    const t = await check({ fixture: true, docker: { ...VALID, prepare: [{}, rewritesPointer(repo.sub.path)] } })
    expect(t.result.problems).toEqual(['git-administratie gewijzigd: changed: vendor/sub/.git'])
    expect(t.result.hiddenOnBase.files[1]).toMatchObject({ file: B_TEST, ran: true }) // A's side was done
    expect(t.result.hiddenOnRef).toMatchObject({ pass: false, reason: 'niet gedraaid' })
    expect(containersOf(t).at(-1)).toEqual(['prepare', 'ws-ref'])
  })
})

describe('checkCase — a stop from outside', () => {
  it('stops during the prepare on A: the container is killed, nothing else starts, and the result says afgebroken', async () => {
    const stop = new AbortController()
    const t = await start({ signal: stop.signal, docker: { prepare: [hangsUntil(stop)] } })
    const result = await t.run()
    const { saved, hex8 } = savedCheck(t.out)
    expect(result).toMatchObject({ ok: false, baseVerifyGreen: false, problems: ['afgebroken'] })
    expect(saved).toEqual(JSON.parse(JSON.stringify(result))) // the file exists, written after the container was cleaned up
    expect(t.docker.kills()).toEqual([`harness-${hex8}-prepare-1`])
    expect(t.docker.runs).toHaveLength(1)
    expect(timeline.filter((entry) => entry === 'scan' || entry === 'restore')).toEqual([])
  })

  it('stops during the hidden check on B, and says afgebroken only, also when A had a problem of its own', async () => {
    const stop = new AbortController()
    const t = await start({ signal: stop.signal, docker: { verify: [RED], hidden: [ON_BASE, hangsUntil(stop)] } })
    const result = await t.run()
    const { hex8 } = savedCheck(t.out)
    // 'verify rood op base_commit' was true, but a check that was cut short is not judged
    expect(result).toMatchObject({ ok: false, problems: ['afgebroken'] })
    expect(t.docker.kills()).toEqual([`harness-${hex8}-verify-5`])
    expect(containersOf(t).at(-1)).toEqual(['hidden', 'ws-ref'])
  })

  it('writes an afgebroken result without a clone or a container when the stop came before anything started', async () => {
    const stop = new AbortController()
    stop.abort()
    const t = await start({ signal: stop.signal })
    const result = await t.run()
    expect(result).toMatchObject({ ok: false, problems: ['afgebroken'] })
    expect(savedCheck(t.out).saved.problems).toEqual(['afgebroken'])
    expect(timeline).toEqual([])
    expect(t.docker.runs).toHaveLength(0)
  })

  it('starts no container once the stop has come, also when it came while the work tree was being made ready for it', async () => {
    const stop = new AbortController()
    const t = await start({ signal: stop.signal })
    // the restore cannot be aborted and takes a moment; the stop comes in that moment
    const restore = vi.mocked(restoreForHiddenCheck)
    const real = restore.getMockImplementation()
    if (!real) throw new Error('restoreForHiddenCheck is not traced')
    restore.mockImplementationOnce(async (...args) => {
      stop.abort()
      return real(...args)
    })
    const result = await t.run()
    expect(result.problems).toEqual(['afgebroken'])
    expect(containersOf(t)).toEqual([
      ['prepare', 'ws-base'],
      ['verify', 'ws-base'],
    ]) // no hidden check was started, so none had to be killed
    expect(t.docker.kills()).toEqual([])
  })

  it('ends on a container that was not provably stopped, with no host git after it and no container after it', async () => {
    const t = await check({
      docker: { ...VALID, verify: [{ hang: true }], killCode: 1 }, // the kill fails, so the cleanup ends 'uncertain'
      tune: quickTimeout,
    })
    expect(t.result).toMatchObject({ ok: false, problems: [`container harness-${t.hex8}-verify-2 niet aantoonbaar gestopt`] })
    expect(containersOf(t)).toEqual([
      ['prepare', 'ws-base'],
      ['verify', 'ws-base'],
    ])
    expect(timeline).not.toContain('scan')
    expect(timeline).not.toContain('restore')
  })
})

describe('checkCase — failures of the check itself', () => {
  it('is not ok when the task config has no recipe for the repository, before anything is cloned or started', async () => {
    const t = await check({ task: { recipes: [{ repoUrl: 'https://example.invalid/other', prepare: [], verify: 'npm test' }] } })
    expect(t.result.ok).toBe(false)
    expect(t.result.problems).toEqual([`geen recept voor ${t.benchCase.repo_url}`])
    expect(timeline).toEqual([])
    expect(t.docker.runs).toHaveLength(0)
  })

  it('is not ok when the clone on A cannot be made', async () => {
    const t = await check({ case: { base_commit: 'f'.repeat(40) } })
    expect(t.result.ok).toBe(false)
    expect(t.result.problems).toHaveLength(1)
    expect(t.result.problems[0]).toMatch(/^werkruimte aanmaken mislukt \(base_commit\): /)
    expect(t.docker.runs).toHaveLength(0)
  })

  it('is not ok when the clone on B cannot be made, and by then no container has started', async () => {
    const t = await start()
    // the first clone is the real one; the second one fails (a repository that is gone between the two clones does the same)
    const clone = vi.mocked(createWorkspace)
    const real = clone.getMockImplementation()
    if (!real) throw new Error('createWorkspace is not traced')
    clone.mockImplementationOnce(real).mockImplementationOnce(() => Promise.reject(new Error('fatal: de repository is weg')))
    const result = await t.run()
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual(['werkruimte aanmaken mislukt (ref_commit): fatal: de repository is weg'])
    expect(t.docker.runs).toHaveLength(0) // both clones come before the first container, so the check stops without paying for one
  })
})

describe('checkCase — the hidden report cannot be forged', () => {
  it('removes .task-bench before the hidden container on A starts, so a report left by the verify counts for nothing', async () => {
    const seen: { atStart?: boolean } = {}
    // a failing report, as if the repo's own verify wrote it; the hidden container then dies without writing one (exit 1)
    const forge: DockerStep = { effect: ({ work }) => writeReport(work, { testResults: [fileResult(work, B_TEST, 'assertion-failed')] }) }
    const died: DockerStep = { code: 1, onStart: ({ work }) => (seen.atStart = existsSync(join(work, '.task-bench/hidden.json'))) }
    const t = await check({ docker: { verify: [forge], hidden: [died, ON_REF] } })
    expect(seen.atStart).toBe(false)
    expect(t.result.problems).toEqual(['verborgen toets op base_commit zonder echte testfout'])
  })

  it('removes .task-bench before the hidden container on B starts, so a report left by the prepare counts for nothing', async () => {
    const seen: { atStart?: boolean } = {}
    const forge: DockerStep = { effect: ({ work }) => writeReport(work, { testResults: [fileResult(work, A_TEST, 'passed'), fileResult(work, B_TEST, 'passed')] }) }
    const died: DockerStep = { onStart: ({ work }) => (seen.atStart = existsSync(join(work, '.task-bench/hidden.json'))) } // exit 0, no report
    const t = await check({ docker: { prepare: [{}, forge], hidden: [ON_BASE, died] } })
    expect(seen.atStart).toBe(false)
    expect(t.result.problems).toEqual(['verborgen toets slaagt niet op ref_commit'])
  })

  it('does not follow a hidden.json on A that is a symlink to a file of the host, copies nothing of it, and says what it found', async () => {
    const MARKER = 'HOST-SECRET-MARKER-9d1e'
    const host = benchTmp('host')
    writeFileSync(join(host, 'secret.key'), MARKER)
    const link: DockerStep = {
      code: 1,
      effect: ({ work }) => {
        mkdirSync(join(work, '.task-bench'))
        symlinkSync(join(host, 'secret.key'), join(work, '.task-bench/hidden.json'))
      },
    }
    const t = await check({ docker: { hidden: [link, ON_REF] } })
    expect(t.result.problems).toEqual(['verborgen toets op base_commit zonder echte testfout'])
    expect(t.result.hiddenOnBase.reason).toContain('.task-bench/hidden.json is een symlink, geen gewoon bestand')
    const written = allFiles(t.dir).filter((f) => !f.startsWith(join(t.dir, 'ws-base')) && !f.startsWith(join(t.dir, 'ws-ref')))
    expect(written.map((f) => readFileSync(f, 'utf8')).join('\n')).not.toContain(MARKER)
  })
})
