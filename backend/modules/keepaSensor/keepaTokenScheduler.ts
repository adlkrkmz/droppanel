export const KEEPA_SOLD_CADENCE_HOURS = 12
export const KEEPA_STANDARD_CADENCE_HOURS = 24
export const KEEPA_MAX_BATCH = 100
export const KEEPA_TOKEN_RESERVE_DEFAULT = 5
export const KEEPA_TOKEN_COST_PER_ASIN_MAX = 1
/** Keepa `refillIn` is milliseconds (live values like 522 / 1019). */
export const KEEPA_REFILL_PERIOD_MS = 60_000
export const KEEPA_MIN_SLEEP_MS = 250
/** Do not credit a projected refill until this long after Keepa's refillIn. */
export const KEEPA_REFILL_CREDIT_GRACE_MS = 3_000
export const KEEPA_POLL_MS_DEFAULT = 15_000
export const KEEPA_BATCH_GAP_MS_DEFAULT = 800

export type KeepaTokenTelemetry = {
  tokensLeft: number | null
  refillRate: number | null
  refillIn: number | null
  tokensConsumed: number | null
  tokenFlowReduction: number | null
  processingTimeInMs: number | null
  httpStatus: number | null
  requested: number
  returned: number
  parsed: number
}

export type KeepaBatchPlan =
  | { action: "call"; batch: number; spendable: number; probe: boolean }
  | { action: "wait_refill"; batch: 0; spendable: 0; waitMs: number }
  | { action: "idle"; batch: 0; spendable: number }

export function floorTokensLeft(tokensLeft: number | null | undefined): number | null {
  if (tokensLeft == null || !Number.isFinite(Number(tokensLeft))) return null
  return Math.floor(Number(tokensLeft))
}

export function spendableTokens(tokensLeft: number | null | undefined, reserve = KEEPA_TOKEN_RESERVE_DEFAULT): number {
  const left = floorTokensLeft(tokensLeft)
  if (left == null) return 0
  return Math.max(0, left - Math.max(0, reserve))
}

export function keepaRefillInMs(raw: number | null | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 1000
  return Math.round(n)
}

/** Project tokens/refill from a stale Keepa sample. Never writes; Keepa response stays authoritative. */
export function projectKeepaTokenState(input: {
  sampledAtMs: number | null | undefined
  nowMs: number
  tokensLeft: number | null | undefined
  refillRate: number | null | undefined
  refillInMs: number | null | undefined
}): { tokensLeft: number | null; refillInMs: number | null; projected: boolean } {
  const left = floorTokensLeft(input.tokensLeft)
  const refillIn =
    input.refillInMs == null || !Number.isFinite(Number(input.refillInMs))
      ? null
      : Math.max(0, Math.round(Number(input.refillInMs)))
  if (left == null) return { tokensLeft: null, refillInMs: refillIn, projected: false }
  const sampledAt = Number(input.sampledAtMs)
  const now = Number(input.nowMs)
  if (!Number.isFinite(sampledAt) || sampledAt <= 0 || !Number.isFinite(now) || now <= sampledAt) {
    return { tokensLeft: left, refillInMs: refillIn ?? 1000, projected: false }
  }
  const elapsed = now - sampledAt
  const firstIn = refillIn ?? KEEPA_REFILL_PERIOD_MS
  const creditAt = firstIn + KEEPA_REFILL_CREDIT_GRACE_MS
  if (elapsed < creditAt) {
    return { tokensLeft: left, refillInMs: Math.max(1, creditAt - elapsed), projected: true }
  }
  const rate = Number(input.refillRate)
  if (!Number.isFinite(rate) || rate <= 0) {
    return { tokensLeft: left, refillInMs: 0, projected: true }
  }
  const afterFirst = elapsed - creditAt
  const extra = 1 + Math.floor(afterFirst / KEEPA_REFILL_PERIOD_MS)
  const capacity = rate * 60
  const projectedLeft = Math.min(capacity, left + extra * rate)
  const rem = KEEPA_REFILL_PERIOD_MS - (afterFirst % KEEPA_REFILL_PERIOD_MS)
  return {
    tokensLeft: Math.floor(projectedLeft),
    refillInMs: rem === 0 ? KEEPA_REFILL_PERIOD_MS : rem,
    projected: true,
  }
}

