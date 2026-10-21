import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createReadOnlyTools, createTaskTools } from '../src/worker/task-tools.js'
import { tmp } from './helpers.js'

const sig = () => AbortSignal.timeout(5000)

/** What the path guard (`resolvePath`) answers for a path that leaves the root. */
const OUTSIDE_ROOT = 'pad valt buiten de worktree'

/** A synthetic review workspace: root/sources/doc holds the document under review. */
function reviewRoot(): string {
  const root = tmp('ro-root')
  mkdirSync(join(root, 'sources'), { recursive: true })
  writeFileSync(join(root, 'sources', 'doc'), 'eerste regel\nSYNTHETISCHE-TREFFER hier\nlaatste regel\n')
  return root
}

describe('createReadOnlyTools: registry', () => {
  it('exposes exactly list_files, read_file and search, sorted', () => {
    const reg = createReadOnlyTools({ root: reviewRoot() })
    expect(reg.snapshot.entries.map((e) => e.name)).toEqual(['list_files', 'read_file', 'search'])
    expect(reg.toOpenAiTools().map((t) => t.function.name)).toEqual(['list_files', 'read_file', 'search'])
    expect(reg.snapshot.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('answers UNKNOWN_TOOL for write_file, edit_file and run_tests and creates no file', async () => {
    const root = reviewRoot()
    const reg = createReadOnlyTools({ root })
    const unknown = { ok: false, errorCode: 'UNKNOWN_TOOL', content: 'tool not in snapshot', truncated: false }

    expect(await reg.execute('write_file', { path: 'nieuw.txt', content: 'x' }, sig())).toEqual(unknown)
    expect(await reg.execute('edit_file', { path: 'sources/doc', old_string: 'eerste', new_string: 'tweede' }, sig())).toEqual(unknown)
    expect(await reg.execute('run_tests', {}, sig())).toEqual(unknown)

    expect(existsSync(join(root, 'nieuw.txt'))).toBe(false)
    const read = await reg.execute('read_file', { path: 'sources/doc' }, sig())
    expect(read.content).toContain('eerste regel')
  })

  it('lists files under the root', async () => {
    const reg = createReadOnlyTools({ root: reviewRoot() })
    const r = await reg.execute('list_files', {}, sig())
    expect(r.ok).toBe(true)
    expect(r.content.split('\n')).toEqual(['sources/', 'sources/doc'])
  })
})

describe('createReadOnlyTools: path containment', () => {
  it('refuses ".." escaping the root', async () => {
    const root = reviewRoot()
    const reg = createReadOnlyTools({ root })
    const r = await reg.execute('read_file', { path: '../buiten.txt' }, sig())
    // The guard's own text: any other TOOL_ERROR (a file that is not there) would pass without the guard.
    expect(r).toEqual({ ok: false, errorCode: 'TOOL_ERROR', content: OUTSIDE_ROOT, truncated: false })
  })

  it('refuses a symlink in the root pointing to a file outside it', async () => {
    const root = reviewRoot()
    const outside = tmp('ro-outside')
    writeFileSync(join(outside, 'geheim.txt'), 'buiten de root')
    symlinkSync(join(outside, 'geheim.txt'), join(root, 'link.txt'))
    const reg = createReadOnlyTools({ root })
    const r = await reg.execute('read_file', { path: 'link.txt' }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
    expect(r.content).not.toContain('buiten de root')
  })

  it('refuses the absolute path /sources/doc and reads nothing outside the root', async () => {
    const root = reviewRoot()
    const reg = createReadOnlyTools({ root })
    // The model addressing the document root-relative, as "/sources/doc", is an absolute path on the host.
    const r = await reg.execute('read_file', { path: '/sources/doc' }, sig())
    // The guard's own text: "/sources/doc" is not a file on the host either, so a plain "not found" would pass without the guard.
    expect(r).toEqual({ ok: false, errorCode: 'TOOL_ERROR', content: OUTSIDE_ROOT, truncated: false })

    // And an absolute path to a real file outside the root is refused with its content never returned.
    const outside = tmp('ro-outside')
    writeFileSync(join(outside, 'geheim.txt'), 'buiten de root')
    const abs = await reg.execute('read_file', { path: join(outside, 'geheim.txt') }, sig())
    expect(abs).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
    expect(abs.content).not.toContain('buiten de root')
  })
})

describe('createReadOnlyTools: read_file', () => {
  it('returns the requested slice with offset/limit on a file over 20 000 characters', async () => {
    const root = reviewRoot()
    const line = 'y'.repeat(100)
    writeFileSync(join(root, 'groot.txt'), Array.from({ length: 500 }, (_, i) => `${line}${i}`).join('\n'))
    const reg = createReadOnlyTools({ root })
    const r = await reg.execute('read_file', { path: 'groot.txt', offset: 300, limit: 2 }, sig())
    expect(r.ok).toBe(true)
    expect(r.content).toBe(`301\t${line}300\n302\t${line}301`)
  })

  it('ends a whole-file read over 20 000 characters on the truncation note', async () => {
    const root = reviewRoot()
    const line = 'y'.repeat(100)
    writeFileSync(join(root, 'groot.txt'), Array.from({ length: 500 }, () => line).join('\n'))
    const reg = createReadOnlyTools({ root })
    const r = await reg.execute('read_file', { path: 'groot.txt' }, sig())
    expect(r.ok).toBe(true)
    expect(r.content.endsWith('[afgekapt, gebruik offset/limit]')).toBe(true)
  })
})

describe('createReadOnlyTools: search', () => {
  it('finds a line in sources/doc', async () => {
    const reg = createReadOnlyTools({ root: reviewRoot() })
    const r = await reg.execute('search', { pattern: 'SYNTHETISCHE-TREFFER' }, sig())
    expect(r.ok).toBe(true)
    expect(r.content).toBe('sources/doc:2: SYNTHETISCHE-TREFFER hier')
  })
})

// The read-only registry has its own factory body (the snapshot and the `execute` switch are written out a second time), so nothing but
// these tests ties it to `createTaskTools`: a change to one that skips the other has to fail here, not in a review run.
describe('createReadOnlyTools: drift guard against createTaskTools', () => {
  const READ_NAMES = ['list_files', 'read_file', 'search']
  const neverVerify = () => Promise.reject(new Error('run_tests not expected in this test'))

  it('has the snapshot entries, the hash and the OpenAI definitions of the matching three tools of createTaskTools', () => {
    const root = reviewRoot()
    const readOnly = createReadOnlyTools({ root })
    const full = createTaskTools({ root, runVerify: neverVerify })

    const entries = full.snapshot.entries.filter((e) => READ_NAMES.includes(e.name))
    expect(entries.map((e) => e.name)).toEqual(READ_NAMES) // the premise: all three are there, in the same sorted order
    expect(readOnly.snapshot.entries).toEqual(entries)
    // The hash input is JSON text, so key order counts as well: recomputed from the entries of createTaskTools, not compared as objects.
    expect(readOnly.snapshot.hash).toBe(createHash('sha256').update(JSON.stringify(entries)).digest('hex'))
    expect(readOnly.toOpenAiTools()).toEqual(full.toOpenAiTools().filter((t) => READ_NAMES.includes(t.function.name)))
  })

  it('answers the same as createTaskTools for the same calls on the same root, errors included', async () => {
    const root = reviewRoot()
    mkdirSync(join(root, 'work'))
    const readOnly = createReadOnlyTools({ root })
    const full = createTaskTools({ root, runVerify: neverVerify })

    const calls: Array<[string, Record<string, unknown>]> = [
      ['list_files', {}],
      ['list_files', { path: 'sources' }],
      ['list_files', { path: 'work' }],
      ['list_files', { path: 'sources/doc' }], // not a directory
      ['read_file', { path: 'sources/doc' }],
      ['read_file', { path: 'sources/doc', offset: 1, limit: 1 }],
      ['read_file', { path: 'sources/ontbreekt' }],
      ['read_file', { path: '../buiten.txt' }],
      ['read_file', { path: '/sources/doc' }],
      ['search', { pattern: 'SYNTHETISCHE-TREFFER' }],
      ['search', { pattern: 'komt-niet-voor', path: 'sources' }],
      ['search', { pattern: '(' }], // not a regex
    ]
    for (const [name, args] of calls) {
      const expected = await full.execute(name, args, sig())
      expect(await readOnly.execute(name, args, sig()), `${name} ${JSON.stringify(args)}`).toEqual(expected)
    }
  })
})
