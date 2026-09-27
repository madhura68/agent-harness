import { createHash } from 'node:crypto'
import { closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, type Stats } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { TOOL_OUTPUT_LIMIT } from '../tools/registry.js'
import type { ToolDef, ToolExecResult, ToolRegistry, ToolSnapshot, ToolSnapshotEntry } from '../types.js'

/** What the injected verify runner (Task 9: docker) reports back after one attempt. */
export type VerifyRun = {
  exitCode: number | null
  output: string
  timedOut: boolean
  /** Set only when the runner itself failed (not a red test run); makes run_tests a tool error. */
  runnerError?: string
  cleanup?: 'stopped' | 'uncertain'
}

export type TaskToolsOptions = {
  /** Worktree root; every path argument is resolved against it and may never escape it. */
  root: string
  runVerify: (signal: AbortSignal) => Promise<VerifyRun>
  /**
   * Test-only overrides for `search`'s internal bounds. Production callers never set this — each field
   * defaults to the real constant below. It exists so a test can deterministically exercise the
   * "a bound cut the search short" notice path in milliseconds, instead of needing an actual 5 s wall
   * clock or 200 MB of files to genuinely hit the production limits.
   */
  searchLimits?: { totalBytesCap?: number; timeoutMs?: number; perFileTimeoutMs?: number }
}

const GIT_SEGMENT_ERROR = 'pad met .git is niet toegestaan'
const OUTSIDE_ROOT_ERROR = 'pad valt buiten de worktree'
const SYMLINK_ERROR = 'pad is een symlink en wordt niet gevolgd'
const SKIP_DIR_NAMES = new Set(['node_modules', '.git'])
const MAX_LIST_LINES = 300
const MAX_READ_CHARS = 20_000
const READ_TRUNCATED_NOTE = '\n\n[afgekapt, gebruik offset/limit]'
const MAX_READ_FILE_BYTES = 5 * 1024 * 1024 // read_file refuses a file bigger than this outright
const MAX_SEARCH_FILE_BYTES = 1 * 1024 * 1024 // search silently skips a file bigger than this
// Total bytes matched per search() call, not lines: a byte budget scales with real file sizes, unlike a
// fixed line count that a large-but-ordinary repo can exhaust long before reaching files later in the
// (alphabetical) walk order — silently missing real matches there with no indication anything was cut.
const MAX_SEARCH_TOTAL_BYTES = 200 * 1024 * 1024
const MAX_SEARCH_HITS = 100
const SEARCH_TIMEOUT_MS = 5000
// A single file's worth of matching taking anywhere near this long only happens for catastrophic regex
// backtracking on one of its lines — normal matching of even a full MAX_SEARCH_FILE_BYTES file is well
// under a millisecond, so this lets a genuine ReDoS hang be told apart from simply running out of the
// overall SEARCH_TIMEOUT_MS budget while steadily making progress through a large tree.
const SEARCH_PER_FILE_TIMEOUT_MS = 2000
const RUN_TESTS_TAIL = 6000

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toolError(content: string): ToolExecResult {
  return { ok: false, errorCode: 'TOOL_ERROR', content, truncated: false }
}

function toolOk(content: string): ToolExecResult {
  return { ok: true, content, truncated: false }
}

/** Truncates to at most `limit` UTF-8 bytes without splitting a multi-byte character; mirrors tools/registry.ts. */
function capBytes(result: ToolExecResult, limit: number): ToolExecResult {
  const buf = Buffer.from(result.content, 'utf8')
  if (buf.length <= limit) return result
  let end = limit
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return { ...result, content: buf.subarray(0, end).toString('utf8'), truncated: true, fullContent: result.content }
}

function relPosix(root: string, target: string): string {
  return relative(root, target).split(sep).join('/')
}

/**
 * Type-checking stat for a resolved top-level path: `lstat`, except exactly at the root itself, where
 * `resolvePath`'s own containment check already exempts a symlinked root (`ancestor !== root`) — using
 * `lstat` there too would see the symlink instead of what it points to and wrongly report "not a
 * directory" for a worktree whose root happens to be reached through a symlink.
 */
function topLevelStat(root: string, target: string): Stats {
  return target === root ? statSync(target) : lstatSync(target)
}