export const KEEPA_MAX_IDLE_SLEEP_MS = 60_000

export function tokenWaitSleepMs(input: {
  refillInMs: number | null | undefined
  pollMs: number
  jitterMs?: number
  minSleepMs?: number
}): number {
  const minSleep = Math.max(1, input.minSleepMs ?? KEEPA_MIN_SLEEP_MS)
  const jitter = Math.max(0, Math.floor(input.jitterMs ?? 0))
  const poll = Math.max(minSleep, Number(input.pollMs) || KEEPA_POLL_MS_DEFAULT)
  if (input.refillInMs == null || !Number.isFinite(Number(input.refillInMs))) {
    return Math.min(KEEPA_MAX_IDLE_SLEEP_MS, poll)
  }
  return Math.max(
    minSleep,
    Math.min(KEEPA_MAX_IDLE_SLEEP_MS, keepaRefillInMs(input.refillInMs) + jitter + KEEPA_REFILL_CREDIT_GRACE_MS)
  )
}

export function nextDaemonSleepMs(input: {
  skipped: string | null
  waitMs: number
  keepaCalls: number
  pollMs: number
  stopKeepa?: boolean
  heartbeatMs?: number
  continueDrain?: boolean
  batchGapMs?: number
  nextDueAtMs?: number | null
  nowMs?: number
}): number {
  const gap = Math.max(KEEPA_MIN_SLEEP_MS, Math.min(5_000, input.batchGapMs ?? KEEPA_BATCH_GAP_MS_DEFAULT))
  if (input.stopKeepa) return Math.max(KEEPA_MIN_SLEEP_MS, input.heartbeatMs ?? input.pollMs)
  if (input.continueDrain) return gap
  if (input.skipped === "NO_DUE") {
    const nowMs = input.nowMs ?? Date.now()
    const dueAt = input.nextDueAtMs
    const untilDue = dueAt != null && Number.isFinite(dueAt) ? Math.max(0, dueAt - nowMs) : KEEPA_MAX_IDLE_SLEEP_MS
    return Math.max(KEEPA_MIN_SLEEP_MS, Math.min(KEEPA_MAX_IDLE_SLEEP_MS, untilDue || KEEPA_MAX_IDLE_SLEEP_MS))
  }
  if (input.waitMs > 0) return Math.max(KEEPA_MIN_SLEEP_MS, Math.min(KEEPA_MAX_IDLE_SLEEP_MS, input.waitMs))
  if (input.keepaCalls === 0) {
    return Math.max(KEEPA_MIN_SLEEP_MS, Math.min(KEEPA_MAX_IDLE_SLEEP_MS, Number(input.pollMs) || KEEPA_POLL_MS_DEFAULT))
  }
  return gap
}

export function planKeepaBatch(input: {
  dueCount: number
  tokensLeft: number | null | undefined
  reserve?: number
  maxBatch?: number
  knownTelemetry: boolean
  refillInMs?: number | null
  refillInSec?: number | null
  pollMs?: number
  jitterMs?: number
}): KeepaBatchPlan {
  const dueCount = Math.max(0, Math.floor(input.dueCount))
  const maxBatch = Math.min(KEEPA_MAX_BATCH, Math.max(1, input.maxBatch ?? KEEPA_MAX_BATCH))
  const reserve = input.reserve ?? KEEPA_TOKEN_RESERVE_DEFAULT
  if (dueCount <= 0) return { action: "idle", batch: 0, spendable: spendableTokens(input.tokensLeft, reserve) }
  if (!input.knownTelemetry) {
    return { action: "call", batch: 1, spendable: 1, probe: true }
  }
  const spendable = spendableTokens(input.tokensLeft, reserve)
  if (spendable < 1) {
    return {
      action: "wait_refill",
      batch: 0,
      spendable: 0,
      waitMs: tokenWaitSleepMs({
        refillInMs: input.refillInMs ?? input.refillInSec,
        pollMs: input.pollMs ?? KEEPA_POLL_MS_DEFAULT,
        jitterMs: input.jitterMs,
      }),
    }
  }
  return {
    action: "call",
    batch: Math.min(maxBatch, dueCount, spendable),
    spendable,
    probe: false,
  }
}

