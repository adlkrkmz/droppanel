export const AMAZON_BROWSER_PLANNER_FLAG = "AMAZON_BROWSER_PLANNER_ENABLED"
export const AMAZON_SCAN_REMOTE_PROTOCOL_FLAG = "AMAZON_SCAN_REMOTE_PROTOCOL_ENABLED"
export const AMAZON_SCAN_REMOTE_WORKERS_FLAG = "AMAZON_SCAN_REMOTE_WORKERS_ENABLED"
export const AMAZON_MUTATION_CONFIRM_READ_FLAG = "AMAZON_MUTATION_CONFIRM_READ"
export const AMAZON_SCAN_APPLY_PROCESSOR_FLAG = "AMAZON_SCAN_APPLY_PROCESSOR_ENABLED"
export const AMAZON_SCAN_APPLY_FLAG = "AMAZON_SCAN_APPLY_ENABLED"
export const AMAZON_BROWSER_PLANNER_BATCH_FLAG = "AMAZON_BROWSER_PLANNER_BATCH_SIZE"
export const AMAZON_BROWSER_PLANNER_MAX_OUTSTANDING_FLAG = "AMAZON_BROWSER_PLANNER_MAX_OUTSTANDING"
export const AMAZON_KEEPA_ROUTINE_ACTIONS_FLAG = "AMAZON_KEEPA_ROUTINE_ACTIONS_DISABLED"
export const AMAZON_AUTH_WORKER_DISABLED_FLAG = "AMAZON_AUTH_WORKER_DISABLED"
export const KEEPA_VERIFY_CLAIM_FLAG = "KEEPA_VERIFY_CLAIM_ENABLED"
export const KEEPA_VERIFY_ENQUEUE_FLAG = "KEEPA_VERIFY_ENQUEUE_ENABLED"

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw.trim() === "") return defaultValue
  return raw.trim().toLowerCase() === "true"
}

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export type AmazonScanConfig = {
  plannerEnabled: boolean
  remoteProtocolEnabled: boolean
  remoteWorkersEnabled: boolean
  mutationConfirmRead: boolean
  applyProcessorEnabled: boolean
  applyEnabled: boolean
  plannerBatchSize: number
  plannerMaxOutstanding: number
  keepaRoutineActionsDisabled: boolean
  soldRecheckHours: number
  otherRecheckHours: number
  tickIntervalMs: number
  leaseSeconds: number
  maxAttempts: number
  maxPendingRoutine: number
  maxPendingConfirm: number
  applyConcurrency: number
  marketplace: string
  deliveryZip: string
  sessionClass: string
  confirmMaxAgeMs: number
  keepaVerifyClaimEnabled: boolean
  keepaVerifyEnqueueEnabled: boolean
  keepaVerifyPrimaryMaxActive: number
}

export function loadAmazonScanConfig(): AmazonScanConfig {
  return {
    plannerEnabled: envFlag(AMAZON_BROWSER_PLANNER_FLAG, false),
    remoteProtocolEnabled: envFlag(AMAZON_SCAN_REMOTE_PROTOCOL_FLAG, false),
    remoteWorkersEnabled: envFlag(AMAZON_SCAN_REMOTE_WORKERS_FLAG, false),
    mutationConfirmRead: envFlag(AMAZON_MUTATION_CONFIRM_READ_FLAG, false),
    applyProcessorEnabled: envFlag(AMAZON_SCAN_APPLY_PROCESSOR_FLAG, false),
    applyEnabled: envFlag(AMAZON_SCAN_APPLY_FLAG, false),
    plannerBatchSize: Math.min(50, envInt(AMAZON_BROWSER_PLANNER_BATCH_FLAG, 50)),
    plannerMaxOutstanding: envInt(AMAZON_BROWSER_PLANNER_MAX_OUTSTANDING_FLAG, 50),
    keepaRoutineActionsDisabled: envFlag(AMAZON_KEEPA_ROUTINE_ACTIONS_FLAG, false),
    soldRecheckHours: envInt("AMAZON_SCAN_SOLD_RECHECK_HOURS", 12),
    otherRecheckHours: envInt("AMAZON_SCAN_OTHER_RECHECK_HOURS", 24),
    tickIntervalMs: envInt("AMAZON_SCAN_TICK_INTERVAL_MS", 60_000),
    leaseSeconds: envInt("AMAZON_SCAN_LEASE_SECONDS", 180),
    maxAttempts: envInt("AMAZON_SCAN_MAX_ATTEMPTS", 3),
    maxPendingRoutine: envInt("AMAZON_SCAN_MAX_PENDING", 400),
    maxPendingConfirm: envInt("AMAZON_SCAN_CONFIRM_MAX_PENDING", 80),
    applyConcurrency: Math.min(4, envInt("AMAZON_SCAN_APPLY_CONCURRENCY", 2)),
    marketplace: (process.env.AMAZON_SCAN_MARKETPLACE ?? "US").trim().toUpperCase() || "US",
    deliveryZip: process.env.AMAZON_PUBLIC_US_ZIP?.trim() || process.env.AMAZON_SCAN_DELIVERY_ZIP?.trim() || "10001",
    sessionClass: "PUBLIC_UNAUTH",
    confirmMaxAgeMs: (() => {
      const n = parseInt(process.env.AMAZON_SCAN_CONFIRM_MAX_AGE_MS ?? "600000", 10)
      if (!Number.isFinite(n) || n < 60_000) return 600_000
      return Math.min(n, 3_600_000)
    })(),
    keepaVerifyClaimEnabled: envFlag(KEEPA_VERIFY_CLAIM_FLAG, false),
    keepaVerifyEnqueueEnabled: envFlag(KEEPA_VERIFY_ENQUEUE_FLAG, false),
    keepaVerifyPrimaryMaxActive: Math.min(50, envInt("KEEPA_VERIFY_PRIMARY_ACTIVE_CAP", 50)),
  }
}

export function amazonScanRecheckHours(priority: number, cfg = loadAmazonScanConfig()): number {
  return priority === 0 ? cfg.soldRecheckHours : cfg.otherRecheckHours
}

/** ROUTINE enqueue slots this tick. CONFIRM jobs are not counted in activeRoutineCount. */
export function plannerRoutineEnqueueBudget(input: {
  activeRoutineCount: number
  batchSize?: number
  maxOutstanding?: number
}): number {
  const cfg = loadAmazonScanConfig()
  const batchSize = input.batchSize ?? cfg.plannerBatchSize
  const maxOutstanding = input.maxOutstanding ?? cfg.plannerMaxOutstanding
  const active = Number.isFinite(input.activeRoutineCount) ? Math.max(0, Math.floor(input.activeRoutineCount)) : 0
  return Math.min(batchSize, Math.max(0, maxOutstanding - active))
}
