import { PassThrough } from 'node:stream'
import type { SpawnFn } from '../../src/worker/containers.js'

/** What one `docker run` is asked to do: the container name, the work tree it mounts (`-w`), the script it runs, and what that script is. */
export type DockerRun = {
  name: string
  work: string
  script: string
  /** `hidden` is the hidden check (it runs vitest with the JSON reporter); the other two are told apart by the container name. */
  purpose: 'prepare' | 'verify' | 'hidden'
}

/** How one container behaves. The default is a green run that does nothing. */
export type DockerStep = {
  /** Exit code of the `docker run` CLI; `null` is "no exit code" (the CLI ended by a signal). Default 0. */
  code?: number | null
  /** What the container prints. */
  out?: string
  /** The container never ends by itself: a `docker kill` of its name (or `kill()` on the child) ends it. */
  hang?: boolean
  /** The container ends only after this many milliseconds (a slow answer); by default it ends on the next tick. */
  delayMs?: number
  /** Runs at once when the container starts, with the container in hand. For a test that wants to act "while it runs". */
  onStart?: (run: DockerRun) => void
  /** The work the container does in the work tree; it runs just before a container that does not hang ends. */
  effect?: (run: DockerRun) => void
}

export type FakeDockerOptions = {
  /** Steps per kind of container, used in the order the containers start; once used up, a container is the default step. */
  prepare?: DockerStep[]
  /** The verify containers of the model loop: `run_tests` and the gate. */
  verify?: DockerStep[]
  hidden?: DockerStep[]
  /** Exit code of `docker kill`. 1 makes the cleanup of a container end `uncertain`. Default 0. */
  killCode?: number
  /** `docker kill` answers only after this many milliseconds: the cleanup of a container stays in flight for that long. */
  killDelayMs?: number
}

type FakeChild = ReturnType<SpawnFn>

function fakeChild(step: DockerStep, run?: DockerRun): FakeChild {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let resolveDone!: (code: number | null) => void
  const done = new Promise<number | null>((r) => (resolveDone = r))
  let finished = false
  const finish = (code: number | null) => {
    if (finished) return
    finished = true
    let pending = 2
    const onEnd = () => {
      if (--pending === 0) resolveDone(code)
    }
    stdout.once('end', onEnd)
    stderr.once('end', onEnd)
    stdout.end(step.out ?? '')
    stderr.end('')
    stdout.resume()
    stderr.resume()
  }
  if (!step.hang) {
    const settle = () => {
      if (run) step.effect?.(run)
      finish(step.code === undefined ? 0 : step.code)
    }
    if (step.delayMs) setTimeout(settle, step.delayMs)
    else setImmediate(settle)
  }
  return { stdout, stderr, done, kill: () => finish(null) }
}

function parseRun(args: string[]): DockerRun {
  const name = args[args.indexOf('--name') + 1]
  const script = args[args.length - 1]
  const purpose = script.includes('vitest run --reporter=json') ? 'hidden' : name.includes('-prepare-') ? 'prepare' : 'verify'
  return { name, work: args[args.indexOf('-w') + 1], script, purpose }
}

/**
 * A stand-in for the `docker` CLI behind `ContainerDeps.spawn`: it answers `run`, `kill`, `ps` and `rm` and records them, so that
 * a test can say what each container does and afterwards see what was started, killed and cleaned up. It never starts a process.
 */
export function fakeDocker(o: FakeDockerOptions = {}) {
  const calls: string[][] = []
  const runs: DockerRun[] = []
  const steps = { prepare: [...(o.prepare ?? [])], verify: [...(o.verify ?? [])], hidden: [...(o.hidden ?? [])] }
  const spawn: SpawnFn = (_cmd, args) => {
    calls.push(args)
    switch (args[0]) {
      case 'run': {
        const run = parseRun(args)
        runs.push(run)
        const step = steps[run.purpose].shift() ?? {}
        step.onStart?.(run)
        return fakeChild(step, run)
      }
      case 'kill':
        return fakeChild({ code: o.killCode ?? 0, delayMs: o.killDelayMs })
      case 'ps':
        return fakeChild({ code: 0, out: '' }) // the killed container is gone
      case 'rm':
        return fakeChild({ code: 0 })
      default:
        throw new Error(`onverwacht docker-subcommando: ${args[0]}`)
    }
  }
  return { spawn, calls, runs, kills: () => calls.filter((a) => a[0] === 'kill').map((a) => a[1]) }
}
