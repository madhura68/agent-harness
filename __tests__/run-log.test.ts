import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openRunLog, type RunLogInit, type WorkerLogConfig } from '../src/worker/run-log.js'
import type { RunResult, TraceEvent, TraceWriter } from '../src/trace.js'

// Obvious test values -- never a real secret.
const SECRET = 'leak-0123456789'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-runlog-'))
})

function cfg(overrides: Partial<WorkerLogConfig> = {}): WorkerLogConfig {
  return { dir, pool: 'harness', instance: 'max2', ...overrides }
}

function baseInit(overrides: Partial<RunLogInit> = {}): RunLogInit {
  return {
    jobId: 'job-1',
    kind: 'TASK_IMPLEMENTATION',
    model: { name: 'test-model', baseUrl: 'http://127.0.0.1:11434/v1' },
    version: 'agent-harness@0.1.0',
    secrets: [],
    ...overrides,
  }
}

/** A fixed, mutable clock: sleep() advances it the way the real world would, deterministically. */
function fixedClock(startIso: string): { now: () => Date; sleep: (ms: number) => void; advance: (ms: number) => void } {
  let current = new Date(startIso)
  const advance = (ms: number) => {
    current = new Date(current.getTime() + ms)
  }
  return { now: () => current, sleep: advance, advance }
}

function runsDir(): string {
  return join(dir, 'harness', 'max2', 'runs')
}

function logFilePath(): string {
  const files = readdirSync(runsDir()).filter((f) => f.endsWith('.log'))
  if (files.length !== 1) throw new Error(`expected exactly one run-log file, found ${files.length}: ${files.join(', ')}`)
  return join(runsDir(), files[0])
}

function readLogText(): string {
  return readFileSync(logFilePath(), 'utf8')
}

function readLogLines(): string[] {
  return readLogText().trim().split('\n')
}

function readJsonLines(): Array<Record<string, unknown> & { type: string }> {
  return readLogLines()
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
}

function fakeTrace(): TraceWriter & { events: unknown[]; toolContents: Array<[string, string]>; containerOutputs: Array<[number, string]>; results: RunResult[] } {
  const events: unknown[] = []
  const toolContents: Array<[string, string]> = []
  const containerOutputs: Array<[number, string]> = []
  const results: RunResult[] = []
  return {
    dir: '/fake/dir',
    events,
    toolContents,
    containerOutputs,
    results,
    event(e) {
      events.push({ ...e }) // mirrors openTrace's real `{ ts: ..., ...e }` spread: reads getters exactly once
    },
    toolContent(callId, text) {
      toolContents.push([callId, text])
    },
    containerOutput(n, text) {
      containerOutputs.push([n, text])
    },
    result(r) {
      results.push(r)
    },
  }
}

const RESULT: RunResult = {
  runId: 'r1',
  status: 'completed',
  answer: 'klaar',
  model: { name: 'test-model', baseUrl: 'http://127.0.0.1:11434/v1' },
  usage: { source: 'provider_reported', inputTokens: 50, outputTokens: 20, turns: 3, toolCalls: 2, toolErrors: 0, cachedTokens: 5 },
  durationMs: 1234,
}

