// Task 7 (spec docs/specs/2026-09-28-harness-run-logging-design.md §10 criterion 4): an automated
// stand-in for the manual `grep -rF "$WAARDE" …` recipe in the runbook (docs/runbooks/idea-chat-worker.md).
// That recipe put the secret value in a shell variable and then in grep's argv, which `ps` and
// /proc/<pid>/cmdline can see -- this reads the secrets itself instead, from the same sources as the
// redaction (Task 3's collectSecretEntries/workerSecretSources), and never prints a value: only
// names, hit counts and a "shorter than the redaction floor" flag leave this module. The CLI
// (src/cli.ts) owns printing and the exit code; this function stays pure so it can be tested without
// touching stdout.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkerConfig } from './config.js'
import { collectSecretEntries, workerSecretSources } from './redact.js'

// Mirrors redact.ts's MIN_SECRET_LENGTH: below this, the redaction would not have masked the value
// (collectSecretEntries has no length filter), so a hit on a short secret is a real finding, not noise.
const MIN_SECRET_LENGTH = 8

export interface SecretCheckResult {
  name: string
  hits: number
  short: boolean
}

/** Every regular file under `dir`, recursing into subdirectories (matches <dir>/<pool>/<instance>/runs/*.log). */
function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** Non-overlapping occurrences of `needle` in `haystack` -- the same count `grep -F` would give. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * Collapses entries that share both name and value: the same variable found via two sources (e.g.
 * SCRUM4ME_TOKEN in both process.env and the resolved MCP env), or a URL password whose decoded form
 * equals its raw form (no %-escapes), would otherwise double-count as two rows for one real secret.
 * A NUL byte cannot appear in either field from these sources, so it is a safe join separator.
 */
function dedupeEntries(entries: { name: string; value: string }[]): { name: string; value: string }[] {
  const seen = new Set<string>()
  const out: { name: string; value: string }[] = []
  for (const entry of entries) {
    const key = `${entry.name}\0${entry.value}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/**
 * Scans every file under `dir` for the secrets in `collectSecretEntries(...workerSecretSources(config,
 * processEnv))`: the redaction's own selection, but also shorter than 8 characters, so a short secret
 * is checked and reported instead of silently skipped (spec §10 criterion 4). Never returns a value,
 * only names and counts.
 */
export function checkRunLogs(config: WorkerConfig, processEnv: NodeJS.ProcessEnv, dir: string): { checked: number; results: SecretCheckResult[] } {
  const entries = dedupeEntries(collectSecretEntries(...workerSecretSources(config, processEnv)))
  const texts = listFiles(dir).map((f) => readFileSync(f, 'utf8'))
  const results = entries.map(({ name, value }) => ({
    name,
    hits: texts.reduce((sum, text) => sum + countOccurrences(text, value), 0),
    short: value.length < MIN_SECRET_LENGTH,
  }))
  return { checked: entries.length, results }
}
