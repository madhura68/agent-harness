// Costs in whole nano-dollars (M45-2d, decisions 11-13): a reported amount is a JSON number, and adding or comparing floats
// decides the edge cases wrongly (0.1 + 0.2 + 0.3 is 0.6000000000000001; Math.ceil(0.000123 * 1e9) is 123001). So an amount goes
// through its shortest decimal spelling into a BigInt, and everything after that is exact.

import type { CompleteResult } from './types.js'

const NANOS_PER_USD_DIGITS = 9
const NANOS_PER_USD = 10n ** BigInt(NANOS_PER_USD_DIGITS)

// What `String(n)` writes for a finite n >= 0: digits, optionally a point and digits, optionally an exponent ('1e-7', '1.5e-10', '1e+21').
const SHORTEST_NUMBER = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/
// A plain decimal string, as the payload carries the ceiling: no exponent, no sign, no spaces, no '.5' and no '5.'. \d is 0-9 in JavaScript.
const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/

/**
 * A reported amount in dollars as whole nano-dollars. The amount is read from the shortest decimal spelling of `n` (an exponent is written
 * out), never multiplied in floats. Only digits after the ninth decimal round up (up never reports too little). `n` must be finite and >= 0.
 */
export function costToNanos(n: number): bigint {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new RangeError(`geen geldig bedrag: ${String(n)}`)
  const match = SHORTEST_NUMBER.exec(String(n))
  if (!match) throw new RangeError(`bedrag zonder bekende schrijfwijze: ${String(n)}`)
  const [, whole, fraction = '', exponent = '0'] = match
  // value = digits * 10^(exponent - fraction.length); in nanos: digits * 10^shift
  const digits = BigInt(whole + fraction)
  const shift = NANOS_PER_USD_DIGITS + Number(exponent) - fraction.length
  if (shift >= 0) return digits * 10n ** BigInt(shift)
  const divisor = 10n ** BigInt(-shift)
  const quotient = digits / divisor
  return digits % divisor === 0n ? quotient : quotient + 1n
}

/**
 * The ceiling of a job, from its decimal string, as whole nano-dollars. Exact: the digits are read as they stand. A ceiling with more than nine
 * decimals is cut off after the ninth, so it rounds down: the stricter limit. Anything that is not a plain decimal string throws.
 */
export function parseCeilingNanos(s: string): bigint {
  const match = typeof s === 'string' ? PLAIN_DECIMAL.exec(s) : null
  if (!match) throw new RangeError(`geen decimaal bedrag: ${String(s).slice(0, 80)}`)
  const [, whole, fraction = ''] = match
  return BigInt(whole + fraction.slice(0, NANOS_PER_USD_DIGITS).padEnd(NANOS_PER_USD_DIGITS, '0'))
}

/** Nano-dollars as a decimal string with nine decimals ('600000000' is '0.600000000'). */
export function formatNanos(b: bigint): string {
  if (b < 0n) throw new RangeError('een bedrag is nooit negatief')
  return `${b / NANOS_PER_USD}.${(b % NANOS_PER_USD).toString().padStart(NANOS_PER_USD_DIGITS, '0')}`
}

export type CostMode = 'local' | 'hosted'

/** A run that stops on its costs: the Terminal-shaped result of a guard hook. */
export type CostStop = { status: 'failed'; error: { code: 'COST_LIMIT_EXCEEDED' | 'COST_UNKNOWN'; message: string } }

/** What a guard measured, for the cost report of the job and for the run-log. */
export type CostSummary = {
  mode: CostMode
  /** Model responses the guard has seen. */
  responses: number
  /** The exact sum of the reported amounts; always 0 for a local configuration (decision 13). */
  totalNanos: bigint
  /** A hosted response came without a usable amount: the cost of the job is unknown. */
  unknown: boolean
  /** The distinct `provider` values of the responses, in the order they were first seen. */
  providers: string[]
}

export type CostGuard = {
  /** Before a model call: a stop when the total has reached the ceiling. Never for the first call. */
  beforeRequest(): CostStop | undefined
  /** After a model response (the whole `CompleteResult`): adds its amount, and a stop on an unknown amount or, when the response asks for tools, a reached ceiling. */
  afterResponse(res: CompleteResult): CostStop | undefined
  summary(): CostSummary
}

/** `costMode` says whose amounts count: a hosted configuration reports them, a local one is free whatever its responses say. */
export function createCostGuard(opts: { mode: CostMode; ceilingNanos: bigint; configuration: string }): CostGuard {
  const { mode, ceilingNanos, configuration } = opts
  let responses = 0
  let totalNanos = 0n
  let unknown = false
  const providers: string[] = []

  const limitStop = (): CostStop => ({
    status: 'failed',
    error: { code: 'COST_LIMIT_EXCEEDED', message: `${formatNanos(totalNanos)} ≥ ${formatNanos(ceilingNanos)} USD na ${responses} aanroepen` },
  })

  return {
    beforeRequest() {
      if (mode === 'local') return undefined // decision 13: a local configuration never stops on money, whatever the ceiling is
      return responses > 0 && totalNanos >= ceilingNanos ? limitStop() : undefined
    },
    afterResponse(res) {
      responses++
      if (mode === 'local') return undefined
      if (res.provider !== undefined && !providers.includes(res.provider)) providers.push(res.provider)
      let amount: bigint | undefined
      try {
        // A missing amount is never 0; neither is one that is no valid amount (negative, not finite).
        if (typeof res.usage.costUsd === 'number') amount = costToNanos(res.usage.costUsd)
      } catch {
        amount = undefined
      }
      if (amount === undefined) {
        unknown = true
        return { status: 'failed', error: { code: 'COST_UNKNOWN', message: `antwoord ${responses} van ${configuration} had geen bedrag` } }
      }
      totalNanos += amount
      return totalNanos >= ceilingNanos && res.message.toolCalls.length > 0 ? limitStop() : undefined
    },
    summary: () => ({ mode, responses, totalNanos, unknown, providers: [...providers] }),
  }
}

/** The cost of a job as `update_job_status` takes it (spec §6.2). */
export type StatusCost = { reported_cost_usd: string | null; cost_source: 'provider_reported' | 'local' | 'none'; provider?: string }

const PROVIDER_LIMIT = 200 // the MCP's limit on `provider`

/** The cost report of a job from what its guard measured. A job that never ran has no guard: `none` with no figure. */
export function statusCost(summary: CostSummary | undefined): StatusCost {
  if (!summary) return { reported_cost_usd: null, cost_source: 'none' }
  if (summary.mode === 'local') return { reported_cost_usd: '0', cost_source: 'local' }
  if (summary.unknown || summary.responses === 0) return { reported_cost_usd: null, cost_source: 'none' }
  let provider = summary.providers.join(',')
  if (provider.length > PROVIDER_LIMIT) {
    provider = provider.slice(0, PROVIDER_LIMIT)
    if (/[\uD800-\uDBFF]$/.test(provider)) provider = provider.slice(0, -1) // no half surrogate pair
  }
  return { reported_cost_usd: formatNanos(summary.totalNanos), cost_source: 'provider_reported', ...(provider !== '' ? { provider } : {}) }
}