/** Opens for reading without following a final-component symlink; a FIFO/socket never blocks the open itself. */
function readFileNoFollow(target: string): string {
  const fd = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  try {
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** Opens for writing without following a final-component symlink; O_NONBLOCK keeps a stray FIFO from hanging the write. */
function writeFileNoFollow(target: string, content: string): void {
  const fd = openSync(
    target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    0o644,
  )
  try {
    writeFileSync(fd, content, 'utf8')
  } finally {
    closeSync(fd)
  }
}

type Resolved = { ok: true; target: string } | { ok: false; error: ToolExecResult }

/**
 * Path rule (spec 4.2): resolve(root, p), then the realpath of the nearest existing ancestor must be
 * root itself or fall under root + sep; any path segment literally ".git" is refused outright.
 *
 * Existence is decided per component with `lstatSync`, never by treating a `realpath` ENOENT as "does
 * not exist yet": a *dangling* symlink (an existing symlink whose target is missing) lstat's just fine,
 * so climbing on a bare `realpath` ENOENT wrongly treated it as free ground to create through — exactly
 * the write-outside-the-root escape via `symlinkSync('/outside/planted.txt', 'root/dang')` followed by
 * `write_file`. The requested path's own final component is refused outright the moment it is an
 * existing symlink, dangling or not, inside the root or not — the tool never follows it (the actual
 * open() calls in read/write/edit repeat this with O_NOFOLLOW as a second, independent layer). An
 * existing symlink higher up the chain (reached while climbing because the exact target does not yet
 * exist) is allowed only if it resolves to somewhere inside the root; a dangling one cannot be verified
 * and is refused the same way.
 */
function resolvePath(root: string, realRoot: string, rawPath: unknown): Resolved {
  const p = typeof rawPath === 'string' && rawPath !== '' ? rawPath : '.'
  const target = resolve(root, p)
  const segments = target.split(sep).filter(Boolean)
  if (segments.includes('.git')) return { ok: false, error: toolError(GIT_SEGMENT_ERROR) }

  let ancestor = target
  let isTarget = true
  for (;;) {
    let st
    try {
      st = lstatSync(ancestor)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: toolError(`pad kon niet worden opgelost: ${message(err)}`) }
      const parent = dirname(ancestor)
      if (parent === ancestor) return { ok: false, error: toolError(OUTSIDE_ROOT_ERROR) }
      ancestor = parent
      isTarget = false
      continue
    }
    if (isTarget && ancestor !== root && st.isSymbolicLink()) return { ok: false, error: toolError(SYMLINK_ERROR) }
    let real: string
    try {
      real = realpathSync(ancestor)
    } catch {
      // Existing-but-dangling symlink (or something realpath otherwise cannot resolve): refused, not
      // climbed past — this is the exact "dangling symlink in the middle of the path" escape.
      return { ok: false, error: toolError(OUTSIDE_ROOT_ERROR) }
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return { ok: false, error: toolError(OUTSIDE_ROOT_ERROR) }
    return { ok: true, target }
  }
}

/** Rejects anything that is not a plain file or (for a not-yet-existing write target) absent. */
function assertRegularOrAbsent(root: string, target: string): ToolExecResult | null {
  let st
  try {
    st = lstatSync(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return toolError(`kan pad niet controleren: ${message(err)}`)
  }
  if (!st.isFile()) return toolError(`geen gewoon bestand: ${relPosix(root, target) || '.'}`)
  return null
}

type FileGuard = { ok: true; size: number } | { ok: false; error: ToolExecResult }

/** Rejects anything that is not a plain, size-bounded file the tool can safely open and read. */
function assertReadableFile(root: string, target: string, maxBytes: number): FileGuard {
  let st
  try {
    st = lstatSync(target)
  } catch (err) {
    return { ok: false, error: toolError(`kan bestand niet lezen: ${message(err)}`) }
  }
  if (!st.isFile()) return { ok: false, error: toolError(`geen gewoon bestand: ${relPosix(root, target) || '.'}`) }
  if (st.size > maxBytes) return { ok: false, error: toolError(`bestand te groot om te lezen (${st.size} bytes, max ${maxBytes})`) }
  return { ok: true, size: st.size }
}

function listFiles(root: string, realRoot: string, rawPath: unknown): ToolExecResult {
  const resolved = resolvePath(root, realRoot, rawPath)
  if (!resolved.ok) return resolved.error
  let st
  try {
    st = topLevelStat(root, resolved.target)
  } catch (err) {
    return toolError(`pad bestaat niet: ${message(err)}`)
  }
  if (!st.isDirectory()) return toolError(`geen map: ${relPosix(root, resolved.target) || '.'}`)

  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name
      const full = join(dir, entry.name)
      // A symlink is listed by name but never followed: one planted inside the root could point
      // anywhere on the host, and the top-level path rule only checks the tool's own `path` argument,
      // not names discovered while recursing.
      if (entry.isSymbolicLink()) {
        out.push(entryRel)
      } else if (entry.isDirectory()) {
        out.push(`${entryRel}/`)
        walk(full, entryRel)
      } else {
        out.push(entryRel)
      }
    }
  }
  walk(resolved.target, relPosix(root, resolved.target))
  return capBytes(toolOk(out.slice(0, MAX_LIST_LINES).join('\n')), TOOL_OUTPUT_LIMIT)
}

function readFile(root: string, realRoot: string, args: Record<string, unknown>): ToolExecResult {
  const resolved = resolvePath(root, realRoot, args.path)
  if (!resolved.ok) return resolved.error
  const guard = assertReadableFile(root, resolved.target, MAX_READ_FILE_BYTES)
  if (!guard.ok) return guard.error
  let raw: string
  try {
    raw = readFileNoFollow(resolved.target)
  } catch (err) {
    return toolError(`kan bestand niet lezen: ${message(err)}`)
  }
  const lines = raw.split('\n')
  if (raw.endsWith('\n') && lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const hasOffset = typeof args.offset === 'number'
  const hasLimit = typeof args.limit === 'number'
  if (!hasOffset && !hasLimit) {
    const numbered = lines.map((line, i) => `${i + 1}\t${line}`).join('\n')
    if (numbered.length > MAX_READ_CHARS) return toolOk(numbered.slice(0, MAX_READ_CHARS) + READ_TRUNCATED_NOTE)
    return toolOk(numbered)
  }

  const offset = hasOffset ? Math.max(0, Math.trunc(args.offset as number)) : 0
  const limit = hasLimit ? Math.max(0, Math.trunc(args.limit as number)) : undefined
  const slice = limit === undefined ? lines.slice(offset) : lines.slice(offset, offset + limit)
  return toolOk(slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n'))
}

function writeFile(root: string, realRoot: string, args: Record<string, unknown>): ToolExecResult {
  const resolved = resolvePath(root, realRoot, args.path)
  if (!resolved.ok) return resolved.error
  const guardErr = assertRegularOrAbsent(root, resolved.target)
  if (guardErr) return guardErr
  const content = typeof args.content === 'string' ? args.content : ''
  try {
    mkdirSync(dirname(resolved.target), { recursive: true })
    writeFileNoFollow(resolved.target, content)
  } catch (err) {
    return toolError(`kan niet schrijven: ${message(err)}`)
  }
  return toolOk(`geschreven: ${relPosix(root, resolved.target)} (${Buffer.byteLength(content, 'utf8')} bytes)`)
}

function editFile(root: string, realRoot: string, args: Record<string, unknown>): ToolExecResult {
  const resolved = resolvePath(root, realRoot, args.path)
  if (!resolved.ok) return resolved.error
  const guard = assertReadableFile(root, resolved.target, MAX_READ_FILE_BYTES)
  if (!guard.ok) return guard.error
  const oldStr = typeof args.old_string === 'string' ? args.old_string : ''
  const newStr = typeof args.new_string === 'string' ? args.new_string : ''
  if (oldStr === '') return toolError('old_string mag niet leeg zijn')
  let content: string
  try {
    content = readFileNoFollow(resolved.target)
  } catch (err) {
    return toolError(`kan bestand niet lezen: ${message(err)}`)
  }
  const relName = relPosix(root, resolved.target)
  // Occurrences via split (non-overlapping), never `String.replace(old, new)` — new_string must stay
  // literal even when it contains replacement-pattern sequences such as `$&`.
  const occurrences = content.split(oldStr).length - 1
  if (occurrences === 0) return toolError(`old_string niet gevonden in ${relName}`)
  if (occurrences > 1) return toolError(`old_string komt ${occurrences}x voor in ${relName}, moet precies 1x voorkomen`)
  const idx = content.indexOf(oldStr)
  const updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length)
  try {
    writeFileNoFollow(resolved.target, updated)
  } catch (err) {
    return toolError(`kan niet schrijven: ${message(err)}`)
  }
  return toolOk(`vervangen in ${relName}`)
}

type SearchLine = { file: string; lineNo: number; text: string }
type MatchOutcome = { ok: true; hits: string[] } | { ok: false; error: string } | { ok: false; error: 'timeout' }

// Regex *matching* against untrusted, model-chosen patterns can blow up (catastrophic backtracking,
// e.g. /^(a+)+$/ against "aaaa...!"), and that is a synchronous, uninterruptible loop on whichever
// thread runs it — capping input length alone does not bound the time. Running it in a throwaway
// worker thread lets a hard wall-clock timeout actually stop it via terminate(), which forcibly ends
// the thread regardless of what synchronous JS is stuck inside it. The eval'd source (not a separate
// compiled file) keeps this working identically under tsx/vitest and the tsc build.
//
// The walk stays on the main thread — that is where every path guard already lives (symlinks never
// followed, node_modules/.git excluded, plain files only, per-file byte cap) — and one persistent
// worker is fed one file's lines per message, matching incrementally so a single huge repo cannot
// silently truncate the search space before ever reaching a match (round-1's fixed-line-count cap did
// exactly that). The worker itself is spawned fresh per search() call and torn down at the end.
const SEARCH_WORKER_SOURCE = `
import('node:worker_threads').then(({ parentPort }) => {
  parentPort.on('message', (msg) => {
    const { pattern, lines, maxHits } = msg
    const hits = []
    try {
      const re = new RegExp(pattern)
      for (const { file, lineNo, text } of lines) {
        if (hits.length >= maxHits) break
        if (re.test(text)) hits.push(file + ':' + lineNo + ': ' + text)
      }
      parentPort.postMessage({ ok: true, hits })
    } catch (err) {
      parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) })
    }
  })
})
`

/** One request/response cycle against an already-running worker. On timeout the caller must terminate
 * the worker (never reused afterwards) — the very reason a request can outlast `timeoutMs` is that the
 * worker is stuck inside a synchronous `re.test()` call that will never yield back to its event loop. */
function matchInWorker(worker: Worker, pattern: string, lines: SearchLine[], maxHits: number, timeoutMs: number): Promise<MatchOutcome> {
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (result: MatchOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('error', onError)
      resolvePromise(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs)
    const onMessage = (msg: MatchOutcome) => finish(msg)
    const onError = (err: Error) => finish({ ok: false, error: err.message })
    worker.once('message', onMessage)
    worker.once('error', onError)
    worker.postMessage({ pattern, lines, maxHits })
  })
}

async function* walkSearchableFiles(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue
    // Never follow a symlink discovered while recursing (see the matching comment in listFiles): it
    // could point outside the root and readFileSync/readdirSync would silently follow it.
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkSearchableFiles(full)
    else yield full
  }
}