/** Consecutive Keepa batch sizes that drain spendable tokens at 1 token/ASIN without going below reserve. */
export function backlogDrainBatchSizes(input: {
  dueCount: number
  tokensLeft: number
  reserve?: number
  maxBatch?: number
}): number[] {
  const reserve = input.reserve ?? KEEPA_TOKEN_RESERVE_DEFAULT
  const maxBatch = Math.min(KEEPA_MAX_BATCH, Math.max(1, input.maxBatch ?? KEEPA_MAX_BATCH))
  let due = Math.max(0, Math.floor(input.dueCount))
  let tokens = Math.floor(Number(input.tokensLeft) || 0)
  const out: number[] = []
  while (due > 0) {
    const spendable = Math.max(0, tokens - reserve)
    if (spendable < 1) break
    const batch = Math.min(maxBatch, due, spendable)
    out.push(batch)
    due -= batch
    tokens -= batch
  }
  return out
}

export function formatKeepaDurationMs(ms: number | null | undefined): string {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return "—"
  const sec = Math.round(n / 1000)
  if (sec < 90) return `${Math.max(0, sec)} sn`
  const min = Math.round(sec / 60)
  if (min < 90) return `${min} dk`
  const hr = Math.round(min / 60)
  return `${hr} sa`
}

export function keepaScanMode(input: { dueCount: number; spendable: number }): "BACKLOG_DRAIN" | "TOKEN_WAIT" | "CADENCE_WAIT" {
  if (input.dueCount <= 0) return "CADENCE_WAIT"
  if (input.spendable < 1) return "TOKEN_WAIT"
  return "BACKLOG_DRAIN"
}

export const KEEPA_STALL_LOOPS_BEFORE_EXIT = 3
/** 3 tight 15s loops must not kill the daemon; require wall time so TOKEN_WAIT/repair backoff can heartbeat. */
export const KEEPA_STALL_MIN_WALL_MS = 180_000
const STALL_RETRY_SKIPS = new Set([
  "TOKEN_WAIT",
  "CADENCE_WAIT",
  "SYNC_RECONCILE_MISMATCH",
  "HTTP_429",
  "HTTP_5XX",
  "NETWORK",
  "TIMEOUT",
  "NO_DUE",
])

export type DueWorkStallState = {
  stallLoops: number
  stallStartedAtMs: number | null
  shouldExit: boolean
}

/** Due work with spendable tokens and Keepa allowed, but no batch progress. */
export function dueWorkStallAdvance(input: {
  previous: number
  stallStartedAtMs?: number | null
  nowMs?: number
  dueCount: number
  progressed: boolean
  tokenWait?: boolean
  stopKeepa?: boolean
  keepaAllowed?: boolean
  spendable?: number
  skipped?: string | null
}): DueWorkStallState {
  const nowMs = input.nowMs ?? Date.now()
  const retrySkip = input.skipped != null && STALL_RETRY_SKIPS.has(input.skipped)
  const waitingTokens = Boolean(input.tokenWait) || (input.spendable != null && input.spendable < 1)
  if (
    input.dueCount <= 0 ||
    input.progressed ||
    waitingTokens ||
    input.stopKeepa ||
    input.keepaAllowed === false ||
    retrySkip
  ) {
    return { stallLoops: 0, stallStartedAtMs: null, shouldExit: false }
  }
  const stallStartedAtMs = input.stallStartedAtMs ?? nowMs
  const stallLoops = input.previous + 1
  const wall = nowMs - stallStartedAtMs
  return {
    stallLoops,
    stallStartedAtMs,
    shouldExit: stallLoops >= KEEPA_STALL_LOOPS_BEFORE_EXIT && wall >= KEEPA_STALL_MIN_WALL_MS,
  }
}

export function tokenCostExceeded(tokensConsumed: number | null | undefined, requestedAsinCount: number): boolean {
  if (tokensConsumed == null || !Number.isFinite(Number(tokensConsumed))) return false
  return Number(tokensConsumed) > requestedAsinCount
}

