import { execFile } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { BENCH_DIR, evaluateHidden, HIDDEN_REPORT, hiddenCheckScript, MAX_HIDDEN_REPORT_BYTES, readHiddenReport } from '../src/bench/hidden-check.js'
import { makeFifo } from './helpers.js'

const execFileAsync = promisify(execFile)

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop() as string, { recursive: true, force: true })
})
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bench-hidden-${prefix}-`))
  cleanup.push(dir)
  return dir
}

describe('hiddenCheckScript', () => {
  it('runs vitest with the JSON reporter into .task-bench/hidden.json, one quoted argument per file', () => {
    expect(hiddenCheckScript(['__tests__/b.test.ts'])).toBe(
      "npx vitest run --reporter=json --outputFile=.task-bench/hidden.json '__tests__/b.test.ts'",
    )
    expect(hiddenCheckScript(['__tests__/b.test.ts', '__tests__/c.test.ts'])).toBe(
      "npx vitest run --reporter=json --outputFile=.task-bench/hidden.json '__tests__/b.test.ts' '__tests__/c.test.ts'",
    )
  })

  it("escapes a single quote as '\\'' inside the quoted path", () => {
    expect(hiddenCheckScript(["__tests__/it's.test.ts"])).toBe(
      "npx vitest run --reporter=json --outputFile=.task-bench/hidden.json '__tests__/it'\\''s.test.ts'",
    )
  })

  it('hands every path to the program unchanged and runs nothing it contains', async () => {
    const bin = tmp('bin')
    const marker = join(bin, 'pwned')
    // A stand-in for npx: prints its arguments NUL-separated, so that a path with a newline in it stays recognizable.
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a"; done\n')
    chmodSync(join(bin, 'npx'), 0o755)

    const paths = [
      '__tests__/a b.test.ts',
      "__tests__/it's.test.ts",
      `__tests__/$(touch ${marker}).test.ts`,
      `__tests__/\`touch ${marker}\`.test.ts`,
      `__tests__/x;touch ${marker};.test.ts`,
      `__tests__/y && touch ${marker}.test.ts`,
      '__tests__/*.test.ts',
      '__tests__/new\nline.test.ts',
      '__tests__/"double".test.ts',
      '__tests__/back\\slash.test.ts',
    ]
    const { stdout } = await execFileAsync('sh', ['-c', hiddenCheckScript(paths)], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME },
    })

    expect(stdout.split('\0')).toEqual(['vitest', 'run', '--reporter=json', '--outputFile=.task-bench/hidden.json', ...paths, ''])
    expect(existsSync(marker)).toBe(false)
  })
})

// A report in the shape of vitest's JSON reporter (vitest 5.0.2): `testResults[].name` is the absolute path of the test file, and
// `assertionResults[].status` is one of passed, failed, skipped, pending, todo. A file that cannot be imported has no assertions.
type Status = 'passed' | 'failed' | 'skipped' | 'pending' | 'todo'

function fileResult(name: string, statuses: Status[], message = '') {
  return {
    assertionResults: statuses.map((status, i) => ({
      ancestorTitles: [],
      fullName: `test ${i}`,
      status,
      title: `test ${i}`,
      failureMessages: status === 'failed' ? ['AssertionError: expected 2 to be 3 // Object.is equality'] : [],
      meta: {},
      tags: [],
      benchmarks: [],
    })),
    startTime: 1790960283888,
    endTime: 1790960283892,
    status: statuses.length > 0 && statuses.every((s) => s === 'passed') ? 'passed' : 'failed',
    message,
    name,
  }
}

function report(...testResults: unknown[]) {
  return { numTotalTestSuites: testResults.length, success: true, startTime: 1790960283771, testResults }
}

const WORK = '/srv/bench/ws/work'
const B = '__tests__/b.test.ts'
const C = '__tests__/c.test.ts'

