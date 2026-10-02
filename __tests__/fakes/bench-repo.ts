import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { vi } from 'vitest'

const execFileAsync = promisify(execFile)

const tracked: string[] = []

/** A fresh, empty temp dir under `os.tmpdir()`. `cleanupBenchFixtures()` removes it again. */
export function benchTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bench-${prefix}-`))
  tracked.push(dir)
  return dir
}

/**
 * Call this from `afterEach`. It undoes the env stubs of `createBenchRepo` (`vi.unstubAllEnvs()`, so `GIT_ALLOW_PROTOCOL` does not
 * keep other tests on `file` only) and removes every dir that `benchTmp` handed out. The fixture origin itself stays until
 * `disposeBenchRepo()`.
 */
export function cleanupBenchFixtures(): void {
  vi.unstubAllEnvs()
  while (tracked.length > 0) rmSync(tracked.pop() as string, { recursive: true, force: true })
}

/**
 * Setup git for the fixtures, with a minimal env instead of the whole `process.env`: stray `GIT_DIR` or `GIT_INDEX_FILE` of whoever
 * started the tests can then never point a fixture command at another repo. The config is the stubbed test identity (so use it
 * after `createBenchRepo()`), and `file` is allowed as a transport for the local submodule. This is not the code under test: that
 * one inherits `process.env`, which `createBenchRepo` stubs to the same values.
 */
export async function fixtureGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file',
    },
  })
  return stdout.trim()
}

const CONFIG = ['[user]', '\tname = Bench Fixture', '\temail = bench-fixture@example.com', '[init]', '\tdefaultBranch = main', ''].join('\n')

const FILES_A: Record<string, string> = {
  'package-lock.json': '{ "name": "bench-fixture", "lockfileVersion": 3, "requires": true, "packages": {} }\n',
  'src/x.ts': 'export const x = 1\n',
  '__tests__/a.test.ts': "import { expect, it } from 'vitest'\nimport { x } from '../src/x.js'\n\nit('x is 1', () => {\n  expect(x).toBe(1)\n})\n",
  'vitest.config.ts': "import { defineConfig } from 'vitest/config'\n\nexport default defineConfig({ test: { include: ['__tests__/**/*.test.ts'] } })\n",
}

const FILES_B: Record<string, string> = {
  ...FILES_A,
  'src/y.ts': 'export const y = 2\n',
  '__tests__/a.test.ts': "import { expect, it } from 'vitest'\nimport { x } from '../src/x.js'\n\nit('x is 1', () => {\n  expect(x).toBe(1)\n})\n\nit('x is not 2', () => {\n  expect(x).not.toBe(2)\n})\n",
  '__tests__/b.test.ts': "import { expect, it } from 'vitest'\nimport { y } from '../src/y.js'\n\nit('y is 2', () => {\n  expect(y).toBe(2)\n})\n",
}

export type BenchRepo = {
  /** `file://` URL of the fixture origin: what the bench takes as `repoUrl`. */
  url: string
  /**
   * Commit A, the base: `src/x.ts`, `__tests__/a.test.ts`, `vitest.config.ts`, `package-lock.json` and the submodule `sub.path`, pinned
   * at `sub.pinned`. There is no `package.json` and no `.npmrc`: a test that wants the restore to bring either back builds an origin of its own.
   */
  a: string
  /** Commit B, the ref: A plus `src/y.ts`, `__tests__/b.test.ts` and a changed `__tests__/a.test.ts`. The gitlink and the lockfile stay the same. */
  b: string
  /** The content of every plain file (path relative to the repo root) at commit A and at commit B. */
  at: { a: Record<string, string>; b: Record<string, string> }
  /**
   * The submodule. `pinned` is the commit that the gitlink of A (and B) points at; `head` is a newer commit that the submodule's own
   * repo has, so a workspace that sits on `head` instead of `pinned` followed the remote instead of the gitlink.
   */
  sub: { path: string; url: string; pinned: string; head: string }
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

async function buildOrigin(root: string): Promise<BenchRepo> {
  // The submodule's own repo: two commits, so that the gitlink can pin the older one.
  const subDir = join(root, 'sub')
  mkdirSync(subDir)
  await fixtureGit(subDir, ['init', '-q'])
  writeFileSync(join(subDir, 'lib.txt'), 'one\n')
  await fixtureGit(subDir, ['add', '-A'])
  await fixtureGit(subDir, ['commit', '-q', '-m', 'sub one'])
  const pinned = await fixtureGit(subDir, ['rev-parse', 'HEAD'])
  writeFileSync(join(subDir, 'lib.txt'), 'two\n')
  await fixtureGit(subDir, ['commit', '-q', '-am', 'sub two'])
  const head = await fixtureGit(subDir, ['rev-parse', 'HEAD'])

  const sub = { path: 'vendor/sub', url: `file://${subDir}`, pinned, head }

  const origin = join(root, 'origin')
  mkdirSync(origin)
  await fixtureGit(origin, ['init', '-q'])
  writeFiles(origin, FILES_A)
  await fixtureGit(origin, ['submodule', 'add', '-q', sub.url, sub.path])
  await fixtureGit(join(origin, sub.path), ['checkout', '-q', pinned]) // `submodule add` took the newest commit: pin the older one
  await fixtureGit(origin, ['add', '-A'])
  await fixtureGit(origin, ['commit', '-q', '-m', 'A'])
  const a = await fixtureGit(origin, ['rev-parse', 'HEAD'])

  writeFiles(origin, FILES_B)
  await fixtureGit(origin, ['add', '-A'])
  await fixtureGit(origin, ['commit', '-q', '-m', 'B'])
  const b = await fixtureGit(origin, ['rev-parse', 'HEAD'])

  return { url: `file://${origin}`, a, b, at: { a: { ...FILES_A }, b: { ...FILES_B } }, sub }
}

// One origin per test file (vitest gives every file its own module state). Clones never write to their origin, so tests share it.
let originRoot: string | undefined
let origin: Promise<BenchRepo> | undefined

/**
 * The fixture origin repo, a throw-away repo in the OS temp dir that is built with real `git` once per test file (see `BenchRepo`).
 * Call it at the start of every test: it also stubs the env of that test, and `cleanupBenchFixtures()` in `afterEach` undoes that.
 * - `GIT_ALLOW_PROTOCOL=file`: git 2.38.1 and later refuse a submodule clone over `file` ("transport 'file' not allowed"). The
 *   stub lets the code under test clone the local submodule, because `execFile` inherits the env. Only the tests do this: the bench
 *   itself keeps `SAFE_GIT_CONFIG` without `protocol.file.allow`, and the real submodule URL is `https://`.
 * - `GIT_CONFIG_GLOBAL` (a test identity) and `GIT_CONFIG_NOSYSTEM`: the developer's own git config, for example a signing
 *   requirement, can neither break the setup commits nor change what the code under test does.
 * Remove the origin with `disposeBenchRepo()` from `afterAll`.
 */
export async function createBenchRepo(): Promise<BenchRepo> {
  if (!originRoot) {
    originRoot = mkdtempSync(join(tmpdir(), 'bench-origin-'))
    writeFileSync(join(originRoot, 'gitconfig'), CONFIG)
  }
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(originRoot, 'gitconfig'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
  origin ??= buildOrigin(originRoot)
  return origin
}

/** Call this from `afterAll`: removes the fixture origin that `createBenchRepo` built. */
export function disposeBenchRepo(): void {
  if (originRoot) rmSync(originRoot, { recursive: true, force: true })
  originRoot = undefined
  origin = undefined
}
