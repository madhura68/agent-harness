import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openTrace, redactManifest, type RunResult } from '../src/trace.js'

let out: string
beforeEach(() => { out = mkdtempSync(join(tmpdir(), 'harness-trace-')) })

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? allFiles(p) : [p]
  })
}

const manifest = {
  id: 'r1',
  profile: 'tools',
  prompt: 'p',
  model: { baseUrl: 'http://h/v1', name: 'm', apiKey: 'sk-test-secret' },
  tools: {
    server: { command: 'node', args: ['x'], env: { DATABASE_URL: 'postgres://u:db-secret@h/d', SCRUM4ME_TOKEN: '${SCRUM4ME_TOKEN}' } },
    allow: ['echo'],
  },
  limits: { maxTurns: 1, maxOutputTokens: 1, maxWallSeconds: 1, maxToolErrors: 0 },
}

const result: RunResult = {
  runId: 'r1',
  status: 'completed',
  answer: 'ok',
  model: { name: 'm', baseUrl: 'http://h/v1', reported: 'm' },
  usage: { source: 'provider_reported', inputTokens: 3, outputTokens: 2, turns: 1, toolCalls: 0, toolErrors: 0 },
  durationMs: 12,
}

describe('openTrace', () => {
  it('refuses an existing run dir', () => {
    openTrace(out, 'r1')
    expect(() => openTrace(out, 'r1')).toThrow(/already exists/)
  })

  it('appends events in order, each with an ISO ts', () => {
    const t = openTrace(out, 'r1')
    t.event({ type: 'model_request', turn: 1, messages: 2, tools: 0, maxTokens: 10 })
    t.event({ type: 'run_end', status: 'completed' })
    const lines = readFileSync(join(t.dir, 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.type)).toEqual(['model_request', 'run_end'])
    for (const l of lines) expect(new Date(l.ts).toISOString()).toBe(l.ts)
  })

  it('writes tool content and result.json', () => {
    const t = openTrace(out, 'r1')
    t.toolContent('call_1_0', 'hello')
    t.result(result)
    expect(readFileSync(join(t.dir, 'tools', 'call_1_0.txt'), 'utf8')).toBe('hello')
    expect(JSON.parse(readFileSync(join(t.dir, 'result.json'), 'utf8'))).toEqual(result)
  })

  it('keeps model-supplied call ids inside tools/', () => {
    const t = openTrace(out, 'r1')
    t.toolContent('../../escape', 'x')
    const files = allFiles(out)
    expect(files).toHaveLength(1)
    expect(files[0].startsWith(join(t.dir, 'tools'))).toBe(true)
  })
})

describe('redactManifest', () => {
  it('drops apiKey, redacts every server env value and keeps the rest', () => {
    const r = redactManifest(manifest) as typeof manifest
    expect(r.model).toEqual({ baseUrl: 'http://h/v1', name: 'm' })
    expect(r.tools.server.env).toEqual({ DATABASE_URL: '<redacted>', SCRUM4ME_TOKEN: '<redacted>' })
    const { model: _m, tools: _t, ...rest } = r
    const { model: _m2, tools: _t2, ...origRest } = manifest
    expect(rest).toEqual(origRest)
    expect(r.tools.allow).toEqual(['echo'])
    expect(r.tools.server.args).toEqual(['x'])
    expect(manifest.model.apiKey).toBe('sk-test-secret') // input untouched
  })

  it('handles manifests without tools or apiKey', () => {
    expect(redactManifest({ id: 'a', model: { name: 'm' } })).toEqual({ id: 'a', model: { name: 'm' } })
  })

  it('leaves no secret in any file of the run dir', () => {
    const t = openTrace(out, 'r1')
    t.event({ type: 'run_start', manifest: redactManifest(manifest) })
    t.result(result)
    for (const f of allFiles(t.dir)) {
      const text = readFileSync(f, 'utf8')
      expect(text).not.toContain('sk-test-secret')
      expect(text).not.toContain('db-secret')
    }
  })
})