async function* singleSearchableFile(path: string): AsyncGenerator<string> {
  yield path
}

type SearchBounds = { totalBytesCap: number; timeoutMs: number; perFileTimeoutMs: number }

async function search(
  root: string,
  realRoot: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  bounds: SearchBounds,
): Promise<ToolExecResult> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : ''
  try {
    void new RegExp(pattern) // syntax-only check; matching itself happens in the worker
  } catch (err) {
    return toolError(`ongeldige regex: ${message(err)}`)
  }
  const resolved = resolvePath(root, realRoot, args.path)
  if (!resolved.ok) return resolved.error
  let stat
  try {
    stat = topLevelStat(root, resolved.target)
  } catch (err) {
    return toolError(`pad bestaat niet: ${message(err)}`)
  }

  const deadline = Date.now() + bounds.timeoutMs
  const worker = new Worker(SEARCH_WORKER_SOURCE, { eval: true })
  const hits: string[] = []
  let totalBytes = 0
  let truncatedReason: string | null = null
  let redosError: string | null = null

  try {
    const files = stat.isDirectory() ? walkSearchableFiles(resolved.target) : singleSearchableFile(resolved.target)
    for await (const full of files) {
      if (hits.length >= MAX_SEARCH_HITS) break // the documented output cap, not a search-space cut — no notice needed
      if (signal.aborted || Date.now() >= deadline) {
        truncatedReason = 'timeout'
        break
      }

      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      // Never anything but a plain file: a FIFO/socket/device can block or misbehave on open/read
      // regardless of size, so its type alone disqualifies it (symlinks are already excluded by the walk).
      if (!st.isFile() || st.size > MAX_SEARCH_FILE_BYTES) continue
      if (totalBytes + st.size > bounds.totalBytesCap) {
        truncatedReason = 'datalimiet'
        break
      }

      let text: string
      try {
        text = readFileNoFollow(full)
      } catch {
        continue // unreadable/binary/gone: skip rather than fail the whole search
      }
      totalBytes += st.size
      const relFile = relPosix(root, full)
      const lines: SearchLine[] = text.split('\n').map((t, i) => ({ file: relFile, lineNo: i + 1, text: t }))

      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        truncatedReason = 'timeout'
        break
      }
      const outcome = await matchInWorker(worker, pattern, lines, MAX_SEARCH_HITS - hits.length, Math.min(bounds.perFileTimeoutMs, remaining))
      if (!outcome.ok) {
        // A per-file timeout with the overall budget also gone is a shortage of time, not evidence the
        // regex itself is pathological — that stays a truncation notice, never the hard ReDoS error.
        if (outcome.error === 'timeout' && Date.now() >= deadline) truncatedReason = 'timeout'
        else redosError = outcome.error
        break
      }
      hits.push(...outcome.hits)
    }
  } finally {
    await worker.terminate()
  }

  if (redosError !== null) {
    return toolError(redosError === 'timeout' ? 'search afgebroken: timeout' : `search mislukt: ${redosError}`)
  }
  let content = hits.length > 0 ? hits.join('\n') : `geen treffers voor ${pattern}`
  if (truncatedReason) content += `\n(zoekopdracht afgekapt: ${truncatedReason}; beperk met path)`
  return capBytes(toolOk(content), TOOL_OUTPUT_LIMIT)
}