describe('evaluateHidden', () => {
  it('passes when the exit code is 0 and every hidden file ran with only passed tests', () => {
    const r = evaluateHidden({
      exitCode: 0,
      json: report(fileResult(`${WORK}/${B}`, ['passed', 'passed']), fileResult(`${WORK}/${C}`, ['passed'])),
      work: WORK,
      files: [B, C],
    })
    expect(r.pass).toBe(true)
    expect(r.reason).not.toBe('')
    expect(r.files).toEqual([
      { file: B, ran: true, passed: 2, failed: 0, other: 0 },
      { file: C, ran: true, passed: 1, failed: 0, other: 0 },
    ])
  })

  it('fails on one failed test, and says which file', () => {
    const r = evaluateHidden({ exitCode: 1, json: report(fileResult(`${WORK}/${B}`, ['passed', 'failed'])), work: WORK, files: [B] })
    expect(r.pass).toBe(false)
    expect(r.files).toEqual([{ file: B, ran: true, passed: 1, failed: 1, other: 0 }])
    expect(r.reason).toContain(B)
  })

  it('fails on a failed test even when the exit code claims success', () => {
    const r = evaluateHidden({ exitCode: 0, json: report(fileResult(`${WORK}/${B}`, ['passed', 'failed'])), work: WORK, files: [B] })
    expect(r.pass).toBe(false)
  })

  it.each(['skipped', 'pending', 'todo'] as const)('fails on a %s test, counted as other', (status) => {
    const r = evaluateHidden({ exitCode: 0, json: report(fileResult(`${WORK}/${B}`, ['passed', status])), work: WORK, files: [B] })
    expect(r.pass).toBe(false)
    expect(r.files).toEqual([{ file: B, ran: true, passed: 1, failed: 0, other: 1 }])
  })

  it('fails with "niet gedraaid" for a hidden file that is not in testResults, even if a file next to it passed', () => {
    const r = evaluateHidden({
      exitCode: 0,
      json: report(fileResult(`${WORK}/__tests__/a.test.ts`, ['passed']), fileResult(`${WORK}/${C}`, ['passed'])),
      work: WORK,
      files: [B, C],
    })
    expect(r.pass).toBe(false)
    expect(r.reason).toContain('niet gedraaid')
    expect(r.reason).toContain(B)
    expect(r.files).toEqual([
      { file: B, ran: false, passed: 0, failed: 0, other: 0 },
      { file: C, ran: true, passed: 1, failed: 0, other: 0 },
    ])
  })

  it('fails for a file without assertionResults, such as an import error', () => {
    const importError = fileResult(`${WORK}/${B}`, [], "Cannot find module '../src/y.js' imported from " + `${WORK}/${B}`)
    expect(importError.assertionResults).toEqual([])
    const r = evaluateHidden({ exitCode: 0, json: report(importError), work: WORK, files: [B] })
    expect(r.pass).toBe(false)
    expect(r.files).toEqual([{ file: B, ran: true, passed: 0, failed: 0, other: 0 }])

    const { assertionResults: _omitted, ...withoutKey } = importError
    expect(evaluateHidden({ exitCode: 0, json: report(withoutKey), work: WORK, files: [B] }).pass).toBe(false)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not json'],
    ['an array', []],
    ['an object without testResults', { success: true }],
    ['testResults that is not an array', { testResults: 'x' }],
    ['a result without a name', { testResults: [{ assertionResults: [{ status: 'passed' }] }] }],
    ['assertionResults that is not an array', { testResults: [{ name: `${WORK}/${B}`, assertionResults: 'passed' }] }],
  ])('fails with exit code 0 when the JSON is missing or unreadable: %s', (_label, json) => {
    const r = evaluateHidden({ exitCode: 0, json, work: WORK, files: [B] })
    expect(r.pass).toBe(false)
    expect(r.reason).toContain('JSON')
    expect(r.files).toEqual([{ file: B, ran: false, passed: 0, failed: 0, other: 0 }])
  })

  it.each([1, 2, 137])('fails on exit code %i even when the JSON shows only passed tests', (exitCode) => {
    const r = evaluateHidden({ exitCode, json: report(fileResult(`${WORK}/${B}`, ['passed'])), work: WORK, files: [B] })
    expect(r.pass).toBe(false)
    expect(r.reason).toContain(`exitcode ${exitCode}`)
  })

  it('fails on a null exit code (no exit code at all) even when the JSON shows only passed tests', () => {
    const r = evaluateHidden({ exitCode: null, json: report(fileResult(`${WORK}/${B}`, ['passed'])), work: WORK, files: [B] })
    expect(r.pass).toBe(false)
    expect(r.reason).toContain('exitcode')
  })

  it('only counts a result whose path relative to work is exactly the hidden file', () => {
    const elsewhere = [`${WORK}/src/${B}`, `/srv/bench/other/work/${B}`, `${WORK}/${B}.bak`, `${WORK}x/${B}`]
    const r = evaluateHidden({ exitCode: 0, json: report(...elsewhere.map((n) => fileResult(n, ['passed']))), work: WORK, files: [B] })
    expect(r.pass).toBe(false)
    expect(r.files).toEqual([{ file: B, ran: false, passed: 0, failed: 0, other: 0 }])
  })

  it('counts a file that appears twice in testResults as failed when one of the entries is', () => {
    const r = evaluateHidden({
      exitCode: 0,
      json: report(fileResult(`${WORK}/${B}`, ['passed']), fileResult(`${WORK}/${B}`, ['failed'])),
      work: WORK,
      files: [B],
    })
    expect(r.pass).toBe(false)
    expect(r.files).toEqual([{ file: B, ran: true, passed: 1, failed: 1, other: 0 }])
  })

  it('never passes without hidden files, so an empty list is no vacuous pass', () => {
    const r = evaluateHidden({ exitCode: 0, json: report(), work: WORK, files: [] })
    expect(r.pass).toBe(false)
    expect(r.files).toEqual([])
  })

  it('passes for a work path through a symlink when the JSON names the real path, as vitest does', () => {
    const real = tmp('real')
    mkdirSync(join(real, '__tests__'))
    writeFileSync(join(real, B), '')
    const link = join(tmp('link'), 'work')
    symlinkSync(real, link)

    const json = report(fileResult(join(realpathSync(real), B), ['passed']))
    expect(evaluateHidden({ exitCode: 0, json, work: link, files: [B] }).pass).toBe(true)
    // the other way round: the JSON names the real path and work is spelled differently than it, such as /var against /private/var
    expect(evaluateHidden({ exitCode: 0, json, work: real, files: [B] }).pass).toBe(true)
    // and the real work dir under a name that the JSON does not know stays a miss
    expect(evaluateHidden({ exitCode: 0, json, work: join(link, '__tests__'), files: [B] }).pass).toBe(false)
  })

  it('also matches a file that does not exist when its name goes through a symlink: the nearest existing ancestor decides', () => {
    const real = tmp('ghost')
    const link = join(tmp('ghostlink'), 'work')
    symlinkSync(real, link)
    // Vitest only reports files that exist. A hand-made report may name one that is not there, and not by its real path.
    const json = report(fileResult(join(link, 'nope', 'ghost.test.ts'), ['passed']))
    expect(evaluateHidden({ exitCode: 0, json, work: real, files: ['nope/ghost.test.ts'] }).pass).toBe(true)
    expect(evaluateHidden({ exitCode: 0, json, work: link, files: ['nope/ghost.test.ts'] }).pass).toBe(true)
  })

  it('compares paths as they are when nothing of them exists', () => {
    const json = report(fileResult(`${WORK}/${B}`, ['passed']))
    expect(evaluateHidden({ exitCode: 0, json, work: WORK, files: [B] }).pass).toBe(true)
    expect(evaluateHidden({ exitCode: 0, json, work: `${WORK}/sub`, files: [B] }).pass).toBe(false)
  })
})

