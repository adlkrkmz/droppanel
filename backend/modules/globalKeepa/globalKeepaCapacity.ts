import type { ListingPriorityRank } from "./globalKeepaTypes"
import {
  LISTING_PRIORITY_CLICKED,
  LISTING_PRIORITY_NORMAL,
  LISTING_PRIORITY_SOLD,
} from "./globalKeepaTypes"

export type CapacitySeverity = "HEALTHY" | "INFO" | "NOTICE" | "WARNING" | "CRITICAL"

export type RecheckPolicyHours = {
  soldMinRecheckHours: number
  clickedMinRecheckHours: number
  normalMinRecheckHours: number
  hardMaxCheckAgeHours: number
}

/** Configured surplus buffer. Default 100. Independent of refillRate so a 40/min plan still keeps the same floor. */
export function tokenReserve(_refillRate?: number | null, configuredReserve?: number | null): number {
  if (configuredReserve != null && Number.isFinite(configuredReserve) && configuredReserve >= 0) {
    return Math.floor(configuredReserve)
  }
  const fromEnv = parseInt(process.env.GLOBAL_KEEPA_TOKEN_RESERVE ?? "", 10)
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv
  return 100
}

export function theoreticalDailyCapacity(refillRate: number | null | undefined): number {
  const rate = refillRate != null && Number.isFinite(refillRate) && refillRate > 0 ? refillRate : 0
  return rate * 60 * 24
}

export function safeDailyCapacity(
  refillRate: number | null | undefined,
  safeUtilization = 0.95
): number {
  const util = Number.isFinite(safeUtilization) && safeUtilization > 0 && safeUtilization <= 1
    ? safeUtilization
    : 0.95
  return theoreticalDailyCapacity(refillRate) * util
}

export function affordableAsins(input: {
  tokensLeft: number | null | undefined
  refillRate: number | null | undefined
  tokenCostPerAsin?: number
  tokenReserve?: number | null
}): number {
  const left = input.tokensLeft != null && Number.isFinite(input.tokensLeft) ? Math.max(0, input.tokensLeft) : 0
  const cost = input.tokenCostPerAsin != null && input.tokenCostPerAsin > 0 ? input.tokenCostPerAsin : 1
  const reserve = tokenReserve(input.refillRate, input.tokenReserve)
  return Math.max(0, Math.floor((left - reserve) / cost))
}

/** Apply Keepa's refillRate to a stale tokensLeft snapshot so scanning can resume after tokens hit reserve/0. */
export function projectedTokensLeft(input: {
  tokensLeft: number | null | undefined
  refillRate: number | null | undefined
  lastApiAt: Date | string | null | undefined
  now?: Date
}): number {
  const left = input.tokensLeft != null && Number.isFinite(Number(input.tokensLeft))
    ? Math.max(0, Number(input.tokensLeft))
    : 0
  const rate =
    input.refillRate != null && Number.isFinite(input.refillRate) && input.refillRate > 0
      ? input.refillRate
      : 20
  if (input.lastApiAt == null) return left
  const at = input.lastApiAt instanceof Date ? input.lastApiAt : new Date(input.lastApiAt)
  if (Number.isNaN(at.getTime())) return left
  const now = input.now ?? new Date()
  const minutes = Math.max(0, (now.getTime() - at.getTime()) / 60_000)
  return left + rate * minutes
}

export function keepaBatchSize(input: {
  productBatchMax: number
  affordableAsins: number
  dueAsins: number
}): number {
  const cap = Math.min(100, Math.max(1, input.productBatchMax || 100))
  return Math.max(0, Math.min(cap, Math.max(0, input.affordableAsins), Math.max(0, input.dueAsins)))
}

export function avgTokensPerAsin(tokensConsumed: number, asinsProcessed: number): number | null {
  if (!Number.isFinite(tokensConsumed) || !Number.isFinite(asinsProcessed) || asinsProcessed <= 0) {
    return null
  }
  return Math.round((tokensConsumed / asinsProcessed) * 1000) / 1000
}

export function projectedDailyRequirement(
  activeUniqueAsins: number,
  avgTokensPerSuccessfulAsin: number | null
): { baseChecks: number; observedTokens: number | null } {
  const base = Math.max(0, activeUniqueAsins)
  const avg = avgTokensPerSuccessfulAsin != null && avgTokensPerSuccessfulAsin > 0
    ? avgTokensPerSuccessfulAsin
    : 1
  return { baseChecks: base, observedTokens: base * avg }
}

export function utilizationPercent(requirement: number, capacity: number): number | null {
  if (!Number.isFinite(capacity) || capacity <= 0) return null
  return Math.round((requirement / capacity) * 10000) / 100
}

