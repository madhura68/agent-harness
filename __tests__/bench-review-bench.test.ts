import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mapReviewStatus, runReviewBench, type ReviewBenchResult } from '../src/bench/review-bench.js'
import { CaseInvalidError } from '../src/bench/review-case.js'
import { adaptReviewPrompt } from '../src/bench/review-prompt.js'
import type { ModelSpec } from '../src/bench/task-bench.js'
import { ModelError, type CompleteOptions, type ModelClient } from '../src/model-client.js'
import type { RunResult } from '../src/trace.js'
import type { ChatMessage, CompleteResult } from '../src/types.js'
import { benchTmp, cleanupBenchFixtures } from './fakes/bench-repo.js'
import { seedProbe } from './fakes/probe-seed.js'
import { TEST_CONFIGURATION, testWorkerConfig } from './fakes/worker-config.js'
import { makeCase, type MadeCase } from './fixtures/review-bench/make-case.js'
import { allFiles, DUMMY_KEY, leakedFragments, readTrace } from './helpers.js'

afterEach(cleanupBenchFixtures)

// ---- the synthetic review ----

type Json = Record<string, unknown>
/** A result that production accepts and that repeats the documents of the synthetic case. */
const VALID = JSON.parse(readFileSync(new URL('./fixtures/review-bench/valid-result.json', import.meta.url), 'utf8')) as Json
const validAnswer = (over: Json = {}): string => JSON.stringify({ ...VALID, ...over })
const REVIEW_MD = readFileSync(new URL('./fixtures/queue-review.md', import.meta.url), 'utf8')

// ---- the fake model ----

const usageOf = (o: { in?: number; cost?: number }): CompleteResult['usage'] => ({
  source: 'provider_reported',
  inputTokens: o.in ?? 100,
  outputTokens: 20,
  ...(o.cost !== undefined ? { costUsd: o.cost } : {}),
})

type ReplyOpts = { in?: number; cost?: number; provider?: string }

const reply = (content: string, o: ReplyOpts = {}): CompleteResult => ({
  message: { content, toolCalls: [] },
  finishReason: 'stop',
  usage: usageOf(o),
  model: 'm',
  durationMs: 1,
  ...(o.provider !== undefined ? { provider: o.provider } : {}),
})

const toolReply = (name: string, args: Json, o: ReplyOpts = {}): CompleteResult => ({
  message: { content: null, toolCalls: [{ id: 'call_1', name, arguments: JSON.stringify(args), argumentsWasObject: false }] },
  finishReason: 'tool_calls',
  usage: usageOf(o),
  model: 'm',
  durationMs: 1,
  ...(o.provider !== undefined ? { provider: o.provider } : {}),
})

/** An answer that came back whole but cannot be used: finish reason `other`. The model client turns every unknown finish reason into it. */
const dropped = (cost?: number, provider?: string): CompleteResult => ({
  ...reply('', { ...(cost !== undefined ? { cost } : {}), ...(provider !== undefined ? { provider } : {}) }),
  finishReason: 'other',
})

type Step = CompleteResult | Error | (() => CompleteResult)

/**
 * The base client of a run: plays `steps` in order and counts its calls (`seen`, with the messages as they were at the call). A call
 * past the end of the script throws an error that is no ModelError, so a run that asks for one answer too many fails loudly.
 */
function scripted(steps: Step[]) {
  const seen: Array<{ messages: ChatMessage[]; options: CompleteOptions }> = []
  const client: ModelClient = {
    async complete(messages, options) {
      seen.push({ messages: structuredClone(messages), options })
      const next = steps[seen.length - 1]
      if (next === undefined) throw new Error('script ran out')
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next() : next
    },
  }
  return { client, seen }
}

// ---- the run ----

type Setup = { made: MadeCase; config: ReturnType<typeof testWorkerConfig>; out: string; probeDir: string }

/**
 * A case, a worker config with one configuration, an `out` dir and a separate probe dir (so the files of the probe are never part of
 * what a test reads from `out`). `hosted` makes the configuration hosted, which also makes the bench retry; the probe is accepted unless
 * `probe: false`.
 */
