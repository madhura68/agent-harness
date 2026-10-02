import { execFile } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
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
  options: { cwd?: string; maxBuffer: number; encoding: 'utf8' },
) => Promise<{ stdout: string; stderr: string }>

const defaultExec: ExecFileFn = (file, args, options) => execFileAsync(file, args, options)

// A patch of a binary file can be large; exceeding this throws instead of cutting the output off.
const MAX_BUFFER = 64 * 1024 * 1024

async function gitVia(exec: ExecFileFn, ws: Workspace, args: string[]): Promise<string> {
  const { stdout } = await exec('git', [...SAFE_GIT_CONFIG, '--git-dir', ws.gitdir, '--work-tree', ws.work, ...args], {
    cwd: ws.work,
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
 * container. The env is the process env, on purpose: a clone over https needs `GIT_ASKPASS` and friends.
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
 * has `SAFE_GIT_CONFIG`. Every call after it goes through the same path as `git()`. `deps.execFile` replaces the real `execFile` in
 * tests; production passes nothing.
 */
export async function createWorkspace(o: { repoUrl: string; commit: string; dir: string }, deps: { execFile?: ExecFileFn } = {}): Promise<Workspace> {
  const exec = deps.execFile ?? defaultExec
  const dir = resolve(o.dir)
  const ws: Workspace = { work: join(dir, 'work'), gitdir: join(dir, 'gitdir') }
  await mkdir(dir, { recursive: true })
  await exec('git', [...SAFE_GIT_CONFIG, 'clone', '--no-checkout', '--separate-git-dir', ws.gitdir, o.repoUrl, ws.work], {
    cwd: dir,
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
 * `assertAdminUnchanged` first.
 */
export async function capturePatch(ws: Workspace, base: string): Promise<{ patch: string; empty: boolean }> {
  await git(ws, ['add', '-A', '--', '.', `:(exclude)${BENCH_DIR}`])
  const patch = await git(ws, ['diff', '--cached', '--binary', base])
  return { patch, empty: patch.length === 0 }
}

// What the hidden check takes from the ref commit: the whole `__tests__/` and the runner configuration in the root (spec §4.1 step 5).
const ROOT_CONFIG = /^(vitest\.config\..+|package\.json|tsconfig.*\.json)$/
const isRestored = (name: string): boolean => name === '__tests__' || ROOT_CONFIG.test(name)

/**
 * Puts `__tests__/` and the runner configuration (`vitest.config.*`, `package.json`, `tsconfig*.json` in the root) exactly back to
 * their state in `ref`, so that nothing the model did to tests or configuration can change what the hidden check proves. Files the
 * model added there are gone, and files it deleted are back. Everything else in the work tree stays as the model left it.
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
