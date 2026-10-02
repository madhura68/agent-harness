import { execFile } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  AdminChangedError,
  assertAdminUnchanged,
  capturePatch,
  createWorkspace,
  git,
  isRunnerConfig,
  restoreForHiddenCheck,
  snapshotAdmin,
  type ExecFileFn,
  type Workspace,
} from '../src/bench/workspace.js'
import { SAFE_GIT_CONFIG, snapshotGitAdmin } from '../src/worker/host-git.js'
import { benchTmp, cleanupBenchFixtures, createBenchRepo, disposeBenchRepo, fixtureGit, type BenchRepo } from './fakes/bench-repo.js'
import { DUMMY_KEY } from './helpers.js'

const execFileAsync = promisify(execFile)

afterEach(() => cleanupBenchFixtures())
afterAll(() => disposeBenchRepo())

/** A fresh fixture origin and a workspace cloned from it, on commit A or B. */
async function setup(commit: 'a' | 'b' = 'a'): Promise<{ repo: BenchRepo; dir: string; ws: Workspace }> {
  const repo = await createBenchRepo()
  const dir = benchTmp('ws')
  const ws = await createWorkspace({ repoUrl: repo.url, commit: repo[commit], dir })
  return { repo, dir, ws }
}

/** What the "model" does inside the container: it writes into the work tree, whatever it likes. */
function write(ws: Workspace, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(ws.work, path)), { recursive: true })
  writeFileSync(join(ws.work, path), content)
}

function read(ws: Workspace, path: string): string {
  return readFileSync(join(ws.work, path), 'utf8')
}

