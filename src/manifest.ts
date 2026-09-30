import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { REASONING_EFFORTS } from './model-client.js'

/** Request fields the model client sets itself; `extraBody` may not carry them. */
export const RESERVED_BODY_KEYS = ['model', 'messages', 'tools', 'stream', 'max_tokens', 'max_completion_tokens', 'n'] as const

/**
 * Throws a ManifestError for a reserved key, or for reasoning_effort next to reasoningEffort, which would set the same
 * field twice. The nested `reasoning` object (OpenRouter's form) is a different field and passes.
 */
export function assertExtraBody(extraBody: Record<string, unknown>, reasoningEffort?: string): void {
  const reserved: readonly string[] = RESERVED_BODY_KEYS
  const found = Object.keys(extraBody).filter((key) => reserved.includes(key))
  if (found.length > 0) {
    throw new ManifestError(
      `extraBody mag geen gereserveerde sleutels bevatten: ${found.map((k) => `"${k}"`).join(', ')} (gereserveerd: ${RESERVED_BODY_KEYS.join(', ')})`,
    )
  }
  if (reasoningEffort !== undefined && Object.hasOwn(extraBody, 'reasoning_effort')) {
    throw new ManifestError('extraBody mag reasoning_effort niet bevatten naast reasoningEffort: zet het ene of het andere')
  }
}

/** Model block shared by run manifests and the worker config. */
export const ModelSpecSchema = z
  .object({
    baseUrl: z.string().url(),
    name: z.string().min(1),
    apiKey: z.string().optional(),
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
    /** Extra fields merged into every chat-completions request: temperature, seed, a provider block, a reasoning object. */
    extraBody: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((model, ctx) => {
    if (!model.extraBody) return
    try {
      assertExtraBody(model.extraBody, model.reasoningEffort)
    } catch (err) {
      if (!(err instanceof ManifestError)) throw err
      ctx.addIssue({ code: 'custom', path: ['extraBody'], message: err.message })
    }
  })

export const ManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
    profile: z.enum(['answer', 'tools']),
    prompt: z.string().min(1),
    system: z.string().optional(),
    /** Earlier visible turns of a conversation; run.ts places them between `system` and `prompt`. */
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).optional(),
    model: ModelSpecSchema,
    tools: z
      .object({
        server: z.object({
          command: z.string().min(1),
          args: z.array(z.string()),
          env: z.record(z.string(), z.string()).optional(),
        }),
        allow: z.array(z.string().min(1)).min(1),
      })
      .optional(),
    limits: z.object({
      maxTurns: z.number().int().positive(),
      maxOutputTokens: z.number().int().positive(),
      maxWallSeconds: z.number().int().positive(),
      maxToolErrors: z.number().int().nonnegative(),
      /** The model's context window (Ollama: OLLAMA_CONTEXT_LENGTH). Unset = no context bookkeeping. */
      contextTokens: z.number().int().positive().optional(),
    }),
  })
  .superRefine((m, ctx) => {
    if (m.profile === 'tools' && !m.tools) ctx.addIssue({ code: 'custom', path: ['tools'], message: 'tools is verplicht bij profile "tools"' })
    if (m.profile === 'answer' && m.tools) ctx.addIssue({ code: 'custom', path: ['tools'], message: 'tools is verboden bij profile "answer"' })

    // The prompt is the next user message, so earlier turns must be whole exchanges: user, assistant, user, assistant, …
    const history = m.history ?? []
    const off = history.findIndex((h, i) => h.role !== (i % 2 === 0 ? 'user' : 'assistant'))
    const historyIssue = (message: string) => ctx.addIssue({ code: 'custom', path: ['history'], message })
    if (off === 0) historyIssue('history moet met een user-bericht beginnen')
    else if (off > 0) historyIssue(`history moet afwisselen tussen user en assistant (bericht ${off + 1} is ${history[off].role})`)
    else if (history.at(-1)?.role === 'user') historyIssue('history moet met een assistant-bericht eindigen')
  })

export type Manifest = z.infer<typeof ManifestSchema>

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

/** Reads and validates a manifest. Expands NOTHING: secrets stay as `${VAR}` so the manifest is safe to trace. */
export function loadManifest(path: string): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ManifestError(`cannot read manifest ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const parsed = ManifestSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
    throw new ManifestError(`invalid manifest ${path}: ${issues}`)
  }
  return parsed.data
}

/** Replaces ${VAR}; an unset or empty VAR is an error naming the variable. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv, where = 'tools.server.env'): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const v = env[name]
    if (v === undefined || v === '') throw new ManifestError(`environment variable ${name} is not set (needed by ${where})`)
    return v
  })
}

/** The only ${VAR} expansion; call it solely on the way to the MCP child process. */
export function resolveServerEnv(m: Manifest, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m.tools?.server.env ?? {})) out[k] = expandEnv(v, env)
  return out
}
