import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { expandEnv, ManifestError, ModelSpecSchema } from '../manifest.js'

/** The only tools the model may see in worker mode: read-only product docs. */
export const DOC_TOOLS = ['search_product_docs', 'get_product_doc', 'list_product_docs', 'related_product_docs'] as const
/** Called by the harness alone, never offered to the model. */
export const CONTROL_TOOLS = [
  'wait_for_job',
  'job_heartbeat',
  'update_job_status',
  'update_task_status',
  'verify_task_against_plan',
  'log_implementation',
  'log_commit',
  'log_test_result',
] as const

const DEFAULT_LIMITS = { maxTurns: 6, maxOutputTokens: 2048, maxWallSeconds: 240, maxToolErrors: 2 }

// Run-log path segments (spec docs/specs/2026-09-28-harness-run-logging-design.md §5.1); matches the
// worker-log pipeline's own NAME_SEGMENT_RE (scrum4me-docker/Ops-dashboard lib/worker-logs.ts).
const SEGMENT = /^[A-Za-z0-9._-]{1,64}$/

const TASK_LIMITS = z.object({
  maxTurns: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxWallSeconds: z.number().int().positive(),
  maxToolErrors: z.number().int().nonnegative(),
  contextTokens: z.number().int().positive().optional(),
})

const RecipeSchema = z.object({
  repoUrl: z.string().min(1),
  prepare: z.array(z.string()),
  verify: z.string().min(1),
})

/** Config for TASK_IMPLEMENTATION jobs: image/user, timeouts and the per-repo recipes. */
export const TaskConfigSchema = z.object({
  limits: TASK_LIMITS,
  image: z.string().min(1),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
  npmCacheDir: z.string().min(1),
  prepareTimeoutSeconds: z.number().int().positive().default(900),
  verifyTimeoutSeconds: z.number().int().positive().default(600),
  maxVerifyRepairs: z.number().int().nonnegative().default(3),
  recipes: z.array(RecipeSchema).min(1),
})

export type TaskConfig = z.infer<typeof TaskConfigSchema>
export type Recipe = z.infer<typeof RecipeSchema>

/** Trims, lowercases the host and strips a trailing slash and `.git` suffix, so recipe matching is exact but forgiving of the usual repo-URL spellings. */
export function normalizeRepoUrl(url: string): string {
  let out = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  try {
    const u = new URL(out)
    u.host = u.host.toLowerCase()
    out = u.toString().replace(/\/+$/, '')
  } catch {
    // Not a parseable URL (e.g. an scp-like git remote): lowercase the host between an optional user@ and the first ':'.
    const scp = out.match(/^([^@/]+@)?([^:/]+):(.+)$/)
    if (scp) out = `${scp[1] ?? ''}${scp[2].toLowerCase()}:${scp[3]}`
  }
  return out
}

/** Finds the recipe whose `repoUrl` matches `repoUrl` after normalization. */
export function findRecipe(task: TaskConfig, repoUrl: string): Recipe | undefined {
  const target = normalizeRepoUrl(repoUrl)
  return task.recipes.find((r) => normalizeRepoUrl(r.repoUrl) === target)
}

export const WorkerConfigSchema = z
  .object({
    model: ModelSpecSchema,
    mcp: z.object({ command: z.string().min(1), args: z.array(z.string()), env: z.record(z.string(), z.string()).optional() }),
    allow: z.array(z.string().min(1)).min(1).default([...DOC_TOOLS]),
    limits: z
      .object({
        maxTurns: z.number().int().positive().default(DEFAULT_LIMITS.maxTurns),
        maxOutputTokens: z.number().int().positive().default(DEFAULT_LIMITS.maxOutputTokens),
        maxWallSeconds: z.number().int().positive().default(DEFAULT_LIMITS.maxWallSeconds),
        maxToolErrors: z.number().int().nonnegative().default(DEFAULT_LIMITS.maxToolErrors),
        contextTokens: z.number().int().positive().optional(),
      })
      .default(DEFAULT_LIMITS),
    waitSeconds: z.number().int().min(1).max(600).default(300),
    task: TaskConfigSchema.optional(),
    workerLog: z.object({ dir: z.string().min(1), pool: z.string().regex(SEGMENT), instance: z.string().regex(SEGMENT) }).optional(),
  })
  .superRefine((cfg, ctx) => {
    // Stricter than banning the control tools: anything outside the doc tools could write.
    const docTools: readonly string[] = DOC_TOOLS
    for (const tool of cfg.allow) {
      if (!docTools.includes(tool)) {
        ctx.addIssue({ code: 'custom', path: ['allow'], message: `tool ${tool} is niet toegestaan in worker-modus (alleen ${DOC_TOOLS.join(', ')})` })
      }
    }
  })

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>

/** Reads and validates a worker config. Expands NOTHING, like loadManifest. */
export function loadWorkerConfig(path: string): WorkerConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ManifestError(`cannot read worker config ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const parsed = WorkerConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
    throw new ManifestError(`invalid worker config ${path}: ${issues}`)
  }
  return parsed.data
}

/**
 * The MCP child's env: the config env with ${VAR} expanded, then the fixed worker identity: runtime HARNESS, no capability.
 * The fixed keys come last so no config can make this worker claim jobs of another runtime. An empty capability list is the
 * identity; an unset variable would give the MCP its default `code_edit,planning,review`.
 */
export function workerMcpEnv(cfg: WorkerConfig, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(cfg.mcp.env ?? {})) out[k] = expandEnv(v, env, 'mcp.env')
  out.SCRUM4ME_WORKER_CAPABILITIES = ''
  out.SCRUM4ME_WORKER_RUNTIME = 'HARNESS'
  return out
}
