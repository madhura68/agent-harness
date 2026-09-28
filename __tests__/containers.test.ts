import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  buildDockerArgs,
  buildScript,
  containerName,
  defaultSpawn,
  killLeftoverContainers,
  runInContainer,
  type SpawnFn,
} from '../src/worker/containers.js'
import type { TaskConfig } from '../src/worker/config.js'

const TASK: TaskConfig = {
  limits: { maxTurns: 6, maxOutputTokens: 2048, maxWallSeconds: 240, maxToolErrors: 2 },
  image: 'node:24-bookworm',
  uid: 1000,
  gid: 1000,
  npmCacheDir: '/cache/npm',
  prepareTimeoutSeconds: 1,
  verifyTimeoutSeconds: 1,
  maxVerifyRepairs: 3,
  recipes: [{ repoUrl: 'https://git.example/repo.git', prepare: ['npm ci'], verify: 'npm test' }],
}

type FakeChild = ReturnType<SpawnFn>

/**
 * A fake docker child: resolves `done` with `exitCode` after `delayMs`, or never resolves at all.
 * Mirrors the real `'close'`-based wiring in `defaultSpawn` — `done` only resolves once both streams
 * have actually finished emitting (i.e. after a consumer has drained them), never before, so a caller
 * that races `done` against the stream `'data'` events never sees a truncated read.
 *
 * `errorMessage` mirrors `defaultSpawn`'s optional field for a spawn `'error'`. `lateOnKill` simulates a
 * CLI child that keeps running (like `never: true`) until `kill()` is actually called, at which point it
 * flushes late output and settles — modelling a real `docker run` that only exits once the container
 * underneath it is confirmed gone.
 */
function fakeChild(opts: {
  exitCode?: number | null
  delayMs?: number
  never?: boolean
  stdout?: string
  stderr?: string
  errorMessage?: string
  lateOnKill?: { stdout?: string; stderr?: string; exitCode?: number | null; delayMs?: number }
}): FakeChild {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let resolveDone!: (code: number | null) => void
  const done = new Promise<number | null>((resolvePromise) => {
    resolveDone = resolvePromise
  })

  const finish = (outText: string | undefined, errText: string | undefined, code: number | null) => {
    let pending = 2
    const onStreamEnd = () => {
      pending--
      if (pending === 0) resolveDone(code)
    }
    stdout.once('end', onStreamEnd)
    stderr.once('end', onStreamEnd)
    stdout.end(outText ?? '')
    stderr.end(errText ?? '')
  }

  // `exitCode` is deliberately distinguished from "not provided": a fake modelling a spawn error or a
  // signal-killed CLI passes `exitCode: null` explicitly, which must stay `null`, not fall back to `0`
  // the way `?? 0` would (`null ?? 0` is `0`, same as `undefined ?? 0` — that would silently defeat every
  // "done resolves null" test in this file).
  const exitCodeOrDefault = (v: number | null | undefined) => (v === undefined ? 0 : v)

  if (!opts.never) {
    const settle = () => finish(opts.stdout, opts.stderr, exitCodeOrDefault(opts.exitCode))
    if (opts.delayMs) setTimeout(settle, opts.delayMs)
    else settle()
  }

  return {
    stdout,
    stderr,
    done,
    kill(): void {
      if (opts.lateOnKill) {
        const { stdout: out, stderr: err, exitCode, delayMs } = opts.lateOnKill
        const settleLate = () => finish(out, err, exitCodeOrDefault(exitCode))
        if (delayMs) setTimeout(settleLate, delayMs)
        else settleLate()
      }
    },
    errorMessage: () => opts.errorMessage,
  }
}

type Call = { cmd: string; args: string[] }

/** Routes fake docker calls by subcommand (args[0]): 'run' | 'kill' | 'ps' | 'rm'. Records every call. */
function fakeSpawn(handlers: Partial<Record<'run' | 'kill' | 'ps' | 'rm', () => FakeChild>>): { spawn: SpawnFn; calls: Call[] } {
  const calls: Call[] = []
  const spawn: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args })
    const sub = args[0] as 'run' | 'kill' | 'ps' | 'rm'
    const handler = handlers[sub]
    if (!handler) throw new Error(`onverwacht docker-subcommando in test: ${sub}`)
    return handler()
  }
  return { spawn, calls }
}