describe('openRunLog: file creation (spec §5.1)', () => {
  it('returns null without a workerLog config, and never touches log', () => {
    const logLines: string[] = []
    const rl = openRunLog(undefined, baseInit({ log: (l) => logLines.push(l) }))
    expect(rl).toBeNull()
    expect(logLines).toEqual([])
  })

  it('creates <dir>/<pool>/<instance>/runs/<YYYYMMDDTHHMMSSZ>.log with mode 0644, regardless of umask', () => {
    const original = process.umask(0o077)
    try {
      const rl = openRunLog(cfg(), baseInit({ now: () => new Date('2026-09-28T10:00:00.000Z') }))
      expect(rl).not.toBeNull()
    } finally {
      process.umask(original)
    }
    const files = readdirSync(runsDir())
    expect(files).toEqual(['20260928T100000Z.log'])
    const mode = statSync(join(runsDir(), files[0])).mode & 0o777
    expect(mode).toBe(0o644)
  })

  it('writes claimed and config as the first two lines, exact and in order', () => {
    const rl = openRunLog(
      cfg(),
      baseInit({
        jobId: 'job-abc',
        kind: 'TASK_IMPLEMENTATION',
        model: { name: 'qwen3-coder:30b', baseUrl: 'http://127.0.0.1:11434/v1' },
        now: () => new Date('2026-09-28T10:00:00.000Z'),
      }),
    )
    expect(rl).not.toBeNull()
    const lines = readLogLines()
    expect(lines[0]).toBe('2026-09-28T10:00:00.000Z [harness] claimed job_id=job-abc')
    expect(lines[1]).toBe(
      '2026-09-28T10:00:00.000Z [harness] config job_id=job-abc runtime=HARNESS kind=TASK_IMPLEMENTATION model=qwen3-coder:30b base_url=http://127.0.0.1:11434/v1',
    )
  })

  it('retries once after the next second when the computed filename already exists, then succeeds', () => {
    const clock = fixedClock('2026-09-28T10:00:00.500Z')
    mkdirSync(runsDir(), { recursive: true })
    writeFileSync(join(runsDir(), '20260928T100000Z.log'), 'pre-existing')
    const slept: number[] = []
    const rl = openRunLog(
      cfg(),
      baseInit({
        now: clock.now,
        sleep: (ms) => {
          slept.push(ms)
          clock.advance(ms)
        },
      }),
    )
    expect(rl).not.toBeNull()
    expect(slept).toEqual([500]) // waits only to the next second boundary (1000 - 500ms into the second)
    expect(readdirSync(runsDir()).sort()).toEqual(['20260928T100000Z.log', '20260928T100001Z.log'])
  })

  it('gives up after a second collision: returns null and logs exactly one line', () => {
    const clock = fixedClock('2026-09-28T10:00:00.500Z')
    mkdirSync(runsDir(), { recursive: true })
    writeFileSync(join(runsDir(), '20260928T100000Z.log'), 'pre-existing')
    writeFileSync(join(runsDir(), '20260928T100001Z.log'), 'also pre-existing')
    const logLines: string[] = []
    const rl = openRunLog(
      cfg(),
      baseInit({
        now: clock.now,
        sleep: (ms) => clock.advance(ms),
        log: (l) => logLines.push(l),
      }),
    )
    expect(rl).toBeNull()
    expect(logLines).toHaveLength(1)
    expect(logLines[0]).toBe('run-log uitgeschakeld voor job job-1: EEXIST: file already exists, open \'' + join(runsDir(), '20260928T100001Z.log') + '\'')
  })

  it('returns null and logs once when the worker-logs directory cannot be created (Review Focus 4: unwritable/full disk)', () => {
    const blockerFile = join(dir, 'blocker')
    writeFileSync(blockerFile, 'x') // a plain file where a directory is expected: mkdir fails even as root
    const logLines: string[] = []
    const rl = openRunLog({ dir: blockerFile, pool: 'harness', instance: 'max2' }, baseInit({ log: (l) => logLines.push(l) }))
    expect(rl).toBeNull()
    expect(logLines).toHaveLength(1)
    expect(logLines[0]).toMatch(/^run-log uitgeschakeld voor job job-1: /)
  })

  it('works end to end with the real defaults for now/sleep/log (no collision, so the real sleep is never exercised)', () => {
    const rl = openRunLog(cfg(), baseInit())
    expect(rl).not.toBeNull()
    expect(readdirSync(runsDir())).toHaveLength(1)
  })
})

describe('openRunLog never throws, even when process.cwd() is unavailable (spec §6.3, Review F2)', () => {
  it('does not throw and still returns a usable RunLog when process.cwd() throws and init.cwd is not given', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('cwd gone')
    })
    try {
      let rl: ReturnType<typeof openRunLog> = null
      expect(() => {
        rl = openRunLog(cfg(), baseInit())
      }).not.toThrow()
      expect(rl).not.toBeNull()
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('a deferred harness.run_start that needs the default cwd disables further writes with exactly one log line instead of throwing', () => {
    const logLines: string[] = []
    const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('cwd gone')
    })
    try {
      const rl = openRunLog(cfg(), baseInit({ log: (l) => logLines.push(l) }))!
      const followed = rl.follow(fakeTrace())
      expect(() => {
        followed.event({ type: 'run_start', manifest: { id: 'r1' } })
        followed.event({ type: 'tool_snapshot', names: [], hash: 'h' })
      }).not.toThrow()
      expect(logLines).toHaveLength(1)
      expect(logLines[0]).toMatch(/^run-log uitgeschakeld voor job job-1: /)
      expect(() => rl.end('done', 5)).not.toThrow() // end() still makes its own closing attempt
    } finally {
      cwdSpy.mockRestore()
    }
  })
})

