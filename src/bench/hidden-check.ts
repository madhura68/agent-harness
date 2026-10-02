import { realpathSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { z } from 'zod'

/**
 * The verdict of the hidden check (spec §4.1 step 5). `files` has one entry per hidden file, in the order given: whether vitest ran
 * it, and how many of its tests passed, failed, or were anything else (skipped, pending, todo).
 */
export type HiddenResult = {
  pass: boolean
  reason: string
  files: Array<{ file: string; ran: boolean; passed: number; failed: number; other: number }>
}

/** The directory that the bench writes its own files to inside the work tree. It is never part of a patch. */
export const BENCH_DIR = '.task-bench'

/** Where the script lets vitest write its JSON report, relative to the work tree. The caller reads it from there. */
export const HIDDEN_REPORT = `${BENCH_DIR}/hidden.json`

/** Single quotes around the text, and each single quote in it as `'\''`: the shell takes everything in between literally. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

/**
 * The shell command that runs the hidden tests in the verify container: vitest with the JSON reporter, on exactly these files, with
 * the report in `.task-bench/hidden.json`. Every path is quoted, so no path can add an argument or run something.
 */
export function hiddenCheckScript(files: string[]): string {
  return ['npx vitest run --reporter=json', `--outputFile=${HIDDEN_REPORT}`, ...files.map(shellQuote)].join(' ')
}

// The part of vitest's JSON report that the verdict rests on. Anything that does not fit is treated as no usable report at all.
const VitestReportSchema = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      assertionResults: z.array(z.object({ status: z.string() })).optional(),
    }),
  ),
})

/**
 * `realpathSync`, also for a path that does not exist: the real path of its nearest existing ancestor with the rest appended.
 * Vitest reports real paths of files that exist; a path that is not there (a hand-made report, a vanished file) still has to be
 * compared on the same terms as the real work dir, and without an existing ancestor it stays as it is.
 */
function realPathLoose(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(realPathLoose(parent), basename(path))
  }
}

/**
 * Decides from the exit code and vitest's JSON report whether the hidden tests passed. They did when the exit code is 0 and, for
 * every file in `files`, vitest ran it, it has at least one test, and all of its tests are `passed`. Nothing else counts as a
 * pass: a file missing from the report ("niet gedraaid"), a file without tests (an import error), a failed, skipped, pending
 * or todo test, no exit code, an unreadable report, and an empty `files`.
 *
 * `testResults[].name` is matched to a file by its path relative to `work`, both as real paths, because vitest reports real
 * paths and `work` may be spelled through a symlink.
 */
export function evaluateHidden(o: { exitCode: number | null; json: unknown; work: string; files: string[] }): HiddenResult {
  const problems: string[] = []
  if (o.exitCode !== 0) problems.push(o.exitCode === null ? 'geen exitcode (afgebroken of time-out)' : `exitcode ${o.exitCode}`)
  if (o.files.length === 0) problems.push('geen verborgen testbestanden opgegeven')

  const report = VitestReportSchema.safeParse(o.json)
  if (!report.success) {
    problems.push('vitest-JSON ontbreekt of is onleesbaar')
    return { pass: false, reason: problems.join('; '), files: o.files.map((file) => ({ file, ran: false, passed: 0, failed: 0, other: 0 })) }
  }

  const realWork = realPathLoose(o.work)
  const results = report.data.testResults.map((r) => ({ rel: relative(realWork, realPathLoose(r.name)), assertions: r.assertionResults ?? [] }))

  const files = o.files.map((file) => {
    // A file that appears more than once counts with all of its entries.
    const entries = results.filter((r) => r.rel === file)
    let passed = 0
    let failed = 0
    let other = 0
    for (const entry of entries) {
      for (const assertion of entry.assertions) {
        if (assertion.status === 'passed') passed++
        else if (assertion.status === 'failed') failed++
        else other++
      }
    }
    return { file, ran: entries.length > 0, passed, failed, other }
  })

  for (const f of files) {
    if (!f.ran) problems.push(`niet gedraaid: ${f.file}`)
    else if (f.passed + f.failed + f.other === 0) problems.push(`geen enkele test in ${f.file}`)
    else {
      if (f.failed > 0) problems.push(`${f.failed} falende test(s) in ${f.file}`)
      if (f.other > 0) problems.push(`${f.other} overgeslagen of todo in ${f.file}`)
    }
  }

  if (problems.length > 0) return { pass: false, reason: problems.join('; '), files }
  const total = files.reduce((n, f) => n + f.passed, 0)
  return { pass: true, reason: `geslaagd: ${total} tests in ${files.length} verborgen testbestand(en)`, files }
}
