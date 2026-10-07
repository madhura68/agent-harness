import type { Manifest } from '../manifest.js'
import type { ModelClient } from '../model-client.js'
import { runManifest } from '../run.js'
import { openTrace, type RunResult } from '../trace.js'
import type { ToolRegistry } from '../types.js'
import type { WorkerConfig } from './config.js'
import { killLeftoverContainers, type ContainerDeps } from './containers.js'
import type { ClaimResult, ControlChannel, StatusUpdate } from './control.js'
import { EXIT_NO_RESTART, EXIT_RESTART, EXIT_STOPPED, type ExitCode } from './exit-codes.js'
import { startHeartbeat } from './heartbeat.js'
import { IDEA_CHAT_SYSTEM_PROMPT, IdeaChatPayloadSchema, pendingUserMessages, renderIdeaChatUserMessage } from './idea-chat.js'
import { failBeforeRunning, limitsFor, modelClientFor, modelSpecFor, resolveJobConfiguration } from './job-configuration.js'
import { checkProbeForJob } from './probe-gate.js'
import type { RunLog } from './run-log.js'
import { ContainerUncertainError, runTaskJob, type TaskJobContext } from './task-impl.js'

export type WorkerDeps = {
  control: ControlChannel
  /** Allowlist view on the shared MCP connection; closing it leaves the connection open. */
  registryView: (signal?: AbortSignal) => Promise<ToolRegistry>
  /** One model client per configuration of `config`, by name; each job runs through the client of the configuration its payload names. */
  modelClients: Record<string, ModelClient>
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
  /** Opens the run-log for a claimed job (spec §6.4); no field, or a null return, means no run-log (as before M4). */
  runLogFor?: (claim: Claim) => RunLog | null
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

/** What to send when the run ended; null = send nothing (ownership lost). `configuration` is the name the provider's own model name falls back to. */
function closingUpdate(result: RunResult, config: WorkerConfig, configuration: string): StatusUpdate {
  if (result.status === 'completed') {
    const answer = result.answer ?? ''
    const modelId = result.model.reported ?? configuration
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

/**
 * The RunLog.fail() code for a `failed` StatusUpdate coming out of closingUpdate (spec §5.6, table row
 * "closingUpdate geeft failed"): a completed run only turns into `failed` on an empty answer (JOB_FAILED);
 * an incomplete run uses the model loop's own error code, falling back to the budget/timeout status.
 */
function ideaChatFailCode(result: RunResult): string {
  if (result.status === 'completed') return 'JOB_FAILED'
  if (result.error) return result.error.code
  if (result.status === 'budget_exceeded') return 'BUDGET_EXCEEDED'
  if (result.status === 'timed_out') return 'TIMED_OUT'
  return 'JOB_FAILED'
}

/** Routes a claim by kind: IDEA_CHAT and TASK_IMPLEMENTATION; anything else is a claim-filter breach. */
export async function runOneJob(deps: WorkerDeps, claim: Claim, taskCtx?: TaskJobContext): Promise<JobOutcome> {
  const started = Date.now()
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  // Guarded on its own (spec §6.3): a throwing runLogFor must never take the job outcome down with it.
  let runLog: RunLog | null = null
  try {
    runLog = deps.runLogFor?.(claim) ?? null
  } catch (err) {
    log(`run-log uitgeschakeld voor job ${claim.jobId}: ${err instanceof Error ? err.message : String(err)}`)
  }
  let outcome: JobOutcome = 'failed'
  try {
    outcome = claim.kind === 'TASK_IMPLEMENTATION'
      ? await runTaskJob(deps, claim, taskCtx, runLog)
      : await runIdeaChatJob(deps, claim, runLog)
    return outcome
  } catch (err) {
    if (err instanceof ContainerUncertainError) outcome = err.outcome
    else if (!(err instanceof ClaimFilterError)) runLog?.fail('HARNESS_ERROR', err instanceof Error ? err.message : String(err))
    throw err // de worker-lus handelt de fout af zoals nu
  } finally {
    runLog?.end(outcome, Date.now() - started)
  }
}

async function runIdeaChatJob(deps: WorkerDeps, claim: Claim, runLog: RunLog | null): Promise<JobOutcome> {
  const { control, config } = deps
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const { jobId } = claim

  const close = async (update: StatusUpdate): Promise<JobOutcome> => {
    const res = await control.updateStatus(jobId, update)
    if (!res.ok) log(`job ${jobId}: update_job_status(${update.status}) mislukt: ${res.message ?? 'onbekend'}`)
    runLog?.step(`job_status ${update.status === 'done' ? 'done' : 'failed'}`)
    return update.status === 'done' ? 'done' : 'failed'
  }

  // Second lock behind the claim filter: this worker runs IDEA_CHAT and TASK_IMPLEMENTATION only.
  if (claim.kind !== 'IDEA_CHAT') {
    runLog?.fail('CLAIM_FILTER', `kind ${claim.kind} niet ondersteund door agent-harness`)
    await close({ status: 'failed', error: `kind ${claim.kind} niet ondersteund door agent-harness` })
    throw new ClaimFilterError(`kind ${claim.kind}`)
  }
  const parsed = IdeaChatPayloadSchema.safeParse(claim.payload)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
    runLog?.fail('CLAIM_FILTER', `payload ongeldig: ${issues}`)
    await close({ status: 'failed', error: cut(`payload ongeldig: ${issues}`, ERROR_LIMIT) })
    throw new ClaimFilterError(`payload ongeldig (${issues})`)
  }
  const payload = parsed.data
  if (pendingUserMessages(payload).length === 0) {
    runLog?.fail('JOB_FAILED', 'geen onbeantwoord USER-bericht')
    return close({ status: 'failed', error: 'geen onbeantwoord USER-bericht' })
  }
  // The job's own configuration and cost ceiling, from its payload: one that this worker does not have fails this job only, before it runs.
  const resolved = resolveJobConfiguration(config, claim.payload)
  if (!resolved.ok) return failBeforeRunning(deps, jobId, runLog, resolved.failure)
  const job = resolved.job
  // The probe gate of that configuration, after the configuration and the ceiling and before running: no accepted probe of the hash it has now fails this job only.
  const probed = checkProbeForJob(config, deps.out, job.name)
  if (!probed.ok) return failBeforeRunning(deps, jobId, runLog, probed.failure)

  const running = await control.updateStatus(jobId, { status: 'running' })
  if (!running.ok) {
    log(`job ${jobId}: niet (meer) van deze worker (${running.message ?? 'onbekend'}); overgeslagen`)
    runLog?.fail('ABANDONED', `niet (meer) van deze worker (${running.message ?? 'onbekend'})`)
    return 'abandoned'
  }
  runLog?.step('job_status running')

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
  let failInfo: { code: string; message: string } | undefined
  try {
    const runId = runIdFor(jobId)
    const manifest: Manifest = {
      id: runId,
      profile: 'tools',
      system: IDEA_CHAT_SYSTEM_PROMPT,
      prompt: renderIdeaChatUserMessage(payload),
      model: modelSpecFor(config, job),
      tools: { server: { command: 'shared', args: [] }, allow: config.allow },
      limits: limitsFor(config.limits, job),
    }
    const result = await runManifest(manifest, {
      client: modelClientFor(deps.modelClients, job.name),
      trace: runLog ? runLog.follow(openTrace(deps.out, runId)) : openTrace(deps.out, runId),
      connectRegistry: (signal) => deps.registryView(signal),
      signal: inner.signal,
      runStartExtra: { jobId, ideaId: payload.idea.id },
    })
    update = closingUpdate(result, config, job.name)
    if (update.status === 'failed') failInfo = { code: ideaChatFailCode(result), message: update.error ?? '' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    update = { status: 'failed', error: cut(`harness: ${msg}`, ERROR_LIMIT) }
    failInfo = { code: 'HARNESS_ERROR', message: msg }
  } finally {
    stopBeat()
    deps.signal.removeEventListener('abort', onStop)
  }

  if (lost) {
    log(`job ${jobId}: eigendom kwijt tijdens de beurt (heartbeat geweigerd); niets afgesloten`)
    runLog?.fail('ABANDONED', 'eigendom kwijt tijdens de beurt (heartbeat geweigerd)')
    return 'abandoned'
  }
  // A stop that lands after a completed turn keeps the answer.
  if (deps.signal.aborted && update.status !== 'done') {
    update = { status: 'failed', error: 'worker gestopt' }
    failInfo = { code: 'STOPPED', message: 'worker gestopt' }
  }
  // The code is only recorded now, after the possible STOPPED override (spec §6.4): fail() keeps the first
  // code, so recording the run's own code any earlier would block STOPPED from ever taking over.
  if (update.status !== 'done' && failInfo) runLog?.fail(failInfo.code, failInfo.message)
  const outcome = await close(update)
  log(`job ${jobId}: ${outcome}`)
  return outcome
}

/** The runtime a claimed payload says it was made for (`config.runtime`); anything but a string is no runtime at all. */
function payloadRuntime(payload: unknown): unknown {
  return (payload as { config?: { runtime?: unknown } } | null | undefined)?.config?.runtime
}

export async function runWorker(deps: WorkerDeps): Promise<{ jobs: Array<{ jobId: string; outcome: JobOutcome }>; exitCode: ExitCode }> {
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
    if (deps.signal.aborted) return { jobs, exitCode: EXIT_STOPPED }
    const claim = await deps.control.waitForJob(deps.config.waitSeconds, deps.signal)
    switch (claim.type) {
      case 'stopped':
        return { jobs, exitCode: EXIT_STOPPED }
      case 'timeout':
        if (deps.once) return { jobs, exitCode: EXIT_STOPPED }
        continue
      case 'error':
        log(`wait_for_job: ${claim.message}`)
        if (deps.once) return { jobs, exitCode: EXIT_RESTART }
        await sleep(deps.errorBackoffMs ?? 5000, deps.signal)
        continue
      case 'runtime_mismatch':
        // The MCP gave the claim back itself (the job stays QUEUED), so there is nothing to close. A restart would meet the same job and the same refusal.
        log('RUNTIME_MISMATCH: de MCP gaf de claim terug omdat de runtime van de job niet bij deze worker hoort. Worker stopt zonder herstart.')
        return { jobs, exitCode: EXIT_NO_RESTART }
      case 'broken':
        // A claim may have landed server-side; its job returns to QUEUED through the lease reset.
        log(`MCP-verbinding onbruikbaar (${claim.message}); uitkomst van een eventueel lopende claim onbekend. Worker stopt.`)
        return { jobs, exitCode: EXIT_RESTART }
      case 'job': {
        // Own check, for an MCP without the claim check of M45-2b: a job that is not ours is left alone (no update_job_status, no run-log);
        // against such an MCP its lease runs out and the job returns to the queue. A payload without config.runtime is no HARNESS payload.
        const runtime = payloadRuntime(claim.payload)
        if (runtime !== 'HARNESS') {
          jobs.push({ jobId: claim.jobId, outcome: 'abandoned' })
          log(`RUNTIME_MISMATCH (eigen controle): job ${claim.jobId} heeft config.runtime=${JSON.stringify(runtime)?.slice(0, 60) ?? 'ontbrekend'}; niet aangeraakt. Worker stopt zonder herstart.`)
          return { jobs, exitCode: EXIT_NO_RESTART }
        }
        let outcome: JobOutcome
        try {
          outcome = await runOneJob(deps, claim, taskCtx)
        } catch (err) {
          if (err instanceof ContainerUncertainError) {
            jobs.push({ jobId: claim.jobId, outcome: err.outcome })
            log(`job ${claim.jobId}: ${err.message}. Worker stopt.`)
            return { jobs, exitCode: EXIT_RESTART }
          }
          if (!(err instanceof ClaimFilterError)) throw err
          jobs.push({ jobId: claim.jobId, outcome: 'failed' })
          log(`job ${claim.jobId}: ${err.message} — dit hoort het claimfilter (runtime-isolatie in scrum4me-mcp) te voorkomen. Worker stopt zonder herstart.`)
          return { jobs, exitCode: EXIT_NO_RESTART }
        }
        jobs.push({ jobId: claim.jobId, outcome })
        if (deps.signal.aborted) return { jobs, exitCode: EXIT_STOPPED } // stopped on request: the job is closed, the stop was clean
        if (deps.once) return { jobs, exitCode: outcome === 'done' ? EXIT_STOPPED : EXIT_RESTART }
        continue
      }
    }
  }
}