function setup(o: { hosted?: boolean; probe?: boolean; configuration?: Json; made?: MadeCase } = {}): Setup {
  const made = o.made ?? makeCase()
  const configuration = { costMode: o.hosted ? 'hosted' : 'local', contextTokens: 32768, ...o.configuration }
  const config = testWorkerConfig({ configurations: { [TEST_CONFIGURATION]: configuration } })
  const out = benchTmp('review-out')
  const probeDir = benchTmp('review-probe')
  if (o.probe !== false) seedProbe(config, probeDir, TEST_CONFIGURATION)
  return { made, config, out, probeDir }
}

type Deps = NonNullable<Parameters<typeof runReviewBench>[0]['deps']>

async function bench(s: Setup, client: ModelClient, over: { label?: string; apiKey?: string; signal?: AbortSignal; configuration?: string; deps?: Deps } = {}) {
  const createClient = vi.fn((_spec: ModelSpec & { apiKey?: string }) => client)
  const result = await runReviewBench({
    caseDir: s.made.dir,
    config: s.config,
    configuration: over.configuration ?? TEST_CONFIGURATION,
    probeDir: s.probeDir,
    label: over.label ?? 'lbl',
    out: s.out,
    ...(over.apiKey !== undefined ? { apiKey: over.apiKey } : {}),
    ...(over.signal ? { signal: over.signal } : {}),
    deps: { createClient, sleep: async () => {}, ...over.deps },
  })
  return { result, createClient }
}

/** What `runReviewBench` wrote, as a file. */
const written = (s: Setup, r: ReviewBenchResult): ReviewBenchResult & Json => JSON.parse(readFileSync(join(s.out, r.runId, 'bench-result.json'), 'utf8')) as ReviewBenchResult & Json
const traceOf = (s: Setup, r: ReviewBenchResult) => readTrace(join(s.out, r.runId))

// ---- the status rules (AC6) ----

const NO_USAGE = { source: 'missing', inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0, toolErrors: 0 }

function runEnding(status: RunResult['status'], code?: string): RunResult {
  return {
    runId: 'r',
    status,
    ...(code ? { error: { code, message: 'm' } } : {}),
    model: { name: 'n', baseUrl: 'http://localhost:4000/v1' },
    usage: { source: 'provider_reported', inputTokens: 1, outputTokens: 1, turns: 1, toolCalls: 0, toolErrors: 0 },
    durationMs: 1,
  }
}

