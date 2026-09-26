import type { Manifest } from '../manifest.js'
import type { ModelClient } from '../model-client.js'
import { runManifest } from '../run.js'
import { openTrace, type RunResult } from '../trace.js'
import type { ToolRegistry } from '../types.js'
import type { WorkerConfig } from './config.js'
import type { ClaimResult, ControlChannel, StatusUpdate } from './control.js'
import { IDEA_CHAT_SYSTEM_PROMPT, IdeaChatPayloadSchema, pendingUserMessages, renderIdeaChatUserMessage } from './idea-chat.js'

export type WorkerDeps = {
  control: ControlChannel
  /** Allowlist view on the shared MCP connection; closing it leaves the connection open. */
  registryView: (signal?: AbortSignal) => Promise<ToolRegistry>
  modelClient: ModelClient
  config: WorkerConfig
  out: string
  once: boolean
  /** Ctrl-C. */
  signal: AbortSignal
  heartbeatMs?: number
  /** Pause after a wait_for_job tool error before the next attempt; default 5 s. */
  errorBackoffMs?: number
  log?: (line: string) => void
}

export type JobOutcome = 'done' | 'failed' | 'abandoned' // abandoned = no longer ours, nothing closed

type Claim = Extract<ClaimResult, { type: 'job' }>

const SUMMARY_LIMIT = 4000 // update_job_status server limits
const ERROR_LIMIT = 2000
const TRUNCATED_MARK = '\n\n_[antwoord afgekapt]_'

function cut(text: string, limit: number, mark = ''): string {
  if (text.length <= limit) return text
  let head = text.slice(0, limit - mark.length)
  // Do not leave half a surrogate pair behind.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
  return head + mark
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/** Run ids live inside the manifest grammar ^[a-z0-9][a-z0-9-]{0,79}$; the epoch keeps re-claims apart. */
function runIdFor(jobId: string): string {
  const safe = jobId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60)
  return `job-${safe}-${Date.now()}`
}

function failureText(result: RunResult, config: WorkerConfig): string {
  if (result.error) return `${result.status}: ${result.error.code} ${result.error.message}`
  if (result.status === 'timed_out') return `timed_out: geen antwoord binnen maxWallSeconds=${config.limits.maxWallSeconds}`
  if (result.status === 'budget_exceeded') {
    return `budget_exceeded: maxTurns=${config.limits.maxTurns} of maxOutputTokens=${config.limits.maxOutputTokens} bereikt`
  }
  return `${result.status}: onbekende fout`
}

/** What to send when the run ended; null = send nothing (ownership lost). */
function closingUpdate(result: RunResult, config: WorkerConfig): StatusUpdate {
  if (result.status === 'completed') {
    const answer = result.answer ?? ''
    const modelId = result.model.reported ?? config.model.name
    if (answer.trim() === '') return { status: 'failed', error: `leeg antwoord van ${modelId}` }
    return {
      status: 'done',
      summary: cut(answer, SUMMARY_LIMIT, TRUNCATED_MARK),
      model_id: modelId,
      ...(result.usage.source === 'provider_reported'
        ? { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens }
        : {}),
    }
  }
  return { status: 'failed', error: cut(failureText(result, config), ERROR_LIMIT) }
}