describe('line formats (spec §5.2)', () => {
  it('every JSON line starts with {"type":"harness. and has timestamp as the second key; every meta line matches ^\\S+ \\[harness\\] ', () => {
    const rl = openRunLog(cfg(), baseInit())!
    rl.step('doing things')
    rl.worktree('/srv/worktrees/job-1')
    const followed = rl.follow(fakeTrace())
    followed.event({ type: 'run_start', manifest: { id: 'r1' } })
    followed.event({ type: 'tool_snapshot', names: ['x'], hash: 'h' })
    followed.event({ type: 'model_request', turn: 1, messages: 1, tools: 1, maxTokens: 10 })
    followed.event({
      type: 'model_response',
      turn: 1,
      content: 'hi',
      toolCalls: [],
      finishReason: 'stop',
      durationMs: 5,
      usage: { source: 'provider_reported', inputTokens: 1, outputTokens: 1 },
    })
    rl.end('done', 5)

    const lines = readLogLines()
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      if (line.startsWith('{')) {
        expect(line).toMatch(/^\{"type":"harness\./)
        const keys = Object.keys(JSON.parse(line))
        expect(keys[0]).toBe('type')
        expect(keys[1]).toBe('timestamp')
      } else {
        expect(line).toMatch(/^\S+ \[harness\] /)
      }
    }
  })
})

describe('meta / step / worktree', () => {
  it('meta() writes one redacted line and folds a newline to a space', () => {
    const rl = openRunLog(cfg(), baseInit({ secrets: [SECRET], now: () => new Date('2026-09-28T10:00:00.000Z') }))!
    rl.meta(`line one ${SECRET}\nline two`)
    const lines = readLogLines()
    expect(lines[lines.length - 1]).toBe(`2026-09-28T10:00:00.000Z [harness] line one ${'***'} line two`)
  })

  it('step() prefixes "step "', () => {
    const rl = openRunLog(cfg(), baseInit())!
    rl.step('prepare exit=0 duration_ms=100')
    const lines = readLogLines()
    expect(lines[lines.length - 1]).toMatch(/\[harness\] step prepare exit=0 duration_ms=100$/)
  })

  it('redacts a multi-line secret in meta text before folding newlines to spaces (Review F4)', () => {
    // Obviously fake, multi-line like a PEM-style *_PRIVATE_KEY value; the secret itself carries real \n's.
    const multilineSecret = 'BEGIN-FAKE-KEY\nfake-key-material-0123\nEND-FAKE-KEY'
    const rl = openRunLog(cfg(), baseInit({ secrets: [multilineSecret] }))!
    rl.step(`using ${multilineSecret} for auth`)
    const text = readLogText()
    expect(text).not.toContain(multilineSecret)
    expect(text).not.toContain('fake-key-material-0123') // no unmasked fragment of the secret either
    expect(text).toContain('***')
  })

  it('folds a lone \\r (not just \\r\\n or \\n) to a space in meta text (Review F4)', () => {
    const rl = openRunLog(cfg(), baseInit({ now: () => new Date('2026-09-28T10:00:00.000Z') }))!
    rl.meta('before\rafter')
    const lines = readLogLines()
    expect(lines[lines.length - 1]).toBe('2026-09-28T10:00:00.000Z [harness] before after')
  })

  it('worktree() writes "worktree path=..." and overrides cwd used by a later harness.run_start', () => {
    const rl = openRunLog(cfg(), baseInit())!
    rl.worktree('/srv/worktrees/job-1')
    const lines = readLogLines()
    expect(lines[lines.length - 1]).toMatch(/\[harness\] worktree path=\/srv\/worktrees\/job-1$/)

    const followed = rl.follow(fakeTrace())
    followed.event({ type: 'run_start', manifest: { id: 'r1' } })
    followed.event({ type: 'tool_snapshot', names: [], hash: 'h' })
    const runStart = readJsonLines().find((l) => l.type === 'harness.run_start')
    expect(runStart?.cwd).toBe('/srv/worktrees/job-1')
  })
})

describe('follow(): trace-event mapping (spec §5.4)', () => {
  it('run_start + tool_snapshot -> harness.run_start with runId from the manifest id, model/baseUrl/version from init, cwd defaulting to process.cwd()', () => {
    const rl = openRunLog(
      cfg(),
      baseInit({ jobId: 'job-1', model: { name: 'test-model', baseUrl: 'http://127.0.0.1:11434/v1' }, version: 'agent-harness@0.1.0' }),
    )!
    const trace = fakeTrace()
    const followed = rl.follow(trace)
    followed.event({ type: 'run_start', manifest: { id: 'job-1-171234' } })
    followed.event({ type: 'tool_snapshot', names: ['search_product_docs', 'get_product_doc'], hash: 'h1' })

    expect(followed.dir).toBe(trace.dir)
    const runStart = readJsonLines().find((l) => l.type === 'harness.run_start')
    expect(runStart).toMatchObject({
      runId: 'job-1-171234',
      model: 'test-model',
      baseUrl: 'http://127.0.0.1:11434/v1',
      tools: ['search_product_docs', 'get_product_doc'],
      mcpServers: ['scrum4me'],
      cwd: process.cwd(),
      version: 'agent-harness@0.1.0',
    })
    // exactly one harness.run_start; tool_snapshot has no output of its own
    expect(readJsonLines().filter((l) => l.type === 'harness.run_start')).toHaveLength(1)
  })

  it('run_start NOT followed by tool_snapshot: harness.run_start flushes with empty tools right before the next event', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    followed.event({ type: 'run_start', manifest: { id: 'r1' } })
    followed.event({ type: 'model_request', turn: 1, messages: 1, tools: 0, maxTokens: 10 })

    const types = readJsonLines().map((l) => l.type)
    expect(types).toEqual(['harness.run_start']) // model_request itself has no direct JSON output
    const runStart = readJsonLines()[0]
    expect(runStart.tools).toEqual([])
  })

  it('model_request remembers promptEstimate for the following model_response', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    followed.event({ type: 'model_request', turn: 1, messages: 1, tools: 0, maxTokens: 10, promptEstimate: 555 })
    followed.event({
      type: 'model_response',
      turn: 1,
      content: 'hi',
      toolCalls: [],
      finishReason: 'stop',
      durationMs: 5,
      usage: { source: 'provider_reported', inputTokens: 3, outputTokens: 2 },
    })
    const turn = readJsonLines().find((l) => l.type === 'harness.turn')
    expect(turn?.promptEstimate).toBe(555)
  })

  it('model_response -> harness.turn with usage, reasoning, content and systemFingerprint', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    followed.event({
      type: 'model_response',
      turn: 2,
      content: 'the answer',
      toolCalls: [],
      finishReason: 'stop',
      durationMs: 250,
      usage: { source: 'provider_reported', inputTokens: 100, outputTokens: 40, cachedTokens: 10 },
      reasoning: 'thinking about it',
      systemFingerprint: 'fp_123',
    })
    const turn = readJsonLines().find((l) => l.type === 'harness.turn')
    expect(turn).toMatchObject({
      turn: 2,
      durationMs: 250,
      finishReason: 'stop',
      usageSource: 'provider_reported',
      usage: { input: 100, output: 40, cached: 10 },
      reasoning: 'thinking about it',
      content: 'the answer',
      systemFingerprint: 'fp_123',
    })
  })

  it('model_response with content: null omits the content field; missing usage source omits cached', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    followed.event({
      type: 'model_response',
      turn: 1,
      content: null,
      toolCalls: [{ id: 'c1', name: 'x', arguments: '{}', argumentsWasObject: true }],
      finishReason: 'tool_calls',
      durationMs: 5,
      usage: { source: 'missing', inputTokens: 0, outputTokens: 0 },
    })
    const turn = readJsonLines().find((l) => l.type === 'harness.turn')
    expect(turn).not.toHaveProperty('content')
    expect(turn).not.toHaveProperty('reasoning')
    expect((turn?.usage as Record<string, unknown>)).not.toHaveProperty('cached')
  })

  it('tool_call -> harness.tool_call {callId, name, arguments}', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    followed.event({ type: 'tool_call', callId: 'call_1', name: 'search_product_docs', arguments: '{"q":"x"}', argumentsWasObject: true })
    const line = readJsonLines().find((l) => l.type === 'harness.tool_call')
    expect(line).toMatchObject({ callId: 'call_1', name: 'search_product_docs', arguments: '{"q":"x"}' })
    expect(line).not.toHaveProperty('argumentsTruncated')
  })

  it('toolContent then tool_result -> harness.tool_result {callId, ok, content, contentLength}, errorCode only when present', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    followed.toolContent('call_1', 'the full tool output')
    followed.event({ type: 'tool_result', callId: 'call_1', ok: true, truncated: false, sha256: 'x', bytes: 10 })
    const line = readJsonLines().find((l) => l.type === 'harness.tool_result')
    expect(line).toMatchObject({ callId: 'call_1', ok: true, content: 'the full tool output', contentLength: 'the full tool output'.length })
    expect(line).not.toHaveProperty('errorCode')

    const followed2 = rl.follow(fakeTrace())
    followed2.toolContent('call_2', 'boom')
    followed2.event({ type: 'tool_result', callId: 'call_2', ok: false, errorCode: 'TOOL_ERROR', truncated: false, sha256: 'x', bytes: 4 })
    const line2 = readJsonLines().filter((l) => l.type === 'harness.tool_result')[1]
    expect(line2).toMatchObject({ ok: false, errorCode: 'TOOL_ERROR' })
  })

  it('containerOutput then container -> harness.container {n, kind, source, exitCode, timedOut, durationMs, outputTail, outputLength}', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    followed.containerOutput(1, 'npm ci output')
    followed.event({ type: 'container', kind: 'prepare', source: 'prepare', n: 1, exitCode: 0, timedOut: false, durationMs: 900, outputBytes: 13 })
    const line = readJsonLines().find((l) => l.type === 'harness.container')
    expect(line).toMatchObject({
      n: 1,
      kind: 'prepare',
      source: 'prepare',
      exitCode: 0,
      timedOut: false,
      durationMs: 900,
      outputTail: 'npm ci output',
      outputLength: 'npm ci output'.length,
    })
  })

  it('context_compacted -> harness.compacted', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    followed.event({ type: 'context_compacted', turn: 3, messages: 2, bytes: 4096, estimateBefore: 9000, estimateAfter: 5000 })
    const line = readJsonLines().find((l) => l.type === 'harness.compacted')
    expect(line).toMatchObject({ turn: 3, messages: 2, bytes: 4096, estimateBefore: 9000, estimateAfter: 5000 })
  })

  it('after_answer -> harness.gate {turn, outcome}', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    followed.event({ type: 'after_answer', turn: 4, outcome: 'accept' })
    const line = readJsonLines().find((l) => l.type === 'harness.gate')
    expect(line).toMatchObject({ turn: 4, outcome: 'accept' })
  })

  it('run_end (the trace event) writes nothing to the run-log', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    followed.event({ type: 'run_end', status: 'completed' })
    expect(readJsonLines()).toEqual([])
  })

  it('result(runResult) -> harness.loop_end, and remembers answer/turns for end()', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    followed.result(RESULT)
    const line = readJsonLines().find((l) => l.type === 'harness.loop_end')
    expect(line).toMatchObject({
      status: 'completed',
      turns: 3,
      toolCalls: 2,
      toolErrors: 0,
      usageSource: 'provider_reported',
      inputTokens: 50,
      outputTokens: 20,
      cachedTokens: 5,
      durationMs: 1234,
    })
    rl.end('done', 2000)
    const runEnd = readJsonLines().find((l) => l.type === 'harness.run_end')
    expect(runEnd).toMatchObject({ outcome: 'done', answer: 'klaar', turns: 3 })
  })

  it('follow() passes every call to the real trace first, even toolContent/containerOutput/result', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const trace = fakeTrace()
    const followed = rl.follow(trace)
    followed.event({ type: 'run_start', manifest: { id: 'r1' } })
    followed.toolContent('c1', 'x')
    followed.containerOutput(1, 'y')
    followed.result(RESULT)
    expect(trace.events).toHaveLength(1)
    expect(trace.toolContents).toEqual([['c1', 'x']])
    expect(trace.containerOutputs).toEqual([[1, 'y']])
    expect(trace.results).toEqual([RESULT])
  })
})

