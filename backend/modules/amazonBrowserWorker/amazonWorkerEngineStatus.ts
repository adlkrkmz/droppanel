/**
 * Verification engine ownership for admin UI (read-only status; no business rules).
 * Public owns the production queue when AMAZON_PUBLIC_WORKER_OWNS_QUEUE=true.
 */
export type VerificationEngineId = "PUBLIC" | "LOGIN" | "NONE"

export function publicWorkerOwnsQueue(): boolean {
  const v = String(process.env.AMAZON_PUBLIC_WORKER_OWNS_QUEUE ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function loginWorkerClaimEnabled(): boolean {
  // When public owns the queue, login must not claim (standby).
  if (publicWorkerOwnsQueue()) return false
  const v = String(process.env.AMAZON_LOGIN_WORKER_CLAIM_ENABLED ?? "true").trim().toLowerCase()
  return !(v === "0" || v === "false" || v === "no" || v === "off")
}

/** Map vault/heartbeat account status → compact legacy label for admin UI. */
export function legacyLoginWorkerDisplayStatus(input: {
  accountStatus: string
  sessionState?: string | null
  heartbeatStatus?: string | null
  pauseReason?: string | null
}): { code: string; label: string } {
  const account = String(input.accountStatus ?? "").toUpperCase()
  const session = String(input.sessionState ?? "").toUpperCase()
  const hb = String(input.heartbeatStatus ?? "").toUpperCase()
  const pause = String(input.pauseReason ?? "")

  if (account === "CHALLENGE_REQUIRED" || session === "CHALLENGE" || hb === "CHALLENGE_REQUIRED") {
    return { code: "CAPTCHA", label: "CAPTCHA" }
  }
  if (account === "PAUSED" || hb === "PAUSED" || /standby|public.?worker.?own/i.test(pause)) {
    return { code: "STANDBY", label: "STANDBY" }
  }
  if (account === "LOGIN_REQUIRED" || session === "LOGIN_REQUIRED" || hb === "LOGIN_REQUIRED") {
    return { code: "LOGIN_REQUIRED", label: "LOGIN_REQUIRED" }
  }
  if (account === "THROTTLED" || hb === "THROTTLED") {
    return { code: "THROTTLED", label: "THROTTLED" }
  }
  if (account === "ONLINE" || hb === "ONLINE") {
    return { code: "ONLINE", label: "ONLINE" }
  }
  if (account === "READY") {
    return { code: "READY", label: "READY" }
  }
  if (account === "ERROR" || hb === "ERROR") {
    return { code: "ERROR", label: "ERROR" }
  }
  if (account === "UNCONFIGURED") {
    return { code: "UNCONFIGURED", label: "UNCONFIGURED" }
  }
  return { code: account || "UNKNOWN", label: account || "UNKNOWN" }
}

export function resolveVerificationEngineStatus(input: {
  accountStatus: string
  sessionState?: string | null
  heartbeatStatus?: string | null
  pauseReason?: string | null
  publicWorkerProcessOnline?: boolean
  /** Legacy single-worker stall flag (prefer pool summary). */
  publicWorkerStalled?: boolean
  /** Pool challenge pause (no profile rotation). */
  publicPoolChallenge?: boolean
  /** claimable=0 but RETRYABLE backoff>0 — healthy idle waiting. */
  publicPoolBackoff?: boolean
  poolHealthy?: number
  poolConfigured?: number
}): {
  activeEngine: VerificationEngineId
  verificationEngineLabel: string
  legacyLoginWorker: { code: string; label: string }
  publicWorkerOwnsQueue: boolean
  loginWorkerClaimEnabled: boolean
  publicWorkerStalled: boolean
} {
  const owns = publicWorkerOwnsQueue()
  const loginClaims = loginWorkerClaimEnabled()
  const legacy = legacyLoginWorkerDisplayStatus(input)
  const configured = Math.max(0, input.poolConfigured ?? 0)
  const healthy = Math.max(0, input.poolHealthy ?? 0)
  const poolChallenge = owns && input.publicPoolChallenge === true
  const allStalled = owns && configured > 0 && healthy === 0 && input.publicWorkerStalled === true
  const poolBackoff = owns && input.publicPoolBackoff === true && !poolChallenge && !allStalled

  let activeEngine: VerificationEngineId = "NONE"
  let verificationEngineLabel = "NONE"

  if (owns) {
    activeEngine = "PUBLIC"
    if (poolChallenge) {
      verificationEngineLabel = "PUBLIC WORKER POOL — CHALLENGE"
    } else if (allStalled) {
      verificationEngineLabel = "PUBLIC WORKER POOL STALLED"
    } else if (poolBackoff) {
      verificationEngineLabel = "PUBLIC WORKER POOL — BACKOFF BEKLİYOR"
    } else if (configured > 0 && healthy === 0) {
      verificationEngineLabel = "PUBLIC WORKER POOL — BAŞLATILIYOR"
    } else if (configured > 0 && healthy < configured) {
      verificationEngineLabel = `PUBLIC WORKER POOL — DEGRADED (${healthy}/${configured})`
    } else if (configured > 0) {
      verificationEngineLabel = `PUBLIC WORKER POOL — AKTİF (${healthy}/${configured})`
    } else if (input.publicWorkerProcessOnline === false) {
      verificationEngineLabel = "PUBLIC AMAZON WORKER — BAŞLATILIYOR"
    } else {
      verificationEngineLabel = "PUBLIC AMAZON WORKER — AKTİF"
    }
  } else if (loginClaims && !["PAUSED", "CAPTCHA", "CHALLENGE_REQUIRED"].includes(legacy.code) && legacy.code !== "CAPTCHA") {
    activeEngine = "LOGIN"
    verificationEngineLabel = "LEGACY LOGIN WORKER — AKTİF"
  } else if (!owns && (legacy.code === "CAPTCHA" || legacy.code === "STANDBY" || legacy.code === "PAUSED")) {
    activeEngine = "NONE"
    verificationEngineLabel = "NONE — LOGIN STANDBY/CAPTCHA"
  } else {
    activeEngine = "LOGIN"
    verificationEngineLabel = "LEGACY LOGIN WORKER — AKTİF"
  }

  return {
    activeEngine,
    verificationEngineLabel,
    legacyLoginWorker: legacy,
    publicWorkerOwnsQueue: owns,
    loginWorkerClaimEnabled: loginClaims,
    publicWorkerStalled: allStalled || input.publicWorkerStalled === true,
  }
}