describe('buildScript', () => {
  it('prefixes the HOME setup and joins commands with &&', () => {
    expect(buildScript(['npm ci', 'npm run build'])).toBe('export HOME=/tmp/harness-home && mkdir -p "$HOME" && npm ci && npm run build')
  })

  it('wraps a single command the same way', () => {
    expect(buildScript(['npm test'])).toBe('export HOME=/tmp/harness-home && mkdir -p "$HOME" && npm test')
  })
})

describe('containerName', () => {
  it('formats as harness-<8 chars of jobId>-<kind>-<n>', () => {
    expect(containerName('abcdef1234567890', 'prepare', 0)).toBe('harness-abcdef12-prepare-0')
    expect(containerName('abcdef1234567890', 'verify', 3)).toBe('harness-abcdef12-verify-3')
  })

  it('does not pad a short jobId', () => {
    expect(containerName('ab', 'verify', 1)).toBe('harness-ab-verify-1')
  })
})

describe('buildDockerArgs', () => {
  const script = 'export HOME=/tmp/harness-home && mkdir -p "$HOME" && npm ci'

  it('builds the exact prepare argv', () => {
    const args = buildDockerArgs('prepare', { name: 'harness-abc12345-prepare-0', worktree: '/wt', image: 'node:24-bookworm', uid: 1000, gid: 1000, npmCacheDir: '/cache/npm', script })
    expect(args).toEqual([
      'run',
      '--rm',
      '--name',
      'harness-abc12345-prepare-0',
      '--cpus',
      '8',
      '--memory',
      '8g',
      '--user',
      '1000:1000',
      '-v',
      '/wt:/wt',
      '-v',
      '/cache/npm:/npm-cache',
      '-e',
      'npm_config_cache=/npm-cache',
      '-w',
      '/wt',
      'node:24-bookworm',
      'sh',
      '-c',
      script,
    ])
  })

  it('builds the exact verify argv: --network none, no -e, no --env-file, no cache mount', () => {
    const args = buildDockerArgs('verify', { name: 'harness-abc12345-verify-0', worktree: '/wt', image: 'node:24-bookworm', uid: 1000, gid: 1000, script })
    expect(args).toEqual([
      'run',
      '--rm',
      '--name',
      'harness-abc12345-verify-0',
      '--network',
      'none',
      '--cpus',
      '8',
      '--memory',
      '8g',
      '--user',
      '1000:1000',
      '-v',
      '/wt:/wt',
      '-w',
      '/wt',
      'node:24-bookworm',
      'sh',
      '-c',
      script,
    ])
    expect(args).not.toContain('--env-file')
    expect(args).not.toContain('-e')
    expect(args).not.toContain('--privileged')
  })
})

