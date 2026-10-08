// What every final status of a HARNESS job carries (M45-2d, spec §6.1/§6.2): the tokens the provider reported and the cost of the job.
// A final status is `done` or `failed`, of an idea-chat and of a task alike; one that sends no cost has no report for the job at all.

import { statusCost, type CostGuard, type StatusCost } from '../cost.js'
import type { RunResult } from '../trace.js'
import type { ControlChannel, StatusOutcome, StatusUpdate } from './control.js'

type TokenFields = Pick<StatusUpdate, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'actual_thinking_tokens'>

const isCount = (n: number | undefined): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

/**
 * The measured tokens of a run, only when every response reported its usage. The cached and the thinking tokens go along as the run summed
 * them; the thinking tokens are part of the output tokens, so they are never added to them. Never `cache_write_tokens`: nothing measures it.
 */
export function tokenFields(usage: RunResult['usage'] | undefined): TokenFields {
  if (!usage || usage.source !== 'provider_reported') return {}
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(isCount(usage.cachedTokens) ? { cache_read_tokens: usage.cachedTokens } : {}),
    ...(isCount(usage.reasoningTokens) ? { actual_thinking_tokens: usage.reasoningTokens } : {}),
  }
}

/** The update with its tokens and its cost: what the run measured (none when it never ran) and what the guard of the job counted. */
export function withMeasured(update: StatusUpdate, usage: RunResult['usage'] | undefined, guard: CostGuard | undefined): StatusUpdate & { cost: StatusCost } {
  return { ...update, ...tokenFields(usage), cost: statusCost(guard?.summary()) }
}

/** The run-log line of the cost of a job, written before its closing block. */
export function costLogLine(cost: StatusCost, ceiling: string): string {
  return `cost source=${cost.cost_source} amount=${cost.reported_cost_usd ?? 'null'} provider=${cost.provider ?? '-'} ceiling=${ceiling}`
}

const COST_REFUSALS = ['VALIDATION_ERROR: COST_REPORT_INVALID', 'VALIDATION_ERROR: COST_REPORT_NOT_ALLOWED']

/**
 * Sends a final status. When the MCP refuses its cost report (COST_REPORT_INVALID, or COST_REPORT_NOT_ALLOWED, which refuses any report), the
 * same status goes once more without `cost`: the outcome of the job matters more than its cost. Any other answer, and a call that threw,
 * comes back as it is.
 */
export async function sendFinalStatus(control: ControlChannel, jobId: string, update: StatusUpdate): Promise<StatusOutcome> {
  const res = await control.updateStatus(jobId, update)
  if (res.ok || res.unknown || update.cost === undefined) return res
  if (!COST_REFUSALS.some((refusal) => res.message?.includes(refusal))) return res
  const { cost: _cost, ...withoutCost } = update
  return control.updateStatus(jobId, withoutCost)
}

/** The `error` text of a job that a cost stop ended: `<code>: <detail>`, without the status prefix of other failures; undefined for any other result. */
export function costFailureText(result: RunResult): string | undefined {
  const error = result.error
  return error && (error.code === 'COST_LIMIT_EXCEEDED' || error.code === 'COST_UNKNOWN') ? `${error.code}: ${error.message}` : undefined
}