describe('mapReviewStatus: the order of the rules is the meaning (spec §4.1)', () => {
  describe('rule 1: benchfout', () => {
    it('for a bench error, also on a run that completed with an accepted result', () => {
      expect(mapReviewStatus({ benchError: 'afgebroken', run: runEnding('completed'), accepted: true })).toBe('benchfout')
    })

    it('for a bench error without a run', () => {
      expect(mapReviewStatus({ benchError: 'CONFIGURATION_NOT_PROBED: x', accepted: false })).toBe('benchfout')
    })

    it('when there is no run and no bench error either', () => {
      expect(mapReviewStatus({ accepted: false })).toBe('benchfout')
    })

    it.each(['MODEL_ERROR', 'HARNESS_ERROR', 'TOOL_NOT_AVAILABLE', 'COST_UNKNOWN'])('for the error code %s', (code) => {
      expect(mapReviewStatus({ run: runEnding('failed', code), accepted: false })).toBe('benchfout')
    })

    it('comes before rule 2: a COST_UNKNOWN on a run that went over its budget is still a benchfout', () => {
      expect(mapReviewStatus({ run: runEnding('budget_exceeded', 'COST_UNKNOWN'), accepted: false })).toBe('benchfout')
    })
  })

  describe('rule 2: limiet', () => {
    it.each(['budget_exceeded', 'timed_out'] as const)('for the run status %s', (status) => {
      expect(mapReviewStatus({ run: runEnding(status), accepted: false })).toBe('limiet')
    })

    // Not on `budget_exceeded`: the code alone has to decide, so the status is one that no other limit rule catches.
    it.each(['TOO_MANY_TOOL_ERRORS', 'CONTEXT_EXHAUSTED', 'COST_LIMIT_EXCEEDED'])('for the error code %s', (code) => {
      expect(mapReviewStatus({ run: runEnding('failed', code), accepted: false })).toBe('limiet')
    })

    it('for a context window that ran out, as run.ts reports it: budget_exceeded with CONTEXT_EXHAUSTED', () => {
      expect(mapReviewStatus({ run: runEnding('budget_exceeded', 'CONTEXT_EXHAUSTED'), accepted: false })).toBe('limiet')
    })
  })

  describe('rule 3: resultaat_ongeldig', () => {
    it('for a failed run with REVIEW_RESULT_INVALID', () => {
      expect(mapReviewStatus({ run: runEnding('failed', 'REVIEW_RESULT_INVALID'), accepted: false })).toBe('resultaat_ongeldig')
    })
  })

  describe('rule 4: beoordeeld', () => {
    it('for a completed run with an accepted result', () => {
      expect(mapReviewStatus({ run: runEnding('completed'), accepted: true })).toBe('beoordeeld')
    })
  })

  describe('rule 5: everything else is a benchfout, never a fault of the model', () => {
    it('for a completed run without an accepted result', () => {
      expect(mapReviewStatus({ run: runEnding('completed'), accepted: false })).toBe('benchfout')
    })

    it('for a failed run with a code that no rule names', () => {
      expect(mapReviewStatus({ run: runEnding('failed', 'VERIFY_FAILED'), accepted: false })).toBe('benchfout')
    })

    it('for a failed run without any error', () => {
      expect(mapReviewStatus({ run: runEnding('failed'), accepted: false })).toBe('benchfout')
    })

    it('for an accepted result on a run that did not complete', () => {
      expect(mapReviewStatus({ run: runEnding('failed', 'SOMETHING_NEW'), accepted: true })).toBe('benchfout')
    })
  })
})

// ---- one run, from the case to the result ----