describe('runInContainer: normal exit', () => {
  it('passes the prepare exit code and output through, no cleanup field', async () => {
    const { spawn, calls } = fakeSpawn({ run: () => fakeChild({ exitCode: 0, stdout: 'up to date\n' }) })
    const result = await runInContainer('prepare', { name: 'harness-abc12345-prepare-0', worktree: '/wt', task: TASK, script: buildScript(TASK.recipes[0].prepare), signal: AbortSignal.timeout(60_000) }, { spawn })
    expect(result).toEqual({ exitCode: 0, output: 'up to date\n', timedOut: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('run')
    expect(calls[0].args).not.toContain('--network')
  })

  it('passes a nonzero verify exit code through and combines stdout+stderr', async () => {
    const { spawn } = fakeSpawn({ run: () => fakeChild({ exitCode: 1, stdout: 'ok\n', stderr: 'FAIL foo\n' }) })
    const result = await runInContainer('verify', { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: buildScript([TASK.recipes[0].verify]), signal: AbortSignal.timeout(60_000) }, { spawn })
    expect(result.exitCode).toBe(1)
    expect(result.timedOut).toBe(false)
    expect(result.output).toContain('ok\n')
    expect(result.output).toContain('FAIL foo\n')
    expect(result.cleanup).toBeUndefined()
  })

  it('bounds combined output to the last 64 kB', async () => {
    const big = 'x'.repeat(80 * 1024)
    const tailMarker = 'END-OF-OUTPUT'
    const { spawn } = fakeSpawn({ run: () => fakeChild({ exitCode: 0, stdout: big, stderr: tailMarker }) })
    const result = await runInContainer('verify', { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) }, { spawn })
    expect(result.output.length).toBeLessThanOrEqual(64 * 1024)
    expect(result.output).toContain(tailMarker)
    expect(result.output).not.toContain('x'.repeat(80 * 1024))
  })
})

describe('runInContainer: runner failure (done resolves null on the normal path)', () => {
  it('reports a runnerError instead of showing exitcode null as a test result', async () => {
    const { spawn } = fakeSpawn({ run: () => fakeChild({ exitCode: null, stdout: 'partial output\n' }) })
    const result = await runInContainer('verify', { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) }, { spawn })
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.runnerError).toBeDefined()
    expect(result.output).toContain('partial output\n')
  })

  it('includes the spawn error detail in runnerError when the SpawnFn provides one', async () => {
    const { spawn } = fakeSpawn({ run: () => fakeChild({ exitCode: null, errorMessage: 'ENOENT: docker niet gevonden' }) })
    const result = await runInContainer('prepare', { name: 'harness-abc12345-prepare-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) }, { spawn })
    expect(result.runnerError).toContain('ENOENT: docker niet gevonden')
  })

  it('the real defaultSpawn resolves done with null (not a throw) for a non-existent binary', async () => {
    const child = defaultSpawn('harness-test-definitely-not-a-real-binary-xyz', [], {})
    const code = await child.done
    expect(code).toBeNull()
  })
})

describe('runInContainer: timeout', () => {
  it('kills the container and reports timedOut+stopped when the confirmation is empty', async () => {
    const { spawn, calls } = fakeSpawn({
      run: () => fakeChild({ never: true }),
      kill: () => fakeChild({ exitCode: 0 }),
      ps: () => fakeChild({ exitCode: 0, stdout: '' }),
    })
    const result = await runInContainer(
      'verify',
      { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) },
      { spawn, killGraceMs: 20 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.cleanup).toBe('stopped')
    expect(result.runnerError).toBeUndefined()
    expect(result.exitCode).toBeNull()
    const killCall = calls.find((c) => c.args[0] === 'kill')
    expect(killCall?.args).toEqual(['kill', 'harness-abc12345-verify-0'])
    const psCall = calls.find((c) => c.args[0] === 'ps')
    expect(psCall?.args).toEqual(['ps', '-aq', '--filter', 'name=^harness-abc12345-verify-0$'])
  })

  it('reports uncertain when docker kill fails', async () => {
    const { spawn } = fakeSpawn({
      run: () => fakeChild({ never: true }),
      kill: () => fakeChild({ exitCode: 1 }),
      ps: () => fakeChild({ exitCode: 0, stdout: '' }),
    })
    const result = await runInContainer(
      'verify',
      { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) },
      { spawn, killGraceMs: 20 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.cleanup).toBe('uncertain')
  })

  it('reports uncertain when docker kill hangs past the cleanup bound', async () => {
    const { spawn } = fakeSpawn({
      run: () => fakeChild({ never: true }),
      kill: () => fakeChild({ never: true }),
    })
    const result = await runInContainer(
      'verify',
      { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) },
      { spawn, cleanupTimeoutMs: 30, killGraceMs: 20 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.cleanup).toBe('uncertain')
  }, 2000)

  it('reports uncertain when the container is still listed after the kill for the whole poll bound', async () => {
    const { spawn } = fakeSpawn({
      run: () => fakeChild({ never: true }),
      kill: () => fakeChild({ exitCode: 0 }),
      ps: () => fakeChild({ exitCode: 0, stdout: 'deadbeef1234\n' }),
    })
    const result = await runInContainer(
      'verify',
      { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) },
      { spawn, killGraceMs: 20, cleanupTimeoutMs: 60, pollIntervalMs: 10 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.cleanup).toBe('uncertain')
  }, 2000)

  it('polls past a --rm container still briefly listed and reports stopped once the listing goes empty', async () => {
    let psCalls = 0
    const { spawn, calls } = fakeSpawn({
      run: () => fakeChild({ never: true }),
      kill: () => fakeChild({ exitCode: 0 }),
      ps: () => {
        psCalls++
        // The first 2 polls still see the --rm container mid-removal; the 3rd poll finds it gone.
        return psCalls <= 2 ? fakeChild({ exitCode: 0, stdout: 'deadbeef1234\n' }) : fakeChild({ exitCode: 0, stdout: '' })
      },
    })
    const result = await runInContainer(
      'verify',
      { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) },
      { spawn, killGraceMs: 20, cleanupTimeoutMs: 2000, pollIntervalMs: 10 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.cleanup).toBe('stopped')
    expect(calls.filter((c) => c.args[0] === 'ps').length).toBe(3)
  }, 2000)

  it('reports uncertain within the bound when docker ps fails every time (a failing inspection is not proof of absence)', async () => {
    const { spawn } = fakeSpawn({
      run: () => fakeChild({ never: true }),
      kill: () => fakeChild({ exitCode: 0 }),
      ps: () => fakeChild({ exitCode: 1, stdout: '' }),
    })
    const start = Date.now()
    const result = await runInContainer(
      'verify',
      { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) },
      { spawn, killGraceMs: 20, cleanupTimeoutMs: 60, pollIntervalMs: 10 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.cleanup).toBe('uncertain')
    // Bounded by cleanupTimeoutMs (60 ms), not left to hang: generous margin for CI/test-runner jitter.
    expect(Date.now() - start).toBeLessThan(1800)
  }, 2000)
})

describe('runInContainer: kill grace period', () => {
  it('includes output that arrives from the CLI child between the kill and its own done, within the grace bound', async () => {
    const { spawn } = fakeSpawn({
      run: () => fakeChild({ never: true, lateOnKill: { stdout: 'late tail output\n', delayMs: 20 } }),
      kill: () => fakeChild({ exitCode: 0 }),
      ps: () => fakeChild({ exitCode: 0, stdout: '' }),
    })
    const result = await runInContainer(
      'verify',
      { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) },
      { spawn, killGraceMs: 500 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.output).toContain('late tail output\n')
  }, 2000)

  it('does not block unbounded when the CLI child never exits even after being killed', async () => {
    const { spawn } = fakeSpawn({
      run: () => fakeChild({ never: true }), // no lateOnKill: done never resolves, even once kill() is called
      kill: () => fakeChild({ exitCode: 0 }),
      ps: () => fakeChild({ exitCode: 0, stdout: '' }),
    })
    const start = Date.now()
    const result = await runInContainer(
      'verify',
      { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) },
      { spawn, killGraceMs: 50 },
    )
    expect(result.timedOut).toBe(true)
    // Baseline is TASK.verifyTimeoutSeconds (1s, the smallest zod allows) before the grace period even
    // starts; the assertion is against the *grace* bound (50 ms) adding only a small margin on top of
    // that, not against 0 — a `killGraceMs` that failed to bound anything would instead hang for
    // whatever real time the (never-resolving) `done` needed, which this repo has no reason to bound.
    expect(Date.now() - start).toBeLessThan(1400)
  }, 2000)
})

