import { execFileSync } from 'node:child_process'
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

function toolsWithSearchLimits(root: string, searchLimits: { totalBytesCap?: number; timeoutMs?: number; perFileTimeoutMs?: number }) {
  return createTaskTools({ root, runVerify: neverVerify, searchLimits })
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

describe('createTaskTools: dangling symlinks (fix round 1, Critical)', () => {
  it('refuses write_file through a dangling symlink as the last path component', async () => {
    const root = tmp('root')
    const outside = tmp('outside')
    const plantedTarget = join(outside, 'planted.txt') // never created
    symlinkSync(plantedTarget, join(root, 'dang'))
    const reg = tools(root)
    const r = await reg.execute('write_file', { path: 'dang', content: 'ESCAPED' }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
    expect(() => readFileSync(plantedTarget, 'utf8')).toThrow()
  })

  it('refuses write_file through a dangling symlink in the middle of the path', async () => {
    const root = tmp('root')
    const outside = tmp('outside')
    const missingDir = join(outside, 'nonexistent-dir')
    symlinkSync(missingDir, join(root, 'dlink'))
    const reg = tools(root)
    const r = await reg.execute('write_file', { path: 'dlink/newfile.txt', content: 'ESCAPED' }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
    expect(() => readFileSync(join(missingDir, 'newfile.txt'), 'utf8')).toThrow()
  })

  it('refuses edit_file through a dangling symlink', async () => {
    const root = tmp('root')
    const outside = tmp('outside')
    symlinkSync(join(outside, 'planted-edit.txt'), join(root, 'dang-edit'))
    const reg = tools(root)
    const r = await reg.execute('edit_file', { path: 'dang-edit', old_string: 'a', new_string: 'b' }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
  })

  it('refuses read_file through a dangling symlink', async () => {
    const root = tmp('root')
    const outside = tmp('outside')
    symlinkSync(join(outside, 'planted-read.txt'), join(root, 'dang-read'))
    const reg = tools(root)
    const r = await reg.execute('read_file', { path: 'dang-read' }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
  })

  it('still refuses a non-dangling symlink as the final component (no regression)', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'real.txt'), 'hoi')
    symlinkSync(join(root, 'real.txt'), join(root, 'alias'))
    const reg = tools(root)
    const r = await reg.execute('read_file', { path: 'alias' }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
  })
})

describe('createTaskTools: special files (fix round 1, Important)', () => {
  it('refuses to read a FIFO instead of hanging (read_file)', async () => {
    const root = tmp('root')
    const fifoPath = join(root, 'p')
    execFileSync('mkfifo', [fifoPath])
    const reg = tools(root)
    const r = await reg.execute('read_file', { path: 'p' }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
  }, 8000)

  it('does not hang on a FIFO in the tree (search)', async () => {
    const root = tmp('root')
    execFileSync('mkfifo', [join(root, 'p')])
    writeFileSync(join(root, 'a.txt'), 'TARGET')
    const reg = tools(root)
    const r = await reg.execute('search', { pattern: 'TARGET' }, sig())
    expect(r.ok).toBe(true)
    expect(r.content).toBe('a.txt:1: TARGET')
  }, 8000)

  it('refuses to read an oversized file', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'huge.bin'), Buffer.alloc(6 * 1024 * 1024, 'x'))
    const reg = tools(root)
    const r = await reg.execute('read_file', { path: 'huge.bin' }, sig())
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
  })

  it('skips an oversized file during search rather than reading it whole', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'huge.txt'), 'TARGET\n'.repeat(200_000)) // > 1 MB
    writeFileSync(join(root, 'small.txt'), 'TARGET small')
    const reg = tools(root)
    const r = await reg.execute('search', { pattern: 'TARGET' }, sig())
    expect(r.ok).toBe(true)
    expect(r.content).toBe('small.txt:1: TARGET small')
  }, 8000)
})

describe('createTaskTools: ReDoS guard (fix round 1, Important)', () => {
  it('aborts a catastrophic regex within the timeout instead of hanging', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'a.txt'), `${'a'.repeat(34)}!`)
    const reg = tools(root)
    const started = Date.now()
    const r = await reg.execute('search', { pattern: '^(a+)+$' }, AbortSignal.timeout(9000))
    const elapsed = Date.now() - started
    expect(r).toEqual({ ok: false, errorCode: 'TOOL_ERROR', content: 'search afgebroken: timeout', truncated: false })
    expect(elapsed).toBeLessThan(8000)
  }, 10_000)
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

