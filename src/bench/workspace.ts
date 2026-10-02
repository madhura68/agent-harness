import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { diffGitAdmin, SAFE_GIT_CONFIG, snapshotGitAdmin, type GitAdminSnapshot } from '../worker/host-git.js'
import { BENCH_DIR } from './hidden-check.js'

const execFileAsync = promisify(execFile)

/**
 * The two directories of a throw-away clone. `gitdir` lies next to `work`, never inside it: only `work` is mounted into the
 * containers, so whatever the model's code writes there cannot reach the git administration that host git trusts. Both paths are
 * absolute.
 */
export type Workspace = { work: string; gitdir: string }

/** The `execFile` that the git calls run through (argv, never a shell). `createWorkspace` takes it as a test seam. */
export type ExecFileFn = (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer: number; encoding: 'utf8' },
) => Promise<{ stdout: string; stderr: string }>

const defaultExec: ExecFileFn = (file, args, options) => execFileAsync(file, args, options)

// A patch of a binary file can be large; exceeding this throws instead of cutting the output off.
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * The env of the bootstrap clone: the process env, which a clone over https needs (`GIT_ASKPASS` and friends) and which holds the git
 * config of the user (on the bench host the credential helper for the forge that agent-harness is cloned from), without the API key of
 * a hosted window. No git child, nor a hook, filter or credential helper that it starts, has any use for that key.
 */
function cloneEnv(): NodeJS.ProcessEnv {
  const { OPENROUTER_API_KEY: _key, ...env } = process.env
  return env
}

/**
 * The env of every git call after the clone: `cloneEnv()` with the global and the system git config switched off, the way
 * `gitEnv()` of host-git.ts does it. Those calls are all local, so nothing of the user's config (an external diff, a textconv filter,
 * colour, a credential helper) can change what they do or say. The rest of the process env stays; `gitEnv()` itself keeps only `PATH`
 * and `HOME`, which is too little for the tests (they hand git `GIT_ALLOW_PROTOCOL`) and for a submodule update over https.
 */
