import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `harness-${prefix}-`))
}

export function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? allFiles(p) : [p]
  })
}

export function readTrace(dir: string): Array<Record<string, unknown> & { type: string }> {
  return readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
}

export function dirContains(dir: string, needle: string): boolean {
  return allFiles(dir).some((f) => readFileSync(f, 'utf8').includes(needle))
}