describe('createWorkspace', () => {
  it('clones with exactly the bootstrap argv, and gives every later call the safe flags plus --git-dir and --work-tree', async () => {
    const repo = await createBenchRepo()
    const dir = benchTmp('ws')
    const calls: Array<{ file: string; args: string[]; options: Parameters<ExecFileFn>[2] }> = []
    const spy: ExecFileFn = (file, args, options) => {
      calls.push({ file, args: [...args], options })
      return execFileAsync(file, args, options)
    }

    const ws = await createWorkspace({ repoUrl: repo.url, commit: repo.a, dir }, { execFile: spy })

    // the one call without --git-dir/--work-tree: with them the clone fails ("work already exists")
    expect(calls[0]?.args).toEqual([...SAFE_GIT_CONFIG, 'clone', '--no-checkout', '--separate-git-dir', join(dir, 'gitdir'), repo.url, join(dir, 'work')])
    expect(calls[0]?.args).not.toContain('--git-dir')
    expect(calls[0]?.args).not.toContain('--work-tree')

    const prefix = [...SAFE_GIT_CONFIG, '--git-dir', ws.gitdir, '--work-tree', ws.work]
    expect(calls.slice(1).map((c) => c.args)).toEqual([
      [...prefix, 'checkout', '--detach', repo.a],
      [...prefix, 'submodule', 'update', '--init', '--recursive'],
    ])
    expect(calls.slice(1).every((c) => c.options.cwd === ws.work)).toBe(true)

    // argv to the git binary, never a shell
    expect(calls.every((c) => c.file === 'git')).toBe(true)
    expect(calls.every((c) => !('shell' in c.options))).toBe(true)
  })

  // The clone is the one call that needs the git config of the user (on the bench host it holds the credential helper for the forge that
  // agent-harness is cloned from). Everything after it is local, so it runs without that config, and no git child ever gets the API key.
  it('gives the clone the process env minus the API key, and every later call that env without the git config of the user', async () => {
    const repo = await createBenchRepo()
    vi.stubEnv('OPENROUTER_API_KEY', DUMMY_KEY) // as in a hosted window
    const calls: Array<{ args: string[]; options: Parameters<ExecFileFn>[2] }> = []
    const spy: ExecFileFn = (file, args, options) => {
      calls.push({ args: [...args], options })
      return execFileAsync(file, args, options)
    }

    await createWorkspace({ repoUrl: repo.url, commit: repo.a, dir: benchTmp('ws') }, { execFile: spy })

    expect(calls.length).toBeGreaterThanOrEqual(3)
    const [clone, ...later] = calls
    expect(clone.options.env).toBeDefined()
    expect(clone.options.env).not.toHaveProperty('OPENROUTER_API_KEY')
    expect(clone.options.env?.GIT_CONFIG_GLOBAL).toBe(process.env.GIT_CONFIG_GLOBAL) // the config of the user stays for the clone
    expect(clone.options.env?.GIT_ALLOW_PROTOCOL).toBe('file') // and so does the rest of the process env
    for (const c of later) {
      const label = c.args.join(' ')
      expect(c.options.env, label).toBeDefined()
      expect(c.options.env, label).not.toHaveProperty('OPENROUTER_API_KEY')
      expect(c.options.env, label).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' })
    }
  })

  it('makes <dir>/work and <dir>/gitdir, with work/.git a file that points outside the work tree', async () => {
    const { dir, ws } = await setup()
    expect(ws).toEqual({ work: join(dir, 'work'), gitdir: join(dir, 'gitdir') })

    const dotGit = join(ws.work, '.git')
    expect(lstatSync(dotGit).isFile()).toBe(true)
    const pointer = readFileSync(dotGit, 'utf8')
    expect(pointer).toMatch(/^gitdir: /)
    expect(realpathSync(pointer.replace(/^gitdir: /, '').trim())).toBe(realpathSync(ws.gitdir))

    expect(relative(ws.work, ws.gitdir).startsWith('..')).toBe(true) // the gitdir is not inside work
    expect(existsSync(join(ws.gitdir, 'HEAD'))).toBe(true)
    expect(existsSync(join(ws.gitdir, 'objects'))).toBe(true)
  })

  it('creates the dir when it does not exist yet, and makes the paths absolute', async () => {
    const repo = await createBenchRepo()
    const parent = benchTmp('parent')
    const ws = await createWorkspace({ repoUrl: repo.url, commit: repo.a, dir: join(parent, 'deeper', 'ws') })
    expect(ws).toEqual({ work: join(parent, 'deeper', 'ws', 'work'), gitdir: join(parent, 'deeper', 'ws', 'gitdir') })

    const relativeDir = relative(process.cwd(), join(parent, 'again'))
    const second = await createWorkspace({ repoUrl: repo.url, commit: repo.a, dir: relativeDir })
    expect(second).toEqual({ work: resolve(relativeDir, 'work'), gitdir: resolve(relativeDir, 'gitdir') })
    expect(read(second, 'src/x.ts')).toBe(repo.at.a['src/x.ts'])
  })

  it('checks out the base commit, detached, with the files of that commit', async () => {
    const { repo, ws } = await setup('a')
    expect(readFileSync(join(ws.gitdir, 'HEAD'), 'utf8').trim()).toBe(repo.a) // a detached HEAD holds the commit itself
    expect(read(ws, 'src/x.ts')).toBe(repo.at.a['src/x.ts'])
    expect(read(ws, '__tests__/a.test.ts')).toBe(repo.at.a['__tests__/a.test.ts'])
    expect(read(ws, 'vitest.config.ts')).toBe(repo.at.a['vitest.config.ts'])
    expect(existsSync(join(ws.work, 'src/y.ts'))).toBe(false) // only commit B has it
    expect(existsSync(join(ws.work, '__tests__/b.test.ts'))).toBe(false)
  })

  it('checks out any other commit just as well', async () => {
    const { repo, ws } = await setup('b')
    expect(readFileSync(join(ws.gitdir, 'HEAD'), 'utf8').trim()).toBe(repo.b)
    expect(read(ws, 'src/y.ts')).toBe(repo.at.b['src/y.ts'])
    expect(read(ws, '__tests__/a.test.ts')).toBe(repo.at.b['__tests__/a.test.ts'])
  })

  it('puts the submodule on the gitlink of the commit, with its administration under gitdir/modules', async () => {
    const { repo, ws } = await setup()
    expect(repo.sub.pinned).not.toBe(repo.sub.head)

    const pointerFile = join(ws.work, repo.sub.path, '.git')
    expect(lstatSync(pointerFile).isFile()).toBe(true)
    const adminDir = join(ws.gitdir, 'modules', repo.sub.path)
    expect(existsSync(adminDir)).toBe(true)
    const target = readFileSync(pointerFile, 'utf8').replace(/^gitdir: /, '').trim()
    expect(realpathSync(resolve(dirname(pointerFile), target))).toBe(realpathSync(adminDir))

    expect(readFileSync(join(adminDir, 'HEAD'), 'utf8').trim()).toBe(repo.sub.pinned) // the gitlink, not what the remote has now
    expect(read(ws, `${repo.sub.path}/lib.txt`)).toBe('one\n')
  })

  it('refuses to reuse a dir that already holds a workspace, and leaves it alone', async () => {
    const { repo, dir, ws } = await setup()
    write(ws, 'src/x.ts', 'export const x = 42\n')
    await expect(createWorkspace({ repoUrl: repo.url, commit: repo.a, dir })).rejects.toThrow()
    expect(read(ws, 'src/x.ts')).toBe('export const x = 42\n')
  })

  it('rejects when the commit is not in the repo', async () => {
    const repo = await createBenchRepo()
    await expect(createWorkspace({ repoUrl: repo.url, commit: 'f'.repeat(40), dir: benchTmp('ws') })).rejects.toThrow()
  })
})

