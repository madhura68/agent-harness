import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTaskTools, type VerifyRun } from '../src/worker/task-tools.js'
import { tmp } from './helpers.js'

const sig = () => AbortSignal.timeout(5000)
const neverVerify = () => Promise.reject(new Error('run_tests not expected in this test'))

function tools(root: string, runVerify: (signal: AbortSignal) => Promise<VerifyRun> = neverVerify) {
  return createTaskTools({ root, runVerify })
}

describe('createTaskTools: path containment', () => {
  it('refuses ".." escaping the worktree', async () => {
    const root = tmp('root')
    const reg = tools(root)
    const r = await reg.execute('read_file', { path: '../outside.txt' }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
  })

  it('refuses an absolute path outside the worktree', async () => {
    const root = tmp('root')
    const outside = tmp('outside')
    writeFileSync(join(outside, 'secret.txt'), 'geheim')
    const reg = tools(root)
    const r = await reg.execute('read_file', { path: join(outside, 'secret.txt') }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
  })

  it('refuses a symlink inside the root pointing outside it', async () => {
    const root = tmp('root')
    const outside = tmp('outside')
    writeFileSync(join(outside, 'secret.txt'), 'geheim')
    symlinkSync(outside, join(root, 'link'))
    const reg = tools(root)
    const r = await reg.execute('read_file', { path: 'link/secret.txt' }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
  })

  it('refuses writing a new file under a symlinked directory pointing outside the root', async () => {
    const root = tmp('root')
    const outside = tmp('outside')
    symlinkSync(outside, join(root, 'outlink'))
    const reg = tools(root)
    const r = await reg.execute('write_file', { path: 'outlink/newfile.txt', content: 'x' }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
    expect(() => readFileSync(join(outside, 'newfile.txt'), 'utf8')).toThrow()
  })

  it('refuses a nested .git segment', async () => {
    const root = tmp('root')
    mkdirSync(join(root, 'a'), { recursive: true })
    const reg = tools(root)
    const r = await reg.execute('read_file', { path: 'a/.git/config' }, sig())
    expect(r).toEqual({ ok: false, errorCode: 'TOOL_ERROR', content: 'pad met .git is niet toegestaan', truncated: false })
  })

  it('refuses a bare .git segment', async () => {
    const root = tmp('root')
    const reg = tools(root)
    const r = await reg.execute('read_file', { path: '.git' }, sig())
    expect(r).toEqual({ ok: false, errorCode: 'TOOL_ERROR', content: 'pad met .git is niet toegestaan', truncated: false })
  })

  it('allows a normal path under the root', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'hello.txt'), 'hoi')
    const reg = tools(root)
    const r = await reg.execute('read_file', { path: 'hello.txt' }, sig())
    expect(r.ok).toBe(true)
    expect(r.content).toContain('hoi')
  })
})

describe('read_file', () => {
  it('numbers lines and reads a sub-range with offset/limit', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'f.txt'), 'a\nb\nc\nd\ne\n')
    const reg = tools(root)
    const r = await reg.execute('read_file', { path: 'f.txt', offset: 1, limit: 2 }, sig())
    expect(r.ok).toBe(true)
    expect(r.content).toBe('2\tb\n3\tc')
  })

  it('caps the whole-file read at 20 000 characters with a truncation note', async () => {
    const root = tmp('root')
    const line = 'x'.repeat(100)
    writeFileSync(join(root, 'big.txt'), Array.from({ length: 500 }, () => line).join('\n'))
    const reg = tools(root)
    const r = await reg.execute('read_file', { path: 'big.txt' }, sig())
    expect(r.ok).toBe(true)
    expect(r.content).toContain('afgekapt, gebruik offset/limit')
    expect(r.content.length).toBeLessThan(20_100)
  })

  it('does not truncate a small file', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'small.txt'), 'one\ntwo')
    const reg = tools(root)
    const r = await reg.execute('read_file', { path: 'small.txt' }, sig())
    expect(r.content).toBe('1\tone\n2\ttwo')
    expect(r.content).not.toContain('afgekapt')
  })
})

