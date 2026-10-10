export const GLOBAL_EXTENSION_VERIFICATION_FLAG = "GLOBAL_EXTENSION_VERIFICATION_ENABLED"
/**
 * Legacy env name. Gates Keepa → amazon_price_verification_tasks enqueue (server Amazon Worker).
 * Does NOT grant Chrome extension claim ownership when GLOBAL_SERVER_BROWSER_PRIMARY=true
 * and GLOBAL_EXTENSION_VERIFICATION_FALLBACK=false (extension claim returns NO_WORK).
 */
export const GLOBAL_KEEPA_TO_EXTENSION_DISPATCH_FLAG = "GLOBAL_KEEPA_TO_EXTENSION_DISPATCH_ENABLED"
export const GLOBAL_EXTENSION_APPLY_SOURCE_PRICE_FLAG = "GLOBAL_EXTENSION_APPLY_SOURCE_PRICE"
export const VERIFIED_STOCK_ACTIONS_FLAG = "VERIFIED_STOCK_ACTIONS_ENABLED"
export const ACTIVITY_CENTER_FLAG = "ACTIVITY_CENTER_ENABLED"
export const GLOBAL_SERVER_BROWSER_VERIFICATION_FLAG = "GLOBAL_SERVER_BROWSER_VERIFICATION_ENABLED"
export const GLOBAL_SERVER_BROWSER_PRIMARY_FLAG = "GLOBAL_SERVER_BROWSER_PRIMARY"
export const GLOBAL_EXTENSION_VERIFICATION_FALLBACK_FLAG = "GLOBAL_EXTENSION_VERIFICATION_FALLBACK"

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw.trim() === "") return defaultValue
  return raw.trim().toLowerCase() === "true"
}

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envFloat(name: string, fallback: number): number {
  const n = parseFloat(process.env[name] ?? "")
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback
}

export type AmazonVerificationConfig = {
  verificationEnabled: boolean
  keepaDispatchEnabled: boolean
  applySourcePrice: boolean
  verifiedStockActionsEnabled: boolean
  activityCenterEnabled: boolean
  serverBrowserEnabled: boolean
  serverBrowserPrimary: boolean
  extensionFallbackEnabled: boolean
  heartbeatIntervalSeconds: number
  workerOfflineAfterSeconds: number
  leaseSeconds: number
  maxConcurrentTasksPerWorker: number
  maxAttempts: number
  keepaMaxRetries: number
  keepaFallbackMaxTasksPerMinute: number
  keepaFallbackMaxPendingTasks: number
  keepaOutageWindowMinutes: number
  keepaOutageFailureRate: number
  testEnqueueMaxAsins: number
}

export function loadAmazonVerificationConfig(): AmazonVerificationConfig {
  return {
    verificationEnabled: envFlag(GLOBAL_EXTENSION_VERIFICATION_FLAG, false),
    keepaDispatchEnabled: envFlag(GLOBAL_KEEPA_TO_EXTENSION_DISPATCH_FLAG, false),
    applySourcePrice: envFlag(GLOBAL_EXTENSION_APPLY_SOURCE_PRICE_FLAG, false),
    verifiedStockActionsEnabled: envFlag(VERIFIED_STOCK_ACTIONS_FLAG, false),
    activityCenterEnabled: envFlag(ACTIVITY_CENTER_FLAG, false),
    serverBrowserEnabled: envFlag(GLOBAL_SERVER_BROWSER_VERIFICATION_FLAG, true),
    serverBrowserPrimary: envFlag(GLOBAL_SERVER_BROWSER_PRIMARY_FLAG, true),
    extensionFallbackEnabled: envFlag(GLOBAL_EXTENSION_VERIFICATION_FALLBACK_FLAG, false),
    heartbeatIntervalSeconds: envInt("EXTENSION_HEARTBEAT_INTERVAL_SECONDS", 30),
    workerOfflineAfterSeconds: envInt("EXTENSION_WORKER_OFFLINE_AFTER_SECONDS", 90),
    leaseSeconds: envInt("AMAZON_VERIFICATION_LEASE_SECONDS", 120),
    maxConcurrentTasksPerWorker: envInt("MAX_CONCURRENT_VERIFICATION_TASKS_PER_WORKER", 1),
    maxAttempts: envInt("AMAZON_VERIFICATION_MAX_ATTEMPTS", 3),
    keepaMaxRetries: envInt("AMAZON_VERIFICATION_KEEPA_MAX_RETRIES", 3),
    keepaFallbackMaxTasksPerMinute: envInt("KEEPA_FALLBACK_MAX_TASKS_PER_MINUTE", 20),
    keepaFallbackMaxPendingTasks: envInt("KEEPA_FALLBACK_MAX_PENDING_TASKS", 400),
    keepaOutageWindowMinutes: envInt("KEEPA_OUTAGE_WINDOW_MINUTES", 5),
    keepaOutageFailureRate: envFloat("KEEPA_OUTAGE_FAILURE_RATE", 0.5),
    testEnqueueMaxAsins: envInt("AMAZON_VERIFICATION_TEST_MAX_ASINS", 10),
  }
}
