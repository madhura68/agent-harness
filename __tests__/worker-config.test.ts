import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOC_TOOLS, findRecipe, loadWorkerConfig, normalizeRepoUrl, WorkerConfigSchema, workerMcpEnv } from '../src/worker/config.js'
import { ManifestError } from '../src/manifest.js'

const base = {
  litellm: { baseUrl: 'http://127.0.0.1:4000/v1', configPath: '/etc/agent-harness/litellm/config.yaml', composePath: '/etc/agent-harness/litellm/compose.yaml' },
  configurations: { 'qwen3-coder-30b': { costMode: 'local', contextTokens: 32768 } },
  mcp: { command: 'node', args: ['server.js'], env: { SCRUM4ME_TOKEN: '${SCRUM4ME_TOKEN}' } },
}

/** The messages of the issues a parse of `input` gives, as `path: message` lines; empty when it parses. */
function issuesOf(input: unknown): string {
  const r = WorkerConfigSchema.safeParse(input)
  return r.success ? '' : r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
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

  it('refuses contextTokens in limits: the context window belongs to the configuration', () => {
    const limits = { maxTurns: 8, maxOutputTokens: 4096, maxWallSeconds: 240, maxToolErrors: 2 }
    expect(WorkerConfigSchema.parse({ ...base, limits }).limits).toEqual(limits)
    const r = WorkerConfigSchema.safeParse({ ...base, limits: { ...limits, contextTokens: 32768 } })
    expect(r.success).toBe(false)
    expect(issuesOf({ ...base, limits: { ...limits, contextTokens: 32768 } })).toContain('limits')
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
  it('forces HARNESS without a capability over whatever the config says', () => {
    const cfg = WorkerConfigSchema.parse({
      ...base,
      mcp: { ...base.mcp, env: { ...base.mcp.env, SCRUM4ME_WORKER_CAPABILITIES: 'code_edit', SCRUM4ME_WORKER_RUNTIME: 'CODEX' } },
    })
    const env = workerMcpEnv(cfg, { SCRUM4ME_TOKEN: 'tok' })
    expect(env).toEqual({ SCRUM4ME_TOKEN: 'tok', SCRUM4ME_WORKER_CAPABILITIES: '', SCRUM4ME_WORKER_RUNTIME: 'HARNESS' })
  })

  it('names an unset variable', () => {
    const cfg = WorkerConfigSchema.parse(base)
    expect(() => workerMcpEnv(cfg, {})).toThrow(/SCRUM4ME_TOKEN/)
  })

  it('works without mcp.env', () => {
    const cfg = WorkerConfigSchema.parse({ ...base, mcp: { command: 'node', args: [] } })
    expect(workerMcpEnv(cfg, {})).toEqual({ SCRUM4ME_WORKER_CAPABILITIES: '', SCRUM4ME_WORKER_RUNTIME: 'HARNESS' })
  })
})

// Row 1 of the T-2065 table: the schema is strict at every level, and a configuration carries what the model needs.
const taskBlock = {
  limits: { maxTurns: 40, maxOutputTokens: 80000, maxWallSeconds: 2400, maxToolErrors: 8 },
  image: 'node:24-bookworm',
  uid: 1000,
  gid: 1000,
  npmCacheDir: '/c',
  recipes: [{ repoUrl: 'https://git.jp-visser.nl/janpeter/agent-harness.git', prepare: ['npm ci'], verify: 'npm run verify' }],
}

describe('strict schema', () => {
  it('refuses the old model block, naming it', () => {
    const issues = issuesOf({ ...base, model: { baseUrl: 'http://127.0.0.1:11434/v1', name: 'qwen3-coder:30b' } })
    expect(issues).toContain('model')
  })

  it.each([
    ['at the top', (c: Record<string, unknown>) => ({ ...c, extra: 1 }), 'extra'],
    ['in litellm', (c: Record<string, unknown>) => ({ ...c, litellm: { ...(c.litellm as object), extra: 1 } }), 'litellm'],
    ['in a configuration', (c: Record<string, unknown>) => ({ ...c, configurations: { 'qwen3-coder-30b': { costMode: 'local', contextTokens: 1, extra_body: {} } } }), 'extra_body'],
    ['in mcp', (c: Record<string, unknown>) => ({ ...c, mcp: { ...(c.mcp as object), cwd: '/x' } }), 'mcp'],
    ['in limits', (c: Record<string, unknown>) => ({ ...c, limits: { maxTurns: 1, maxOutputTokens: 1, maxWallSeconds: 1, maxToolErrors: 0, maxTurn: 2 } }), 'maxTurn'],
    ['in workerLog', (c: Record<string, unknown>) => ({ ...c, workerLog: { dir: '/x', pool: 'harness', instance: 'max2', extra: 1 } }), 'workerLog'],
  ])('refuses an unknown key %s instead of dropping it', (_where, mutate, shown) => {
    const issues = issuesOf(mutate(base))
    expect(issues).not.toBe('')
    expect(issues).toContain(shown)
  })

  it('refuses an unknown key in the task block, its limits and a recipe', () => {
    expect(issuesOf({ ...base, task: taskBlock })).toBe('')
    expect(issuesOf({ ...base, task: { ...taskBlock, extra: 1 } })).toContain('task')
    expect(issuesOf({ ...base, task: { ...taskBlock, limits: { ...taskBlock.limits, maxTurn: 2 } } })).toContain('task.limits')
    expect(issuesOf({ ...base, task: { ...taskBlock, recipes: [{ ...taskBlock.recipes[0], extra: 1 }] } })).toContain('task.recipes')
  })

  it('refuses contextTokens in task.limits', () => {
    expect(issuesOf({ ...base, task: { ...taskBlock, limits: { ...taskBlock.limits, contextTokens: 65536 } } })).toContain('task.limits')
  })

  it('still accepts every top-level key the live config uses', () => {
    const live = {
      ...base,
      mcp: { command: 'tsx', args: ['a'], env: { SCRUM4ME_TOKEN: '${SCRUM4ME_TOKEN}' } },
      allow: ['search_product_docs'],
      limits: { maxTurns: 8, maxOutputTokens: 4096, maxWallSeconds: 240, maxToolErrors: 2 },
      waitSeconds: 300,
      workerLog: { dir: '/srv/scrum4me/worker-logs', pool: 'harness', instance: 'max2' },
      task: taskBlock,
    }
    expect(issuesOf(live)).toBe('')
  })
})

describe('configurations', () => {
  const withConfigurations = (configurations: unknown) => ({ ...base, configurations })

  it('takes one or more, each with a cost mode and a context window', () => {
    const hosted = { costMode: 'hosted', contextTokens: 131072, reasoningEffort: 'medium', extraBody: { temperature: 0.7, provider: { data_collection: 'deny' } } }
    const cfg = WorkerConfigSchema.parse(withConfigurations({ 'qwen3-coder-30b': { costMode: 'local', contextTokens: 32768 }, 'qwen3.6-35b-a3b': hosted }))
    expect(Object.keys(cfg.configurations)).toEqual(['qwen3-coder-30b', 'qwen3.6-35b-a3b'])
    expect(cfg.configurations['qwen3.6-35b-a3b']).toEqual(hosted)
  })

  it('wants at least one', () => {
    expect(issuesOf(withConfigurations({}))).toContain('configurations')
  })

  it('wants the key configurations at all', () => {
    const { configurations: _gone, ...rest } = base
    expect(issuesOf(rest)).toContain('configurations')
  })

  it.each(['a', 'qwen3-coder-30b', 'qwen3.6-35b-a3b', '0abc', 'a'.repeat(64)])('accepts the name %s', (name) => {
    expect(issuesOf(withConfigurations({ [name]: { costMode: 'local', contextTokens: 1 } }))).toBe('')
  })

  it.each(['', 'Qwen', '-qwen', '.qwen', 'qwen:30b', 'qwen_30b', 'qwen 30b', 'qwen/30b', 'a'.repeat(65), 'é'])('refuses the name %j', (name) => {
    expect(issuesOf(withConfigurations({ [name]: { costMode: 'local', contextTokens: 1 } }))).toContain('configurations')
  })

  it('refuses a configuration without contextTokens, and one with a zero, negative, fractional or text value', () => {
    expect(issuesOf(withConfigurations({ x: { costMode: 'local' } }))).toContain('contextTokens')
    for (const contextTokens of [0, -1, 1.5, '32768']) {
      expect(issuesOf(withConfigurations({ x: { costMode: 'local', contextTokens } }))).toContain('contextTokens')
    }
  })

  it('refuses a configuration without costMode, and one with another cost mode', () => {
    expect(issuesOf(withConfigurations({ x: { contextTokens: 1 } }))).toContain('costMode')
    expect(issuesOf(withConfigurations({ x: { costMode: 'free', contextTokens: 1 } }))).toContain('costMode')
  })

  it('accepts none/low/medium/high as reasoningEffort and leaves it unset by default', () => {
    expect(WorkerConfigSchema.parse(base).configurations['qwen3-coder-30b'].reasoningEffort).toBeUndefined()
    for (const e of ['none', 'low', 'medium', 'high']) {
      const cfg = WorkerConfigSchema.parse(withConfigurations({ x: { costMode: 'local', contextTokens: 1, reasoningEffort: e } }))
      expect(cfg.configurations.x.reasoningEffort).toBe(e)
    }
    expect(issuesOf(withConfigurations({ x: { costMode: 'local', contextTokens: 1, reasoningEffort: 'off' } }))).toContain('reasoningEffort')
  })

  it.each(['model', 'messages', 'tools', 'stream', 'max_tokens', 'max_completion_tokens', 'n'])('refuses the reserved extraBody key %s with a ManifestError naming the configuration', (key) => {
    const p = writeConfig(withConfigurations({ x: { costMode: 'local', contextTokens: 1, extraBody: { [key]: 1 } } }))
    expect(() => loadWorkerConfig(p)).toThrow(ManifestError)
    expect(() => loadWorkerConfig(p)).toThrow(new RegExp(`configurations\\.x\\.extraBody: .*bevatten: "${key}"`))
  })

  it('refuses reasoning_effort in extraBody next to reasoningEffort, and lets it through alone', () => {
    const clash = withConfigurations({ x: { costMode: 'local', contextTokens: 1, reasoningEffort: 'none', extraBody: { reasoning_effort: 'low' } } })
    expect(issuesOf(clash)).toContain('configurations.x.extraBody')
    expect(issuesOf(withConfigurations({ x: { costMode: 'local', contextTokens: 1, extraBody: { reasoning_effort: 'low' } } }))).toBe('')
  })
})

describe('litellm', () => {
  const withLitellm = (litellm: unknown) => ({ ...base, litellm })
  const good: Record<string, string> = base.litellm

  it('takes a URL and two absolute paths', () => {
    expect(WorkerConfigSchema.parse(base).litellm).toEqual(good)
  })

  it.each(['baseUrl', 'configPath', 'composePath'])('wants %s', (key) => {
    const { [key]: _gone, ...rest } = good
    expect(issuesOf(withLitellm(rest))).toContain(`litellm.${key}`)
  })

  it('refuses a baseUrl that is no URL', () => {
    expect(issuesOf(withLitellm({ ...good, baseUrl: 'not a url' }))).toContain('litellm.baseUrl')
  })

  it.each(['configPath', 'composePath'])('refuses a relative %s', (key) => {
    expect(issuesOf(withLitellm({ ...good, [key]: 'litellm/config.yaml' }))).toContain(`litellm.${key}`)
  })

  it('is required', () => {
    const { litellm: _gone, ...rest } = base
    expect(issuesOf(rest)).toContain('litellm')
  })
})

describe('the example worker config', () => {
  it('is in the new form: a LiteLLM block and configurations, no model block, and room for thinking tokens', () => {
    const cfg = loadWorkerConfig('examples/worker.json')
    expect(cfg.litellm).toMatchObject({ baseUrl: 'http://127.0.0.1:4000/v1' })
    expect(Object.keys(cfg.configurations)).toEqual(['qwen3.8-gsq-rco'])
    expect(cfg.configurations['qwen3.8-gsq-rco']).toEqual({ costMode: 'local', contextTokens: 65536 })
    expect(cfg).not.toHaveProperty('model')
    expect(cfg.limits).toMatchObject({ maxTurns: 8, maxOutputTokens: 4096 })
  })

  it('the example worker config carries the M3 task block (spec §4.1/§6 example limits, image and recipes)', () => {
    const cfg = loadWorkerConfig('examples/worker.json')
    expect(cfg.task).toBeDefined()
    expect(cfg.task).toMatchObject({
      limits: { maxTurns: 40, maxOutputTokens: 80000, maxWallSeconds: 2400, maxToolErrors: 8 },
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
        verify: 'npm run typecheck && npm run typecheck:tests && npx vitest run --exclude __tests__/ppe-bundle1-parity.test.ts --exclude __tests__/branch-safety.test.ts --exclude __tests__/default-branch.test.ts --exclude __tests__/worktree-branch-safety.test.ts --exclude __tests__/update-job-status-local-llm-chain.test.ts --exclude __tests__/update-job-status-local-llm-done-gitlink.test.ts --exclude __tests__/git/local-llm.test.ts',
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

describe('workerLog', () => {
  it('accepts a valid workerLog block', () => {
    const cfg = WorkerConfigSchema.parse({ ...base, workerLog: { dir: '/srv/scrum4me/worker-logs', pool: 'harness', instance: 'max2' } })
    expect(cfg.workerLog).toEqual({ dir: '/srv/scrum4me/worker-logs', pool: 'harness', instance: 'max2' })
  })

  it('stays valid without a workerLog block', () => {
    expect(WorkerConfigSchema.parse(base).workerLog).toBeUndefined()
  })

  it.each(['bad pool!', '', 'a'.repeat(65)])('rejects an invalid pool %j', (pool) => {
    const r = WorkerConfigSchema.safeParse({ ...base, workerLog: { dir: '/x', pool, instance: 'max2' } })
    expect(r.success).toBe(false)
  })

  it.each(['bad instance!', '', 'a'.repeat(65)])('rejects an invalid instance %j', (instance) => {
    const r = WorkerConfigSchema.safeParse({ ...base, workerLog: { dir: '/x', pool: 'harness', instance } })
    expect(r.success).toBe(false)
  })

  it('rejects an empty dir', () => {
    const r = WorkerConfigSchema.safeParse({ ...base, workerLog: { dir: '', pool: 'harness', instance: 'max2' } })
    expect(r.success).toBe(false)
  })

  it('the example worker config carries the workerLog block for max2', () => {
    const cfg = loadWorkerConfig('examples/worker.json')
    expect(cfg.workerLog).toEqual({ dir: '/srv/scrum4me/worker-logs', pool: 'harness', instance: 'max2' })
  })
})

describe('normalizeRepoUrl', () => {
  it('lowercases the host and strips a trailing slash and .git suffix', () => {
    expect(normalizeRepoUrl('https://git.jp-visser.nl/janpeter/Scrum4Me.git')).toBe('https://git.jp-visser.nl/janpeter/Scrum4Me')
    expect(normalizeRepoUrl('https://Git.JP-Visser.NL/janpeter/Scrum4Me')).toBe('https://git.jp-visser.nl/janpeter/Scrum4Me')
    expect(normalizeRepoUrl('https://git.jp-visser.nl/janpeter/Scrum4Me/')).toBe('https://git.jp-visser.nl/janpeter/Scrum4Me')
    expect(normalizeRepoUrl('  https://git.jp-visser.nl/janpeter/Scrum4Me.git  ')).toBe('https://git.jp-visser.nl/janpeter/Scrum4Me')
  })

  it('lowercases the host of an scp-like remote, leaving user and path untouched', () => {
    expect(normalizeRepoUrl('git@Git.JP-Visser.NL:janpeter/Scrum4Me.git')).toBe('git@git.jp-visser.nl:janpeter/Scrum4Me')
    expect(normalizeRepoUrl('Git.JP-Visser.NL:janpeter/Scrum4Me/')).toBe('git.jp-visser.nl:janpeter/Scrum4Me')
    expect(normalizeRepoUrl('git@git.jp-visser.nl:JanPeter/Repo')).toBe('git@git.jp-visser.nl:JanPeter/Repo')
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
