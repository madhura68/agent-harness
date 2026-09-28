// Run-log writer (spec docs/specs/2026-09-28-harness-run-logging-design.md §5, §6.3, §6.5): one file per
// claimed job in the existing worker-log format (scrum4me-docker bin/run-agent.sh / run-one-job.ts), so
// harness runs show up in Worker Logs/Insights next to Claude and Codex runs. `follow(trace)` tees the
// existing TraceWriter calls in run.ts/task-impl.ts into this format; nothing about the real trace changes.
//
// Best-effort throughout (spec §6.3): a run-log problem must never change a job outcome. Every public
// method catches everything; the first failure logs one line and disables further intermediate writes,
// but `end()` still makes one closing attempt regardless, and never runs its own body twice.

import { appendFileSync, closeSync, fchmodSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import type { RunResult, TraceEvent, TraceWriter } from '../trace.js'
import { redactDeep, redactText } from './redact.js'

/** WorkerConfig.workerLog, once present. */
export type WorkerLogConfig = { dir: string; pool: string; instance: string }

export type RunLogOutcome = 'done' | 'failed' | 'abandoned'

export type RunLogInit = {
  jobId: string
  kind: string // claim.kind
  model: { name: string; baseUrl: string }
  version: string // 'agent-harness@<package.json-versie>'
  secrets: readonly string[] // uit collectSecretValues
  cwd?: string // voor harness.run_start; standaard process.cwd(), worktree() overschrijft het
  now?: () => Date // testnaad
  sleep?: (ms: number) => void // testnaad voor de wx-poging; standaard synchroon wachten met Atomics.wait
  log?: (line: string) => void // stderr; standaard process.stderr
}

export interface RunLog {
  meta(text: string): void
  step(text: string): void
  worktree(path: string): void
  follow(trace: TraceWriter): TraceWriter
  fail(code: string, message: string, opts?: { override?: boolean }): void
  end(outcome: RunLogOutcome, durationMs: number): void
}

// Boundaries (spec §5.5), applied AFTER redaction.
const TEXT_LIMIT = 16_384 // reasoning, turn content, answer
const ARGUMENTS_LIMIT = 4_096
const TAIL_LIMIT = 8_192 // tool content, container outputTail

/** Character-safe head truncation (never splits a UTF-16 surrogate pair); mirrors worker/task-impl.ts's cut(). */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text
  let head = text.slice(0, limit)
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
  return head
}

/** The last `limit` characters, without starting on the second half of a surrogate pair; mirrors task-impl.ts's tail(). */
function tail(text: string, limit: number): string {
  if (text.length <= limit) return text
  const t = text.slice(-limit)
  return /^[\uDC00-\uDFFF]/.test(t) ? t.slice(1) : t
}

/** Mutates `fields[key]` in place: cuts to `limit` and sets `fields[flagKey] = true` only when it was longer. */
function applyHeadTruncation(fields: Record<string, unknown>, key: string, limit: number, flagKey: string): void {
  const v = fields[key]
  if (typeof v !== 'string' || v.length <= limit) return
  fields[key] = cut(v, limit)
  fields[flagKey] = true
}

/** contentLength is always the full (redacted, pre-cut) length; content itself is head-cut to `limit`. */
function applyFullLengthTruncation(fields: Record<string, unknown>, key: string, lengthKey: string, limit: number): void {
  const v = fields[key]
  if (typeof v !== 'string') return
  fields[lengthKey] = v.length
  if (v.length > limit) fields[key] = cut(v, limit)
}

/** lengthKey is always the full (redacted, pre-cut) length, same contract as applyFullLengthTruncation; key
 * itself is tail-cut (the LAST `limit` chars) instead of head-cut. So lengthKey > the retained key.length
 * exactly when the writer cut (spec §5.5; the Ops-dashboard parser reads lengthKey as the full length). */
function applyTailLengthTruncation(fields: Record<string, unknown>, key: string, lengthKey: string, limit: number): void {
  const v = fields[key]
  if (typeof v !== 'string') return
  fields[lengthKey] = v.length
  if (v.length > limit) fields[key] = tail(v, limit)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EEXIST'
}