describe('git', () => {
  it('returns the stdout of a call on the workspace, and rejects when git fails', async () => {
    const { repo, ws } = await setup()
    expect((await git(ws, ['rev-parse', 'HEAD'])).trim()).toBe(repo.a)
    await expect(git(ws, ['rev-parse', '--verify', '--quiet', 'refs/heads/nope'])).rejects.toThrow()
  })

  // A shell alias runs in the env that git hands to its children, so it shows what the real child got. It prints the four variables
  // under test and nothing else: a failing run must not print the whole environment of whoever runs the tests.
  it('runs git without the API key, with the global and system git config switched off, and with the rest of the process env', async () => {
    const { ws } = await setup()
    vi.stubEnv('OPENROUTER_API_KEY', DUMMY_KEY) // as in a hosted window
    const names = ['OPENROUTER_API_KEY', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ALLOW_PROTOCOL']
    const show = `!printf '%s\\n' ${names.map((name) => '"' + name + '=${' + name + '-unset}"').join(' ')}`
    const out = await git(ws, ['-c', `alias.show-env=${show}`, 'show-env'])
    const seen = Object.fromEntries(out.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    expect(seen).toEqual({
      OPENROUTER_API_KEY: 'unset',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file', // the rest of the process env stays, as GIT_ASKPASS would for a clone over https
    })
  })

  it('does not read the global git config of the user: what it sets there is not set for a call on the workspace', async () => {
    const { ws } = await setup()
    // the premise: the env of this test points git at a global config that sets user.name
    expect((await execFileAsync('git', ['config', '--global', '--get', 'user.name'])).stdout.trim()).toBe('Bench Fixture')
    await expect(git(ws, ['config', '--get', 'user.name'])).rejects.toThrow() // exit code 1: set nowhere git looks
  })
})

describe('snapshotAdmin and assertAdminUnchanged', () => {
  it('snapshots the .git pointers of the work tree and of the submodule, as the host-git scan does', async () => {
    const { ws } = await setup()
    const snap = await snapshotAdmin(ws)
    expect([...snap.keys()].sort()).toEqual(['.git', 'vendor/sub/.git'])
    expect(snap).toEqual(await snapshotGitAdmin(ws.work))
  })

  it('accepts a work tree whose administration is unchanged, whatever else the model edited', async () => {
    const { ws } = await setup()
    const snap = await snapshotAdmin(ws)
    write(ws, 'src/x.ts', 'export const x = 42\n')
    write(ws, 'src/new.ts', 'export const n = 1\n')
    write(ws, 'node_modules/pkg/index.js', 'module.exports = {}\n')
    await expect(assertAdminUnchanged(ws, snap)).resolves.toBeUndefined()
  })

  it('throws AdminChangedError with the path when the .git pointer of the submodule is rewritten to another gitdir with a hook', async () => {
    const { repo, ws } = await setup()
    const snap = await snapshotAdmin(ws)

    const evil = benchTmp('evil')
    await fixtureGit(evil, ['init', '-q'])
    const hook = join(evil, '.git', 'hooks', 'post-checkout')
    mkdirSync(dirname(hook), { recursive: true })
    writeFileSync(hook, '#!/bin/sh\ntouch /nonexistent/never\n')
    chmodSync(hook, 0o755)
    writeFileSync(join(ws.work, repo.sub.path, '.git'), `gitdir: ${join(evil, '.git')}\n`)

    const err = await assertAdminUnchanged(ws, snap).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AdminChangedError)
    expect(err).toBeInstanceOf(Error)
    expect((err as AdminChangedError).paths).toEqual(['changed: vendor/sub/.git'])
    expect((err as AdminChangedError).message).toContain('vendor/sub/.git')
  })

  it('reports every difference: a rewritten work pointer, a planted .git and a removed submodule pointer', async () => {
    const { ws } = await setup()
    const snap = await snapshotAdmin(ws)
    writeFileSync(join(ws.work, '.git'), 'gitdir: /elsewhere\n')
    mkdirSync(join(ws.work, 'node_modules/x/.git'), { recursive: true })
    rmSync(join(ws.work, 'vendor/sub/.git'))

    const err = await assertAdminUnchanged(ws, snap).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AdminChangedError)
    expect((err as AdminChangedError).paths).toEqual(['changed: .git', 'new: node_modules/x/.git', 'removed: vendor/sub/.git'])
  })
})

