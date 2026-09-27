import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  buildDockerArgs,
  buildScript,
  containerName,
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
 */
function fakeChild(opts: { exitCode?: number | null; delayMs?: number; never?: boolean; stdout?: string; stderr?: string }): FakeChild {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const done = new Promise<number | null>((resolvePromise) => {
    if (opts.never) return
    let pending = 2
    const onStreamEnd = () => {
      pending--
      if (pending === 0) resolvePromise(opts.exitCode ?? 0)
    }
    stdout.once('end', onStreamEnd)
    stderr.once('end', onStreamEnd)
    const settle = () => {
      if (opts.stdout !== undefined) stdout.end(opts.stdout)
      else stdout.end()
      if (opts.stderr !== undefined) stderr.end(opts.stderr)
      else stderr.end()
    }
    if (opts.delayMs) setTimeout(settle, opts.delayMs)
    else settle()
  })
  return {
    stdout,
    stderr,
    done,
    kill(): void {
      // no-op: this fake process is already "gone" once `done` settles or the test asserts on it
    },
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

describe('runInContainer: timeout', () => {
  it('kills the container and reports timedOut+stopped when the confirmation is empty', async () => {
    const { spawn, calls } = fakeSpawn({
      run: () => fakeChild({ never: true }),
      kill: () => fakeChild({ exitCode: 0 }),
      ps: () => fakeChild({ exitCode: 0, stdout: '' }),
    })
    const result = await runInContainer('verify', { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) }, { spawn })
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
    const result = await runInContainer('verify', { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) }, { spawn })
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
      { spawn, cleanupTimeoutMs: 30 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.cleanup).toBe('uncertain')
  }, 2000)

  it('reports uncertain when the container is still listed after the kill', async () => {
    const { spawn } = fakeSpawn({
      run: () => fakeChild({ never: true }),
      kill: () => fakeChild({ exitCode: 0 }),
      ps: () => fakeChild({ exitCode: 0, stdout: 'deadbeef1234\n' }),
    })
    const result = await runInContainer('verify', { name: 'harness-abc12345-verify-0', worktree: '/wt', task: TASK, script: 'noop', signal: AbortSignal.timeout(60_000) }, { spawn })
    expect(result.timedOut).toBe(true)
    expect(result.cleanup).toBe('uncertain')
  })
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
    const result = await runInContainer('prepare', { name: 'harness-abc12345-prepare-0', worktree: '/wt', task: TASK, script: 'noop', signal: controller.signal }, { spawn })
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
    const result = await runInContainer('prepare', { name: 'harness-abc12345-prepare-0', worktree: '/wt', task: TASK, script: 'noop', signal: controller.signal }, { spawn })
    expect(result.timedOut).toBe(true)
    expect(result.runnerError).toBe('afgebroken')
    expect(result.cleanup).toBe('uncertain')
  })
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