describe('truncation (spec §5.5, applied after redaction)', () => {
  it('reasoning over 16384 chars is head-cut with reasoningTruncated: true', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    const long = 'r'.repeat(20000)
    followed.event({
      type: 'model_response',
      turn: 1,
      content: null,
      toolCalls: [],
      finishReason: 'stop',
      durationMs: 1,
      usage: { source: 'missing', inputTokens: 0, outputTokens: 0 },
      reasoning: long,
    })
    const turn = readJsonLines().find((l) => l.type === 'harness.turn')
    expect(turn?.reasoningTruncated).toBe(true)
    expect(turn?.reasoning).toBe(long.slice(0, 16384))
    expect((turn?.reasoning as string).length).toBe(16384)
  })

  it('content (turn) over 16384 chars is head-cut with contentTruncated: true', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    const long = 'c'.repeat(20000)
    followed.event({
      type: 'model_response',
      turn: 1,
      content: long,
      toolCalls: [],
      finishReason: 'stop',
      durationMs: 1,
      usage: { source: 'missing', inputTokens: 0, outputTokens: 0 },
    })
    const turn = readJsonLines().find((l) => l.type === 'harness.turn')
    expect(turn?.contentTruncated).toBe(true)
    expect((turn?.content as string).length).toBe(16384)
  })

  it('answer over 16384 chars is head-cut with answerTruncated: true, and only appears when outcome is done', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    const long = 'a'.repeat(20000)
    followed.result({ ...RESULT, answer: long })
    rl.end('done', 10)
    const runEnd = readJsonLines().find((l) => l.type === 'harness.run_end')
    expect(runEnd?.answerTruncated).toBe(true)
    expect((runEnd?.answer as string).length).toBe(16384)
  })

  it('tool_call arguments over 4096 chars is head-cut with argumentsTruncated: true', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    const long = JSON.stringify({ q: 'x'.repeat(5000) })
    followed.event({ type: 'tool_call', callId: 'c1', name: 'search_product_docs', arguments: long, argumentsWasObject: true })
    const line = readJsonLines().find((l) => l.type === 'harness.tool_call')
    expect(line?.argumentsTruncated).toBe(true)
    expect((line?.arguments as string).length).toBe(4096)
    expect(line?.arguments).toBe(long.slice(0, 4096))
  })

  it('tool_result content over 8192 chars is head-cut; contentLength is the full (redacted, pre-cut) length', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    const long = 'o'.repeat(9000)
    followed.toolContent('c1', long)
    followed.event({ type: 'tool_result', callId: 'c1', ok: true, truncated: false, sha256: 'x', bytes: 9000 })
    const line = readJsonLines().find((l) => l.type === 'harness.tool_result')
    expect(line?.contentLength).toBe(9000)
    expect((line?.content as string).length).toBe(8192)
    expect(line?.content).toBe(long.slice(0, 8192))
  })

  it('container outputTail over 8192 chars keeps the LAST 8192 chars; outputLength is the full length before the cut (Review F1)', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    const long = Array.from({ length: 9000 }, (_, i) => String(i % 10)).join('')
    followed.containerOutput(1, long)
    followed.event({ type: 'container', kind: 'verify', source: 'run_tests', n: 1, exitCode: 1, timedOut: false, durationMs: 500, outputBytes: 9000 })
    const line = readJsonLines().find((l) => l.type === 'harness.container')
    expect(line?.outputLength).toBe(9000) // full redacted length, BEFORE the tail cut -- not outputTail.length
    expect((line?.outputTail as string).length).toBe(8192)
    expect(line?.outputTail).toBe(long.slice(-8192))
    expect(line?.outputLength).toBeGreaterThan((line?.outputTail as string).length)
  })

  it('container outputTail under 8192 chars: outputLength equals outputTail.length (not cut) (Review F1)', () => {
    const rl = openRunLog(cfg(), baseInit())!
    const followed = rl.follow(fakeTrace())
    followed.containerOutput(1, 'short output')
    followed.event({ type: 'container', kind: 'prepare', source: 'prepare', n: 1, exitCode: 0, timedOut: false, durationMs: 10, outputBytes: 13 })
    const line = readJsonLines().find((l) => l.type === 'harness.container')
    expect(line?.outputLength).toBe('short output'.length)
    expect(line?.outputLength).toBe((line?.outputTail as string).length)
  })
})