export function capacitySeverity(
  baseUtilizationPercent: number | null,
  projectedRequirement: number,
  safeCapacity: number
): CapacitySeverity {
  if (safeCapacity > 0 && projectedRequirement > safeCapacity) return "CRITICAL"
  const u = baseUtilizationPercent ?? 0
  if (u >= 95) return "CRITICAL"
  if (u >= 90) return "WARNING"
  if (u >= 85) return "NOTICE"
  if (u >= 75) return "INFO"
  return "HEALTHY"
}

export function minRecheckHoursForPriority(
  priority: ListingPriorityRank,
  policy: RecheckPolicyHours
): number {
  if (priority === LISTING_PRIORITY_SOLD) return policy.soldMinRecheckHours
  if (priority === LISTING_PRIORITY_CLICKED) return policy.clickedMinRecheckHours
  return policy.normalMinRecheckHours
}

export function retryDelayMinutes(failureCount: number): number {
  const n = Math.max(1, Math.floor(failureCount))
  if (n <= 1) return 5
  if (n === 2) return 15
  return 30
}

export function nextSuccessCheckAt(input: {
  lastSuccessAt: Date
  priority: ListingPriorityRank
  policy: RecheckPolicyHours
}): Date {
  const hours = minRecheckHoursForPriority(input.priority, input.policy)
  return new Date(input.lastSuccessAt.getTime() + hours * 3600_000)
}

export function nextFailureCheckAt(input: {
  now: Date
  failureCount: number
  refillInMs?: number | null
}): Date {
  const backoffMs = retryDelayMinutes(input.failureCount) * 60_000
  const refillWait =
    input.refillInMs != null && Number.isFinite(input.refillInMs) && input.refillInMs > 0
      ? input.refillInMs
      : 0
  if (refillWait > 0) return new Date(input.now.getTime() + refillWait)
  return new Date(input.now.getTime() + backoffMs)
}

export function slaOverdue(input: {
  now: Date
  lastSuccessAt: Date | null
  hardMaxCheckAgeHours: number
}): boolean {
  if (input.lastSuccessAt == null) return true
  const ageMs = input.now.getTime() - input.lastSuccessAt.getTime()
  return ageMs >= input.hardMaxCheckAgeHours * 3600_000
}

export type DueBucket = "SLA_OVERDUE" | "SLA_SCHEDULED" | "SOLD_EARLY" | "CLICKED_EARLY"

export function dueBucket(input: {
  now: Date
  lastSuccessAt: Date | null
  nextCheckAt: Date | null
  priority: ListingPriorityRank
  policy: RecheckPolicyHours
}): DueBucket | null {
  const overdue = slaOverdue({
    now: input.now,
    lastSuccessAt: input.lastSuccessAt,
    hardMaxCheckAgeHours: input.policy.hardMaxCheckAgeHours,
  })
  if (overdue) return "SLA_OVERDUE"

  const dueBySchedule =
    input.nextCheckAt == null || input.nextCheckAt.getTime() <= input.now.getTime()
  if (!dueBySchedule) return null

  if (input.priority === LISTING_PRIORITY_SOLD) return "SOLD_EARLY"
  if (input.priority === LISTING_PRIORITY_CLICKED) return "CLICKED_EARLY"
  return "SLA_SCHEDULED"
}

/** Overdue always sorts before extra-capacity priority. */
export function dueSortKey(bucket: DueBucket): number {
  switch (bucket) {
    case "SLA_OVERDUE":
      return 0
    case "SLA_SCHEDULED":
      return 1
    case "SOLD_EARLY":
      return 2
    case "CLICKED_EARLY":
      return 3
    default:
      return 9
  }
}

export function requiredAsinsPerMinute(input: {
  remainingDueUntilSla: number
  remainingMinutesUntilSlaWindow: number
  activeUniqueAsins: number
  hardMaxCheckAgeHours: number
}): number {
  const windowMin = Math.max(1, input.remainingMinutesUntilSlaWindow)
  const catchUp = Math.max(0, input.remainingDueUntilSla) / windowMin
  const hours = Math.max(1, input.hardMaxCheckAgeHours)
  const spread = Math.max(0, input.activeUniqueAsins) / (hours * 60)
  return Math.max(spread, catchUp)
}

export function tickAsinBudget(input: {
  requiredAsinsPerMinute: number
  tickIntervalMs: number
  affordableAsins: number
  dueAsins: number
  productBatchMax: number
  overdueCount: number
  extraDueCount: number
}): number {
  const tickMinutes = Math.max(input.tickIntervalMs / 60_000, 0.25)
  const paced = Math.max(input.dueAsins > 0 ? 1 : 0, Math.ceil(input.requiredAsinsPerMinute * tickMinutes))
  const want =
    input.overdueCount > 0
      ? Math.min(input.dueAsins, Math.max(paced, Math.min(input.overdueCount, paced)))
      : Math.min(input.dueAsins, Math.max(paced, Math.min(Math.max(0, input.extraDueCount), paced)))
  return keepaBatchSize({
    productBatchMax: input.productBatchMax,
    affordableAsins: input.affordableAsins,
    dueAsins: want,
  })
}