async function runTests(runVerify: TaskToolsOptions['runVerify'], signal: AbortSignal): Promise<ToolExecResult> {
  let run: VerifyRun
  try {
    run = await runVerify(signal)
  } catch (err) {
    return toolError(`verify-runner faalde: ${message(err)}`)
  }
  if (run.runnerError) return toolError(run.runnerError)
  const exitLabel = run.timedOut ? 'timeout' : String(run.exitCode)
  return toolOk(`exitcode ${exitLabel}\n${run.output.slice(-RUN_TESTS_TAIL)}`)
}

const NO_PROPS_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const

const TOOL_DEFS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'list_files',
    description: 'List files and directories recursively under the worktree (or a subpath), skipping node_modules and .git.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'read_file',
    description: 'Read a file with line numbers. Without offset/limit the whole file is returned, capped at 20 000 characters.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: 'Write a file, creating parent directories as needed.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description: 'Replace old_string with new_string in a file. old_string must occur exactly once.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description: 'Regex search across files (optionally under a subpath), formatted as bestand:regel: tekst, max 100 hits.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_tests',
    description: 'Run the verify command in the verify container and report its exit code and tail output.',
    inputSchema: NO_PROPS_SCHEMA,
  },
]

/**
 * In-process ToolRegistry (no MCP) giving a TASK_IMPLEMENTATION model the six work tools of spec 4.2,
 * bounded to `opts.root`. No git or shell tool: the harness stays the only thing that ever runs git.
 */