describe('write_file', () => {
  it('creates parent directories and writes content', async () => {
    const root = tmp('root')
    const reg = tools(root)
    const r = await reg.execute('write_file', { path: 'a/b/c.txt', content: 'hallo' }, sig())
    expect(r.ok).toBe(true)
    expect(readFileSync(join(root, 'a', 'b', 'c.txt'), 'utf8')).toBe('hallo')
  })
})

describe('edit_file', () => {
  it('errors when old_string does not occur', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'f.txt'), 'const x = 1\n')
    const reg = tools(root)
    const r = await reg.execute('edit_file', { path: 'f.txt', old_string: 'y = 2', new_string: 'y = 3' }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
  })

  it('errors when old_string occurs more than once', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'f.txt'), 'dup\ndup\n')
    const reg = tools(root)
    const r = await reg.execute('edit_file', { path: 'f.txt', old_string: 'dup', new_string: 'x' }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
  })

  it('replaces a single occurrence, keeping a literal $& in new_string', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'f.txt'), 'const x = 1;\n')
    const reg = tools(root)
    const r = await reg.execute('edit_file', { path: 'f.txt', old_string: 'x = 1', new_string: 'y = $&' }, sig())
    expect(r.ok).toBe(true)
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('const y = $&;\n')
  })
})

describe('list_files', () => {
  it('skips node_modules and .git and caps at 300 lines', async () => {
    const root = tmp('root')
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'config'), '')
    for (let i = 0; i < 305; i++) writeFileSync(join(root, `file${String(i).padStart(3, '0')}.txt`), '')
    const reg = tools(root)
    const r = await reg.execute('list_files', {}, sig())
    expect(r.ok).toBe(true)
    const lines = r.content.split('\n')
    expect(lines.length).toBe(300)
    expect(r.content).not.toContain('node_modules')
    expect(r.content).not.toContain('.git')
  })

  it('lists a nested subdirectory', async () => {
    const root = tmp('root')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), '')
    const reg = tools(root)
    const r = await reg.execute('list_files', {}, sig())
    expect(r.content.split('\n').sort()).toEqual(['src/', 'src/a.ts'])
  })
})

describe('search', () => {
  it('finds matches formatted as bestand:regel: tekst', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'a.txt'), 'foo\nTARGET one\nbar\n')
    writeFileSync(join(root, 'b.txt'), 'TARGET two\n')
    const reg = tools(root)
    const r = await reg.execute('search', { pattern: 'TARGET' }, sig())
    expect(r.ok).toBe(true)
    const lines = r.content.split('\n').sort()
    expect(lines).toEqual(['a.txt:2: TARGET one', 'b.txt:1: TARGET two'])
  })

  it('caps hits at 100', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'many.txt'), Array.from({ length: 150 }, () => 'HIT').join('\n'))
    const reg = tools(root)
    const r = await reg.execute('search', { pattern: 'HIT' }, sig())
    expect(r.ok).toBe(true)
    expect(r.content.split('\n').length).toBe(100)
  })

  it('does not descend into node_modules or .git', async () => {
    const root = tmp('root')
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'x.txt'), 'TARGET')
    writeFileSync(join(root, 'a.txt'), 'TARGET')
    const reg = tools(root)
    const r = await reg.execute('search', { pattern: 'TARGET' }, sig())
    expect(r.content).toBe('a.txt:1: TARGET')
  })

  it('does not follow a symlink planted inside the root pointing to a file outside it', async () => {
    const root = tmp('root')
    const outside = tmp('outside')
    writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET content')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'sneaky.txt'))
    const reg = tools(root)
    const r = await reg.execute('search', { pattern: 'TOPSECRET' }, sig())
    expect(r.ok).toBe(true)
    expect(r.content).not.toContain('content')
    expect(r.content).not.toContain('sneaky.txt')
  })

  it('does not descend into a symlinked directory planted inside the root pointing outside it', async () => {
    const root = tmp('root')
    const outside = tmp('outside')
    writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET content')
    symlinkSync(outside, join(root, 'linkdir'))
    const reg = tools(root)
    const r = await reg.execute('search', { pattern: 'TOPSECRET' }, sig())
    expect(r.ok).toBe(true)
    expect(r.content).not.toContain('content')
  })
})

