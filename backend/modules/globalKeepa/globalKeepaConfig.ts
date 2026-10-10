/**
 * Global Keepa foundation + planner config.
 * Not imported by Stock Guard, eBay action, or existing KeepaClient paths.
 */
export const GLOBAL_KEEPA_MONITOR_FLAG = "GLOBAL_KEEPA_MONITOR_ENABLED"
export const GLOBAL_KEEPA_ACTIONS_FLAG = "GLOBAL_KEEPA_ACTIONS_ENABLED"
export const GLOBAL_KEEPA_PLANNER_FLAG = "GLOBAL_KEEPA_PLANNER_ENABLED"
export const GLOBAL_KEEPA_SHADOW_FLAG = "GLOBAL_KEEPA_SHADOW_MODE"

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw.trim() === "") return defaultValue
  return raw.trim().toLowerCase() === "true"
}

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envIntAllowZero(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === "") return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function envCapacityTarget(): number {
  const pctRaw = process.env.GLOBAL_KEEPA_CAPACITY_TARGET_PERCENT
  if (pctRaw != null && pctRaw.trim() !== "") {
    const n = parseFloat(pctRaw)
    if (Number.isFinite(n) && n > 1 && n <= 100) return n / 100
    if (Number.isFinite(n) && n > 0 && n <= 1) return n
  }
  const utilizationRaw = parseFloat(process.env.GLOBAL_KEEPA_TARGET_MAX_CAPACITY_UTILIZATION ?? "0.95")
  if (Number.isFinite(utilizationRaw) && utilizationRaw > 0 && utilizationRaw <= 1) return utilizationRaw
  return 0.95
}

export type GlobalKeepaFoundationConfig = {
  monitorEnabled: boolean
  actionsEnabled: boolean
  plannerEnabled: boolean
  shadowMode: boolean
  keepaDomain: number
  productBatchMax: number
  tokenCostPerAsin: number
  soldMinRecheckHours: number
  clickedMinRecheckHours: number
  normalMinRecheckHours: number
  hardMaxCheckAgeHours: number
  targetMaxCapacityUtilization: number
  safeUtilization: number
  tokenReserve: number
  claimLeaseSeconds: number
  maxFailureRetries: number
  tickIntervalMs: number
  plannerTimeoutMs: number
}

export function loadGlobalKeepaFoundationConfig(): GlobalKeepaFoundationConfig {
  const domain = parseInt(process.env.KEEPA_DOMAIN ?? "1", 10)
  const target = envCapacityTarget()
  const safeUtil = parseFloat(process.env.GLOBAL_KEEPA_SAFE_UTILIZATION ?? "")
  const normalMinRecheckHours = envInt("GLOBAL_KEEPA_NORMAL_MIN_RECHECK_HOURS", 36)
  // A hard cap shorter than the normal class silently breaks the 36-hour
  // contract. Keep the safety cap, but never let it pre-empt that cadence.
  const hardMaxCheckAgeHours = Math.max(
    envInt("GLOBAL_KEEPA_HARD_MAX_CHECK_AGE_HOURS", normalMinRecheckHours),
    normalMinRecheckHours
  )
  return {
    monitorEnabled: envFlag(GLOBAL_KEEPA_MONITOR_FLAG, false),
    actionsEnabled: envFlag(GLOBAL_KEEPA_ACTIONS_FLAG, false),
    plannerEnabled: envFlag(GLOBAL_KEEPA_PLANNER_FLAG, false),
    shadowMode: envFlag(GLOBAL_KEEPA_SHADOW_FLAG, true),
    keepaDomain: Number.isFinite(domain) && domain > 0 ? domain : 1,
    productBatchMax: Math.min(100, envInt("GLOBAL_KEEPA_PRODUCT_BATCH_MAX", 100)),
    tokenCostPerAsin: envInt("GLOBAL_KEEPA_TOKEN_COST_PER_ASIN", 1),
    soldMinRecheckHours: envInt("GLOBAL_KEEPA_SOLD_MIN_RECHECK_HOURS", 12),
    clickedMinRecheckHours: envInt("GLOBAL_KEEPA_CLICKED_MIN_RECHECK_HOURS", 24),
    normalMinRecheckHours,
    hardMaxCheckAgeHours,
    targetMaxCapacityUtilization: target,
    safeUtilization:
      Number.isFinite(safeUtil) && safeUtil > 0 && safeUtil <= 1 ? safeUtil : target,
    tokenReserve: envIntAllowZero("GLOBAL_KEEPA_TOKEN_RESERVE", 100),
    claimLeaseSeconds: envInt("GLOBAL_KEEPA_CLAIM_LEASE_SECONDS", 90),
    maxFailureRetries: envInt("GLOBAL_KEEPA_MAX_FAILURE_RETRIES", 3),
    tickIntervalMs: envInt("GLOBAL_KEEPA_TICK_INTERVAL_MS", 60_000),
    plannerTimeoutMs: envInt("GLOBAL_KEEPA_TIMEOUT_MS", 25_000),
  }
}

export function globalKeepaLiveKeepaAllowed(cfg = loadGlobalKeepaFoundationConfig()): boolean {
  return cfg.plannerEnabled && cfg.monitorEnabled
}
