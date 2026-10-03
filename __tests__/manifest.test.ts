import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertExtraBody, expandEnv, loadManifest, ManifestError, RESERVED_BODY_KEYS, resolveServerEnv } from '../src/manifest.js'

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

describe('model.extraBody in a manifest', () => {
  // What the comparison runner writes for an OpenRouter model: sampling fields, the provider block and the nested reasoning object.
  const fields = { temperature: 0.7, seed: 1, provider: { data_collection: 'deny', require_parameters: true }, reasoning: { effort: 'none' } }
  const withModel = (model: Record<string, unknown>) => write({ ...answer, model: { ...answer.model, ...model } })

  it('leaves extraBody undefined when the model block has none', () => {
    expect(loadManifest(write(answer)).model.extraBody).toBeUndefined()
  })

  it('accepts temperature, seed, a provider block and a reasoning object, and keeps them as written', () => {
    expect(loadManifest(withModel({ extraBody: fields })).model.extraBody).toEqual(fields)
  })

  it('accepts an empty extraBody', () => {
    expect(loadManifest(withModel({ extraBody: {} })).model.extraBody).toEqual({})
  })

  it.each(RESERVED_BODY_KEYS)('rejects the reserved key %s, naming it and the path model.extraBody', (key) => {
    const file = withModel({ extraBody: { temperature: 0.7, [key]: 'x' } })
    expect(() => loadManifest(file)).toThrow(ManifestError)
    // The found keys are quoted, the list of reserved keys is not: this only matches when `key` itself was reported.
    expect(() => loadManifest(file)).toThrow(new RegExp(`: model\\.extraBody: extraBody mag geen gereserveerde sleutels bevatten: "${key}"`))
  })

  it('names every reserved key it finds, not just the first', () => {
    const extraBody = Object.fromEntries(RESERVED_BODY_KEYS.map((k) => [k, 1]))
    expect(() => loadManifest(withModel({ extraBody }))).toThrow(/bevatten: "model", "messages", "tools", "stream", "max_tokens", "max_completion_tokens", "n" \(/)
  })

  it('rejects reasoning_effort in extraBody next to reasoningEffort', () => {
    const file = withModel({ reasoningEffort: 'none', extraBody: { reasoning_effort: 'low' } })
    expect(() => loadManifest(file)).toThrow(ManifestError)
    expect(() => loadManifest(file)).toThrow(/model\.extraBody: extraBody mag reasoning_effort niet bevatten naast reasoningEffort/)
  })

  it('lets reasoning_effort in extraBody through when reasoningEffort is not set', () => {
    expect(loadManifest(withModel({ extraBody: { reasoning_effort: 'low' } })).model.extraBody).toEqual({ reasoning_effort: 'low' })
  })

  it('does not confuse the reasoning object with reasoning_effort: it is not reserved, with or without reasoningEffort', () => {
    expect(loadManifest(withModel({ extraBody: { reasoning: { effort: 'none' } } })).model.extraBody).toEqual({ reasoning: { effort: 'none' } })
    expect(loadManifest(withModel({ reasoningEffort: 'low', extraBody: { reasoning: { effort: 'none' } } })).model.reasoningEffort).toBe('low')
  })

  it.each([
    ['a list', [{ temperature: 0.7 }]],
    ['a string', 'temperature'],
    ['null', null],
  ])('rejects an extraBody that is %s', (_label, extraBody) => {
    const file = withModel({ extraBody })
    expect(() => loadManifest(file)).toThrow(ManifestError)
    expect(() => loadManifest(file)).toThrow(/model\.extraBody/)
  })
})

describe('assertExtraBody', () => {
  it('passes the usual fields', () => {
    expect(() => assertExtraBody({})).not.toThrow()
    expect(() => assertExtraBody({ temperature: 0.7, seed: 1, provider: { data_collection: 'deny' }, reasoning: { effort: 'none' } }, 'low')).not.toThrow()
  })

  it.each(RESERVED_BODY_KEYS)('throws a ManifestError for the reserved key %s', (key) => {
    expect(() => assertExtraBody({ [key]: 1 })).toThrow(ManifestError)
    expect(() => assertExtraBody({ [key]: 1 }, 'low')).toThrow(ManifestError)
  })

  it('throws for reasoning_effort only when reasoningEffort is given', () => {
    expect(() => assertExtraBody({ reasoning_effort: 'low' })).not.toThrow()
    expect(() => assertExtraBody({ reasoning_effort: 'low' }, undefined)).not.toThrow()
    expect(() => assertExtraBody({ reasoning_effort: 'low' }, 'none')).toThrow(ManifestError)
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

describe('a key that the model block does not know', () => {
  // `harness task-bench` reads its model config strictly (cli.ts, ModelSpecSchema.strict()). The shared schema must stay as it is: a
  // manifest or a worker config with a key it does not know loads today, and run and worker are not to change with task-bench.
  it('is dropped by the manifest, not refused', () => {
    const file = write({ ...answer, model: { ...answer.model, extra_body: { provider: { data_collection: 'deny' } } } })
    expect(loadManifest(file).model).toStrictEqual(answer.model)
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