describe('list_files: symlinks', () => {
  it('lists a symlink by name but does not recurse into its outside target', async () => {
    const root = tmp('root')
    const outside = tmp('outside')
    writeFileSync(join(outside, 'secret.txt'), 'x')
    symlinkSync(outside, join(root, 'linkdir'))
    const reg = tools(root)
    const r = await reg.execute('list_files', {}, sig())
    expect(r.ok).toBe(true)
    expect(r.content).not.toContain('secret.txt')
  })
})

describe('run_tests', () => {
  it('is ok:true with exitcode 1 for a red run (not a tool error)', async () => {
    const root = tmp('root')
    const reg = tools(root, () => Promise.resolve({ exitCode: 1, output: 'FAIL: 2 tests failed', timedOut: false }))
    const r = await reg.execute('run_tests', {}, sig())
    expect(r).toMatchObject({ ok: true })
    expect(r.content.startsWith('exitcode 1\n')).toBe(true)
    expect(r.content).toContain('FAIL: 2 tests failed')
  })

  it('is ok:true with exitcode 0 for a green run', async () => {
    const root = tmp('root')
    const reg = tools(root, () => Promise.resolve({ exitCode: 0, output: 'all good', timedOut: false }))
    const r = await reg.execute('run_tests', {}, sig())
    expect(r).toMatchObject({ ok: true, content: 'exitcode 0\nall good' })
  })

  it('reports "exitcode timeout" when the run timed out', async () => {
    const root = tmp('root')
    const reg = tools(root, () => Promise.resolve({ exitCode: null, output: 'partial', timedOut: true }))
    const r = await reg.execute('run_tests', {}, sig())
    expect(r).toMatchObject({ ok: true })
    expect(r.content.startsWith('exitcode timeout\n')).toBe(true)
  })

  it('keeps only the last 6000 characters of output', async () => {
    const root = tmp('root')
    const output = 'y'.repeat(7000)
    const reg = tools(root, () => Promise.resolve({ exitCode: 1, output, timedOut: false }))
    const r = await reg.execute('run_tests', {}, sig())
    const [, tail] = r.content.split('\n')
    expect(tail.length).toBe(6000)
  })

  it('is ok:false when the runner itself fails', async () => {
    const root = tmp('root')
    const reg = tools(root, () => Promise.resolve({ exitCode: null, output: '', timedOut: false, runnerError: 'docker niet bereikbaar' }))
    const r = await reg.execute('run_tests', {}, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
    expect(r.content).toContain('docker niet bereikbaar')
  })
})

describe('snapshot', () => {
  it('lists all six tools sorted by name with a stable hash', async () => {
    const root = tmp('root')
    const reg = tools(root)
    expect(reg.snapshot.entries.map((e) => e.name)).toEqual(['edit_file', 'list_files', 'read_file', 'run_tests', 'search', 'write_file'])
    expect(reg.snapshot.hash).toMatch(/^[0-9a-f]{64}$/)
    const reg2 = tools(tmp('root2'))
    expect(reg2.snapshot.hash).toBe(reg.snapshot.hash)
  })

  it('offers no git or shell tool', async () => {
    const root = tmp('root')
    const reg = tools(root)
    expect(reg.snapshot.entries.map((e) => e.name)).not.toEqual(expect.arrayContaining(['git', 'shell', 'bash', 'exec']))
  })
})