// The container that runs the hidden tests runs model-written code with the work tree mounted writable, so whatever it leaves at
// `.task-bench/hidden.json` is the model's doing: a symlink to a file of the host, a FIFO, a directory. The bench reads that path on
// the host after the container is gone, and it must never follow, wait for, or copy anything but a plain file that lies in the work tree.
describe('readHiddenReport', () => {
  const SECRET = 'HOST-SECRET-MARKER-7c1e' // in a host file that must never be read

  /** A work tree, and a host dir outside it that holds `secret.txt` (the SECRET) and a dir `elsewhere/` with a hidden.json of its own. */
  function setup() {
    const work = tmp('report-work')
    const host = tmp('report-host')
    writeFileSync(join(host, 'secret.txt'), SECRET)
    mkdirSync(join(host, 'elsewhere'))
    writeFileSync(join(host, 'elsewhere', 'hidden.json'), JSON.stringify({ testResults: [], marker: SECRET }))
    return { work, secret: join(host, 'secret.txt'), elsewhere: join(host, 'elsewhere') }
  }
  const reportPath = (work: string) => join(work, HIDDEN_REPORT)
  /** `.task-bench/` as a real directory, as vitest makes it. */
  const benchDir = (work: string) => mkdirSync(join(work, BENCH_DIR), { recursive: true })
  /** What a refusal must look like: it names the problem, and nothing of the host file is in it. */
  function expectUnsafe(read: ReturnType<typeof readHiddenReport>, ...about: string[]) {
    expect(read.kind).toBe('unsafe')
    const why = read.kind === 'unsafe' ? read.why : ''
    for (const word of about) expect(why).toContain(word)
    expect(JSON.stringify(read)).not.toContain(SECRET)
  }

  it('reads a plain report as text', () => {
    const { work } = setup()
    benchDir(work)
    const text = JSON.stringify({ testResults: [], naam: 'één test ✓' })
    writeFileSync(reportPath(work), text)
    expect(readHiddenReport(work)).toEqual({ kind: 'report', text })
  })

  it('reads an empty file as an empty report, and a report of exactly the cap in full', () => {
    const { work } = setup()
    benchDir(work)
    writeFileSync(reportPath(work), '')
    expect(readHiddenReport(work)).toEqual({ kind: 'report', text: '' })
    writeFileSync(reportPath(work), 'x'.repeat(MAX_HIDDEN_REPORT_BYTES))
    const read = readHiddenReport(work)
    expect(read.kind === 'report' && read.text.length).toBe(MAX_HIDDEN_REPORT_BYTES)
  })

  it('finds nothing when vitest wrote no report: no .task-bench, or no hidden.json in it', () => {
    const { work } = setup()
    expect(readHiddenReport(work)).toEqual({ kind: 'none' })
    benchDir(work)
    expect(readHiddenReport(work)).toEqual({ kind: 'none' })
  })

  it('refuses a hidden.json that is a symlink to a file of the host, and reads none of it', () => {
    const { work, secret } = setup()
    benchDir(work)
    symlinkSync(secret, reportPath(work))
    expectUnsafe(readHiddenReport(work), HIDDEN_REPORT, 'symlink')
  })

  it('refuses a hidden.json that is a symlink that leads nowhere', () => {
    const { work } = setup()
    benchDir(work)
    symlinkSync(join(work, 'bestaat-niet'), reportPath(work))
    expectUnsafe(readHiddenReport(work), HIDDEN_REPORT, 'symlink')
  })

  it('refuses a hidden.json that is a FIFO at once, without waiting for a writer that never comes', () => {
    const { work } = setup()
    benchDir(work)
    makeFifo(reportPath(work))
    const started = Date.now()
    expectUnsafe(readHiddenReport(work), HIDDEN_REPORT, 'FIFO')
    expect(Date.now() - started).toBeLessThan(1000) // makeFifo's writer only comes at 1500 ms
  })

  it('refuses a hidden.json that is a directory', () => {
    const { work } = setup()
    benchDir(work)
    mkdirSync(reportPath(work))
    expectUnsafe(readHiddenReport(work), HIDDEN_REPORT, 'map')
  })

  it('refuses a report over the cap', () => {
    const { work } = setup()
    benchDir(work)
    writeFileSync(reportPath(work), 'x'.repeat(MAX_HIDDEN_REPORT_BYTES + 1))
    expectUnsafe(readHiddenReport(work), HIDDEN_REPORT, 'te groot')
  })

  it('refuses .task-bench as a symlink to a directory outside the work tree, and reads the report in that directory not', () => {
    const { work, elsewhere } = setup()
    symlinkSync(elsewhere, join(work, BENCH_DIR))
    expectUnsafe(readHiddenReport(work), BENCH_DIR, 'symlink')
  })

  it('refuses .task-bench as a plain file, and as a FIFO', () => {
    const { work } = setup()
    writeFileSync(join(work, BENCH_DIR), 'geen map')
    expectUnsafe(readHiddenReport(work), BENCH_DIR, 'gewoon bestand')
    rmSync(join(work, BENCH_DIR))
    makeFifo(join(work, BENCH_DIR))
    expectUnsafe(readHiddenReport(work), BENCH_DIR, 'FIFO')
  })

  // A container can also make the path impossible to look at: chmod 0 on its own directory shuts out the owner too. Not a plain missing
  // report (that is the model's doing as much as vitest's), but not something to read or to score either. (root ignores modes.)
  describe.skipIf(process.getuid?.() === 0)('when the path cannot be looked at', () => {
    it('refuses a .task-bench that cannot be entered', () => {
      const { work } = setup()
      benchDir(work)
      writeFileSync(reportPath(work), '{}')
      chmodSync(join(work, BENCH_DIR), 0)
      try {
        expectUnsafe(readHiddenReport(work), HIDDEN_REPORT, 'kon niet worden onderzocht')
      } finally {
        chmodSync(join(work, BENCH_DIR), 0o755) // so that the cleanup can remove it
      }
    })

    it('refuses a work tree whose .task-bench cannot be looked at', () => {
      const { work } = setup()
      benchDir(work)
      chmodSync(work, 0)
      try {
        expectUnsafe(readHiddenReport(work), BENCH_DIR, 'kon niet worden onderzocht')
      } finally {
        chmodSync(work, 0o755)
      }
    })
  })

  // The look at the path (lstat) and the open are two moments. These tests make the first one believe that all is well, as if the
  // path had been swapped in between, and show that the open and the checks on the descriptor refuse it on their own.
  describe('when the path is swapped after the first look', () => {
    const believingItIsPlain = (work: string, secret: string) => {
      const plain = lstatSync(secret) // the Stats of a small regular file
      return { lstatSync: (path: string) => (path === reportPath(work) ? plain : lstatSync(path)) }
    }

    it('does not follow a symlink: the open refuses it (O_NOFOLLOW)', () => {
      const { work, secret } = setup()
      benchDir(work)
      symlinkSync(secret, reportPath(work))
      expectUnsafe(readHiddenReport(work, believingItIsPlain(work, secret)), HIDDEN_REPORT, 'niet veilig worden geopend')
    })

    it('does not wait on a FIFO: the open does not block (O_NONBLOCK), and the descriptor says it is no file', () => {
      const { work, secret } = setup()
      benchDir(work)
      makeFifo(reportPath(work))
      const started = Date.now()
      expectUnsafe(readHiddenReport(work, believingItIsPlain(work, secret)), HIDDEN_REPORT, 'FIFO')
      expect(Date.now() - started).toBeLessThan(1000) // makeFifo's writer only comes at 1500 ms
    })

    it('does not read a file that has outgrown the cap: the descriptor has the size', () => {
      const { work, secret } = setup()
      benchDir(work)
      writeFileSync(reportPath(work), 'x'.repeat(MAX_HIDDEN_REPORT_BYTES + 1))
      expectUnsafe(readHiddenReport(work, believingItIsPlain(work, secret)), HIDDEN_REPORT, 'te groot')
    })
  })
})
