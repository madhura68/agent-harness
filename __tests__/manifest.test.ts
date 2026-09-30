import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandEnv, loadManifest, ManifestError, resolveServerEnv } from '../src/manifest.js'

const limits = { maxTurns: 3, maxOutputTokens: 512, maxWallSeconds: 120, maxToolErrors: 0 }
const answer = { id: 'answer-smoke', profile: 'answer', prompt: 'Hallo ${HOME}', model: { baseUrl: 'http://127.0.0.1:11434/v1', name: 'qwen3-coder:30b' }, limits }
const tools = {
  ...answer,
  id: 'tools-smoke',
  profile: 'tools',
  tools: {
    server: { command: 'node', args: ['server.js'], env: { SCRUM4ME_TOKEN: '${SCRUM4ME_TOKEN}', DATABASE_URL: 'postgres://${DB_USER}@h/d', PLAIN: 'x' } },
    allow: ['get_context'],
  },
}

function write(obj: unknown): string {
  const p = join(mkdtempSync(join(tmpdir(), 'harness-manifest-')), 'm.json')
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj))
  return p
}

describe('loadManifest', () => {
  it('accepts a valid answer manifest', () => {
    expect(loadManifest(write(answer)).profile).toBe('answer')
  })

  it('accepts a valid tools manifest and leaves ${VAR} in server env untouched', () => {
    const m = loadManifest(write(tools))
    expect(m.tools?.server.env?.SCRUM4ME_TOKEN).toBe('${SCRUM4ME_TOKEN}')
  })

  it('never expands the prompt', () => {
    expect(loadManifest(write(answer)).prompt).toBe('Hallo ${HOME}')
  })

  it('rejects profile tools without tools, naming the path', () => {
    const { tools: _t, ...noTools } = tools
    expect(() => loadManifest(write(noTools))).toThrow(ManifestError)
    expect(() => loadManifest(write(noTools))).toThrow(/tools/)
  })

  it('rejects profile answer with tools', () => {
    expect(() => loadManifest(write({ ...tools, profile: 'answer' }))).toThrow(/verboden/)
  })

  it('rejects an id with a space', () => {
    expect(() => loadManifest(write({ ...answer, id: 'bad id' }))).toThrow(/id/)
  })

  it('rejects an empty allowlist and non-positive limits', () => {
    expect(() => loadManifest(write({ ...tools, tools: { ...tools.tools, allow: [] } }))).toThrow(ManifestError)
    expect(() => loadManifest(write({ ...answer, limits: { ...limits, maxTurns: 0 } }))).toThrow(/maxTurns/)
  })

  it('accepts an optional positive contextTokens', () => {
    expect(loadManifest(write({ ...answer, limits: { ...limits, contextTokens: 32768 } })).limits.contextTokens).toBe(32768)
    expect(loadManifest(write(answer)).limits.contextTokens).toBeUndefined()
    expect(() => loadManifest(write({ ...answer, limits: { ...limits, contextTokens: 0 } }))).toThrow(/contextTokens/)
  })

  it('reports invalid JSON and a missing file as ManifestError', () => {
    expect(() => loadManifest(write('{ nope'))).toThrow(ManifestError)
    expect(() => loadManifest('/nonexistent/m.json')).toThrow(ManifestError)
  })
})

describe('history in a manifest', () => {
  type Turn = { role: 'user' | 'assistant'; content: string }
  const user = (content: string): Turn => ({ role: 'user', content })
  const assistant = (content: string): Turn => ({ role: 'assistant', content })
  const two = [user('Wat is een PBI?'), assistant('Een product backlog item.')]
  const four = [...two, user('En een story?'), assistant('Een verfijning van een PBI.')]

  it('leaves history undefined when the manifest has none', () => {
    expect(loadManifest(write(answer)).history).toBeUndefined()
  })

  it('accepts an empty history', () => {
    expect(loadManifest(write({ ...answer, history: [] })).history).toEqual([])
  })

  it('accepts a history of two and of four messages and keeps their order', () => {
    expect(loadManifest(write({ ...answer, history: two })).history).toEqual(two)
    expect(loadManifest(write({ ...answer, history: four })).history).toEqual(four)
  })

  it('accepts a history on a tools manifest, next to the tools rule', () => {
    expect(loadManifest(write({ ...tools, history: two })).history).toEqual(two)
  })

  // Each case breaks exactly one rule, so none of them can be rejected by another rule's check.
  it.each([
    ['starts with assistant', [assistant('a1'), user('u1'), assistant('a2')], /met een user-bericht beginnen/],
    ['does not alternate', [user('u1'), user('u2'), assistant('a1')], /afwisselen.*bericht 2 is user/],
    ['ends with user', [user('u1'), assistant('a1'), user('u2')], /met een assistant-bericht eindigen/],
  ])('rejects a history that %s, with the path history in the message', (_why, history, rule) => {
    const file = write({ ...answer, history })
    expect(() => loadManifest(file)).toThrow(ManifestError)
    // `loadManifest` prints `<path>: <message>`; the path here must be exactly `history`, not `history.N`.
    expect(() => loadManifest(file)).toThrow(/: history: /)
    expect(() => loadManifest(file)).toThrow(rule)
  })

  it('rejects a role other than user and assistant, naming the message', () => {
    const file = write({ ...answer, history: [{ role: 'system', content: 'x' }, assistant('a1')] })
    expect(() => loadManifest(file)).toThrow(ManifestError)
    expect(() => loadManifest(file)).toThrow(/history\.0\.role/)
  })
})

describe('expandEnv / resolveServerEnv', () => {
  it('replaces ${VAR} occurrences', () => {
    expect(expandEnv('a-${X}-${Y}', { X: '1', Y: '2' })).toBe('a-1-2')
    expect(expandEnv('no vars', {})).toBe('no vars')
  })

  it('resolves every server env value from the given env', () => {
    const m = loadManifest(write(tools))
    expect(resolveServerEnv(m, { SCRUM4ME_TOKEN: 'tok', DB_USER: 'u' })).toEqual({
      SCRUM4ME_TOKEN: 'tok', DATABASE_URL: 'postgres://u@h/d', PLAIN: 'x',
    })
  })

  it('throws a ManifestError naming the unset variable', () => {
    const m = loadManifest(write(tools))
    expect(() => resolveServerEnv(m, { DB_USER: 'u' })).toThrow(ManifestError)
    expect(() => resolveServerEnv(m, { DB_USER: 'u' })).toThrow(/SCRUM4ME_TOKEN/)
  })

  it('returns an empty object for an answer manifest', () => {
    expect(resolveServerEnv(loadManifest(write(answer)), {})).toEqual({})
  })
})

describe('model.reasoningEffort in a manifest', () => {
  it('accepts a known effort and rejects an unknown one', async () => {
    const { ManifestSchema } = await import('../src/manifest.js')
    const m = { id: 'x', profile: 'answer', prompt: 'p', model: { baseUrl: 'http://127.0.0.1:1/v1', name: 'm', reasoningEffort: 'none' }, limits: { maxTurns: 1, maxOutputTokens: 1, maxWallSeconds: 1, maxToolErrors: 0 } }
    expect(ManifestSchema.parse(m).model.reasoningEffort).toBe('none')
    expect(ManifestSchema.safeParse({ ...m, model: { ...m.model, reasoningEffort: 'off' } }).success).toBe(false)
  })
})
