import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Command-line flags every host-git call in this file uses (spec §4.5): they disable hooks, fsmonitor
 * and submodule recursion, and make git treat every submodule as ignored. A rewritten gitlink can still
 * point host git at a fully attacker-controlled admin dir with its own executable config (e.g.
 * `core.sshCommand`), which no flag list can fully neutralize — so **the scan
 * (`snapshotGitAdmin`/`diffGitAdmin`) is the actual control, these flags are a second layer, not a
 * substitute**.
 */
export const SAFE_GIT_CONFIG: readonly string[] = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.ignoreSubmodules=all',
  '-c',
  'status.submoduleSummary=false',
  '-c',
  'submodule.recurse=false',
]

/** One entry per item whose basename is `.git`, keyed by its path relative to the worktree (POSIX separators). */
export type GitAdminSnapshot = Map<string, { type: 'file' | 'dir' | 'symlink'; sha256: string }>

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function direntType(entry: Dirent): string {
  if (entry.isSymbolicLink()) return 'symlink'
  if (entry.isDirectory()) return 'dir'
  return 'file'
}

/**
 * Hashes one `.git` item: file content, symlink target text, or — for a directory — a sorted list of its
 * direct children's names+types (one level only, never recursed into; a `.git` directory does not exist
 * at claim time, so any new one is already a difference on its own).
 */
async function hashGitItem(absPath: string, stats: Stats): Promise<{ type: 'file' | 'dir' | 'symlink'; sha256: string }> {
  if (stats.isSymbolicLink()) {
    const target = await readlink(absPath)
    return { type: 'symlink', sha256: sha256Hex(target) }
  }
  if (stats.isDirectory()) {
    const children = await readdir(absPath, { withFileTypes: true })
    const listing = children
      .map((c) => `${c.name}:${direntType(c)}`)
      .sort()
      .join('\n')
    return { type: 'dir', sha256: sha256Hex(listing) }
  }
  if (stats.isFile()) {
    const content = await readFile(absPath)
    return { type: 'file', sha256: sha256Hex(content) }
  }
  // Special file (socket, fifo, device): never read its content; a signature keeps it distinct from a
  // real file without doing an unsafe/blocking read.
  return { type: 'file', sha256: sha256Hex(`special:${stats.mode}:${stats.size}`) }
}

function toRelativePosix(worktree: string, absPath: string): string {
  return relative(worktree, absPath).split(sep).join('/')
}

/**
 * Walks the worktree with `fs` only — never git — recording one entry per item named `.git`: the
 * worktree's own gitlink, every submodule gitlink, and any `.git` file/dir/symlink planted anywhere else
 * (e.g. `node_modules/x/.git`). Iterative (an explicit queue, not recursion) and processes entries one
 * directory at a time, so it cannot blow the stack or open unbounded file handles on a large
 * `node_modules`. Never follows symlinks: a symlinked `.git` is recorded (as type `symlink`) rather than
 * entered, and any other symlink is skipped outright. Descends into every other directory, but never
 * into one named `.git`.
 */
export async function snapshotGitAdmin(worktree: string): Promise<GitAdminSnapshot> {
  const snapshot: GitAdminSnapshot = new Map()
  const queue: string[] = [worktree]

  while (queue.length > 0) {
    const dir = queue.pop() as string
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // vanished or unreadable mid-walk; nothing more to record here
    }
    for (const entry of entries) {
      const absPath = join(dir, entry.name)
      let stats: Stats
      try {
        stats = await lstat(absPath)
      } catch {
        continue // vanished between readdir and lstat
      }
      if (entry.name === '.git') {
        snapshot.set(toRelativePosix(worktree, absPath), await hashGitItem(absPath, stats))
        continue // never descend into a .git item, even if it is a directory
      }
      if (stats.isSymbolicLink()) continue // never follow a symlink that isn't itself named .git
      if (stats.isDirectory()) queue.push(absPath)
    }
  }
  return snapshot
}

/** Readable differences (`new: <path>` / `changed: <path>` / `removed: <path>`), sorted for determinism. Empty means the two snapshots match. */
export function diffGitAdmin(before: GitAdminSnapshot, after: GitAdminSnapshot): string[] {
  const diffs: string[] = []
  for (const [key, beforeEntry] of before) {
    const afterEntry = after.get(key)
    if (!afterEntry) {
      diffs.push(`removed: ${key}`)
    } else if (afterEntry.type !== beforeEntry.type || afterEntry.sha256 !== beforeEntry.sha256) {
      diffs.push(`changed: ${key}`)
    }
  }
  for (const key of after.keys()) {
    if (!before.has(key)) diffs.push(`new: ${key}`)
  }
  return diffs.sort()
}

/** Exactly `PATH`, `HOME` (from `process.env`), plus a global/system config that is ignored entirely. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
}

type GitCallResult = { code: number; stdout: string; stderr: string }

/**
 * Runs one `git <SAFE_GIT_CONFIG> <args>` call via `execFile` (an argv array — never a shell), with
 * `worktree` as `cwd` and the fixed env from `gitEnv()`. A non-zero exit is returned, not thrown, so
 * callers can inspect the exit code (e.g. to detect "nothing staged" exit-code based); only a failure to
 * even launch git throws.
 */
async function runGit(worktree: string, args: string[]): Promise<GitCallResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', [...SAFE_GIT_CONFIG, ...args], {
      cwd: worktree,
      env: gitEnv(),
      maxBuffer: 16 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message: string }
    if (typeof e.code === 'number') {
      return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
    }
    throw new Error(`git ${args.join(' ')} kon niet starten: ${e.message}`)
  }
}

/**
 * `git add -A`, then a safe commit: fixed author (`agent-harness <agent-harness@jp-visser.nl>`),
 * `--no-verify`. Whether anything is staged is detected exit-code based via `git diff --cached --quiet`
 * (0 = nothing staged, 1 = something staged) rather than by parsing (possibly localized) output; nothing
 * staged returns `{ committed: false }` without ever calling `git commit`. Any other git failure throws
 * with a clear message. The commit sha comes from `git rev-parse HEAD`, same flags and env throughout.
 */
export async function commitAll(worktree: string, message: string): Promise<{ committed: boolean; sha?: string }> {
  const add = await runGit(worktree, ['add', '-A'])
  if (add.code !== 0) throw new Error(`git add -A faalde: ${add.stderr || add.stdout}`)

  const diff = await runGit(worktree, ['diff', '--cached', '--quiet'])
  if (diff.code === 0) return { committed: false }
  if (diff.code !== 1) throw new Error(`git diff --cached --quiet faalde: ${diff.stderr || diff.stdout}`)

  const commit = await runGit(worktree, [
    '-c',
    'user.name=agent-harness',
    '-c',
    'user.email=agent-harness@jp-visser.nl',
    'commit',
    '--no-verify',
    '-m',
    message,
  ])
  if (commit.code !== 0) throw new Error(`git commit faalde: ${commit.stderr || commit.stdout}`)

  const rev = await runGit(worktree, ['rev-parse', 'HEAD'])
  if (rev.code !== 0) throw new Error(`git rev-parse HEAD faalde: ${rev.stderr || rev.stdout}`)

  return { committed: true, sha: rev.stdout.trim() }
}
