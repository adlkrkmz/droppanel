export type ScanClaimKind = "ROUTINE" | "CONFIRM" | "KEEPA_VERIFY_PRIMARY" | "KEEPA_VERIFY_CONFIRM"

export function resolveScanClaimKind(workerId: string): ScanClaimKind | null {
  const id = String(workerId ?? "").trim()
  if (id.startsWith("amazon-keepa-verify-primary-") && id.length > "amazon-keepa-verify-primary-".length) {
    return "KEEPA_VERIFY_PRIMARY"
  }
  if (id.startsWith("amazon-keepa-verify-confirm-") && id.length > "amazon-keepa-verify-confirm-".length) {
    return "KEEPA_VERIFY_CONFIRM"
  }
  if (id.startsWith("amazon-public-browser-worker-") && id.length > "amazon-public-browser-worker-".length) {
    return "ROUTINE"
  }
  if (id.startsWith("amazon-scan-confirm-") && id.length > "amazon-scan-confirm-".length) {
    return "CONFIRM"
  }
  return null
}

export function scanJobClaimableByWorker(workerId: string, jobKind: string): boolean {
  return resolveScanClaimKind(workerId) === jobKind
}

export function browserObservationFingerprint(input: {
  asin: string
  acceptedPrice: number | null
  isPrime: boolean | null
  isFba: boolean | null
  shipsFromAmazon: boolean | null
  purchasable: string | null
  stockStatus: string | null
  outcome: string
}): string {
  const asin = String(input.asin ?? "").trim().toUpperCase()
  const p = input.acceptedPrice != null && Number.isFinite(input.acceptedPrice) ? Math.round(input.acceptedPrice * 100) : ""
  const sellerClass =
    input.shipsFromAmazon === true || input.isFba === true ? "AMAZON_FBA" : input.isPrime === true ? "PRIME" : "OTHER"
  return [
    asin,
    String(input.outcome ?? ""),
    String(p),
    input.isPrime === true ? "1" : input.isPrime === false ? "0" : "u",
    input.isFba === true ? "1" : input.isFba === false ? "0" : "u",
    input.shipsFromAmazon === true ? "1" : input.shipsFromAmazon === false ? "0" : "u",
    String(input.purchasable ?? "u"),
    String(input.stockStatus ?? "u"),
    sellerClass,
  ].join("|")
}

export function fingerprint(decision: { outcome: string; code: string; acceptedPrice: number | null; requestedAsin?: string; validPrimeOrFba?: boolean }): string {
  return browserObservationFingerprint({
    asin: decision.requestedAsin ?? "",
    acceptedPrice: decision.acceptedPrice,
    isPrime: decision.validPrimeOrFba ?? null,
    isFba: decision.validPrimeOrFba ?? null,
    shipsFromAmazon: decision.validPrimeOrFba ?? null,
    purchasable: null,
    stockStatus: null,
    outcome: decision.outcome,
  })
}

export function amazonScanConfirmMaxAgeMs(raw = process.env.AMAZON_SCAN_CONFIRM_MAX_AGE_MS): number {
  const n = parseInt(raw ?? "600000", 10)
  if (!Number.isFinite(n) || n < 60_000) return 600_000
  return Math.min(n, 3_600_000)
}

export function isScanObservationIncomplete(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload) return true
  const meta =
    payload.metadata && typeof payload.metadata === "object" ? (payload.metadata as Record<string, unknown>) : {}
  if (payload.captcha === true || payload.timeout === true || payload.uncertain === true) return true
  if (String(meta.publicStatus ?? "") === "AMAZON_INCOMPLETE") return true
  return false
}

export function evaluateConfirmFreshness(input: {
  nowMs: number
  parentObservedAtMs: number | null
  confirmObservedAtMs: number | null
  maxAgeMs: number
}): "CONFIRM_PARENT_STALE" | "CONFIRM_RESULT_STALE" | null {
  if (input.parentObservedAtMs == null || input.nowMs - input.parentObservedAtMs > input.maxAgeMs) {
    return "CONFIRM_PARENT_STALE"
  }
  if (input.confirmObservedAtMs == null || input.nowMs - input.confirmObservedAtMs > input.maxAgeMs) {
    return "CONFIRM_RESULT_STALE"
  }
  return null
}

export function evaluateScanApplyMutationGate(input: {
  kind: ScanClaimKind
  incomplete: boolean
  decisionOutcome: string
  fingerprintMatch: boolean
  hasParent: boolean
  parentObservedAtMs: number | null
  resultObservedAtMs: number | null
  nowMs: number
  maxAgeMs: number
  mutationCandidate: boolean
}): { allowEbayMutation: boolean; persistObservationOnly: boolean; skip: string | null } {
  if (input.incomplete) {
    return { allowEbayMutation: false, persistObservationOnly: false, skip: "INCOMPLETE_NO_MUTATION" }
  }
  if (input.decisionOutcome === "UNKNOWN") {
    return { allowEbayMutation: false, persistObservationOnly: false, skip: "UNKNOWN_NO_MUTATION" }
  }
  if (input.kind === "KEEPA_VERIFY_PRIMARY") {
    return { allowEbayMutation: false, persistObservationOnly: false, skip: "KEEPA_VERIFY_PRIMARY_NO_MUTATION" }
  }
  if (input.kind === "ROUTINE") {
    if (input.mutationCandidate) {
      return { allowEbayMutation: false, persistObservationOnly: false, skip: "CONFIRM_QUEUED" }
    }
    return { allowEbayMutation: false, persistObservationOnly: true, skip: null }
  }
  if (!input.hasParent) {
    return { allowEbayMutation: false, persistObservationOnly: false, skip: "PARENT_MISSING" }
  }
  const stale = evaluateConfirmFreshness({
    nowMs: input.nowMs,
    parentObservedAtMs: input.parentObservedAtMs,
    confirmObservedAtMs: input.resultObservedAtMs,
    maxAgeMs: input.maxAgeMs,
  })
  if (stale) {
    return { allowEbayMutation: false, persistObservationOnly: false, skip: stale }
  }
  if (!input.fingerprintMatch) {
    return { allowEbayMutation: false, persistObservationOnly: false, skip: "CONFIRM_CONFLICT" }
  }
  if (!input.mutationCandidate) {
    return { allowEbayMutation: false, persistObservationOnly: true, skip: null }
  }
  return { allowEbayMutation: true, persistObservationOnly: false, skip: null }
}