const BANNED_PARAMS = ["offers", "buybox", "update", "stock", "offers-page", "only-live-offers", "buybox-seller"]

export function keepaProductQueryIsOneToken(params: URLSearchParams): boolean {
  if (params.get("history") !== "0") return false
  if (params.get("stats") !== "1") return false
  if (!params.get("asin")) return false
  for (const key of params.keys()) {
    if (BANNED_PARAMS.includes(key.toLowerCase())) return false
  }
  return true
}

export function minCadenceHours(priority: string): number {
  return priority === "SOLD" ? KEEPA_SOLD_CADENCE_HOURS : KEEPA_STANDARD_CADENCE_HOURS
}

export function nextScanAtMs(nowMs: number, priority: string): number {
  return nowMs + minCadenceHours(priority) * 3600_000
}

export function tooEarlyToScan(input: {
  priority: string
  lastScannedAt: number | null | undefined
  nowMs: number
}): boolean {
  const last = Number(input.lastScannedAt ?? 0)
  if (!Number.isFinite(last) || last <= 0) return false
  return input.nowMs < last + minCadenceHours(input.priority) * 3600_000
}

export function keepaCapacityStats(input: {
  sold: number
  standard: number
  refillRate: number
  tokenFlowReduction?: number | null
}): {
  estimatedBucketCapacity: number
  effectiveRefillRate: number
  dailyCapacity: number
  requiredDaily: number
  requiredPerMinute: number
  utilizationPct: number
  headroom: number
  capacityShort: boolean
} {
  const refillRate = Math.max(0, Number(input.refillRate) || 0)
  const reduction = Math.max(0, Number(input.tokenFlowReduction) || 0)
  const effectiveRefillRate = Math.max(0, refillRate - reduction)
  const estimatedBucketCapacity = refillRate * 60
  const dailyCapacity = effectiveRefillRate * 1440
  const requiredDaily = Math.max(0, input.sold) * 2 + Math.max(0, input.standard)
  const requiredPerMinute = requiredDaily / 1440
  const utilizationPct = dailyCapacity > 0 ? (requiredDaily / dailyCapacity) * 100 : 0
  const headroom = dailyCapacity - requiredDaily
  return {
    estimatedBucketCapacity,
    effectiveRefillRate,
    dailyCapacity,
    requiredDaily,
    requiredPerMinute,
    utilizationPct,
    headroom,
    capacityShort: dailyCapacity > 0 && requiredDaily > dailyCapacity,
  }
}

export function refillWaitMs(input: {
  refillInMs?: number | null
  refillInSec?: number | null
  attempt: number
  jitterMs?: number
}): number {
  const raw = input.refillInMs ?? input.refillInSec
  const base = Math.max(1000, keepaRefillInMs(raw))
  const exp = Math.min(15 * 60_000, base * Math.pow(2, Math.max(0, input.attempt - 1)))
  return exp + Math.max(0, Math.floor(input.jitterMs ?? 0))
}

export function networkBackoffMs(attempt: number): number {
  return Math.min(15 * 60_000, 1000 * Math.pow(2, Math.max(0, attempt)))
}

export function dashboardKeepaBanner(input: {
  dueCount: number
  tokensLeft: number | null
  reserve: number
  capacityShort: boolean
  baselineIncomplete: boolean
  queueEtaLabel?: string | null
}): string {
  if (input.capacityShort) return "Keepa kapasitesi yetersiz"
  if (input.baselineIncomplete && input.queueEtaLabel) return `Baseline sürüyor · ETA ${input.queueEtaLabel}`
  if (input.dueCount <= 0) {
    return "Due yok — token birikmesi hata değildir. Cadence dolmadan tarama yok."
  }
  if (input.tokensLeft != null && input.tokensLeft > input.reserve + 2) {
    return "Due kuyruk var — yüksek token bakiyesi normal değildir; backlog-drain tokenı reserve’e indirir."
  }
  if (input.tokensLeft != null && input.tokensLeft <= input.reserve + 2) {
    return "Token bekleniyor (TOKEN_WAIT)"
  }
  return "Token kontrollü tarama"
}
