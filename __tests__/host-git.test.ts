import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { commitAll, diffGitAdmin, snapshotGitAdmin, type GitAdminSnapshot } from '../src/worker/host-git.js'

const execFileAsync = promisify(execFile)

let globalConfigPath: string
const cleanupDirs: string[] = []

beforeAll(() => {
  const configDir = mkdtempSync(join(tmpdir(), 'host-git-cfg-'))
  globalConfigPath = join(configDir, 'gitconfig')
  writeFileSync(
    globalConfigPath,
    '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n',
  )
  cleanupDirs.push(configDir)
})

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop() as string
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A fresh temp dir under `os.tmpdir()`, tracked for cleanup after each test. */
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `host-git-${prefix}-`))
  cleanupDirs.push(dir)
  return dir
}

/**
 * Test-setup git only: isolated from the developer's real global/system config via a temp
 * `GIT_CONFIG_GLOBAL` (holding just user.name/email) and `GIT_CONFIG_NOSYSTEM=1`. Never uses the safe
 * flags under test — that's the point of the RED/GREEN contrast in the regression tests below.
 */
async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: globalConfigPath, GIT_CONFIG_NOSYSTEM: '1' },
  })
}

/**
 * Bare repo ← seed clone ← linked worktree, matching the production shape (a worktree of a story-branch
 * clone). Production code (and most of these tests) operates on the returned `worktreeDir`.
 */
async function setupRepoWithWorktree(): Promise<{ bareDir: string; cloneDir: string; worktreeDir: string }> {
  const root = tmp('repo')
  const seed = join(root, 'seed')
  mkdirSync(seed)
  await git(seed, ['init', '-q'])
  writeFileSync(join(seed, 'README.md'), 'hello\n')
  await git(seed, ['add', '-A'])
  await git(seed, ['commit', '-q', '-m', 'initial'])

  const bareDir = join(root, 'bare.git')
  await git(root, ['clone', '-q', '--bare', seed, bareDir])

  const cloneDir = join(root, 'clone')
  await git(root, ['clone', '-q', bareDir, cloneDir])

  const worktreeDir = join(root, 'worktree1')
  await git(cloneDir, ['worktree', 'add', '-q', '-b', 'feature1', worktreeDir])

  return { bareDir, cloneDir, worktreeDir }
}

/** A second bare repo, used as the submodule source (needs its own initial commit to be addable). */
async function setupSubmoduleBare(): Promise<string> {
  const root = tmp('sub')
  const seed = join(root, 'seed')
  mkdirSync(seed)
  await git(seed, ['init', '-q'])
  writeFileSync(join(seed, 'lib.txt'), 'lib\n')
  await git(seed, ['add', '-A'])
  await git(seed, ['commit', '-q', '-m', 'lib initial'])
  const bareDir = join(root, 'sub-bare.git')
  await git(root, ['clone', '-q', '--bare', seed, bareDir])
  return bareDir
}

describe('diffGitAdmin (pure)', () => {
  it('is empty when nothing differs', () => {
    const before: GitAdminSnapshot = new Map([['.git', { type: 'file', sha256: 'x' }]])
    const after: GitAdminSnapshot = new Map([['.git', { type: 'file', sha256: 'x' }]])
    expect(diffGitAdmin(before, after)).toEqual([])
  })

  it('reports new, changed and removed, sorted', () => {
    const before: GitAdminSnapshot = new Map([
      ['b/.git', { type: 'file', sha256: 'x' }],
      ['a/.git', { type: 'file', sha256: 'y' }],
      ['c/.git', { type: 'file', sha256: 'z' }],
    ])
    const after: GitAdminSnapshot = new Map([
      ['b/.git', { type: 'file', sha256: 'x2' }],
      ['a/.git', { type: 'file', sha256: 'y' }],
      ['d/.git', { type: 'dir', sha256: 'w' }],
    ])
    expect(diffGitAdmin(before, after)).toEqual(['changed: b/.git', 'new: d/.git', 'removed: c/.git'])
  })

  it('treats a type change (e.g. file -> symlink) as changed even with the same hash', () => {
    const before: GitAdminSnapshot = new Map([['.git', { type: 'file', sha256: 'x' }]])
    const after: GitAdminSnapshot = new Map([['.git', { type: 'symlink', sha256: 'x' }]])
    expect(diffGitAdmin(before, after)).toEqual(['changed: .git'])
  })
})