describe('redaction (spec §5.7)', () => {
  it('masks a secret inside a meta line written via step()', () => {
    const rl = openRunLog(cfg(), baseInit({ secrets: [SECRET] }))!
    rl.step(`deploy met ${SECRET} gelukt`)
    const text = readLogText()
    expect(text).not.toContain(SECRET)
    expect(text).toContain('***')
  })

  it('masks a secret inside reasoning', () => {
    const rl = openRunLog(cfg(), baseInit({ secrets: [SECRET] }))!
    const followed = rl.follow(fakeTrace())
    followed.event({
      type: 'model_response',
      turn: 1,
      content: null,
      toolCalls: [],
      finishReason: 'stop',
      durationMs: 1,
      usage: { source: 'missing', inputTokens: 0, outputTokens: 0 },
      reasoning: `connecting with ${SECRET} now`,
    })
    expect(readLogText()).not.toContain(SECRET)
  })

  it('masks a secret inside tool content', () => {
    const rl = openRunLog(cfg(), baseInit({ secrets: [SECRET] }))!
    const followed = rl.follow(fakeTrace())
    followed.toolContent('c1', `DATABASE_URL=postgres://u:${SECRET}@h/d`)
    followed.event({ type: 'tool_result', callId: 'c1', ok: false, truncated: false, sha256: 'x', bytes: 1 })
    expect(readLogText()).not.toContain(SECRET)
  })

  it('masks a secret embedded in base_url, in both the config line and harness.run_start', () => {
    const rl = openRunLog(
      cfg(),
      baseInit({ secrets: [SECRET], model: { name: 'm', baseUrl: `http://user:${SECRET}@127.0.0.1:11434/v1` } }),
    )!
    const followed = rl.follow(fakeTrace())
    followed.event({ type: 'run_start', manifest: { id: 'r1' } })
    followed.event({ type: 'tool_snapshot', names: [], hash: 'h' })
    const text = readLogText()
    expect(text).not.toContain(SECRET)
    expect(text).toContain('***')
  })

  it('masks a secret that straddles the truncation boundary in full, never a fragment (Review Focus 1: redact before truncate)', () => {
    const boundarySecret = 'STRADDLE-SECRET-0123456789012345' // 33 chars, obviously fake
    const filler = 'x'.repeat(16380) // cutoff at 16384 falls inside the secret below
    const reasoning = filler + boundarySecret + 'y'.repeat(100)
    const rl = openRunLog(cfg(), baseInit({ secrets: [boundarySecret] }))!
    const followed = rl.follow(fakeTrace())
    followed.event({
      type: 'model_response',
      turn: 1,
      content: null,
      toolCalls: [],
      finishReason: 'stop',
      durationMs: 1,
      usage: { source: 'missing', inputTokens: 0, outputTokens: 0 },
      reasoning,
    })
    const text = readLogText()
    expect(text).not.toContain(boundarySecret)
    // no fragment of the secret leaked either (redaction ran on the whole value before the cut)
    expect(text).not.toContain(boundarySecret.slice(0, 10))
    expect(text).not.toContain(boundarySecret.slice(-10))
    const turn = readJsonLines().find((l) => l.type === 'harness.turn')
    expect(turn?.reasoningTruncated).toBe(true) // redacted text (16380 + 3 + 100 chars) still exceeds the limit
    expect((turn?.reasoning as string).length).toBe(16384)
  })
})

