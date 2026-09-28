import type { Manifest } from '../manifest.js'
import type { ModelClient } from '../model-client.js'
import { runManifest } from '../run.js'
import { openTrace, type RunResult } from '../trace.js'
import type { ToolRegistry } from '../types.js'
import type { WorkerConfig } from './config.js'
import { killLeftoverContainers, type ContainerDeps } from './containers.js'
import type { ClaimResult, ControlChannel, StatusUpdate } from './control.js'
import { startHeartbeat } from './heartbeat.js'
import { IDEA_CHAT_SYSTEM_PROMPT, IdeaChatPayloadSchema, pendingUserMessages, renderIdeaChatUserMessage } from './idea-chat.js'
import { ContainerUncertainError, runTaskJob, type TaskJobContext } from './task-impl.js'

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
  /** Test seam for the task containers (fake docker); production passes nothing. */
  taskDeps?: ContainerDeps
}

export type JobOutcome = 'done' | 'failed' | 'abandoned' // abandoned = no longer ours, nothing closed

/**
 * A claim this worker should never have received: another kind, or an IDEA_CHAT payload from an MCP
 * without M2 (no pending_user_message_ids). Both prove the claim filter is not the M2 one, so the
 * worker stops instead of failing the rest of the queue one job at a time.
 */
export class ClaimFilterError extends Error {}

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

/** Routes a claim by kind: IDEA_CHAT and TASK_IMPLEMENTATION; anything else is a claim-filter breach. */
export async function runOneJob(deps: WorkerDeps, claim: Claim, taskCtx?: TaskJobContext): Promise<JobOutcome> {
  if (claim.kind === 'TASK_IMPLEMENTATION') return runTaskJob(deps, claim, taskCtx)
  return runIdeaChatJob(deps, claim)
}

async function runIdeaChatJob(deps: WorkerDeps, claim: Claim): Promise<JobOutcome> {
  const { control, config } = deps
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const { jobId } = claim

  const close = async (update: StatusUpdate): Promise<JobOutcome> => {
    const res = await control.updateStatus(jobId, update)
    if (!res.ok) log(`job ${jobId}: update_job_status(${update.status}) mislukt: ${res.message ?? 'onbekend'}`)
    return update.status === 'done' ? 'done' : 'failed'
  }

  // Second lock behind the claim filter: this worker runs IDEA_CHAT and TASK_IMPLEMENTATION only.
  if (claim.kind !== 'IDEA_CHAT') {
    await close({ status: 'failed', error: `kind ${claim.kind} niet ondersteund door agent-harness` })
    throw new ClaimFilterError(`kind ${claim.kind}`)
  }
  const parsed = IdeaChatPayloadSchema.safeParse(claim.payload)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
    await close({ status: 'failed', error: cut(`payload ongeldig: ${issues}`, ERROR_LIMIT) })
    throw new ClaimFilterError(`payload ongeldig (${issues})`)
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
  if (deps.signal.aborted) inner.abort() // Ctrl-C during the running update: no model call
  let lost = false
  const stopBeat = startHeartbeat(control, jobId, deps.heartbeatMs ?? 60_000, () => {
    lost = true
    inner.abort()
  })

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
    stopBeat()
    deps.signal.removeEventListener('abort', onStop)
  }

  if (lost) {
    log(`job ${jobId}: eigendom kwijt tijdens de beurt (heartbeat geweigerd); niets afgesloten`)
    return 'abandoned'
  }
  // A stop that lands after a completed turn keeps the answer.
  if (deps.signal.aborted && update.status !== 'done') update = { status: 'failed', error: 'worker gestopt' }
  const outcome = await close(update)
  log(`job ${jobId}: ${outcome}`)
  return outcome
}

export async function runWorker(deps: WorkerDeps): Promise<{ jobs: Array<{ jobId: string; outcome: JobOutcome }>; exitCode: 0 | 1 }> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const jobs: Array<{ jobId: string; outcome: JobOutcome }> = []
  // Leftover harness containers from a crash: clean them up before the first task. Idea-chat never waits on
  // this; a task job re-checks first and is refused (without touching the task) while it stays uncertain.
  let taskReady = true
  if (deps.config.task) {
    taskReady = (await killLeftoverContainers(deps.taskDeps)) === 'clean'
    if (!taskReady) log('achtergebleven harness-containers niet aantoonbaar opgeruimd; taakjobs worden geweigerd tot een hercontrole slaagt')
  }
  const taskCtx: TaskJobContext = {
    containersClean: async () => {
      if (!taskReady) taskReady = (await killLeftoverContainers(deps.taskDeps)) === 'clean'
      return taskReady
    },
  }
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
        let outcome: JobOutcome
        try {
          outcome = await runOneJob(deps, claim, taskCtx)
        } catch (err) {
          if (err instanceof ContainerUncertainError) {
            jobs.push({ jobId: claim.jobId, outcome: err.outcome })
            log(`job ${claim.jobId}: ${err.message}. Worker stopt.`)
            return { jobs, exitCode: 1 }
          }
          if (!(err instanceof ClaimFilterError)) throw err
          jobs.push({ jobId: claim.jobId, outcome: 'failed' })
          log(`job ${claim.jobId}: ${err.message} — dit hoort het claimfilter (local_llm-isolatie in scrum4me-mcp) te voorkomen. Worker stopt.`)
          return { jobs, exitCode: 1 }
        }
        jobs.push({ jobId: claim.jobId, outcome })
        if (deps.signal.aborted) return { jobs, exitCode: 0 } // stopped on request: the job is closed, the stop was clean
        if (deps.once) return { jobs, exitCode: outcome === 'done' ? 0 : 1 }
        continue
      }
    }
  }
}