export async function runOneJob(deps: WorkerDeps, claim: Claim): Promise<JobOutcome> {
  const { control, config } = deps
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const { jobId } = claim

  const close = async (update: StatusUpdate): Promise<JobOutcome> => {
    const res = await control.updateStatus(jobId, update)
    if (!res.ok) log(`job ${jobId}: update_job_status(${update.status}) mislukt: ${res.message ?? 'onbekend'}`)
    return update.status === 'done' ? 'done' : 'failed'
  }

  // Second lock behind the claim filter: this worker runs IDEA_CHAT only.
  if (claim.kind !== 'IDEA_CHAT') return close({ status: 'failed', error: `kind ${claim.kind} niet ondersteund door agent-harness` })
  const parsed = IdeaChatPayloadSchema.safeParse(claim.payload)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
    return close({ status: 'failed', error: cut(`payload ongeldig: ${issues}`, ERROR_LIMIT) })
  }
  const payload = parsed.data
  if (pendingUserMessages(payload).length === 0) return close({ status: 'failed', error: 'geen onbeantwoord USER-bericht' })

  const running = await control.updateStatus(jobId, { status: 'running' })
  if (!running.ok) {
    log(`job ${jobId}: niet (meer) van deze worker (${running.message ?? 'onbekend'}); overgeslagen`)
    return 'abandoned'
  }

  const inner = new AbortController()
  const onStop = () => inner.abort()
  deps.signal.addEventListener('abort', onStop, { once: true })
  let lost = false
  const beat = setInterval(() => {
    void control.heartbeat(jobId).then((ok) => {
      if (!ok && !lost) {
        lost = true
        inner.abort()
      }
    })
  }, deps.heartbeatMs ?? 60_000)

  let update: StatusUpdate
  try {
    const runId = runIdFor(jobId)
    const manifest: Manifest = {
      id: runId,
      profile: 'tools',
      system: IDEA_CHAT_SYSTEM_PROMPT,
      prompt: renderIdeaChatUserMessage(payload),
      model: config.model,
      tools: { server: { command: 'shared', args: [] }, allow: config.allow },
      limits: config.limits,
    }
    const result = await runManifest(manifest, {
      client: deps.modelClient,
      trace: openTrace(deps.out, runId),
      connectRegistry: (signal) => deps.registryView(signal),
      signal: inner.signal,
      runStartExtra: { jobId, ideaId: payload.idea.id },
    })
    update = closingUpdate(result, config)
  } catch (err) {
    update = { status: 'failed', error: cut(`harness: ${err instanceof Error ? err.message : String(err)}`, ERROR_LIMIT) }
  } finally {
    clearInterval(beat)
    deps.signal.removeEventListener('abort', onStop)
  }

  if (lost) {
    log(`job ${jobId}: eigendom kwijt tijdens de beurt (heartbeat geweigerd); niets afgesloten`)
    return 'abandoned'
  }
  if (deps.signal.aborted) update = { status: 'failed', error: 'worker gestopt' }
  const outcome = await close(update)
  log(`job ${jobId}: ${outcome}`)
  return outcome
}

export async function runWorker(deps: WorkerDeps): Promise<{ jobs: Array<{ jobId: string; outcome: JobOutcome }>; exitCode: 0 | 1 }> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const jobs: Array<{ jobId: string; outcome: JobOutcome }> = []
  for (;;) {
    if (deps.signal.aborted) return { jobs, exitCode: 0 }
    const claim = await deps.control.waitForJob(deps.config.waitSeconds, deps.signal)
    switch (claim.type) {
      case 'stopped':
        return { jobs, exitCode: 0 }
      case 'timeout':
        if (deps.once) return { jobs, exitCode: 0 }
        continue
      case 'error':
        log(`wait_for_job: ${claim.message}`)
        if (deps.once) return { jobs, exitCode: 1 }
        await sleep(deps.errorBackoffMs ?? 5000, deps.signal)
        continue
      case 'broken':
        // A claim may have landed server-side; its job returns to QUEUED through the lease reset.
        log(`MCP-verbinding onbruikbaar (${claim.message}); uitkomst van een eventueel lopende claim onbekend. Worker stopt.`)
        return { jobs, exitCode: 1 }
      case 'job': {
        const outcome = await runOneJob(deps, claim)
        jobs.push({ jobId: claim.jobId, outcome })
        if (deps.signal.aborted) return { jobs, exitCode: 0 } // stopped on request: the job is closed, the stop was clean
        if (deps.once) return { jobs, exitCode: outcome === 'done' ? 0 : 1 }
        continue
      }
    }
  }
}