describe('runReviewBench: the run', () => {
  it('reads the staged case, tracks the peak, and writes the result it returns', async () => {
    const s = setup()
    // The larger prompt comes first, so a `peak` that is really "the last one" fails.
    const { client, seen } = scripted([toolReply('read_file', { path: 'payload.json' }, { in: 5000 }), reply(validAnswer(), { in: 3000 })])
    const { result } = await bench(s, client, { label: 'my.label' })

    expect(result.status).toBe('beoordeeld')
    expect(result.runStatus).toBe('completed')
    expect(result.error).toBeUndefined()
    expect(result.runId).toMatch(/^synthetic-review-my\.label-[0-9a-f]{8}$/)
    expect(result.caseId).toBe('synthetic-review')
    expect(result.label).toBe('my.label')
    expect(result.result).toEqual(VALID)
    expect(result.validation).toEqual({ attempts: 1, errors: [] })
    expect(result.peakInputTokens).toBe(5000)
    expect(result.usage).toMatchObject({ inputTokens: 8000, outputTokens: 40, turns: 2, toolCalls: 1, toolErrors: 0 })
    expect({ turns: result.turns, toolCalls: result.toolCalls, toolErrors: result.toolErrors }).toEqual({ turns: 2, toolCalls: 1, toolErrors: 0 })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(seen).toHaveLength(2)

    // The registry looks at the staged root of this run: the payload is there, and the tool read it.
    const events = traceOf(s, result)
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ callId: 'call_1', ok: true })
    expect(readFileSync(join(s.out, result.runId, 'tools', 'call_1.txt'), 'utf8')).toContain('review_documents')
    expect(readFileSync(join(s.out, result.runId, 'root', 'sources', 'doc'), 'utf8')).toContain('Example spec')

    // The file is the result, as JSON.
    expect(written(s, result)).toEqual(JSON.parse(JSON.stringify(result)))
  })

  it('stages an empty work/ next to payload.json and sources/, so list_files on it is an answer and not a tool error (the prompt says work/ is empty)', async () => {
    const s = setup()
    const { client } = scripted([toolReply('list_files', { path: 'work' }), reply(validAnswer())])
    const { result } = await bench(s, client)

    expect(result.status).toBe('beoordeeld')
    expect(result.toolErrors).toBe(0)
    expect(traceOf(s, result).find((e) => e.type === 'tool_result')).toMatchObject({ callId: 'call_1', ok: true })
    expect(readdirSync(join(s.out, result.runId, 'root')).sort()).toEqual(['payload.json', 'sources', 'work'])
    expect(readdirSync(join(s.out, result.runId, 'root', 'work'))).toEqual([])
  })

  it.each(['succeeded', 'failed'])('a valid answer with outcome %s is beoordeeld: the scorer decides about the outcome', async (outcome) => {
    const s = setup()
    const { client } = scripted([reply(validAnswer({ outcome }))])
    const { result } = await bench(s, client)
    expect(result.status).toBe('beoordeeld')
    expect(result.result).toMatchObject({ outcome })
  })

  it('shows the model one user message, the adapted production prompt, with exactly the three read tools', async () => {
    const s = setup()
    const { client, seen } = scripted([reply(validAnswer())])
    await bench(s, client)
    expect(seen[0].messages).toEqual([{ role: 'user', content: adaptReviewPrompt(REVIEW_MD) }])
    expect(seen[0].options.tools?.map((t) => t.function.name).sort()).toEqual(['list_files', 'read_file', 'search'])
  })

  it('takes the limits and the context window from the case, not from the configuration, and sends no system prompt', async () => {
    const s = setup() // the configuration has contextTokens 32768, the case 131072
    const { client } = scripted([reply(validAnswer())])
    const { result } = await bench(s, client)
    expect(result.contextTokens).toBe(131072)
    const start = traceOf(s, result).find((e) => e.type === 'run_start') as unknown as { manifest: Json & { limits: Json; model: Json } }
    expect(start.manifest.limits).toEqual({ maxTurns: 30, maxOutputTokens: 64000, maxWallSeconds: 1800, maxToolErrors: 8, contextTokens: 131072 })
    expect(start.manifest).toMatchObject({ profile: 'tools' })
    expect('system' in start.manifest).toBe(false)
    expect('apiKey' in start.manifest.model).toBe(false)
  })

  it('builds the model from the configuration of the worker config, and hands the key to the client alone', async () => {
    const extraBody = { temperature: 0, provider: { order: ['x'] } }
    const s = setup({ configuration: { reasoningEffort: 'low', extraBody } })
    const { client } = scripted([reply(validAnswer())])
    const { result, createClient } = await bench(s, client, { apiKey: DUMMY_KEY })
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(createClient.mock.calls[0][0]).toStrictEqual({
      baseUrl: s.config.litellm.baseUrl,
      name: TEST_CONFIGURATION,
      reasoningEffort: 'low',
      extraBody,
      apiKey: DUMMY_KEY,
    })
    expect(result.configuration).toEqual({ name: TEST_CONFIGURATION, costMode: 'local', reasoningEffort: 'low' })
  })

  it('leaves out what the configuration does not have', async () => {
    const s = setup()
    const { client } = scripted([reply(validAnswer())])
    const { result, createClient } = await bench(s, client)
    expect(createClient.mock.calls[0][0]).toStrictEqual({ baseUrl: s.config.litellm.baseUrl, name: TEST_CONFIGURATION })
    expect(result.configuration).toStrictEqual({ name: TEST_CONFIGURATION, costMode: 'local' })
  })
})