export function splitAsinsByDomain(rows: Array<{ keepaDomain: number; asin: string }>): Map<number, string[]> {
  const map = new Map<number, string[]>()
  for (const row of rows) {
    const list = map.get(row.keepaDomain) ?? []
    list.push(row.asin)
    map.set(row.keepaDomain, list)
  }
  return map
}

export function chunkAsins(asins: string[], max: number): string[][] {
  const size = Math.min(100, Math.max(1, max))
  const out: string[][] = []
  for (let i = 0; i < asins.length; i += size) out.push(asins.slice(i, i + size))
  return out
}

export type KeepaThrottleMode = "IDLE" | "DRAIN" | "SUSTAIN" | "BRAKE"

export type AdaptiveKeepaSpendPlan = {
  mode: KeepaThrottleMode
  asinsThisTick: number
  batchSize: number
  maxBatches: number
}

/** Keepa's live refillRate is the source of truth. Target percent scales sustainable spend (e.g. 0.95 * 20/min ≈ 19). */
export function sustainableTokensPerTick(input: {
  refillRate: number | null | undefined
  capacityTargetPercent: number
  tickIntervalMs: number
}): number {
  const rate =
    input.refillRate != null && Number.isFinite(input.refillRate) && input.refillRate > 0
      ? input.refillRate
      : 20
  const pct =
    Number.isFinite(input.capacityTargetPercent) &&
    input.capacityTargetPercent > 0 &&
    input.capacityTargetPercent <= 1
      ? input.capacityTargetPercent
      : 0.95
  const tickMin = Math.max(input.tickIntervalMs / 60_000, 0.25)
  return Math.max(1, Math.floor(rate * pct * tickMin))
}

/**
 * Gas when backlog + surplus tokens; cruise near refillRate after surplus is gone;
 * brake near reserve without parking at tokensLeft=0.
 */
export function adaptiveKeepaSpendPlan(input: {
  tokensLeft: number | null | undefined
  refillRate: number | null | undefined
  tokenReserve: number
  tokenCostPerAsin?: number
  dueAsins: number
  productBatchMax: number
  capacityTargetPercent: number
  tickIntervalMs: number
}): AdaptiveKeepaSpendPlan {
  const due = Math.max(0, Math.floor(input.dueAsins))
  const idle: AdaptiveKeepaSpendPlan = { mode: "IDLE", asinsThisTick: 0, batchSize: 0, maxBatches: 0 }
  if (due <= 0) return idle

  const cost = input.tokenCostPerAsin != null && input.tokenCostPerAsin > 0 ? input.tokenCostPerAsin : 1
  const rate =
    input.refillRate != null && Number.isFinite(input.refillRate) && input.refillRate > 0
      ? input.refillRate
      : 20
  const reserve = Math.max(0, Math.floor(input.tokenReserve))
  const left =
    input.tokensLeft != null && Number.isFinite(Number(input.tokensLeft))
      ? Math.max(0, Number(input.tokensLeft))
      : 0
  const batchMax = Math.min(100, Math.max(1, input.productBatchMax || 100))
  const sustain = sustainableTokensPerTick({
    refillRate: rate,
    capacityTargetPercent: input.capacityTargetPercent,
    tickIntervalMs: input.tickIntervalMs,
  })
  const floor = 1
  const hardMax = Math.floor(Math.max(0, left - floor) / cost)
  if (hardMax <= 0) return { mode: "BRAKE", asinsThisTick: 0, batchSize: 0, maxBatches: 0 }

  const surplus = left - reserve
  if (surplus > rate) {
    const drainAsins = Math.min(due, Math.floor(surplus / cost), hardMax)
    const batchSize = Math.min(batchMax, drainAsins)
    const maxBatches = batchSize > 0 ? Math.min(8, Math.ceil(drainAsins / batchSize)) : 0
    return { mode: "DRAIN", asinsThisTick: drainAsins, batchSize, maxBatches }
  }
  if (surplus > 0) {
    const asins = Math.min(due, Math.floor(surplus / cost), sustain, hardMax, batchMax)
    return {
      mode: "SUSTAIN",
      asinsThisTick: asins,
      batchSize: asins,
      maxBatches: asins > 0 ? 1 : 0,
    }
  }
  const brakeAsins = Math.min(due, sustain, hardMax, batchMax)
  return {
    mode: "BRAKE",
    asinsThisTick: brakeAsins,
    batchSize: brakeAsins,
    maxBatches: brakeAsins > 0 ? 1 : 0,
  }
}

export function isKeepaHardBrake(code: string | null | undefined): boolean {
  return (
    code === "HTTP_429" ||
    code === "HTTP_5XX" ||
    code === "TIMEOUT" ||
    code === "NETWORK" ||
    code === "MALFORMED_JSON"
  )
}