/** A script that the traps below run: it creates a marker file, so that the test can see that it ran. */
function writeScript(path: string, marker: string, extra = ''): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\ntouch "${marker}"\n${extra}`)
  chmodSync(path, 0o755)
}

/**
 * Two traps for host git, each of which leaves a marker file when it is sprung:
 * - a `post-checkout` hook in the real gitdir (fires on any checkout that does not switch hooks off);
 * - a hostile `work/.git`, as the container could write it: it points at another repo whose config runs a script as `core.fsmonitor`.
 */
async function plantTraps(ws: Workspace): Promise<{ hook: string; fsmonitor: string; hostileGitDir: string }> {
  const markers = benchTmp('markers')
  const hook = join(markers, 'post-checkout-ran')
  const fsmonitor = join(markers, 'fsmonitor-ran')
  writeScript(join(ws.gitdir, 'hooks', 'post-checkout'), hook)

  const hostile = benchTmp('hostile')
  await fixtureGit(hostile, ['init', '-q'])
  const hostileGitDir = join(hostile, '.git')
  writeScript(join(hostile, 'fsmonitor.sh'), fsmonitor, "printf '1\\n\\n'\n")
  await fixtureGit(hostile, ['config', '--file', join(hostileGitDir, 'config'), 'core.fsmonitor', join(hostile, 'fsmonitor.sh')])
  writeFileSync(join(ws.work, '.git'), `gitdir: ${hostileGitDir}\n`)
  return { hook, fsmonitor, hostileGitDir }
}

describe('host git after the clone', () => {
  // The contrast first: the traps are real. Without these two a green test below could mean that the scenario never springs them.
  it('RED: plain git, which finds the hostile work/.git or does not switch hooks off, springs both traps', async () => {
    const { repo, ws } = await setup()
    const traps = await plantTraps(ws)

    await execFileAsync('git', ['status'], { cwd: ws.work }) // finds the repository through the hostile work/.git
    expect(existsSync(traps.fsmonitor)).toBe(true)

    await execFileAsync('git', ['--git-dir', ws.gitdir, '--work-tree', ws.work, 'checkout', repo.b, '--', '__tests__'], { cwd: ws.work })
    expect(existsSync(traps.hook)).toBe(true) // explicit git dir, but no SAFE_GIT_CONFIG: the hook of the real gitdir runs
  })

  it('GREEN: capturePatch and restoreForHiddenCheck spring neither trap, and use the real gitdir', async () => {
    const { repo, ws } = await setup()
    const snap = await snapshotAdmin(ws)
    const traps = await plantTraps(ws)
    const hostileBefore = readdirSync(traps.hostileGitDir).sort()

    // The scan is the actual control and catches the hostile pointer first; the calls below run anyway, as if it were skipped.
    await expect(assertAdminUnchanged(ws, snap)).rejects.toBeInstanceOf(AdminChangedError)

    write(ws, 'src/new.ts', 'export const added = 1\n')
    const { patch, empty } = await capturePatch(ws, repo.a)
    // only the real gitdir knows commit A: with the hostile one this diff cannot even be made
    expect(empty).toBe(false)
    expect(patch).toContain('src/new.ts')

    write(ws, '__tests__/a.test.ts', '// changed by the model\n')
    await restoreForHiddenCheck(ws, repo.b)
    expect(read(ws, '__tests__/a.test.ts')).toBe(repo.at.b['__tests__/a.test.ts'])

    expect(existsSync(traps.hook)).toBe(false)
    expect(existsSync(traps.fsmonitor)).toBe(false)
    expect(readdirSync(traps.hostileGitDir).sort()).toEqual(hostileBefore) // the hostile gitdir was never opened for writing
    expect(await fixtureGit(ws.work, ['--git-dir', ws.gitdir, 'ls-files', 'src/new.ts'])).toBe('src/new.ts') // the real index has it
  })
})

describe('git() against a hostile submodule pointer', () => {
  it('does not run the config of the repository that a rewritten submodule pointer leads to, where plain git does', async () => {
    const { repo, ws } = await setup()
    const marker = join(benchTmp('markers'), 'submodule-fsmonitor-ran')
    const hostile = benchTmp('hostile-sub')
    await fixtureGit(hostile, ['init', '-q'])
    writeScript(join(hostile, 'fsmonitor.sh'), marker, "printf '1\\n\\n'\n")
    await fixtureGit(hostile, ['config', '--file', join(hostile, '.git', 'config'), 'core.fsmonitor', join(hostile, 'fsmonitor.sh')])
    writeFileSync(join(ws.work, repo.sub.path, '.git'), `gitdir: ${join(hostile, '.git')}\n`)

    // Contrast: with only the explicit git dir, git asks the submodule's repository for its state and so runs its config.
    await execFileAsync('git', ['--git-dir', ws.gitdir, '--work-tree', ws.work, 'status'], { cwd: ws.work })
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)

    for (const args of [['status'], ['diff'], ['diff-files']]) await git(ws, args)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('capturePatch', () => {
  it('is empty when nothing changed', async () => {
    const { repo, ws } = await setup()
    expect(await capturePatch(ws, repo.a)).toEqual({ patch: '', empty: true })
  })

  it('has a new file and a change in it', async () => {
    const { repo, ws } = await setup()
    write(ws, 'src/new.ts', 'export const added = 1\n')
    write(ws, 'src/x.ts', 'export const x = 42\n')

    const { patch, empty } = await capturePatch(ws, repo.a)
    expect(empty).toBe(false)
    expect(patch).toContain('diff --git a/src/new.ts b/src/new.ts')
    expect(patch).toContain('new file mode')
    expect(patch).toContain('+export const added = 1')
    expect(patch).toContain('diff --git a/src/x.ts b/src/x.ts')
    expect(patch).toContain('-export const x = 1')
    expect(patch).toContain('+export const x = 42')
  })

  it('has a deleted file', async () => {
    const { repo, ws } = await setup()
    rmSync(join(ws.work, 'src/x.ts'))
    const { patch, empty } = await capturePatch(ws, repo.a)
    expect(empty).toBe(false)
    expect(patch).toContain('diff --git a/src/x.ts b/src/x.ts')
    expect(patch).toContain('deleted file mode')
  })

  it('has a binary file as a binary patch, not as a line that says it differs', async () => {
    const { repo, ws } = await setup()
    write(ws, 'logo.bin', Buffer.from([0, 1, 2, 255, 0, 254, 0, 7]))
    const { patch, empty } = await capturePatch(ws, repo.a)
    expect(empty).toBe(false)
    expect(patch).toContain('GIT binary patch')
  })

  it('does not count the .task-bench directory', async () => {
    const { repo, ws } = await setup()
    write(ws, '.task-bench/hidden.json', '{"testResults":[]}')
    write(ws, '.task-bench/deeper/log.txt', 'log\n')
    expect(await capturePatch(ws, repo.a)).toEqual({ patch: '', empty: true })

    write(ws, 'src/new.ts', 'export const added = 1\n')
    const { patch, empty } = await capturePatch(ws, repo.a)
    expect(empty).toBe(false)
    expect(patch).toContain('src/new.ts')
    expect(patch).not.toContain('.task-bench')
  })

  // The patch is what is stored and compared, so nothing in the environment of the operator may change what it says. The sources
  // below are the ones that outlive a pinned global config: an env var, and config handed over through GIT_CONFIG_COUNT.
  describe('is the plain patch, whatever the environment asks of git', () => {
    /** Config for every git child of this test, the way an environment can hand it over (GIT_CONFIG_COUNT and friends). */
    function envConfig(...pairs: Array<[key: string, value: string]>): void {
      vi.stubEnv('GIT_CONFIG_COUNT', String(pairs.length))
      pairs.forEach(([key, value], i) => {
        vi.stubEnv(`GIT_CONFIG_KEY_${i}`, key)
        vi.stubEnv(`GIT_CONFIG_VALUE_${i}`, value)
      })
    }
    const script = (name: string, body: string): string => {
      const path = join(benchTmp('program'), name)
      writeFileSync(path, `#!/bin/sh\n${body}\n`)
      chmodSync(path, 0o755)
      return path
    }

    it('has no colour codes, also with colour set to always', async () => {
      const { repo, ws } = await setup()
      envConfig(['color.ui', 'always'])
      write(ws, 'src/x.ts', 'export const x = 42\n')
      const { patch } = await capturePatch(ws, repo.a)
      expect(patch).not.toContain('\u001b[')
      expect(patch).toContain('+export const x = 42')
    })

    it('does not run an external diff program, with GIT_EXTERNAL_DIFF set', async () => {
      const { repo, ws } = await setup()
      const marker = join(benchTmp('markers'), 'external-diff-ran')
      vi.stubEnv('GIT_EXTERNAL_DIFF', script('extdiff.sh', `touch "${marker}"\necho EXTERNAL-DIFF-OUTPUT`))
      write(ws, 'src/x.ts', 'export const x = 42\n')
      const { patch } = await capturePatch(ws, repo.a)
      expect(existsSync(marker)).toBe(false)
      expect(patch).not.toContain('EXTERNAL-DIFF-OUTPUT')
      expect(patch).toContain('+export const x = 42')
    })

    it('does not run a textconv filter on a file whose attributes name one', async () => {
      const { repo, ws } = await setup()
      const upper = script('upper.sh', 'tr a-z A-Z < "$1"')
      envConfig(['diff.up.textconv', upper])
      write(ws, '.gitattributes', '*.ts diff=up\n') // as the model's code could write it
      write(ws, 'src/x.ts', 'export const x = 42\n')
      const { patch } = await capturePatch(ws, repo.a)
      expect(patch).toContain('+export const x = 42')
      expect(patch).not.toContain('EXPORT CONST')
    })
  })
})