describe('runReviewBench: how a run ends (AC6)', () => {
  it('two invalid answers are resultaat_ongeldig: one repeat question, then REVIEW_RESULT_INVALID', async () => {
    const s = setup()
    const { client, seen } = scripted([reply('not a JSON object'), reply('still not one')])
    const { result } = await bench(s, client)
    expect(result.status).toBe('resultaat_ongeldig')
    expect(result.runStatus).toBe('failed')
    expect(result.error?.code).toBe('REVIEW_RESULT_INVALID')
    expect(result.result).toBeNull()
    expect(result.validation.attempts).toBe(2)
    expect(result.validation.errors).toHaveLength(2)
    expect(seen).toHaveLength(2)
    expect(seen[1].messages.at(-1)).toMatchObject({ role: 'user' })
    expect((seen[1].messages.at(-1) as { content: string }).content).toContain('Antwoord alleen met het gecorrigeerde JSON-object.')
  })

  it('an invalid answer followed by a valid one is beoordeeld, and the first error is kept', async () => {
    const s = setup()
    const { client } = scripted([reply('not a JSON object'), reply(validAnswer())])
    const { result } = await bench(s, client)
    expect(result.status).toBe('beoordeeld')
    expect(result.validation.attempts).toBe(2)
    expect(result.validation.errors).toHaveLength(1)
  })

  it('a final answer with content null (reasoning only, no tool call) is one invalid answer, not a crash: one repeat question, then a valid answer is beoordeeld', async () => {
    const s = setup()
    const reasoningOnly: CompleteResult = { ...reply(''), message: { content: null, toolCalls: [] }, reasoning: 'let me think about the documents' }
    const { client, seen } = scripted([reasoningOnly, reply(validAnswer())])
    const { result } = await bench(s, client)
    expect(result.status).toBe('beoordeeld')
    expect(result.runStatus).toBe('completed')
    expect(result.error).toBeUndefined()
    expect(result.result).toEqual(VALID)
    expect(result.validation).toEqual({ attempts: 2, errors: ['antwoord is niet precies één JSON-object'] })
    expect(seen).toHaveLength(2)
    // The empty answer stays in the transcript, followed by the repeat question with the reason.
    expect(seen[1].messages.slice(-2)).toEqual([
      { role: 'assistant', content: '' },
      { role: 'user', content: 'antwoord is niet precies één JSON-object\n\nAntwoord alleen met het gecorrigeerde JSON-object.' },
    ])
    expect(traceOf(s, result).filter((e) => e.type === 'after_answer').map((e) => e.outcome)).toEqual(['retry', 'accept'])
  })

  it('an answer cut off by finishReason length is a limiet, and never reaches the validator', async () => {
    const s = setup()
    const { client } = scripted([{ ...reply('{"version": 1, "outc'), finishReason: 'length' }])
    const { result } = await bench(s, client)
    expect(result.status).toBe('limiet')
    expect(result.runStatus).toBe('budget_exceeded')
    expect(result.result).toBeNull()
    expect(result.validation).toEqual({ attempts: 0, errors: [] })
  })

  it('a ModelError is a benchfout, and a local configuration does not retry it', async () => {
    const s = setup()
    const { client, seen } = scripted([new ModelError('connection reset', { kind: 'network' })])
    const { result } = await bench(s, client)
    expect(result.status).toBe('benchfout')
    expect(result.runStatus).toBe('failed')
    expect(result.error).toEqual({ code: 'MODEL_ERROR', message: 'connection reset' })
    expect(seen).toHaveLength(1)
    expect(result.retries).toEqual([])
  })

  it('a hosted configuration retries a temporary failure and records it', async () => {
    const s = setup({ hosted: true })
    const { client, seen } = scripted([new ModelError('connection reset', { kind: 'network' }), reply(validAnswer(), { cost: 0.05, provider: 'P' })])
    const { result } = await bench(s, client)
    expect(result.status).toBe('beoordeeld')
    expect(seen).toHaveLength(2)
    expect(result.retries).toEqual([{ attempt: 1, kind: 'network' }])
    expect(result.providers).toEqual(['P'])
  })
})

