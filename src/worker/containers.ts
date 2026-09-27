import { spawn as spawnChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { TaskConfig } from './config.js'
import type { VerifyRun } from './task-tools.js'

/** A running `docker` invocation: streamed output, an exit promise, and a hard-stop handle. */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { signal?: AbortSignal },
) => { stdout: Readable; stderr: Readable; done: Promise<number | null>; kill(): void }

/** Test seam shared by `runInContainer` and `killLeftoverContainers`. Production callers pass neither field. */
export type ContainerDeps = { spawn?: SpawnFn; cleanupTimeoutMs?: number }

const HOME_PREFIX = 'export HOME=/tmp/harness-home && mkdir -p "$HOME" && '
/** Combined stdout+stderr kept per container run; `run_tests` (task-tools.ts) truncates further for the model. */
const OUTPUT_TAIL_BYTES = 64 * 1024
/** Bound for every cleanup docker call (kill, ps, rm -f): a hung docker CLI must not hang the worker. */
const DEFAULT_CLEANUP_TIMEOUT_MS = 20_000
const LEFTOVER_FILTER = 'name=^harness-'

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Every prepare/verify script runs as `export HOME=... && mkdir -p "$HOME" && <commands>`: the container user has no passwd entry and thus no writable home. */
export function buildScript(commands: string[]): string {
  return HOME_PREFIX + commands.join(' && ')
}

/** `harness-<first 8 chars of jobId>-<kind>-<n>`, used both as `docker run --name` and later as the `--filter name=^...$` target. */
export function containerName(jobId: string, kind: 'prepare' | 'verify', n: number): string {
  return `harness-${jobId.slice(0, 8)}-${kind}-${n}`
}

/**
 * Exact `docker` argv for one prepare or verify run. Fragile contract (spec 4.5 / plan Task 9) — do not
 * reorder or add flags: never `--env-file`, never another `-e`, never `--privileged`, no other mounts.
 * `--network none` only for verify; the npm-cache mount and its `-e` only for prepare.
 */
export function buildDockerArgs(
  kind: 'prepare' | 'verify',
  o: { name: string; worktree: string; image: string; uid: number; gid: number; npmCacheDir?: string; script: string },
): string[] {
  const args = ['run', '--rm', '--name', o.name]
  if (kind === 'verify') args.push('--network', 'none')
  args.push('--cpus', '8', '--memory', '8g', '--user', `${o.uid}:${o.gid}`, '-v', `${o.worktree}:${o.worktree}`)
  if (kind === 'prepare') args.push('-v', `${o.npmCacheDir}:/npm-cache`, '-e', 'npm_config_cache=/npm-cache')
  args.push('-w', o.worktree, o.image, 'sh', '-c', o.script)
  return args
}

/**
 * Default `SpawnFn`: wraps `node:child_process.spawn`, stdout/stderr piped, no stdin. Never throws
 * synchronously — a spawn error resolves `done` with `null`, same as an exit by signal. Uses `'close'`
 * rather than `'exit'`: `'exit'` can fire before the stdio pipes finish flushing, which would let the
 * caller race ahead and miss trailing output.
 */
function defaultSpawn(cmd: string, args: string[], opts: { signal?: AbortSignal }): ReturnType<SpawnFn> {
  const child = spawnChildProcess(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal })
  const done = new Promise<number | null>((resolvePromise) => {
    child.once('close', (code) => resolvePromise(code))
    child.once('error', () => resolvePromise(null))
  })
  return {
    stdout: child.stdout as Readable,
    stderr: child.stderr as Readable,
    done,
    kill(): void {
      child.kill('SIGKILL')
    },
  }
}

/** Keeps only the last `limit` bytes written across both streams combined, without splitting mid-write. */
class TailBuffer {
  private chunks: Buffer[] = []
  private total = 0
  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.total += chunk.length
    while (this.total > this.limit && this.chunks.length > 0) {
      const excess = this.total - this.limit
      const first = this.chunks[0]
      if (first.length <= excess) {
        this.total -= first.length
        this.chunks.shift()
      } else {
        this.chunks[0] = first.subarray(excess)
        this.total -= excess
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

type BoundedResult = { code: number | null; output: string; timedOut: boolean }

/**
 * Runs one `docker <args>` call bounded to `timeoutMs`, collecting stdout+stderr as text. Never throws:
 * a synchronous spawn failure or a rejected `done` both come back as `{ code: null, timedOut: false }`.
 * A run that outlives `timeoutMs` is reported `timedOut: true` regardless of whether the underlying
 * `SpawnFn` actually honours the abort signal — the bound must hold even against a hung docker CLI.
 */
function runDockerBounded(spawn: SpawnFn, args: string[], timeoutMs: number): Promise<BoundedResult> {
  return new Promise((resolvePromise) => {
    const controller = new AbortController()
    let child: ReturnType<SpawnFn>
    try {
      child = spawn('docker', args, { signal: controller.signal })
    } catch (err) {
      resolvePromise({ code: null, output: message(err), timedOut: false })
      return
    }
    let out = ''
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    child.stderr.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      controller.abort()
      try {
        child.kill()
      } catch {
        // best effort; the run is already being reported as timed out
      }
      resolvePromise({ code: null, output: out, timedOut: true })
    }, timeoutMs)
    child.done.then(
      (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ code, output: out, timedOut: false })
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ code: null, output: out, timedOut: false })
      },
    )
  })
}

