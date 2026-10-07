import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelClient, type ModelClient } from '../../src/model-client.js'
import { WorkerConfigSchema, type WorkerConfig } from '../../src/worker/config.js'

/** The configuration every test job asks for, unless it says otherwise (a valid configuration name: spec §4). */
export const TEST_CONFIGURATION = 'qwen3-coder-30b'
/** The LiteLLM address of a test config that never reaches a LiteLLM. */
export const TEST_LITELLM = 'http://127.0.0.1:4000/v1'

let litellmFiles: { configPath: string; composePath: string } | undefined

/**
 * The two LiteLLM files of a test config (spec §4.2: the probe hash covers their contents), written once per process into a temp dir.
 * They hold obviously fake text: nothing reads them but the hash.
 */
export function testLitellmFiles(): { configPath: string; composePath: string } {
  if (litellmFiles) return litellmFiles
  const dir = mkdtempSync(join(tmpdir(), 'harness-litellm-'))
  litellmFiles = { configPath: join(dir, 'config.yaml'), composePath: join(dir, 'compose.yaml') }
  writeFileSync(litellmFiles.configPath, 'model_list: []\n')
  writeFileSync(litellmFiles.composePath, 'services: {}\n')
  return litellmFiles
}

/** The raw worker config of a test (the input of the schema, so a test can break it), with one configuration. */
export function workerConfigInput(over: Record<string, unknown> = {}, litellmBaseUrl = TEST_LITELLM): Record<string, unknown> {
  return {
    litellm: { baseUrl: litellmBaseUrl, ...testLitellmFiles() },
    configurations: { [TEST_CONFIGURATION]: { costMode: 'local', contextTokens: 32768 } },
    mcp: { command: 'unused', args: [] },
    ...over,
  }
}

/** A valid worker config for tests: LiteLLM at `litellmBaseUrl` and the configuration `TEST_CONFIGURATION`. */
export function testWorkerConfig(over: Record<string, unknown> = {}, litellmBaseUrl = TEST_LITELLM): WorkerConfig {
  return WorkerConfigSchema.parse(workerConfigInput(over, litellmBaseUrl))
}

/** One model client per configuration of `config`, the way `harness worker` builds them. */
export function testModelClients(config: WorkerConfig, apiKey?: string): Record<string, ModelClient> {
  return Object.fromEntries(
    Object.entries(config.configurations).map(([name, c]) => [
      name,
      createModelClient({ baseUrl: config.litellm.baseUrl, name, apiKey, reasoningEffort: c.reasoningEffort, extraBody: c.extraBody }),
    ]),
  )
}

/** What `openRunLog` is given for a test job: the configuration of the job as the product derives it, with a fixed ceiling. */
export function testRunLogInit(config: WorkerConfig, claim: { jobId: string; kind: string }, over: Record<string, unknown> = {}) {
  return {
    jobId: claim.jobId,
    kind: claim.kind,
    model: { name: TEST_CONFIGURATION, baseUrl: config.litellm.baseUrl },
    costMode: config.configurations[TEST_CONFIGURATION].costMode,
    maxCostUsd: '0.05',
    version: 'agent-harness@test',
    secrets: [] as string[],
    ...over,
  }
}