describe('snapshotGitAdmin (fs only)', () => {
  it('records a symlinked .git as type symlink, hashing the link text', async () => {
    const dir = tmp('symlink')
    symlinkSync('/nonexistent/target', join(dir, '.git'))
    const snap = await snapshotGitAdmin(dir)
    expect(snap.get('.git')?.type).toBe('symlink')
  })

  it('does not descend into a directory named .git, even if it contains its own .git item', async () => {
    const dir = tmp('nodescend')
    const gitDir = join(dir, '.git')
    mkdirSync(join(gitDir, 'sub'), { recursive: true })
    writeFileSync(join(gitDir, 'sub', '.git'), 'nested\n')
    const snap = await snapshotGitAdmin(dir)
    expect([...snap.keys()]).toEqual(['.git'])
  })

  it('walks into node_modules and finds a planted .git dir there', async () => {
    const dir = tmp('nodemodules')
    const nested = join(dir, 'node_modules', 'x', '.git')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'HEAD'), 'ref: refs/heads/main\n')
    const snap = await snapshotGitAdmin(dir)
    expect(snap.get('node_modules/x/.git')?.type).toBe('dir')
  })
})

describe('commitAll against real temp repos', () => {
  it('commits both a changed existing file and a new file', async () => {
    const { worktreeDir } = await setupRepoWithWorktree()
    writeFileSync(join(worktreeDir, 'README.md'), 'hello world\n')
    writeFileSync(join(worktreeDir, 'new.txt'), 'new\n')

    const result = await commitAll(worktreeDir, 'test: wijzig en voeg toe')
    expect(result.committed).toBe(true)
    expect(result.sha).toBeTruthy()

    const show = await git(worktreeDir, ['show', '--name-only', '--format=', result.sha as string])
    const files = show.stdout.trim().split('\n').filter(Boolean).sort()
    expect(files).toEqual(['README.md', 'new.txt'])
  })

  it('reports committed: false when nothing changed', async () => {
    const { worktreeDir } = await setupRepoWithWorktree()
    const result = await commitAll(worktreeDir, 'no-op')
    expect(result).toEqual({ committed: false })
  })

  it('diffGitAdmin sees a changed worktree gitlink, a changed and a removed submodule gitlink, and a new .git dir in node_modules', async () => {
    const { worktreeDir } = await setupRepoWithWorktree()
    const subBare = await setupSubmoduleBare()

    await git(worktreeDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subBare, 'vendor/sub'])
    await git(worktreeDir, ['commit', '-q', '-m', 'add submodule'])

    const before = await snapshotGitAdmin(worktreeDir)

    const worktreeGitlink = join(worktreeDir, '.git')
    const originalGitlink = readFileSync(worktreeGitlink, 'utf8')
    writeFileSync(worktreeGitlink, `${originalGitlink}\n# tampered\n`)

    const subGitlink = join(worktreeDir, 'vendor/sub/.git')
    const originalSubGitlink = readFileSync(subGitlink, 'utf8')
    writeFileSync(subGitlink, `${originalSubGitlink}\n# tampered\n`)

    const nmGitDir = join(worktreeDir, 'node_modules/x/.git')
    mkdirSync(nmGitDir, { recursive: true })
    writeFileSync(join(nmGitDir, 'HEAD'), 'ref: refs/heads/main\n')

    const afterTamper = await snapshotGitAdmin(worktreeDir)
    const diffsTamper = diffGitAdmin(before, afterTamper)
    expect(diffsTamper).toContain('changed: .git')
    expect(diffsTamper).toContain('changed: vendor/sub/.git')
    expect(diffsTamper.some((d) => d === 'new: node_modules/x/.git')).toBe(true)

    // restore the worktree gitlink, then make the submodule gitlink disappear entirely
    writeFileSync(worktreeGitlink, originalGitlink)
    rmSync(subGitlink, { force: true })
    rmSync(join(worktreeDir, 'node_modules'), { recursive: true, force: true })

    const afterRemoved = await snapshotGitAdmin(worktreeDir)
    const diffsRemoved = diffGitAdmin(before, afterRemoved)
    expect(diffsRemoved).toEqual(['removed: vendor/sub/.git'])
  })

  it('regression: a submodule gitlink redirected to admin with a core.fsmonitor marker is caught by the scan, and commitAll does not trigger the marker', async () => {
    const { worktreeDir } = await setupRepoWithWorktree()
    const subBare = await setupSubmoduleBare()
    await git(worktreeDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subBare, 'vendor/sub'])
    await git(worktreeDir, ['commit', '-q', '-m', 'add submodule'])

    const before = await snapshotGitAdmin(worktreeDir)

    // A git-admin dir fully controlled by "the container": core.fsmonitor points at a script that
    // touches a marker file. A real fsmonitor hook must speak a version/token protocol on stdout; we
    // don't need the protocol to be correct — only that invocation is observable via the marker.
    const fakeAdminRoot = tmp('fake-admin')
    await git(fakeAdminRoot, ['init', '-q'])
    const fakeGitDir = join(fakeAdminRoot, '.git')
    const markerPath = join(fakeAdminRoot, 'fsmonitor-marker')
    const hookScript = join(fakeAdminRoot, 'fsmonitor-hook.sh')
    writeFileSync(hookScript, `#!/bin/sh\ntouch "${markerPath}"\nprintf '1\\n\\n'\n`)
    chmodSync(hookScript, 0o755)
    await git(fakeAdminRoot, ['config', '--file', join(fakeGitDir, 'config'), 'core.fsmonitor', hookScript])

    const subGitlink = join(worktreeDir, 'vendor/sub/.git')
    writeFileSync(subGitlink, `gitdir: ${fakeGitDir}\n`)

    const after = await snapshotGitAdmin(worktreeDir)
    expect(diffGitAdmin(before, after)).toContain('changed: vendor/sub/.git')

    writeFileSync(join(worktreeDir, 'triggered.txt'), 'x\n')
    const result = await commitAll(worktreeDir, 'test: safe commit with a redirected submodule gitlink')
    expect(result.committed).toBe(true)
    expect(existsSync(markerPath)).toBe(false)
  })

  it('regression: a repo-local core.hooksPath pre-commit marker does not fire through commitAll, though administration is unchanged (RED: a plain git commit does fire it)', async () => {
    const { worktreeDir } = await setupRepoWithWorktree()
    const markerPath = join(worktreeDir, 'hook-marker')
    const huskyDir = join(worktreeDir, '.husky')
    mkdirSync(huskyDir)
    const preCommit = join(huskyDir, 'pre-commit')
    writeFileSync(preCommit, `#!/bin/sh\ntouch "${markerPath}"\n`)
    chmodSync(preCommit, 0o755)
    await git(worktreeDir, ['config', 'core.hooksPath', huskyDir])

    const before = await snapshotGitAdmin(worktreeDir)

    // RED: plain git (setup helper, no safe flags) runs the repo-local hook.
    writeFileSync(join(worktreeDir, 'red-check.txt'), 'red\n')
    await git(worktreeDir, ['add', '-A'])
    await git(worktreeDir, ['commit', '-q', '-m', 'red check'])
    expect(existsSync(markerPath)).toBe(true)
    rmSync(markerPath, { force: true })

    // The administration itself (the .git-named items) is unchanged: core.hooksPath lives in the
    // shared clone config, not in any item this scan records.
    const after = await snapshotGitAdmin(worktreeDir)
    expect(diffGitAdmin(before, after)).toEqual([])

    // GREEN: commitAll must not run the hook.
    writeFileSync(join(worktreeDir, 'green-check.txt'), 'green\n')
    const result = await commitAll(worktreeDir, 'test: safe commit despite core.hooksPath')
    expect(result.committed).toBe(true)
    expect(existsSync(markerPath)).toBe(false)
  })
})