/** `YYYYMMDDTHHMMSSZ`, the UTC second of `ts` (spec §5.1). */
function formatRunLogName(ts: Date): string {
  return ts.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** Default `sleep`: blocks the event loop synchronously via Atomics.wait on a throwaway SharedArrayBuffer. */
function defaultSleep(ms: number): void {
  if (ms <= 0) return
  const view = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(view, 0, 0, ms)
}

/**
 * Creates `<dir>/<pool>/<instance>/runs/<name>.log` exclusively (`wx`) and returns its path.
 * On EEXIST, waits (at most one second) for the next UTC second and retries exactly once; any other
 * failure, or a second EEXIST, propagates to the caller. Forces mode 0644 regardless of umask, since
 * `openSync`'s mode argument is masked by it.
 */
function createRunLogFile(cfg: WorkerLogConfig, now: () => Date, sleep: (ms: number) => void): string {
  const dirPath = join(cfg.dir, cfg.pool, cfg.instance, 'runs')
  mkdirSync(dirPath, { recursive: true })
  const attempt = (ts: Date): { path: string; fd: number } => {
    const path = join(dirPath, `${formatRunLogName(ts)}.log`)
    return { path, fd: openSync(path, 'wx', 0o644) }
  }
  const first = now()
  let opened: { path: string; fd: number }
  try {
    opened = attempt(first)
  } catch (err) {
    if (!isEexist(err)) throw err
    sleep(1000 - (first.getTime() % 1000)) // same-second collision: wait for the next second boundary, at most 1s
    opened = attempt(now()) // a second failure (EEXIST or otherwise) propagates to the caller
  }
  fchmodSync(opened.fd, 0o644)
  closeSync(opened.fd)
  return opened.path
}

export function openRunLog(cfg: WorkerLogConfig | undefined, init: RunLogInit): RunLog | null {
  if (!cfg) return null

  const now = init.now ?? (() => new Date())
  const sleep = init.sleep ?? defaultSleep
  const log = init.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const jobId = init.jobId
  const secrets = init.secrets

  let filePath: string
  try {
    filePath = createRunLogFile(cfg, now, sleep)
  } catch (err) {
    log(`run-log uitgeschakeld voor job ${jobId}: ${errorMessage(err)}`)
    return null
  }

  // --- mutable state, closed over by every method below ---
  let disabled = false
  let ended = false
  // Resolved lazily in flushRunStart, which already runs inside the tee's try/catch: process.cwd() throws
  // when the working directory is gone, and openRunLog itself must never throw (spec §6.3).
  let cwd = init.cwd
  let firstFail: { code: string; message: string } | undefined
  let awaitingRunStart = false
  let pendingRunId: string | undefined
  let pendingPromptEstimate: number | undefined
  const pendingToolContent = new Map<string, string>()
  const pendingContainerOutput = new Map<number, string>()
  let pendingAnswer: string | undefined
  let pendingTurns: number | undefined

  function failOnce(err: unknown): void {
    if (disabled) return
    disabled = true
    log(`run-log uitgeschakeld voor job ${jobId}: ${errorMessage(err)}`)
  }

  function appendMetaLine(text: string): void {
    // Redact BEFORE folding (same order as the closing block): a multi-line secret (e.g. a PEM-style
    // *_PRIVATE_KEY) carries its own \n's, so folding first would desync the text from the literal secret
    // and leave it unmasked (Review F4).
    const redacted = redactText(text, secrets)
    const folded = redacted.replace(/\r\n|\r|\n/g, ' ') // any newline form (CRLF, lone CR, LF) becomes a space (spec §5.2)
    appendFileSync(filePath, `${now().toISOString()} [harness] ${folded}\n`)
  }

  function appendJsonLine(type: string, fields: Record<string, unknown>): void {
    appendFileSync(filePath, `${JSON.stringify({ type, timestamp: now().toISOString(), ...fields })}\n`)
  }

  // Best-effort like every other write: a failure here disables the run-log but openRunLog still returns
  // a usable (now-disabled) RunLog, per the same one-log-line contract as any later write failure.
  try {
    appendMetaLine(`claimed job_id=${jobId}`)
    appendMetaLine(`config job_id=${jobId} runtime=HARNESS kind=${init.kind} model=${init.model.name} base_url=${init.model.baseUrl}`)
  } catch (err) {
    failOnce(err)
  }

  function flushRunStart(tools: string[]): void {
    const fields: Record<string, unknown> = {
      runId: pendingRunId ?? jobId,
      model: init.model.name,
      baseUrl: init.model.baseUrl,
      tools,
      mcpServers: ['scrum4me'],
      cwd: cwd ?? process.cwd(),
      version: init.version,
    }
    appendJsonLine('harness.run_start', redactDeep(fields, secrets))
  }

  function handleEvent(e: TraceEvent): void {
    // Deferred harness.run_start (spec §5.4): flush at tool_snapshot, or before any other next event.
    if (awaitingRunStart) {
      awaitingRunStart = false
      if (e.type === 'tool_snapshot') {
        flushRunStart(e.names)
        return
      }
      flushRunStart([])
      // fall through: still process e itself below
    }

    switch (e.type) {
      case 'run_start': {
        // manifest is the redacted Manifest (trace.ts: `manifest: unknown`, comment "after redactManifest");
        // redactManifest never touches `id`, and run.ts/task-impl.ts always set manifest.id = the same runId
        // used for RunResult.runId, so this recovers it without a direct import of the Manifest type.
        const id = (e.manifest as { id?: unknown } | null)?.id
        pendingRunId = typeof id === 'string' ? id : jobId
        awaitingRunStart = true
        break
      }
      case 'tool_snapshot':
        break // only meaningful via the awaitingRunStart flush above; a stray snapshot has no mapping of its own
      case 'model_request':
        pendingPromptEstimate = e.promptEstimate
        break
      case 'context_compacted': {
        const fields = { turn: e.turn, messages: e.messages, bytes: e.bytes, estimateBefore: e.estimateBefore, estimateAfter: e.estimateAfter }
        appendJsonLine('harness.compacted', redactDeep(fields, secrets))
        break
      }
      case 'model_response': {
        const usage = e.usage // read once: a hostile/unusual getter must not be read more than needed
        const fields: Record<string, unknown> = {
          turn: e.turn,
          durationMs: e.durationMs,
          finishReason: e.finishReason,
          usageSource: usage.source,
          usage: { input: usage.inputTokens, output: usage.outputTokens, ...(usage.cachedTokens !== undefined ? { cached: usage.cachedTokens } : {}) },
          ...(pendingPromptEstimate !== undefined ? { promptEstimate: pendingPromptEstimate } : {}),
          ...(e.reasoning !== undefined ? { reasoning: e.reasoning } : {}),
          ...(e.content !== null ? { content: e.content } : {}),
          ...(e.systemFingerprint !== undefined ? { systemFingerprint: e.systemFingerprint } : {}),
        }
        pendingPromptEstimate = undefined
        const redacted = redactDeep(fields, secrets)
        applyHeadTruncation(redacted, 'reasoning', TEXT_LIMIT, 'reasoningTruncated')
        applyHeadTruncation(redacted, 'content', TEXT_LIMIT, 'contentTruncated')
        appendJsonLine('harness.turn', redacted)
        break
      }
      case 'tool_call': {
        const fields: Record<string, unknown> = { callId: e.callId, name: e.name, arguments: e.arguments }
        const redacted = redactDeep(fields, secrets)
        applyHeadTruncation(redacted, 'arguments', ARGUMENTS_LIMIT, 'argumentsTruncated')
        appendJsonLine('harness.tool_call', redacted)
        break
      }
      case 'tool_result': {
        const content = pendingToolContent.get(e.callId) ?? ''
        pendingToolContent.delete(e.callId)
        const fields: Record<string, unknown> = { callId: e.callId, ok: e.ok, ...(e.errorCode !== undefined ? { errorCode: e.errorCode } : {}), content }
        const redacted = redactDeep(fields, secrets)
        applyFullLengthTruncation(redacted, 'content', 'contentLength', TAIL_LIMIT)
        appendJsonLine('harness.tool_result', redacted)
        break
      }
      case 'container': {
        const outputTail = pendingContainerOutput.get(e.n) ?? ''
        pendingContainerOutput.delete(e.n)
        const fields: Record<string, unknown> = {
          n: e.n, kind: e.kind, source: e.source, exitCode: e.exitCode, timedOut: e.timedOut, durationMs: e.durationMs, outputTail,
        }
        const redacted = redactDeep(fields, secrets)
        applyTailLengthTruncation(redacted, 'outputTail', 'outputLength', TAIL_LIMIT)
        appendJsonLine('harness.container', redacted)
        break
      }
      case 'after_answer': {
        const fields = { turn: e.turn, outcome: e.outcome }
        appendJsonLine('harness.gate', redactDeep(fields, secrets))
        break
      }
      case 'run_end':
        break // not written to the run-log (spec §5.4): the closing block (end()) covers the job outcome
      default:
        break
    }
  }

  function handleResult(r: RunResult): void {
    const usage = r.usage
    const fields: Record<string, unknown> = {
      status: r.status,
      ...(r.error !== undefined ? { error: r.error } : {}),
      turns: usage.turns,
      toolCalls: usage.toolCalls,
      toolErrors: usage.toolErrors,
      usageSource: usage.source,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cachedTokens !== undefined ? { cachedTokens: usage.cachedTokens } : {}),
      durationMs: r.durationMs,
    }
    appendJsonLine('harness.loop_end', redactDeep(fields, secrets))
    if (r.answer !== undefined) pendingAnswer = r.answer
    pendingTurns = usage.turns
  }

  function writeClosingBlock(outcome: RunLogOutcome, durationMs: number): void {
    const iso = now().toISOString()
    const isDone = outcome === 'done'
    const cm = isDone ? undefined : (firstFail ?? { code: outcome === 'failed' ? 'JOB_FAILED' : 'ABANDONED', message: 'geen reden vastgelegd' })

    const rawFields: Record<string, unknown> = { outcome }
    if (cm) {
      rawFields.code = cm.code
      rawFields.message = cm.message
    }
    if (isDone && pendingAnswer !== undefined) rawFields.answer = pendingAnswer
    if (pendingTurns !== undefined) rawFields.turns = pendingTurns
    rawFields.durationMs = durationMs

    const redacted = redactDeep(rawFields, secrets)
    if (isDone) applyHeadTruncation(redacted, 'answer', TEXT_LIMIT, 'answerTruncated')

    const exitCode = isDone ? 0 : 1
    const lines = [JSON.stringify({ type: 'harness.run_end', timestamp: iso, ...redacted })]
    if (!isDone) {
      const code = String(redacted.code).replace(/\r?\n/g, ' ')
      const message = String(redacted.message).replace(/\r?\n/g, ' ')
      lines.push(`${iso} [harness] ERROR ${code}: ${message}`)
    }
    const safeJobId = redactText(jobId, secrets).replace(/\r?\n/g, ' ')
    lines.push(`${iso} [harness] harness done job_id=${safeJobId} exit_code=${exitCode} duration_ms=${durationMs}`)
    lines.push(`${iso} [harness] exit code=${exitCode}`)

    appendFileSync(filePath, `${lines.join('\n')}\n`) // one appendFileSync for the whole closing block (spec §5.6)
  }

  function meta(text: string): void {
    if (disabled || ended) return // end() is write-once and the closing block is the last word (Review F3)
    try {
      appendMetaLine(text)
    } catch (err) {
      failOnce(err)
    }
  }

  return {
    meta,

    step(text: string): void {
      meta(`step ${text}`)
    },

    worktree(path: string): void {
      cwd = path
      meta(`worktree path=${path}`)
    },

    follow(trace: TraceWriter): TraceWriter {
      return {
        dir: trace.dir,
        event(e: TraceEvent): void {
          trace.event(e) // the real trace first, always; its own errors propagate exactly as today
          if (disabled || ended) return // no run-log write survives end() (Review F3)
          try {
            handleEvent(e)
          } catch (err) {
            failOnce(err)
          }
        },
        toolContent(callId: string, text: string): void {
          trace.toolContent(callId, text)
          if (disabled || ended) return
          try {
            pendingToolContent.set(callId, text)
          } catch (err) {
            failOnce(err)
          }
        },
        containerOutput(n: number, text: string): void {
          trace.containerOutput(n, text)
          if (disabled || ended) return
          try {
            pendingContainerOutput.set(n, text)
          } catch (err) {
            failOnce(err)
          }
        },
        result(r: RunResult): void {
          trace.result(r) // the real trace first, always
          if (disabled || ended) return
          try {
            handleResult(r)
          } catch (err) {
            failOnce(err)
          }
        },
      }
    },

    fail(code: string, message: string, opts?: { override?: boolean }): void {
      try {
        if (!firstFail || opts?.override) firstFail = { code, message }
      } catch (err) {
        failOnce(err)
      }
    },

    end(outcome: RunLogOutcome, durationMs: number): void {
      if (ended) return
      ended = true
      try {
        writeClosingBlock(outcome, durationMs)
      } catch (err) {
        failOnce(err)
      }
    },
  }
}
