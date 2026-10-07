import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeDir } from '../../src/probe.js'
import { loadWorkerConfig, type WorkerConfig } from '../../src/worker/config.js'
import { configurationHash, litellmFileHashes } from '../../src/worker/probe-gate.js'

/** What `harness probe --config` writes for an accepted configuration, as far as the per-job gate reads it. `over` replaces fields. */
export function acceptedProbe(config: WorkerConfig, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const configuration = config.configurations[name]
  return {
    baseUrl: config.litellm.baseUrl,
    model: name,
    configuration: name,
    costMode: configuration.costMode,
    hash: configurationHash({ name, ...configuration }, litellmFileHashes(config.litellm)),
    accepted: true,
    reasons: [],
    tool_calling: 'reliable',
    ...over,
  }
}

/** Writes `<out>/probe-<name>/probe.json` for one configuration and returns the path of the file. */
export function seedProbe(config: WorkerConfig, out: string, name: string, over: Record<string, unknown> = {}): string {
  const dir = probeDir(out, name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'probe.json')
  writeFileSync(file, JSON.stringify(acceptedProbe(config, name, over), null, 2) + '\n')
  return file
}

/** An accepted probe for every configuration of the config: what a worker test needs for its jobs to get past the gate. */
export function seedProbes(config: WorkerConfig, out: string): void {
  for (const name of Object.keys(config.configurations)) seedProbe(config, out, name)
}

/**
 * seedProbes for a config file a CLI test wrote. A file that does not load is left alone: such a test is about the refusal, and
 * the worker never reaches a job.
 */
export function seedProbesForConfigFile(configPath: string, out: string): void {
  try {
    seedProbes(loadWorkerConfig(configPath), out)
  } catch {
    // not a loadable config: nothing to probe
  }
}
