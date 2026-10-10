export type VerificationTaskStatus =
  | "PENDING"
  | "CLAIMED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "WAITING_FOR_WORKER"
  | "RETRYABLE"
  | "CANCELLED"

export type VerificationReason =
  | "PRICE_AMBIGUOUS"
  | "KEEPA_PRODUCT_UNRESOLVED"
  | "KEEPA_UNRESOLVED"
  | "ADMIN_TEST"
  | "PRICE_CHANGED"
  | "PRICE_MISSING"
  | "FBA_SIGNAL_LOST"
  | "FBM_ONLY"
  | "SOURCE_STALE"
  | "DESKTOP_AGENT"

export type KeepaVerificationSignal =
  | "PRICE_AMBIGUOUS"
  | "PRODUCT_NOT_RETURNED"
  | "CHECK_FAILED"
  | "FBA_MISSING"
  | "FBA_PRESENT"
  | "PRICE_CHANGED"
  | "PRICE_UNCHANGED"
  | "PRICE_AMBIGUOUS_TEST"
  | "PRICE_MISSING"
  | "FBA_SIGNAL_LOST"
  | "FBM_ONLY"
  | "SOURCE_STALE"

export type PurchasableTriState = "TRUE" | "FALSE" | "UNKNOWN"

export type VerificationFailureCode =
  | "AMAZON_SESSION_UNAVAILABLE"
  | "CAPTCHA"
  | "LOGIN_REQUIRED"
  | "EXTRACTOR_FAILED"
  | "PAGE_LOAD_FAILED"
  | "ASIN_MISMATCH"
  | "LEASE_EXPIRED"
  | "WRONG_WORKER"
  | "MAX_ATTEMPTS_EXCEEDED"

export type ShouldCreateDecision = {
  create: boolean
  reason: VerificationReason | null
  code: string
}

export type KeepaBridgeInput = {
  signal: KeepaVerificationSignal
  keepaFailureCount: number
  dispatchEnabled: boolean
  verificationEnabled: boolean
  keepaOutage: boolean
  pendingTaskCount: number
  fallbackTasksLastMinute: number
  keepaMaxRetries: number
  maxPending: number
  maxPerMinute: number
  source: "planner" | "admin_test"
}