describe('runReviewBench: the gate and the cost guard (AC5)', () => {
  it('without an accepted probe: a benchfout with CONFIGURATION_NOT_PROBED, no client, no model call, and nothing staged', async () => {
    const s = setup({ probe: false })
    const { client, seen } = scripted([reply(validAnswer())])
    const { result, createClient } = await bench(s, client)

    expect(result.status).toBe('benchfout')
    expect(result.benchError).toMatch(/^CONFIGURATION_NOT_PROBED: /)
    expect(result.runStatus).toBe('not_run')
    expect(result.error).toBeUndefined()
    expect(result.result).toBeNull()
    expect(createClient).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
    expect(existsSync(join(s.out, result.runId, 'root'))).toBe(false)

    // Still a result file, with a bill of nothing.
    expect(result.usage).toEqual(NO_USAGE)
    expect(result).toMatchObject({ peakInputTokens: 0, turns: 0, toolCalls: 0, toolErrors: 0, providers: [], retries: [], validation: { attempts: 0, errors: [] } })
    expect(written(s, result)).toEqual(JSON.parse(JSON.stringify(result)))
  })

  it('a configuration that the worker config does not have fails the gate too, and its cost mode is null', async () => {
    const s = setup()
    const { client, seen } = scripted([])
    const { result, createClient } = await bench(s, client, { configuration: 'no-such-config' })
    expect(result.status).toBe('benchfout')
    expect(result.benchError).toMatch(/^CONFIGURATION_NOT_PROBED: /)
    expect(result.configuration).toStrictEqual({ name: 'no-such-config', costMode: null })
    expect(createClient).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
  })

  it('hosted, an answer without an amount is a benchfout with COST_UNKNOWN', async () => {
    const s = setup({ hosted: true })
    const { client } = scripted([reply(validAnswer())])
    const { result } = await bench(s, client)
    expect(result.status).toBe('benchfout')
    expect(result.runStatus).toBe('failed')
    expect(result.error?.code).toBe('COST_UNKNOWN')
  })

  it('hosted, a tool answer that takes the total past maxCostUsd is a limiet with COST_LIMIT_EXCEEDED, before the tool runs', async () => {
    const s = setup({ hosted: true })
    const { client, seen } = scripted([toolReply('read_file', { path: 'payload.json' }, { cost: 1.5 })])
    const { result } = await bench(s, client)
    expect(result.status).toBe('limiet')
    expect(result.runStatus).toBe('failed')
    expect(result.error?.code).toBe('COST_LIMIT_EXCEEDED')
    expect(seen).toHaveLength(1)
    expect(traceOf(s, result).some((e) => e.type === 'tool_result')).toBe(false)
  })

  it('a local configuration never stops on money, whatever the answers report', async () => {
    const s = setup()
    const { client } = scripted([reply(validAnswer(), { cost: 50 })])
    const { result } = await bench(s, client)
    expect(result.status).toBe('beoordeeld')
  })
})

