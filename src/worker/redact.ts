// Selection rules and redactText are a faithful copy of scrum4me-docker lib/log-redact.ts:9-58
// (commit 52ded13): the same secret-key-name pattern, the same URL-password extraction, and the
// same longest-first masking, so the harness's own redaction can never diverge from the runner's.
// The stream line buffer (lib/log-redact.ts:60-88) is not needed here: the run-log writer (Task 4)
// redacts whole meta/JSON lines, not a byte stream off a child process.
//
// collectSecretEntries/collectSecretValues are restructured relative to the source's single
// collectSecretValues: collectSecretEntries keeps every candidate together with its source name and
// without a length filter, so Task 7's secret check can report *which* variable leaked. collectSecretValues
// is derived from it (map + filter + dedupe + sort), so the two can never select a different set of values.

import { workerMcpEnv, type WorkerConfig } from './config.js'

export const REDACTED = '***'

// Key names whose value counts as a secret.
const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|_KEY$|DSN|CREDENTIAL)/i
// Masking shorter values mostly produces false positives ("true", port numbers).
const MIN_SECRET_LENGTH = 8

function urlPassword(value: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:([^@/\s]+)@/i.exec(value)
  return m ? m[1] : null
}

/**
 * All candidates with their source: the value of a variable with a secret-like name, and the
 * password from each URL value (raw and decoded). No length filter; empty values are dropped.
 */
export function collectSecretEntries(...envs: Array<Record<string, string | undefined>>): { name: string; value: string }[] {
  const entries: { name: string; value: string }[] = []
  for (const env of envs) {
    for (const [key, raw] of Object.entries(env)) {
      if (!raw) continue
      if (SECRET_KEY.test(key)) entries.push({ name: key, value: raw })
      const pw = urlPassword(raw)
      if (pw) {
        const name = `${key} (url-wachtwoord)`
        entries.push({ name, value: pw })
        try {
          entries.push({ name, value: decodeURIComponent(pw) })
        } catch {
          // Invalid %-sequence: the raw form was already added above.
        }
      }
    }
  }
  return entries
}

/** The redaction set: the values from collectSecretEntries from 8 characters up, unique, longest first (the runner's rule). */
export function collectSecretValues(...envs: Array<Record<string, string | undefined>>): string[] {
  const found = new Set<string>()
  for (const { value } of collectSecretEntries(...envs)) {
    if (value.length >= MIN_SECRET_LENGTH) found.add(value)
  }
  // Longest first, so a value that contains another gets masked in full.
  return [...found].sort((a, b) => b.length - a.length)
}

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join(REDACTED)
  }
  return out
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, secrets)]))
  }
  return value
}

/** Redacts every string in a JSON value (objects and arrays recursively); other values are left unchanged. */
export function redactDeep<T>(value: T, secrets: readonly string[]): T {
  return redactValue(value, secrets) as T
}

/**
 * The worker's four secret sources, ready to spread into collectSecretValues/collectSecretEntries:
 * process.env, the resolved MCP env (workerMcpEnv), and the model's API key and base URL (the base
 * URL is scanned like any other value, so a password embedded in it is still found). Task 5 (the
 * worker) and Task 7 (the secret check) both call this, so they can never select different sources.
 */
export function workerSecretSources(config: WorkerConfig, processEnv: NodeJS.ProcessEnv = process.env): Array<Record<string, string | undefined>> {
  return [processEnv, workerMcpEnv(config, processEnv), { MODEL_API_KEY: config.model.apiKey, MODEL_BASE_URL: config.model.baseUrl }]
}