describe('best-effort failure handling (spec §6.3)', () => {
  it('disables intermediate lines after a write failure once opened, logs exactly one line, no method throws, and end() still attempts', () => {
    const logLines: string[] = []
    const rl = openRunLog(cfg(), baseInit({ log: (l) => logLines.push(l) }))!
    rmSync(runsDir(), { recursive: true, force: true }) // the file itself disappears from under the writer

    expect(() => rl.step('after removal')).not.toThrow()
    expect(logLines).toHaveLength(1)
    expect(logLines[0]).toMatch(/^run-log uitgeschakeld voor job job-1: /)

    expect(() => rl.fail('HARNESS_ERROR', 'iets ging mis')).not.toThrow()
    expect(() => rl.end('failed', 10)).not.toThrow()
    expect(logLines).toHaveLength(1) // end()'s own failed retry does not add a second line
  })

  it('keeps the run-log best-effort when mapping throws after a successful trace write (follow ordering)', () => {
    const logLines: string[] = []
    const rl = openRunLog(cfg(), baseInit({ log: (l) => logLines.push(l) }))!
    const trace = fakeTrace()

    const goodUsage = { source: 'provider_reported' as const, inputTokens: 1, outputTokens: 1 }
    let usageReads = 0
    const hostileEvent = {
      type: 'model_response',
      turn: 1,
      content: 'hi',
      toolCalls: [],
      finishReason: 'stop',
      durationMs: 5,
      get usage() {
        usageReads++
        if (usageReads === 1) return goodUsage
        throw new Error('boom')
      },
    } as unknown as TraceEvent

    const followed = rl.follow(trace)
    expect(() => followed.event(hostileEvent)).not.toThrow()

    // the real trace still received the event (with the usage value from the first, successful read)
    expect(trace.events).toHaveLength(1)
    expect((trace.events[0] as { usage: unknown }).usage).toEqual(goodUsage)
    // the run-log itself disabled after the second (throwing) read, with exactly one log line
    expect(logLines).toHaveLength(1)
    expect(logLines[0]).toMatch(/^run-log uitgeschakeld voor job job-1: /)
    expect(readJsonLines().find((l) => l.type === 'harness.turn')).toBeUndefined()

    // end() still writes its closing block
    expect(() => rl.end('done', 100)).not.toThrow()
    const text = readLogText()
    expect(text).toContain('"type":"harness.run_end"')
    expect(text).toContain('exit code=0')
    expect(logLines).toHaveLength(1) // no additional log line from end()
  })
})