export function createTaskTools(opts: TaskToolsOptions): ToolRegistry {
  const root = resolve(opts.root)
  const realRoot = realpathSync(root)
  const searchBounds: SearchBounds = {
    totalBytesCap: opts.searchLimits?.totalBytesCap ?? MAX_SEARCH_TOTAL_BYTES,
    timeoutMs: opts.searchLimits?.timeoutMs ?? SEARCH_TIMEOUT_MS,
    perFileTimeoutMs: opts.searchLimits?.perFileTimeoutMs ?? SEARCH_PER_FILE_TIMEOUT_MS,
  }

  const entries: ToolSnapshotEntry[] = [...TOOL_DEFS]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  const snapshot: ToolSnapshot = Object.freeze({
    entries,
    hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  })

  return {
    snapshot,
    toOpenAiTools(): ToolDef[] {
      return entries.map((e) => ({
        type: 'function',
        function: { name: e.name, ...(e.description ? { description: e.description } : {}), parameters: e.inputSchema },
      }))
    },
    async execute(name, args, signal): Promise<ToolExecResult> {
      switch (name) {
        case 'list_files':
          return listFiles(root, realRoot, args.path)
        case 'read_file':
          return readFile(root, realRoot, args)
        case 'write_file':
          return writeFile(root, realRoot, args)
        case 'edit_file':
          return editFile(root, realRoot, args)
        case 'search':
          return search(root, realRoot, args, signal, searchBounds)
        case 'run_tests':
          return runTests(opts.runVerify, signal)
        default:
          return { ok: false, errorCode: 'UNKNOWN_TOOL', content: 'tool not in snapshot', truncated: false }
      }
    },
    async close(): Promise<void> {
      // In-process: nothing to release.
    },
  }
}