describe('isRunnerConfig', () => {
  it.each(['vitest.config.ts', 'vitest.config.mts', 'package.json', 'package-lock.json', '.npmrc', 'tsconfig.json', 'tsconfig.build.json'])(
    'takes %s for runner configuration',
    (name) => {
      expect(isRunnerConfig(name)).toBe(true)
    },
  )

  it.each(['package-lock.json.bak', 'package-lock.jsonl', 'my-package-lock.json', '.npmrc.local', '.npmrcx', 'x.npmrc', 'npmrc', 'sub/package-lock.json', 'sub/.npmrc'])(
    'does not take %s for runner configuration',
    (name) => {
      expect(isRunnerConfig(name)).toBe(false)
    },
  )
})

describe('restoreForHiddenCheck', () => {
  it('puts the whole __tests__ directory back to the state of the ref: changed, added and missing files', async () => {
    const { repo, ws } = await setup('a')
    write(ws, '__tests__/a.test.ts', "it('always passes', () => {})\n") // the model changed a test
    write(ws, '__tests__/extra.test.ts', "it('extra', () => {})\n") // and added one
    write(ws, '__tests__/helpers/shared.ts', 'export {}\n') // also in a subdirectory

    await restoreForHiddenCheck(ws, repo.b)

    expect(read(ws, '__tests__/a.test.ts')).toBe(repo.at.b['__tests__/a.test.ts'])
    expect(read(ws, '__tests__/b.test.ts')).toBe(repo.at.b['__tests__/b.test.ts']) // the hidden test itself arrives
    expect(existsSync(join(ws.work, '__tests__/extra.test.ts'))).toBe(false)
    expect(existsSync(join(ws.work, '__tests__/helpers'))).toBe(false)
    expect(readdirSync(join(ws.work, '__tests__')).sort()).toEqual(['a.test.ts', 'b.test.ts'])
  })

  it('puts the runner configuration back: vitest.config.*, package.json and tsconfig*.json', async () => {
    const { repo, ws } = await setup('a')
    write(ws, 'vitest.config.ts', 'export default { test: { include: [] } }\n') // changed
    write(ws, 'vitest.config.mts', 'export default {}\n') // added next to it
    write(ws, 'tsconfig.extra.json', '{}\n') // added
    write(ws, 'tsconfig.json', '{}\n') // added, and the ref has none
    write(ws, 'package.json', '{"scripts":{}}\n') // added, and the ref has none

    await restoreForHiddenCheck(ws, repo.b)

    expect(read(ws, 'vitest.config.ts')).toBe(repo.at.b['vitest.config.ts'])
    for (const gone of ['vitest.config.mts', 'tsconfig.extra.json', 'tsconfig.json', 'package.json']) {
      expect(existsSync(join(ws.work, gone)), gone).toBe(false)
    }
  })

  // What the dependencies are installed from. The hidden check installs them again from the ref (runTaskBench), so the model must not be
  // the one who chooses the lockfile or the registry.
  it('puts package-lock.json and .npmrc back too: a changed lockfile is the lockfile of the ref again, and an .npmrc the ref does not have is gone', async () => {
    const { repo, ws } = await setup('a')
    write(ws, 'package-lock.json', '{ "lockfileVersion": 3, "forged": true }\n') // changed; the fixture has a lockfile at A and at B
    write(ws, '.npmrc', 'registry=https://registry.invalid/\n') // added, and the ref has none

    await restoreForHiddenCheck(ws, repo.b)

    expect(read(ws, 'package-lock.json')).toBe(repo.at.b['package-lock.json'])
    expect(existsSync(join(ws.work, '.npmrc'))).toBe(false)
  })

  it('brings back a package-lock.json and an .npmrc that the ref has, also when the model deleted the one and made a link of the other', async () => {
    await createBenchRepo() // stubs the env for the setup commit below
    const origin = benchTmp('npm-files')
    await fixtureGit(origin, ['init', '-q'])
    writeFileSync(join(origin, 'package-lock.json'), '{ "lockfileVersion": 3 }\n')
    writeFileSync(join(origin, '.npmrc'), 'ignore-scripts=true\n')
    await fixtureGit(origin, ['add', '-A'])
    await fixtureGit(origin, ['commit', '-q', '-m', 'npm files'])
    const commit = await fixtureGit(origin, ['rev-parse', 'HEAD'])
    const ws = await createWorkspace({ repoUrl: `file://${origin}`, commit, dir: benchTmp('ws') })
    const outside = benchTmp('outside')
    writeFileSync(join(outside, 'target'), 'blijft staan\n')
    rmSync(join(ws.work, 'package-lock.json'))
    rmSync(join(ws.work, '.npmrc'))
    symlinkSync(join(outside, 'target'), join(ws.work, '.npmrc'))

    await restoreForHiddenCheck(ws, commit)

    expect(read(ws, 'package-lock.json')).toBe('{ "lockfileVersion": 3 }\n')
    expect(lstatSync(join(ws.work, '.npmrc')).isSymbolicLink()).toBe(false)
    expect(read(ws, '.npmrc')).toBe('ignore-scripts=true\n')
    expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('blijft staan\n') // what the link pointed at is as it was
  })

  it('brings back what the model deleted', async () => {
    const { repo, ws } = await setup('a')
    rmSync(join(ws.work, 'vitest.config.ts'))
    rmSync(join(ws.work, '__tests__'), { recursive: true })

    await restoreForHiddenCheck(ws, repo.b)

    expect(read(ws, 'vitest.config.ts')).toBe(repo.at.b['vitest.config.ts'])
    expect(read(ws, '__tests__/a.test.ts')).toBe(repo.at.b['__tests__/a.test.ts'])
    expect(read(ws, '__tests__/b.test.ts')).toBe(repo.at.b['__tests__/b.test.ts'])
  })

  it('leaves everything else alone: the solution of the model stays, and the other files of the ref do not arrive', async () => {
    const { repo, ws } = await setup('a')
    write(ws, 'src/x.ts', 'export const x = 42\n')
    write(ws, 'src/new.ts', 'export const added = 1\n')
    write(ws, 'NOTES.md', 'notes\n')
    write(ws, 'tests/other.test.ts', 'export {}\n')

    await restoreForHiddenCheck(ws, repo.b)

    expect(read(ws, 'src/x.ts')).toBe('export const x = 42\n')
    expect(read(ws, 'src/new.ts')).toBe('export const added = 1\n')
    expect(read(ws, 'NOTES.md')).toBe('notes\n')
    expect(read(ws, 'tests/other.test.ts')).toBe('export {}\n')
    expect(existsSync(join(ws.work, 'src/y.ts'))).toBe(false) // in the ref, but it is the model's job to write it
    expect(read(ws, `${repo.sub.path}/lib.txt`)).toBe('one\n')
  })

  it('replaces a symlinked __tests__ by the real directory, and does not touch what the link pointed at', async () => {
    const { repo, ws } = await setup('a')
    const outside = benchTmp('outside')
    writeFileSync(join(outside, 'fake.test.ts'), "it('fake', () => {})\n")
    rmSync(join(ws.work, '__tests__'), { recursive: true })
    symlinkSync(outside, join(ws.work, '__tests__'))

    await restoreForHiddenCheck(ws, repo.b)

    expect(lstatSync(join(ws.work, '__tests__')).isDirectory()).toBe(true)
    expect(lstatSync(join(ws.work, '__tests__')).isSymbolicLink()).toBe(false)
    expect(read(ws, '__tests__/a.test.ts')).toBe(repo.at.b['__tests__/a.test.ts'])
    expect(readdirSync(outside)).toEqual(['fake.test.ts'])
  })

  it('also brings back a config file whose name git quotes in its listing', async () => {
    await createBenchRepo() // stubs the env for the setup commit below
    const origin = benchTmp('quoted')
    await fixtureGit(origin, ['init', '-q'])
    const quoted = 'tsconfig.a"b.json' // git lists this as "tsconfig.a\"b.json" unless it is told to separate names with NUL
    writeFileSync(join(origin, quoted), '{"original":true}\n')
    await fixtureGit(origin, ['add', '-A'])
    await fixtureGit(origin, ['commit', '-q', '-m', 'quoted'])
    const commit = await fixtureGit(origin, ['rev-parse', 'HEAD'])
    const ws = await createWorkspace({ repoUrl: `file://${origin}`, commit, dir: benchTmp('ws') })
    write(ws, quoted, '{"original":false}\n')

    await restoreForHiddenCheck(ws, commit)

    expect(read(ws, quoted)).toBe('{"original":true}\n')
  })

  it('rejects for a ref that is not in the repo', async () => {
    const { ws } = await setup('a')
    await expect(restoreForHiddenCheck(ws, 'f'.repeat(40))).rejects.toThrow()
  })
})
