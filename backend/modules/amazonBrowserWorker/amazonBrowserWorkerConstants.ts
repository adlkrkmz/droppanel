import path from "path"

export const AMAZON_BROWSER_WORKER_ID = "amazon-browser-worker"
export const AMAZON_AUTH_PRICE_FALLBACK_WORKER_ID = "amazon-browser-auth-price-fallback-worker"
/** Separate heartbeat / admin state row — does not share legacy login heartbeat. */
export const AMAZON_PUBLIC_BROWSER_WORKER_ID = "amazon-public-browser-worker"
export const AMAZON_BROWSER_TASK_VERIFY_SOURCE = "VERIFY_SOURCE"
export const AMAZON_WORKER_CLAIMED_BY_SOURCE = "SERVER_BROWSER"
export const EXTENSION_CLAIMED_BY_SOURCE = "EXTENSION"

export const AMAZON_ACCOUNT_STATUSES = [
  "UNCONFIGURED",
  "READY",
  "ONLINE",
  "LOGIN_REQUIRED",
  "CHALLENGE_REQUIRED",
  "THROTTLED",
  "PAUSED",
  "ERROR",
] as const

export type AmazonAccountStatus = (typeof AMAZON_ACCOUNT_STATUSES)[number]

export function amazonBrowserConcurrency(): number {
  const n = parseInt(process.env.AMAZON_BROWSER_CONCURRENCY ?? "1", 10)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1) : 1
}

export function amazonBrowserPaceMs(): number {
  const n = parseInt(process.env.AMAZON_BROWSER_PACE_MS ?? "5000", 10)
  return Number.isFinite(n) && n >= 1000 ? n : 5000
}

export function amazonBrowserHeartbeatMs(): number {
  const n = parseInt(process.env.AMAZON_BROWSER_HEARTBEAT_MS ?? "15000", 10)
  return Number.isFinite(n) && n >= 5000 ? n : 15000
}

/** Outer bound so a wedged Playwright goto cannot stall the claim loop forever. */
export function amazonPublicObserveHardTimeoutMs(): number {
  const n = parseInt(process.env.AMAZON_PUBLIC_OBSERVE_HARD_TIMEOUT_MS ?? "75000", 10)
  return Number.isFinite(n) && n >= 30000 ? Math.min(n, 120000) : 75000
}

/** Admin STALLED when claimable work exists but public progress is older than this. */
export function amazonPublicStallMs(): number {
  const n = parseInt(process.env.AMAZON_PUBLIC_STALL_MS ?? String(12 * 60 * 1000), 10)
  return Number.isFinite(n) && n >= 5 * 60 * 1000 ? Math.min(n, 30 * 60 * 1000) : 12 * 60 * 1000
}

export function amazonBrowserCircuitFailures(): number {
  const n = parseInt(process.env.AMAZON_BROWSER_CIRCUIT_FAILURES ?? "3", 10)
  return Number.isFinite(n) && n > 0 ? n : 3
}

export function amazonBrowserCircuitCooldownMs(): number {
  const n = parseInt(process.env.AMAZON_BROWSER_CIRCUIT_COOLDOWN_MS ?? "900000", 10)
  return Number.isFinite(n) && n >= 30_000 ? n : 900_000
}

export function amazonBrowserProfileDir(): string {
  const fromEnv = process.env.AMAZON_BROWSER_PROFILE_DIR?.trim()
  if (fromEnv) return fromEnv
  return path.join(process.cwd(), "var", "amazon-browser-profile")
}

/** Max wall-clock for one VERIFY_SOURCE attempt (goto 45s + ready + extract + margin). */
export function amazonBrowserTaskAttemptWallclockMs(): number {
  const n = parseInt(process.env.AMAZON_BROWSER_TASK_ATTEMPT_MS ?? "120000", 10)
  return Number.isFinite(n) && n >= 60_000 ? n : 120_000
}

/** Hard deadline for failVerificationTask / DB finalization. */
export function amazonBrowserFinalizationTimeoutMs(): number {
  const n = parseInt(process.env.AMAZON_BROWSER_FINALIZATION_MS ?? "8000", 10)
  return Number.isFinite(n) && n >= 2000 ? n : 8000
}

/** Periodic expired-RUNNING recovery interval. */
export function amazonBrowserExpiredRunningWatchdogMs(): number {
  const n = parseInt(process.env.AMAZON_BROWSER_EXPIRED_RUNNING_MS ?? "45000", 10)
  return Number.isFinite(n) && n >= 15_000 ? n : 45_000
}

export function amazonBrowserGotoTimeoutMs(): number {
  return 45_000
}
