import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs'
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

/**
 * The most a hidden-check report may weigh. A report on a handful of test files is kilobytes; the cap only keeps a file that the
 * container blew up out of the memory of the bench.
 */
export const MAX_HIDDEN_REPORT_BYTES = 8 * 1024 * 1024

/** What `readHiddenReport` found where vitest was to write its report. */
export type HiddenReportRead =
  | { kind: 'report'; text: string } // a plain file in the work tree, read through the descriptor that was checked
  | { kind: 'none' } // nothing there: vitest wrote no report
  | { kind: 'unsafe'; why: string } // something else is there: the container made the path into a link, a FIFO or the like

/** What a path is, for a message. */
function kindOf(st: Stats): string {
  if (st.isSymbolicLink()) return 'een symlink'
  if (st.isFIFO()) return 'een FIFO'
  if (st.isDirectory()) return 'een map'
  if (st.isSocket()) return 'een socket'
  if (st.isFile()) return 'een gewoon bestand'
  return 'een device'
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** `lstat` of a path that may not be there: a missing path is `{}`, any other trouble is its message. */
function inspect(lstat: (path: string) => Stats, path: string): { stats?: Stats; trouble?: string } {
  try {
    return { stats: lstat(path) }
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? {} : { trouble: message(err) }
  }
}

/**
 * Reads the report that vitest wrote to `<work>/.task-bench/hidden.json`, after the container that ran it is gone.
 *
 * That container runs model-written code on a work tree it can write to, so the path is the model's to shape: a symlink to a file of
 * the host would have the bench copy that file (a key file, in a hosted window), and a FIFO would block a synchronous read for good,
 * so that the stop signals never get to run and no result is written. Therefore only a plain file counts, in a plain directory, under
 * a size cap, and the read goes in two steps: `lstat` on the way (a clear message for what is there), then the open itself refuses a
 * symlink (`O_NOFOLLOW`) and never waits (`O_NONBLOCK`), and the descriptor that was opened is checked again (`fstat`: a plain file,
 * under the cap) and is what is read, never the path. Anything else is `unsafe`, with the reason; a report that is not there is `none`.
 * The caller treats `unsafe` as a failure of the bench (`benchfout`), never as a verdict on the tests, and never copies the path.
 *
 * What it guards against is a path that the container left behind. It cannot guard against a process that still runs in the container
 * and swaps `.task-bench` while this reads (`O_NOFOLLOW` only refuses a link as the last component of the path): call it once the
 * container is known to be gone, and throw away what it read when that is not so (`cleanup: 'uncertain'`).
 *
 * `deps.lstatSync` is a test seam, for a path that is swapped after the first look.
 */
export function readHiddenReport(work: string, deps: { lstatSync?: (path: string) => Stats } = {}): HiddenReportRead {
  const lstat = deps.lstatSync ?? lstatSync
  const unsafe = (why: string): HiddenReportRead => ({ kind: 'unsafe', why })
  const tooBig = (bytes: number) => unsafe(`${HIDDEN_REPORT} is te groot (${bytes} bytes, meer dan ${MAX_HIDDEN_REPORT_BYTES})`)

  const dir = inspect(lstat, join(work, BENCH_DIR))
  if (dir.trouble) return unsafe(`${BENCH_DIR} kon niet worden onderzocht: ${dir.trouble}`)
  if (!dir.stats) return { kind: 'none' }
  if (!dir.stats.isDirectory()) return unsafe(`${BENCH_DIR} is ${kindOf(dir.stats)}, geen gewone map`) // lstat: a symlink is not a directory

  const path = join(work, HIDDEN_REPORT)
  const file = inspect(lstat, path)
  if (file.trouble) return unsafe(`${HIDDEN_REPORT} kon niet worden onderzocht: ${file.trouble}`)
  if (!file.stats) return { kind: 'none' }
  if (!file.stats.isFile()) return unsafe(`${HIDDEN_REPORT} is ${kindOf(file.stats)}, geen gewoon bestand`)
  if (file.stats.size > MAX_HIDDEN_REPORT_BYTES) return tooBig(file.stats.size)

  let fd: number
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  } catch (err) {
    return unsafe(`${HIDDEN_REPORT} kon niet veilig worden geopend: ${message(err)}`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return unsafe(`${HIDDEN_REPORT} is ${kindOf(st)}, geen gewoon bestand`)
    if (st.size > MAX_HIDDEN_REPORT_BYTES) return tooBig(st.size)
    // Exactly the size that was checked, never to the end of the file: a read that runs to EOF has no bound if something still writes.
    const buffer = Buffer.allocUnsafe(st.size)
    let filled = 0
    while (filled < st.size) {
      const n = readSync(fd, buffer, filled, st.size - filled, null)
      if (n === 0) break // the file got shorter
      filled += n
    }
    return { kind: 'report', text: buffer.toString('utf8', 0, filled) }
  } catch (err) {
    return unsafe(`${HIDDEN_REPORT} kon niet worden gelezen: ${message(err)}`)
  } finally {
    closeSync(fd)
  }
}

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
