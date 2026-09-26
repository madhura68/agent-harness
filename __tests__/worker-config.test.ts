import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOC_TOOLS, loadWorkerConfig, WorkerConfigSchema, workerMcpEnv } from '../src/worker/config.js'
import { ManifestError } from '../src/manifest.js'

const base = {
  model: { baseUrl: 'http://127.0.0.1:11434/v1', name: 'qwen3-coder:30b' },
  mcp: { command: 'node', args: ['server.js'], env: { SCRUM4ME_TOKEN: '${SCRUM4ME_TOKEN}' } },
}

function writeConfig(cfg: unknown): string {
  const p = join(mkdtempSync(join(tmpdir(), 'harness-wcfg-')), 'worker.json')
  writeFileSync(p, JSON.stringify(cfg))
  return p
}

describe('WorkerConfigSchema', () => {
  it('fills defaults for allow, limits and waitSeconds', () => {
    const cfg = WorkerConfigSchema.parse(base)
    expect(cfg.allow).toEqual([...DOC_TOOLS])
    expect(cfg.limits).toEqual({ maxTurns: 6, maxOutputTokens: 2048, maxWallSeconds: 240, maxToolErrors: 2 })
    expect(cfg.waitSeconds).toBe(300)
  })

  it.each(['update_job_status', 'wait_for_job', 'job_heartbeat', 'update_idea'])('rejects %s in allow, naming it', (tool) => {
    const r = WorkerConfigSchema.safeParse({ ...base, allow: ['search_product_docs', tool] })
    expect(r.success).toBe(false)
    const msg = r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    expect(msg).toContain('allow')
    expect(msg).toContain(tool)
  })

  it('accepts a subset of the doc tools', () => {
    expect(WorkerConfigSchema.parse({ ...base, allow: ['get_product_doc'] }).allow).toEqual(['get_product_doc'])
  })
})

describe('loadWorkerConfig', () => {
  it('expands nothing', () => {
    const cfg = loadWorkerConfig(writeConfig(base))
    expect(cfg.mcp.env).toEqual({ SCRUM4ME_TOKEN: '${SCRUM4ME_TOKEN}' })
  })

  it('reports an invalid config as ManifestError with the path', () => {
    const p = writeConfig({ ...base, allow: ['update_job_status'] })
    expect(() => loadWorkerConfig(p)).toThrow(ManifestError)
    expect(() => loadWorkerConfig(p)).toThrow(/allow/)
  })

  it('reports an unreadable file as ManifestError', () => {
    expect(() => loadWorkerConfig('/nonexistent/worker.json')).toThrow(ManifestError)
  })
})

describe('workerMcpEnv', () => {
  it('forces local_llm and CLAUDE over whatever the config says', () => {
    const cfg = WorkerConfigSchema.parse({
      ...base,
      mcp: { ...base.mcp, env: { ...base.mcp.env, SCRUM4ME_WORKER_CAPABILITIES: 'code_edit', SCRUM4ME_WORKER_RUNTIME: 'CODEX' } },
    })
    const env = workerMcpEnv(cfg, { SCRUM4ME_TOKEN: 'tok' })
    expect(env).toEqual({ SCRUM4ME_TOKEN: 'tok', SCRUM4ME_WORKER_CAPABILITIES: 'local_llm', SCRUM4ME_WORKER_RUNTIME: 'CLAUDE' })
  })

  it('names an unset variable', () => {
    const cfg = WorkerConfigSchema.parse(base)
    expect(() => workerMcpEnv(cfg, {})).toThrow(/SCRUM4ME_TOKEN/)
  })

  it('works without mcp.env', () => {
    const cfg = WorkerConfigSchema.parse({ ...base, mcp: { command: 'node', args: [] } })
    expect(workerMcpEnv(cfg, {})).toEqual({ SCRUM4ME_WORKER_CAPABILITIES: 'local_llm', SCRUM4ME_WORKER_RUNTIME: 'CLAUDE' })
  })
})