describe('runInContainer: abort', () => {
  it('cleans up and reports timedOut + runnerError afgebroken when aborted before starting', async () => {
    const { spawn, calls } = fakeSpawn({
      run: () => fakeChild({ never: true }),
      kill: () => fakeChild({ exitCode: 0 }),
      ps: () => fakeChild({ exitCode: 0, stdout: '' }),
    })
    const controller = new AbortController()
    controller.abort()
    const result = await runInContainer(
      'prepare',
      { name: 'harness-abc12345-prepare-0', worktree: '/wt', task: TASK, script: 'noop', signal: controller.signal },
      { spawn, killGraceMs: 20 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.runnerError).toBe('afgebroken')
    expect(result.cleanup).toBe('stopped')
    expect(calls.some((c) => c.args[0] === 'kill')).toBe(true)
  })

  it('can also report uncertain on an abort when the confirmation still finds the container', async () => {
    const { spawn } = fakeSpawn({
      run: () => fakeChild({ never: true }),
      kill: () => fakeChild({ exitCode: 0 }),
      ps: () => fakeChild({ exitCode: 0, stdout: 'deadbeef1234\n' }),
    })
    const controller = new AbortController()
    controller.abort()
    const result = await runInContainer(
      'prepare',
      { name: 'harness-abc12345-prepare-0', worktree: '/wt', task: TASK, script: 'noop', signal: controller.signal },
      { spawn, killGraceMs: 20, cleanupTimeoutMs: 60, pollIntervalMs: 10 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.runnerError).toBe('afgebroken')
    expect(result.cleanup).toBe('uncertain')
  }, 2000)
})

describe('killLeftoverContainers', () => {
  it('removes found ids with rm -f and reports clean when the recheck is empty', async () => {
    const { spawn, calls } = fakeSpawn({
      ps: (() => {
        let call = 0
        return () => {
          call++
          return fakeChild({ exitCode: 0, stdout: call === 1 ? 'id1\nid2\n' : '' })
        }
      })(),
      rm: () => fakeChild({ exitCode: 0 }),
    })
    const outcome = await killLeftoverContainers({ spawn })
    expect(outcome).toBe('clean')
    const rmCall = calls.find((c) => c.args[0] === 'rm')
    expect(rmCall?.args).toEqual(['rm', '-f', 'id1', 'id2'])
    expect(calls.filter((c) => c.args[0] === 'ps')).toHaveLength(2)
  })

  it('reports clean without calling rm -f when nothing is found', async () => {
    const { spawn, calls } = fakeSpawn({ ps: () => fakeChild({ exitCode: 0, stdout: '' }) })
    const outcome = await killLeftoverContainers({ spawn })
    expect(outcome).toBe('clean')
    expect(calls.some((c) => c.args[0] === 'rm')).toBe(false)
  })

  it('reports uncertain, never throws, when docker ps fails', async () => {
    const { spawn } = fakeSpawn({ ps: () => fakeChild({ exitCode: 1, stdout: '' }) })
    await expect(killLeftoverContainers({ spawn })).resolves.toBe('uncertain')
  })

  it('reports uncertain, bounded, when docker ps hangs', async () => {
    const { spawn } = fakeSpawn({ ps: () => fakeChild({ never: true }) })
    const outcome = await killLeftoverContainers({ spawn, cleanupTimeoutMs: 30 })
    expect(outcome).toBe('uncertain')
  }, 2000)

  it('reports uncertain when rm -f fails', async () => {
    const { spawn } = fakeSpawn({
      ps: (() => {
        let call = 0
        return () => {
          call++
          return fakeChild({ exitCode: 0, stdout: call === 1 ? 'id1\n' : '' })
        }
      })(),
      rm: () => fakeChild({ exitCode: 1 }),
    })
    const outcome = await killLeftoverContainers({ spawn })
    expect(outcome).toBe('uncertain')
  })

  it('reports uncertain when the recheck still finds an id', async () => {
    const { spawn } = fakeSpawn({
      ps: () => fakeChild({ exitCode: 0, stdout: 'id1\n' }),
      rm: () => fakeChild({ exitCode: 0 }),
    })
    const outcome = await killLeftoverContainers({ spawn })
    expect(outcome).toBe('uncertain')
  })
})
