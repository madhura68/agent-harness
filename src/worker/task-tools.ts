import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
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
}

const GIT_SEGMENT_ERROR = 'pad met .git is niet toegestaan'
const OUTSIDE_ROOT_ERROR = 'pad valt buiten de worktree'
const SKIP_DIR_NAMES = new Set(['node_modules', '.git'])
const MAX_LIST_LINES = 300
const MAX_READ_CHARS = 20_000
const READ_TRUNCATED_NOTE = '\n\n[afgekapt, gebruik offset/limit]'
const MAX_SEARCH_HITS = 100
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

type Resolved = { ok: true; target: string } | { ok: false; error: ToolExecResult }

/**
 * Path rule (spec 4.2): resolve(root, p), then the realpath of the nearest existing ancestor must be
 * root itself or fall under root + sep; any path segment literally ".git" is refused outright. The
 * ancestor check (not a check on `target` alone) is what catches a symlink planted inside the root
 * that points outside it — including when the final path component does not exist yet (a write).
 */
function resolvePath(root: string, realRoot: string, rawPath: unknown): Resolved {
  const p = typeof rawPath === 'string' && rawPath !== '' ? rawPath : '.'
  const target = resolve(root, p)
  const segments = target.split(sep).filter(Boolean)
  if (segments.includes('.git')) return { ok: false, error: toolError(GIT_SEGMENT_ERROR) }

  let ancestor = target
  for (;;) {
    try {
      const real = realpathSync(ancestor)
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return { ok: false, error: toolError(OUTSIDE_ROOT_ERROR) }
      return { ok: true, target }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: toolError(`pad kon niet worden opgelost: ${message(err)}`) }
      const parent = dirname(ancestor)
      if (parent === ancestor) return { ok: false, error: toolError(OUTSIDE_ROOT_ERROR) }
      ancestor = parent
    }
  }
}

function listFiles(root: string, realRoot: string, rawPath: unknown): ToolExecResult {
  const resolved = resolvePath(root, realRoot, rawPath)
  if (!resolved.ok) return resolved.error
  let stat
  try {
    stat = statSync(resolved.target)
  } catch (err) {
    return toolError(`pad bestaat niet: ${message(err)}`)
  }
  if (!stat.isDirectory()) return toolError(`geen map: ${relPosix(root, resolved.target) || '.'}`)

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
  let raw: string
  try {
    raw = readFileSync(resolved.target, 'utf8')
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
  const content = typeof args.content === 'string' ? args.content : ''
  try {
    mkdirSync(dirname(resolved.target), { recursive: true })
    writeFileSync(resolved.target, content, 'utf8')
  } catch (err) {
    return toolError(`kan niet schrijven: ${message(err)}`)
  }
  return toolOk(`geschreven: ${relPosix(root, resolved.target)} (${Buffer.byteLength(content, 'utf8')} bytes)`)
}

function editFile(root: string, realRoot: string, args: Record<string, unknown>): ToolExecResult {
  const resolved = resolvePath(root, realRoot, args.path)
  if (!resolved.ok) return resolved.error
  const oldStr = typeof args.old_string === 'string' ? args.old_string : ''
  const newStr = typeof args.new_string === 'string' ? args.new_string : ''
  if (oldStr === '') return toolError('old_string mag niet leeg zijn')
  let content: string
  try {
    content = readFileSync(resolved.target, 'utf8')
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
    writeFileSync(resolved.target, updated, 'utf8')
  } catch (err) {
    return toolError(`kan niet schrijven: ${message(err)}`)
  }
  return toolOk(`vervangen in ${relName}`)
}

function search(root: string, realRoot: string, args: Record<string, unknown>): ToolExecResult {
  const pattern = typeof args.pattern === 'string' ? args.pattern : ''
  let re: RegExp
  try {
    re = new RegExp(pattern)
  } catch (err) {
    return toolError(`ongeldige regex: ${message(err)}`)
  }
  const resolved = resolvePath(root, realRoot, args.path)
  if (!resolved.ok) return resolved.error
  let stat
  try {
    stat = statSync(resolved.target)
  } catch (err) {
    return toolError(`pad bestaat niet: ${message(err)}`)
  }

  const hits: string[] = []
  const searchFile = (full: string): void => {
    let text: string
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      return // unreadable/binary: skip rather than fail the whole search
    }
    const relFile = relPosix(root, full)
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
      if (re.test(lines[i])) hits.push(`${relFile}:${i + 1}: ${lines[i]}`)
    }
  }
  const walk = (dir: string): void => {
    if (hits.length >= MAX_SEARCH_HITS) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (hits.length >= MAX_SEARCH_HITS) return
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      // Never follow a symlink discovered while recursing (see the matching comment in listFiles):
      // it could point outside the root and readFileSync/readdirSync would silently follow it.
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else searchFile(full)
    }
  }

  if (stat.isDirectory()) walk(resolved.target)
  else searchFile(resolved.target)

  const content = hits.length > 0 ? hits.join('\n') : `geen treffers voor ${pattern}`
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
          return search(root, realRoot, args)
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