function localGitEnv(): NodeJS.ProcessEnv {
  return { ...cloneEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
}

async function gitVia(exec: ExecFileFn, ws: Workspace, args: string[]): Promise<string> {
  const { stdout } = await exec('git', [...SAFE_GIT_CONFIG, '--git-dir', ws.gitdir, '--work-tree', ws.work, ...args], {
    cwd: ws.work,
    env: localGitEnv(),
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
  })
  return stdout
}

/**
 * The one way the bench runs git on the host once the clone exists: `git <SAFE_GIT_CONFIG> --git-dir <gitdir> --work-tree <work> <args>`
 * via `execFile` with `cwd` the work tree, and resolves to its stdout. The explicit git dir means git never goes looking for
 * `work/.git`, which the container can have rewritten; the safe flags switch off hooks, fsmonitor and submodule recursion. Neither
 * of the two is the real control. The scan is (`snapshotAdmin` / `assertAdminUnchanged`), and it must run before this after every
 * container. The env is the process env without `OPENROUTER_API_KEY` and without the global and system git config (`localGitEnv`).
 */
export function git(ws: Workspace, args: string[]): Promise<string> {
  return gitVia(defaultExec, ws, args)
}

/**
 * A fresh clone of `repoUrl` on `commit`, with its submodules on the gitlinks of that commit: `<dir>/work` is the work tree and
 * `<dir>/gitdir` the git administration, including `gitdir/modules/` for the submodules. `work/.git` is a plain file that points
 * at the gitdir. Git itself refuses a `dir` that already holds a `work` or `gitdir`, so a workspace is never reused.
 *
 * The clone is the one git call that runs without `--git-dir`/`--work-tree` (with them it fails: "work already exists"); it still
 * has `SAFE_GIT_CONFIG`. It is also the one call that keeps the git config of the user (`cloneEnv`): every call after it goes
 * through the same path as `git()`, which is local and runs without it. `deps.execFile` replaces the real `execFile` in tests;
 * production passes nothing.
 */
export async function createWorkspace(o: { repoUrl: string; commit: string; dir: string }, deps: { execFile?: ExecFileFn } = {}): Promise<Workspace> {
  const exec = deps.execFile ?? defaultExec
  const dir = resolve(o.dir)
  const ws: Workspace = { work: join(dir, 'work'), gitdir: join(dir, 'gitdir') }
  await mkdir(dir, { recursive: true })
  await exec('git', [...SAFE_GIT_CONFIG, 'clone', '--no-checkout', '--separate-git-dir', ws.gitdir, o.repoUrl, ws.work], {
    cwd: dir,
    env: cloneEnv(),
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
  })
  await gitVia(exec, ws, ['checkout', '--detach', o.commit])
  await gitVia(exec, ws, ['submodule', 'update', '--init', '--recursive'])
  return ws
}

/** The git administration found in the work tree is different from the snapshot taken before the container ran. */
export class AdminChangedError extends Error {
  /** The differences as `diffGitAdmin` reports them: `changed: <path>`, `new: <path>` or `removed: <path>`. */
  readonly paths: string[]
  constructor(paths: string[]) {
    super(`git-administratie gewijzigd: ${paths.join(', ')}`)
    this.name = 'AdminChangedError'
    this.paths = paths
  }
}

/** The scan of the git administration (spec §4.5) on the work tree: take it right after `createWorkspace`, before the first container. */
export function snapshotAdmin(ws: Workspace): Promise<GitAdminSnapshot> {
  return snapshotGitAdmin(ws.work)
}

/**
 * Scans the work tree again and compares with `snap`. Any difference throws `AdminChangedError`, and the caller must then run no
 * more host git on this workspace. Call it before every host-git call that follows a container.
 */
export async function assertAdminUnchanged(ws: Workspace, snap: GitAdminSnapshot): Promise<void> {
  const diffs = diffGitAdmin(snap, await snapshotGitAdmin(ws.work))
  if (diffs.length > 0) throw new AdminChangedError(diffs)
}

/**
 * The work done in the work tree as a patch against `base`: everything staged with `add -A` (new, changed and deleted files,
 * binary files included) except `.task-bench/`. `empty` is true when there is no change at all. After a container, run
 * `assertAdminUnchanged` first. The diff is the plain patch whatever the environment asks of git: no external diff program, no
 * textconv filter, no colour.
 */
export async function capturePatch(ws: Workspace, base: string): Promise<{ patch: string; empty: boolean }> {
  await git(ws, ['add', '-A', '--', '.', `:(exclude)${BENCH_DIR}`])
  const patch = await git(ws, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-color', base])
  return { patch, empty: patch.length === 0 }
}

// What the hidden check takes from the ref commit: the whole `__tests__/` and the runner configuration in the root (spec §4.1 step 5).
// `package-lock.json`, `npm-shrinkwrap.json` and `.npmrc` are part of it because they decide what npm installs and from which registry,
// and the `node_modules` that the hidden check runs with comes from an install on the ref (runTaskBench, `swapNodeModules`): the work
// tree has to hold the same files, and the ref may not change them (criterion 6: no new dependency). `npm-shrinkwrap.json` is a lockfile
// like the other, and when both are there npm uses it and ignores `package-lock.json`: restoring only the one would leave a way to differ.
const ROOT_CONFIG = /^(vitest\.config\..+|package\.json|package-lock\.json|npm-shrinkwrap\.json|\.npmrc|tsconfig.*\.json)$/
/**
 * Whether `name`, a name in the root of the repo, is runner configuration (`vitest.config.*`, `package.json`, `package-lock.json`,
 * `npm-shrinkwrap.json`, `.npmrc`, `tsconfig*.json`). It is what `restoreForHiddenCheck` puts back from `ref`, and so what `ref` may not
 * change for a case to be fair (spec §4.2 criterion 6: no new dependency): one definition for both, so that they cannot drift apart.
 */
export const isRunnerConfig = (name: string): boolean => ROOT_CONFIG.test(name)
const isRestored = (name: string): boolean => name === '__tests__' || isRunnerConfig(name)

/**
 * Puts `__tests__/` and the runner configuration (`vitest.config.*`, `package.json`, `package-lock.json`, `npm-shrinkwrap.json`,
 * `.npmrc`, `tsconfig*.json` in the root) exactly back to their state in `ref`, so that nothing the model did to tests or configuration
 * can change what the hidden check proves. Files the model added there are gone (an `.npmrc` or `npm-shrinkwrap.json` that `ref` does
 * not have among them), and files it deleted are back. Everything else in the work tree stays as the model left it, `node_modules`
 * included: the caller replaces that one with a pristine install (`swapNodeModules`).
 * After a container, run `assertAdminUnchanged` first.
 */
export async function restoreForHiddenCheck(ws: Workspace, ref: string): Promise<void> {
  // 1. Remove what is there now. `rm` unlinks a symlink instead of following it.
  for (const name of (await readdir(ws.work)).filter(isRestored)) {
    await rm(join(ws.work, name), { recursive: true, force: true })
  }
  // 2. What `ref` has of it. `-z`: without it git quotes names with special characters, and those would silently not come back.
  const keep = (await git(ws, ['ls-tree', '-z', '--name-only', ref])).split('\0').filter(isRestored)
  // 3. Check it out.
  if (keep.length > 0) await git(ws, ['checkout', ref, '--', ...keep])
}

/**
 * Takes the `node_modules` of `o.from` over into `o.into`: the one that `o.into` has is removed, and the one of `o.from` is moved there
 * with a rename, so both work trees have to be on the same file system. `o.from` is a pristine tree (a clone of the ref that a prepare
 * container installed the dependencies in), `o.into` the work tree of a model run: whatever the model put in its `node_modules` is gone,
 * and nothing of `o.into` is read, run or copied. The removal unlinks a symlink, also one inside, instead of following it. Nothing else of
 * `o.from` moves, so what a generator wrote into `node_modules` (the Prisma client of scrum4me-mcp: `node_modules/.prisma/client`) comes
 * along, and nothing outside it does.
 *
 * Rejects when `o.from` has no real directory `node_modules` (a symlink is none), before anything of `o.into` is removed; a removal or a
 * rename that fails rejects too. After either, the caller ends the run: it does not use the work tree again.
 */
export async function swapNodeModules(o: { from: Workspace; into: Workspace }): Promise<void> {
  const source = join(o.from.work, 'node_modules')
  const found = await lstat(source).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined
    throw err
  })
  if (!found?.isDirectory()) throw new Error('de schone installatie heeft geen gewone map node_modules opgeleverd')
  const target = join(o.into.work, 'node_modules')
  await rm(target, { recursive: true, force: true })
  await rename(source, target)
}
