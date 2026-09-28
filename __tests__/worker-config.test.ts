import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOC_TOOLS, findRecipe, loadWorkerConfig, normalizeRepoUrl, WorkerConfigSchema, workerMcpEnv } from '../src/worker/config.js'
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

  it('passes an optional contextTokens through to the limits', () => {
    const limits = { maxTurns: 8, maxOutputTokens: 4096, maxWallSeconds: 240, maxToolErrors: 2, contextTokens: 32768 }
    expect(WorkerConfigSchema.parse({ ...base, limits }).limits).toEqual(limits)
    expect(WorkerConfigSchema.safeParse({ ...base, limits: { ...limits, contextTokens: -1 } }).success).toBe(false)
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

describe('model.reasoningEffort', () => {
  it('accepts none/low/medium/high and leaves it unset by default', () => {
    expect(WorkerConfigSchema.parse(base).model.reasoningEffort).toBeUndefined()
    for (const e of ['none', 'low', 'medium', 'high']) {
      expect(WorkerConfigSchema.parse({ ...base, model: { ...base.model, reasoningEffort: e } }).model.reasoningEffort).toBe(e)
    }
  })

  it('rejects an unknown effort', () => {
    expect(WorkerConfigSchema.safeParse({ ...base, model: { ...base.model, reasoningEffort: 'off' } }).success).toBe(false)
  })

  it('the example worker config uses GSQ-RCO with thinking on and room for thinking tokens', () => {
    const cfg = loadWorkerConfig('examples/worker.json')
    expect(cfg.model.name).toBe('qwen3.8-gsq-rco:27b-iq3_s-text')
    expect(cfg.model.reasoningEffort).toBeUndefined()
    expect(cfg.limits).toMatchObject({ maxTurns: 8, maxOutputTokens: 4096 })
  })

  it('the example worker config carries the M3 task block (spec §4.1/§6 example limits, image and recipes)', () => {
    const cfg = loadWorkerConfig('examples/worker.json')
    expect(cfg.task).toBeDefined()
    expect(cfg.task).toMatchObject({
      limits: { maxTurns: 40, maxOutputTokens: 80000, maxWallSeconds: 2400, maxToolErrors: 8, contextTokens: 65536 },
      image: 'node:24-bookworm',
      uid: 1000,
      gid: 1000,
      npmCacheDir: '/var/lib/agent-harness/npm-cache',
      // Defaults from TaskConfigSchema, not set explicitly in the example.
      prepareTimeoutSeconds: 900,
      verifyTimeoutSeconds: 600,
      maxVerifyRepairs: 3,
    })
    expect(cfg.task?.recipes).toEqual([
      { repoUrl: 'https://git.jp-visser.nl/janpeter/agent-harness.git', prepare: ['npm ci'], verify: 'npm run verify' },
      {
        repoUrl: 'https://git.jp-visser.nl/janpeter/scrum4me-mcp.git',
        prepare: ['npm ci', 'npm run prisma:generate'],
        verify: 'npm run typecheck && npm run typecheck:tests && npx vitest run --exclude __tests__/ppe-bundle1-parity.test.ts',
      },
    ])
  })

  it('the example worker config adds the Forgejo askpass and repo-root env for the M3 task worker, still as ${VAR}', () => {
    const cfg = loadWorkerConfig('examples/worker.json')
    expect(cfg.mcp.env).toMatchObject({
      // Must match plan Task 13's install path (setup: "askpass-script naar /usr/local/lib/agent-harness/forgejo-askpass.sh") — a
      // mismatch here would leave GIT_ASKPASS pointing at a script that was never installed there (Fix 4).
      GIT_ASKPASS: '/usr/local/lib/agent-harness/forgejo-askpass.sh',
      GIT_TERMINAL_PROMPT: '0',
      FORGEJO_PUSH_TOKEN: '${FORGEJO_PUSH_TOKEN}',
      SCRUM4ME_AGENT_WORKTREE_DIR: '/var/lib/agent-harness/worktrees',
      SCRUM4ME_REPO_ROOT_cmuhjw9e80003mt7rq4w3sauu: '/var/lib/agent-harness/repos/agent-harness',
      'SCRUM4ME_REPO_ROOT_REPO_scrum4me-mcp': '/var/lib/agent-harness/repos/scrum4me-mcp',
    })
    // No real secret value anywhere in the example config.
    expect(JSON.stringify(cfg)).not.toMatch(/FORGEJO_PUSH_TOKEN":\s*"(?!\$\{)/)
  })
})

const taskLimits = { maxTurns: 40, maxOutputTokens: 8000, maxWallSeconds: 2400, maxToolErrors: 8 }
const recipe = { repoUrl: 'https://git.jp-visser.nl/janpeter/Scrum4Me.git', prepare: ['npm ci'], verify: 'npm run verify' }
const minimalTask = { limits: taskLimits, image: 'node:24-bookworm', uid: 1000, gid: 1000, npmCacheDir: '/var/cache/npm', recipes: [recipe] }

describe('TaskConfigSchema (worker config task block)', () => {
  it('is undefined when the config has no task block', () => {
    const cfg = WorkerConfigSchema.parse(base)
    expect(cfg.task).toBeUndefined()
  })

  it('fills prepareTimeoutSeconds, verifyTimeoutSeconds and maxVerifyRepairs with defaults', () => {
    const cfg = WorkerConfigSchema.parse({ ...base, task: minimalTask })
    expect(cfg.task).toBeDefined()
    expect(cfg.task?.prepareTimeoutSeconds).toBe(900)
    expect(cfg.task?.verifyTimeoutSeconds).toBe(600)
    expect(cfg.task?.maxVerifyRepairs).toBe(3)
    expect(cfg.task?.limits).toEqual(taskLimits)
    expect(cfg.task?.image).toBe('node:24-bookworm')
    expect(cfg.task?.uid).toBe(1000)
    expect(cfg.task?.gid).toBe(1000)
    expect(cfg.task?.npmCacheDir).toBe('/var/cache/npm')
  })

  it('rejects an empty recipes array', () => {
    const r = WorkerConfigSchema.safeParse({ ...base, task: { ...minimalTask, recipes: [] } })
    expect(r.success).toBe(false)
  })

  it('accepts explicit overrides for the timeout/repair defaults', () => {
    const cfg = WorkerConfigSchema.parse({ ...base, task: { ...minimalTask, prepareTimeoutSeconds: 120, verifyTimeoutSeconds: 60, maxVerifyRepairs: 1 } })
    expect(cfg.task).toMatchObject({ prepareTimeoutSeconds: 120, verifyTimeoutSeconds: 60, maxVerifyRepairs: 1 })
  })
})

describe('normalizeRepoUrl', () => {
  it('lowercases the host and strips a trailing slash and .git suffix', () => {
    expect(normalizeRepoUrl('https://git.jp-visser.nl/janpeter/Scrum4Me.git')).toBe('https://git.jp-visser.nl/janpeter/Scrum4Me')
    expect(normalizeRepoUrl('https://Git.JP-Visser.NL/janpeter/Scrum4Me')).toBe('https://git.jp-visser.nl/janpeter/Scrum4Me')
    expect(normalizeRepoUrl('https://git.jp-visser.nl/janpeter/Scrum4Me/')).toBe('https://git.jp-visser.nl/janpeter/Scrum4Me')
    expect(normalizeRepoUrl('  https://git.jp-visser.nl/janpeter/Scrum4Me.git  ')).toBe('https://git.jp-visser.nl/janpeter/Scrum4Me')
  })
})

describe('findRecipe', () => {
  const task = WorkerConfigSchema.parse({ ...base, task: minimalTask }).task!

  it.each([
    'https://git.jp-visser.nl/janpeter/Scrum4Me.git',
    'https://git.jp-visser.nl/janpeter/Scrum4Me',
    'https://git.jp-visser.nl/janpeter/Scrum4Me/',
    'https://GIT.JP-VISSER.NL/janpeter/Scrum4Me.git',
  ])('matches %s against the configured repoUrl', (url) => {
    expect(findRecipe(task, url)).toEqual(recipe)
  })

  it('returns undefined for an unknown repo', () => {
    expect(findRecipe(task, 'https://git.jp-visser.nl/janpeter/other-repo.git')).toBeUndefined()
  })
})