describe('runReviewBench: answers that were dropped but paid for (plan-r1 X-M1, C-m3)', () => {
  it('two dropped answers of 0.40, then a tool answer of 0.25: the guard sees all three, and the run stops before the tool', async () => {
    const s = setup({ hosted: true })
    // No fourth step: a guard that is not shared between the retry layer and the run loop would ask for one.
    const { client, seen } = scripted([dropped(0.4), dropped(0.4), toolReply('read_file', { path: 'payload.json' }, { cost: 0.25 })])
    const { result } = await bench(s, client)
    expect(result.status).toBe('limiet')
    expect(result.error?.code).toBe('COST_LIMIT_EXCEEDED')
    expect(seen).toHaveLength(3)
    expect(traceOf(s, result).some((e) => e.type === 'tool_result')).toBe(false)
    expect(result.usage.costUsd).toBeCloseTo(1.05)
    expect(written(s, result).usage.costUsd).toBeCloseTo(1.05)
    expect(result.retries).toHaveLength(2)
  })

  it('three dropped answers of 0.40: a limiet with COST_LIMIT_EXCEEDED, not the MODEL_ERROR that the stop looks like to the run', async () => {
    const s = setup({ hosted: true })
    const { client, seen } = scripted([dropped(0.4), dropped(0.4), dropped(0.4)])
    const { result } = await bench(s, client)
    expect(result.status).toBe('limiet')
    expect(result.runStatus).toBe('failed')
    expect(result.error?.code).toBe('COST_LIMIT_EXCEEDED')
    expect(seen).toHaveLength(3)
    expect(result.usage.costUsd).toBeCloseTo(1.2)
    expect(written(s, result).usage.costUsd).toBeCloseTo(1.2)
    expect(result.retries).toHaveLength(3) // the stopping answer is a record too, so its cost is on the bill
  })

  it('a dropped answer that reports no amount is a benchfout with COST_UNKNOWN, not the MODEL_ERROR that the stop looks like to the run: no retry, no tool', async () => {
    const s = setup({ hosted: true })
    // The second step is what a guard that did not stop would reach: a retry would get this tool answer and run the tool.
    const { client, seen } = scripted([dropped(undefined, 'A'), toolReply('read_file', { path: 'payload.json' }, { cost: 0.05 })])
    const { result } = await bench(s, client)
    // COST_UNKNOWN is a BENCH_CODES code (mapReviewStatus rule 1): a cost that is unknown is a failure of the bench, never a limiet.
    expect(result.status).toBe('benchfout')
    expect(result.runStatus).toBe('failed')
    expect(result.error?.code).toBe('COST_UNKNOWN')
    expect(result.error?.message).toContain(TEST_CONFIGURATION)
    expect(result.benchError).toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(traceOf(s, result).some((e) => e.type === 'tool_result')).toBe(false)
    expect(result.retries).toEqual([{ attempt: 1, kind: 'finish_other', provider: 'A' }]) // the stopping answer is a record, without an amount
    expect(result.providers).toEqual(['A'])
    expect(result.usage.costUsd).toBeUndefined() // nothing was reported, so nothing is on the bill
    expect(written(s, result).error?.code).toBe('COST_UNKNOWN')
  })

  it('three dropped answers of 0.40 with the deadline passed by the third: timed_out stays, the status is limiet, there is no error', async () => {
    const s = setup({ hosted: true })
    let clock = 1_000_000
    // The clock moves in the fake model, just before it returns the third answer: no wait follows the third drop, because the guard
    // stops the run in `onRetry`, so `sleep` is never reached.
    const third = (): CompleteResult => {
      clock += 1800 * 1000 + 1
      return dropped(0.4)
    }
    const { client, seen } = scripted([dropped(0.4), dropped(0.4), third])
    const { result } = await bench(s, client, { deps: { now: () => clock } })
    expect(result.status).toBe('limiet')
    expect(result.runStatus).toBe('timed_out')
    expect(result.error).toBeUndefined()
    expect('error' in written(s, result)).toBe(false)
    expect(seen).toHaveLength(3)
    expect(result.usage.costUsd).toBeCloseTo(1.2)
  })

  it('one dropped answer of 0.02 and then a valid one of 0.05: beoordeeld, and 0.07 on the bill in bench-result.json', async () => {
    const s = setup({ hosted: true })
    const { client, seen } = scripted([dropped(0.02, 'A'), reply(validAnswer(), { cost: 0.05, provider: 'B' })])
    const { result } = await bench(s, client)
    expect(result.status).toBe('beoordeeld')
    expect(seen).toHaveLength(2)
    expect(written(s, result).usage.costUsd).toBeCloseTo(0.07)
    expect(result.retries).toEqual([{ attempt: 1, kind: 'finish_other', costUsd: 0.02, provider: 'A' }])
    expect(result.providers).toEqual(['A', 'B'])
  })
})

