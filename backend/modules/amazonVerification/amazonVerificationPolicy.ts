import type { KeepaBridgeInput, ShouldCreateDecision, VerificationReason } from "./amazonVerificationTypes"

export function isKeepaOutage(input: {
  checks: number
  failedChecks: number
  failureRateThreshold: number
  minChecks?: number
}): boolean {
  const min = input.minChecks ?? 8
  if (input.checks < min) return false
  if (input.checks <= 0) return false
  return input.failedChecks / input.checks >= input.failureRateThreshold
}

export function keepaRetryExhausted(failureCount: number, maxRetries: number): boolean {
  return Math.max(0, failureCount) >= Math.max(1, maxRetries)
}

export function verificationRetryDelayMinutes(attemptCount: number): number {
  const n = Math.max(1, Math.floor(attemptCount))
  if (n <= 1) return 5
  if (n === 2) return 15
  return 30
}

export function nextVerificationRetryAt(input: { now: Date; attemptCount: number }): Date {
  return new Date(input.now.getTime() + verificationRetryDelayMinutes(input.attemptCount) * 60_000)
}

export function workerIsOnline(input: {
  lastHeartbeatAt: Date | null
  now: Date
  offlineAfterSeconds: number
}): boolean {
  if (!input.lastHeartbeatAt) return false
  const age = (input.now.getTime() - input.lastHeartbeatAt.getTime()) / 1000
  return age <= input.offlineAfterSeconds
}

/**
 * Backend-only decision. Extension never decides whether a task exists.
 * Keepa technical failures do not flood the verification queue.
 */
export function shouldCreatePriceVerificationTask(input: KeepaBridgeInput): ShouldCreateDecision {
  if (input.source === "admin_test") {
    return { create: true, reason: "ADMIN_TEST", code: "ADMIN_TEST" }
  }

  if (!input.verificationEnabled || !input.dispatchEnabled) {
    return { create: false, reason: null, code: "DISPATCH_DISABLED" }
  }

  if (input.pendingTaskCount >= input.maxPending) {
    return { create: false, reason: null, code: "PENDING_BACKPRESSURE" }
  }
  if (input.fallbackTasksLastMinute >= input.maxPerMinute) {
    return { create: false, reason: null, code: "RATE_BACKPRESSURE" }
  }

  if (input.signal === "PRICE_AMBIGUOUS" || input.signal === "PRICE_AMBIGUOUS_TEST") {
    return { create: true, reason: "PRICE_AMBIGUOUS", code: "PRICE_AMBIGUOUS" }
  }

  if (input.signal === "PRICE_CHANGED") {
    return { create: true, reason: "PRICE_CHANGED", code: "PRICE_CHANGED" }
  }
  if (input.signal === "PRICE_MISSING") {
    return { create: true, reason: "PRICE_MISSING", code: "PRICE_MISSING" }
  }
  if (input.signal === "FBA_SIGNAL_LOST") {
    return { create: true, reason: "FBA_SIGNAL_LOST", code: "FBA_SIGNAL_LOST" }
  }
  if (input.signal === "FBM_ONLY") {
    return { create: true, reason: "FBM_ONLY", code: "FBM_ONLY" }
  }
  if (input.signal === "SOURCE_STALE") {
    return { create: true, reason: "SOURCE_STALE", code: "SOURCE_STALE" }
  }

  if (input.signal === "FBA_MISSING" || input.signal === "FBA_PRESENT" || input.signal === "PRICE_UNCHANGED") {
    return { create: false, reason: null, code: "SIGNAL_NOT_VERIFICATION" }
  }

  if (input.signal === "CHECK_FAILED" || input.signal === "PRODUCT_NOT_RETURNED") {
    if (!keepaRetryExhausted(input.keepaFailureCount, input.keepaMaxRetries)) {
      return { create: false, reason: null, code: "KEEPA_RETRY_PENDING" }
    }
    if (input.keepaOutage) {
      return { create: false, reason: null, code: "KEEPA_OUTAGE_CIRCUIT" }
    }
    const reason: VerificationReason =
      input.signal === "PRODUCT_NOT_RETURNED" ? "KEEPA_PRODUCT_UNRESOLVED" : "KEEPA_UNRESOLVED"
    return { create: true, reason, code: reason }
  }

  return { create: false, reason: null, code: "UNKNOWN_SIGNAL" }
}

export function claimAllowedForUser(input: {
  taskWorkspaceId: string
  taskPreferredUserId: string
  workerWorkspaceId: string
  workerUserId: string
}): boolean {
  return (
    input.taskWorkspaceId === input.workerWorkspaceId &&
    input.taskPreferredUserId === input.workerUserId
  )
}
