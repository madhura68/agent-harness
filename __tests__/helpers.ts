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

/** A 40-character stand-in for an API key in leak tests. Never a real secret. */
export const DUMMY_KEY = 'test-key-Qx7Zp2Lm9Rt4Vb8Nc3Hf6Jd1Ks5Wg0a'

/**
 * The `min`-character stretches of the key that `text` still holds; empty means nothing of the key survived.
 * Checking stretches, not just the whole key, is what catches a prefix left behind by a cut that came before the mask.
 */
export function leakedFragments(text: string, key = DUMMY_KEY, min = 6): string[] {
  const found: string[] = []
  for (let i = 0; i + min <= key.length; i++) {
    const fragment = key.slice(i, i + min)
    if (text.includes(fragment)) found.push(fragment)
  }
  return found
}

/**
 * A response body in which the key starts exactly at character `offset`. `build` wraps the payload (filler plus key)
 * in whatever shape the test needs. At offset 190 the 200-character excerpt keeps 10 characters of an unmasked key.
 */
export function bodyWithKeyAt(offset: number, build: (payload: string) => string = (p) => p): string {
  const start = build('@').indexOf('@')
  const body = build('.'.repeat(offset - start) + DUMMY_KEY)
  if (body.indexOf(DUMMY_KEY) !== offset) throw new Error(`key starts at ${body.indexOf(DUMMY_KEY)}, expected ${offset}`)
  return body
}