/**
 * `docker kill <name>` then `docker ps -aq --filter name=^<name>$` to confirm it is actually gone, each
 * bounded to its own `cleanupTimeoutMs` (never the already-aborted run signal). `'stopped'` only when
 * both calls succeed and the confirmation is empty; anything else — kill fails, either call hangs past
 * the bound, or the container is still listed — is `'uncertain'`: a failed inspection is not proof the
 * container is gone.
 */
async function cleanupContainer(name: string, spawn: SpawnFn, cleanupTimeoutMs: number): Promise<'stopped' | 'uncertain'> {
  try {
    const kill = await runDockerBounded(spawn, ['kill', name], cleanupTimeoutMs)
    if (kill.timedOut || kill.code !== 0) return 'uncertain'
    const ps = await runDockerBounded(spawn, ['ps', '-aq', '--filter', `name=^${name}$`], cleanupTimeoutMs)
    if (ps.timedOut || ps.code !== 0) return 'uncertain'
    return ps.output.trim() === '' ? 'stopped' : 'uncertain'
  } catch {
    return 'uncertain'
  }
}

/**
 * Runs the prepare or verify script in a throwaway container and reports the outcome as a `VerifyRun`.
 * A normal exit passes the exit code through untouched. A timeout (`prepareTimeoutSeconds` /
 * `verifyTimeoutSeconds`) or an abort via `o.signal` both kill the container (the `docker run` CLI child
 * alone is not enough — only `docker kill <name>` reaches the container itself) and report
 * `timedOut: true`; an abort additionally sets `runnerError: 'afgebroken'`. `cleanup` is set only on
 * that timeout/abort path, never on a normal exit.
 */
export async function runInContainer(
  kind: 'prepare' | 'verify',
  o: { name: string; worktree: string; task: TaskConfig; script: string; signal: AbortSignal },
  deps?: ContainerDeps,
): Promise<VerifyRun> {
  const spawn = deps?.spawn ?? defaultSpawn
  const cleanupTimeoutMs = deps?.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
  const timeoutSeconds = kind === 'prepare' ? o.task.prepareTimeoutSeconds : o.task.verifyTimeoutSeconds
  const args = buildDockerArgs(kind, {
    name: o.name,
    worktree: o.worktree,
    image: o.task.image,
    uid: o.task.uid,
    gid: o.task.gid,
    npmCacheDir: o.task.npmCacheDir,
    script: o.script,
  })

  let child: ReturnType<SpawnFn>
  try {
    child = spawn('docker', args, { signal: o.signal })
  } catch (err) {
    return { exitCode: null, output: '', timedOut: false, runnerError: `docker kon niet starten: ${message(err)}` }
  }

  const tail = new TailBuffer(OUTPUT_TAIL_BYTES)
  child.stdout.on('data', (c: Buffer) => tail.push(c))
  child.stderr.on('data', (c: Buffer) => tail.push(c))

  const donePromise = child.done.then(
    (code) => ({ kind: 'exit' as const, code }),
    () => ({ kind: 'exit' as const, code: null }),
  )
  let timer!: NodeJS.Timeout
  const timeoutPromise = new Promise<{ kind: 'timeout' }>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise({ kind: 'timeout' }), timeoutSeconds * 1000)
  })
  let onAbort!: () => void
  const abortPromise = new Promise<{ kind: 'abort' }>((resolvePromise) => {
    onAbort = () => resolvePromise({ kind: 'abort' })
    if (o.signal.aborted) onAbort()
    else o.signal.addEventListener('abort', onAbort, { once: true })
  })

  const outcome = await Promise.race([donePromise, timeoutPromise, abortPromise])
  clearTimeout(timer)
  o.signal.removeEventListener('abort', onAbort)

  if (outcome.kind === 'exit') {
    return { exitCode: outcome.code, output: tail.toString(), timedOut: false }
  }

  const cleanup = await cleanupContainer(o.name, spawn, cleanupTimeoutMs)
  try {
    child.kill()
  } catch {
    // best effort: the container itself is already handled via cleanupContainer
  }

  const result: VerifyRun = { exitCode: null, output: tail.toString(), timedOut: true, cleanup }
  if (outcome.kind === 'abort') result.runnerError = 'afgebroken'
  return result
}

/**
 * Removes any `harness-*` container still around after a crash or a SIGKILL of the worker itself:
 * `docker ps -aq --filter name=^harness-`, `docker rm -f` on the hits, then the same `ps` again.
 * `'clean'` only when that final check succeeds and is empty — any failure, hang, or remaining hit is
 * `'uncertain'` (a failed inspection is not proof of absence). Every docker call is bounded to
 * `cleanupTimeoutMs`; this function never throws.
 */
export async function killLeftoverContainers(deps?: ContainerDeps): Promise<'clean' | 'uncertain'> {
  const spawn = deps?.spawn ?? defaultSpawn
  const cleanupTimeoutMs = deps?.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
  try {
    const first = await runDockerBounded(spawn, ['ps', '-aq', '--filter', LEFTOVER_FILTER], cleanupTimeoutMs)
    if (first.timedOut || first.code !== 0) return 'uncertain'
    const ids = first.output
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length > 0) {
      const rm = await runDockerBounded(spawn, ['rm', '-f', ...ids], cleanupTimeoutMs)
      if (rm.timedOut || rm.code !== 0) return 'uncertain'
    }
    const second = await runDockerBounded(spawn, ['ps', '-aq', '--filter', LEFTOVER_FILTER], cleanupTimeoutMs)
    if (second.timedOut || second.code !== 0) return 'uncertain'
    return second.output.trim() === '' ? 'clean' : 'uncertain'
  } catch {
    return 'uncertain'
  }
}
