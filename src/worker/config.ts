import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { expandEnv, ManifestError, ModelSpecSchema } from '../manifest.js'

/** The only tools the model may see in worker mode: read-only product docs. */
export const DOC_TOOLS = ['search_product_docs', 'get_product_doc', 'list_product_docs', 'related_product_docs'] as const
/** Called by the harness alone, never offered to the model. */
export const CONTROL_TOOLS = ['wait_for_job', 'job_heartbeat', 'update_job_status'] as const

const DEFAULT_LIMITS = { maxTurns: 6, maxOutputTokens: 2048, maxWallSeconds: 240, maxToolErrors: 2 }

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
 * The MCP child's env: the config env with ${VAR} expanded, then the fixed worker identity.
 * The fixed keys come last so no config can make this worker claim ordinary jobs.
 */
export function workerMcpEnv(cfg: WorkerConfig, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(cfg.mcp.env ?? {})) out[k] = expandEnv(v, env, 'mcp.env')
  out.SCRUM4ME_WORKER_CAPABILITIES = 'local_llm'
  out.SCRUM4ME_WORKER_RUNTIME = 'CLAUDE'
  return out
}