describe('search: incremental matching over large trees (fix round 2, Important)', () => {
  it('finds a match in a late-sorted directory even when the tree has far more lines than the old fixed candidate cap', async () => {
    const root = tmp('root')
    // "aaa" and "bbb" sort — and so get walked — before "zzz". Round 1 stopped COLLECTING candidate
    // lines once a fixed total (50 000) was reached, so a repo with more lines than that never even
    // reached files past that point: the real match below would have been silently missed.
    const fillerLine = 'filler line, nothing to see here\n'
    mkdirSync(join(root, 'aaa'), { recursive: true })
    writeFileSync(join(root, 'aaa', 'big1.txt'), fillerLine.repeat(30_000))
    mkdirSync(join(root, 'bbb'), { recursive: true })
    writeFileSync(join(root, 'bbb', 'big2.txt'), fillerLine.repeat(30_000))
    mkdirSync(join(root, 'zzz'), { recursive: true })
    writeFileSync(join(root, 'zzz', 'target.txt'), 'needle-in-a-haystack-marker\n')

    const reg = tools(root)
    const r = await reg.execute('search', { pattern: 'needle-in-a-haystack-marker' }, AbortSignal.timeout(15_000))
    expect(r.ok).toBe(true)
    expect(r.content).toBe('zzz/target.txt:1: needle-in-a-haystack-marker')
  }, 20_000)

  it('never reports "geen treffers" when a real hit exists but a time bound cut the search short', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'a.txt'), 'nothing interesting here\n')
    writeFileSync(join(root, 'b.txt'), 'TARGET should never be reached\n')
    // An effectively-zero overall budget: the very first file already exceeds it, so the walk stops
    // before ever reaching b.txt — this must be reported, never silently look like "no matches anywhere".
    const reg = toolsWithSearchLimits(root, { timeoutMs: 1, perFileTimeoutMs: 1 })
    const r = await reg.execute('search', { pattern: 'TARGET' }, sig())
    expect(r.ok).toBe(true)
    expect(r.content).toContain('(zoekopdracht afgekapt: timeout; beperk met path)')
  })

  it('never reports "geen treffers" when a real hit exists but the byte budget cut the search short', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'a.txt'), 'this file alone already exceeds the tiny byte budget\n')
    writeFileSync(join(root, 'b.txt'), 'TARGET should never be reached\n')
    const reg = toolsWithSearchLimits(root, { totalBytesCap: 10 })
    const r = await reg.execute('search', { pattern: 'TARGET' }, sig())
    expect(r.ok).toBe(true)
    expect(r.content).toContain('(zoekopdracht afgekapt: datalimiet; beperk met path)')
  })

  it('does not append a truncation notice for an ordinary, complete search', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'a.txt'), 'TARGET\n')
    const reg = tools(root)
    const r = await reg.execute('search', { pattern: 'TARGET' }, sig())
    expect(r.content).toBe('a.txt:1: TARGET')
    expect(r.content).not.toContain('afgekapt')
  })

  it('a genuinely empty result over a small, fully-searched tree stays a plain "geen treffers" (no false notice)', async () => {
    const root = tmp('root')
    writeFileSync(join(root, 'a.txt'), 'nothing to find here\n')
    const reg = tools(root)
    const r = await reg.execute('search', { pattern: 'NEEDLE_NOT_PRESENT' }, sig())
    expect(r.content).toBe('geen treffers voor NEEDLE_NOT_PRESENT')
  })
})

describe('createTaskTools: symlinked worktree root (fix round 2, Minor)', () => {
  it('list_files works when the worktree root itself is a symlink', async () => {
    const realRootDir = tmp('realroot')
    writeFileSync(join(realRootDir, 'a.txt'), 'hi')
    const parent = tmp('linkparent')
    const linkRoot = join(parent, 'root-link')
    symlinkSync(realRootDir, linkRoot)

    const reg = tools(linkRoot)
    const r = await reg.execute('list_files', {}, sig())
    expect(r).toMatchObject({ ok: true, content: 'a.txt' })
  })

  it('search works when the worktree root itself is a symlink', async () => {
    const realRootDir = tmp('realroot')
    writeFileSync(join(realRootDir, 'a.txt'), 'TARGET here')
    const parent = tmp('linkparent')
    const linkRoot = join(parent, 'root-link')
    symlinkSync(realRootDir, linkRoot)

    const reg = tools(linkRoot)
    const r = await reg.execute('search', { pattern: 'TARGET' }, sig())
    expect(r).toMatchObject({ ok: true, content: 'a.txt:1: TARGET here' })
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