describe('no writes after end() (Review F3)', () => {
  it('step(), worktree() and a traced event/toolContent/containerOutput/result after end() add nothing after the exit code= line', () => {
    const rl = openRunLog(cfg(), baseInit())!
    rl.end('done', 5)
    const before = readLogText()
    expect(before.trim().endsWith('exit code=0')).toBe(true)

    const followed = rl.follow(fakeTrace())
    expect(() => {
      rl.step('too late')
      rl.worktree('/too/late')
      followed.event({ type: 'after_answer', turn: 9, outcome: 'accept' })
      followed.toolContent('c1', 'too late')
      followed.containerOutput(1, 'too late')
      followed.result(RESULT)
    }).not.toThrow()

    expect(readLogText()).toBe(before)
  })
})

describe('end()', () => {
  it('done: exact 3 lines (json + done + exit), answer/turns remembered from a prior result(), no code/message', () => {
    const rl = openRunLog(cfg(), baseInit({ jobId: 'job-9', now: () => new Date('2026-09-28T10:05:00.000Z') }))!
    const followed = rl.follow(fakeTrace())
    followed.result(RESULT)
    rl.end('done', 5000)
    const lines = readLogLines().slice(-3)
    expect(lines[0]).toBe(
      '{"type":"harness.run_end","timestamp":"2026-09-28T10:05:00.000Z","outcome":"done","answer":"klaar","turns":3,"durationMs":5000}',
    )
    expect(lines[1]).toBe('2026-09-28T10:05:00.000Z [harness] harness done job_id=job-9 exit_code=0 duration_ms=5000')
    expect(lines[2]).toBe('2026-09-28T10:05:00.000Z [harness] exit code=0')
  })

  it('failed without a prior fail(): code JOB_FAILED, message "geen reden vastgelegd", 4 lines incl. ERROR', () => {
    const rl = openRunLog(cfg(), baseInit({ jobId: 'job-9', now: () => new Date('2026-09-28T10:05:00.000Z') }))!
    rl.end('failed', 3000)
    const lines = readLogLines().slice(-4)
    expect(JSON.parse(lines[0])).toMatchObject({ outcome: 'failed', code: 'JOB_FAILED', message: 'geen reden vastgelegd', durationMs: 3000 })
    expect(lines[1]).toBe('2026-09-28T10:05:00.000Z [harness] ERROR JOB_FAILED: geen reden vastgelegd')
    expect(lines[2]).toBe('2026-09-28T10:05:00.000Z [harness] harness done job_id=job-9 exit_code=1 duration_ms=3000')
    expect(lines[3]).toBe('2026-09-28T10:05:00.000Z [harness] exit code=1')
  })

  it('failed with a prior fail(): uses that code/message instead of the default', () => {
    const rl = openRunLog(cfg(), baseInit())!
    rl.fail('VERIFY_FAILED', 'verify 3x rood')
    rl.end('failed', 100)
    const runEnd = readJsonLines().find((l) => l.type === 'harness.run_end')
    expect(runEnd).toMatchObject({ code: 'VERIFY_FAILED', message: 'verify 3x rood' })
  })

  it('abandoned without a prior fail(): code ABANDONED, fixed message', () => {
    const rl = openRunLog(cfg(), baseInit())!
    rl.end('abandoned', 50)
    const runEnd = readJsonLines().find((l) => l.type === 'harness.run_end')
    expect(runEnd).toMatchObject({ outcome: 'abandoned', code: 'ABANDONED', message: 'geen reden vastgelegd' })
  })

  it('a second end() call writes nothing more', () => {
    const rl = openRunLog(cfg(), baseInit())!
    rl.end('done', 1)
    const before = readLogText()
    rl.end('failed', 999) // different args entirely; must still be a complete no-op
    expect(readLogText()).toBe(before)
  })
})

describe('fail() precedence', () => {
  it('VERIFY_FAILED then JOB_FAILED (no override) keeps VERIFY_FAILED', () => {
    const rl = openRunLog(cfg(), baseInit())!
    rl.fail('VERIFY_FAILED', 'eerste reden')
    rl.fail('JOB_FAILED', 'tweede reden')
    rl.end('failed', 1)
    const runEnd = readJsonLines().find((l) => l.type === 'harness.run_end')
    expect(runEnd).toMatchObject({ code: 'VERIFY_FAILED', message: 'eerste reden' })
  })

  it('VERIFY_FAILED then ABANDONED with override switches to ABANDONED', () => {
    const rl = openRunLog(cfg(), baseInit())!
    rl.fail('VERIFY_FAILED', 'eerste reden')
    rl.fail('ABANDONED', 'eigendom kwijt', { override: true })
    rl.end('abandoned', 1)
    const runEnd = readJsonLines().find((l) => l.type === 'harness.run_end')
    expect(runEnd).toMatchObject({ code: 'ABANDONED', message: 'eigendom kwijt' })
  })
})