describe('runReviewBench: a stop from outside', () => {
  it('a signal that is aborted before the start is a benchfout "afgebroken": no client, no model call, nothing staged', async () => {
    const s = setup()
    const { client, seen } = scripted([reply(validAnswer())])
    const { result, createClient } = await bench(s, client, { signal: AbortSignal.abort() })
    expect(result.status).toBe('benchfout')
    expect(result.benchError).toBe('afgebroken')
    expect(result.runStatus).toBe('not_run')
    expect(createClient).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
    expect(existsSync(join(s.out, result.runId, 'root'))).toBe(false)
    expect(written(s, result).benchError).toBe('afgebroken')
  })

  it('a stop during the run is a benchfout "afgebroken", even when the answer that came with it was a valid one', async () => {
    const s = setup()
    const stop = new AbortController()
    const { client } = scripted([
      () => {
        stop.abort()
        return reply(validAnswer())
      },
    ])
    const { result } = await bench(s, client, { signal: stop.signal })
    expect(result.status).toBe('benchfout')
    expect(result.benchError).toBe('afgebroken')
    expect(result.runStatus).toBe('failed')
  })
})

describe('runReviewBench: a case that cannot be used (AC4)', () => {
  it('a changed byte stops the bench with the CaseInvalidError, and leaves `out` empty', async () => {
    const s = setup()
    s.made.flipByte('sources/doc')
    const { client, seen } = scripted([reply(validAnswer())])
    await expect(bench(s, client)).rejects.toBeInstanceOf(CaseInvalidError)
    expect(readdirSync(s.out)).toEqual([])
    expect(seen).toHaveLength(0)
  })

  it('a production prompt that the replacements no longer fit stops the bench too, and leaves `out` empty', async () => {
    const s = setup()
    const changed = 'You are a reviewer. Read the file at $PAYLOAD_PATH.\n'
    writeFileSync(join(s.made.dir, 'review.md'), changed)
    s.made.editCase((c) => {
      c.prompt.sha256 = createHash('sha256').update(changed).digest('hex')
    })
    const { client } = scripted([reply(validAnswer())])
    await expect(bench(s, client)).rejects.toThrow(/review-prompt: A1 verwacht 2×/)
    expect(readdirSync(s.out)).toEqual([])
  })
})

describe('runReviewBench: the key (AC7)', () => {
  /** Every file under `out` holds no stretch of the key. The list of files is checked too, so the scan cannot pass on an empty dir. */
  function expectNoKeyUnder(out: string): void {
    const files = allFiles(out)
    expect(files.map((f) => f.slice(out.length + 1)).sort()).toEqual(expect.arrayContaining([expect.stringMatching(/trace\.jsonl$/), expect.stringMatching(/bench-result\.json$/), expect.stringMatching(/(^|\/)result\.json$/)]))
    for (const file of files) expect(leakedFragments(readFileSync(file, 'utf8')), file).toEqual([])
  }

  it('a ModelError with the key in its message leaves the key in no file under out, and the message is masked, not lost', async () => {
    const s = setup()
    const { client } = scripted([new ModelError(`401 Unauthorized: invalid key ${DUMMY_KEY}`, { kind: 'http', status: 401 })])
    const { result } = await bench(s, client, { apiKey: DUMMY_KEY })

    expect(result.status).toBe('benchfout')
    expect(result.error?.code).toBe('MODEL_ERROR')
    expect(result.error?.message).toBe('401 Unauthorized: invalid key ***')
    expect(JSON.stringify(result)).not.toContain(DUMMY_KEY.slice(0, 10))
    expectNoKeyUnder(s.out)
  })

  it('a final answer that repeats the key is written without it as well', async () => {
    const s = setup()
    const { client } = scripted([reply(validAnswer({ summary: `The key ${DUMMY_KEY} was in the prompt.` }))])
    const { result } = await bench(s, client, { apiKey: DUMMY_KEY })

    expect(result.status).toBe('beoordeeld')
    expect(result.result?.summary).toBe('The key *** was in the prompt.')
    expectNoKeyUnder(s.out)
  })

  it('a key that is too short to mask safely is left alone, as in the worker', async () => {
    const s = setup()
    const { client } = scripted([new ModelError('bad key abc', { kind: 'http', status: 401 })])
    const { result } = await bench(s, client, { apiKey: 'abc' })
    expect(result.error?.message).toBe('bad key abc')
  })
})
