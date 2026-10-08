import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'

/**
 * spawnSync for tests that run scripts: the child gets its own process group, and when the call returns (also after a timeout) the
 * whole group is killed, so a regression never leaves an orphan node or bash process behind (spawnSync's own timeout only kills the child).
 */
export function spawnGroup(cmd: string, args: string[], opts: Omit<SpawnSyncOptionsWithStringEncoding, 'detached' | 'encoding'> & { encoding?: 'utf8' } = {}): SpawnSyncReturns<string> {
  const res = spawnSync(cmd, args, { ...opts, encoding: 'utf8', detached: true })
  if (res.pid) {
    try {
      process.kill(-res.pid, 'SIGKILL')
    } catch {
      // the group is already gone: that is the normal case
    }
  }
  return res
}
