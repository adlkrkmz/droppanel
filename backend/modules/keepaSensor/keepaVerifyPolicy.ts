import { isScanObservationIncomplete } from "../amazonScan/amazonScanApplyPolicy"

export type BrowserOfferFingerprint = {
  displayedPrice: number | null
  isPrime: boolean | null
  isFba: boolean | null
  stockStatus: string | null
  offerPageHealthy: boolean
  publicStatus: string
  captcha: boolean
  timeout: boolean
}

export function browserOfferFingerprint(payload: Record<string, unknown> | null | undefined): BrowserOfferFingerprint {
  const meta = payload?.metadata && typeof payload.metadata === "object" ? (payload.metadata as Record<string, unknown>) : {}
  const priceRaw = payload?.displayedPrice
  const price = typeof priceRaw === "number" ? priceRaw : typeof priceRaw === "string" ? Number(priceRaw) : null
  return {
    displayedPrice: price != null && Number.isFinite(price) ? Math.round(price * 100) / 100 : null,
    isPrime: typeof payload?.isPrime === "boolean" ? payload.isPrime : null,
    isFba: typeof payload?.isFba === "boolean" ? payload.isFba : null,
    stockStatus: typeof payload?.stockStatus === "string" ? payload.stockStatus : null,
    offerPageHealthy: meta.offerPageHealthy === true,
    publicStatus: String(meta.publicStatus ?? ""),
    captcha: payload?.captcha === true,
    timeout: payload?.timeout === true,
  }
}

export function fingerprintsMatch(a: BrowserOfferFingerprint, b: BrowserOfferFingerprint): boolean {
  return (
    a.displayedPrice === b.displayedPrice &&
    a.isPrime === b.isPrime &&
    a.isFba === b.isFba &&
    a.stockStatus === b.stockStatus &&
    a.offerPageHealthy === true &&
    b.offerPageHealthy === true
  )
}

export function evaluateKeepaDualBrowserGate(input: {
  primaryPayload: Record<string, unknown> | null
  confirmPayload: Record<string, unknown> | null
  primaryObservedAtMs: number | null
  confirmObservedAtMs: number | null
  nowMs: number
  minGapMs?: number
  maxAgeMs?: number
  keepaBuyBoxUsd?: number | null
}): {
  allowEbayMutation: boolean
  decision: "INCOMPLETE" | "UNKNOWN" | "CONFLICT" | "NO_BUSINESS_CHANGE" | "MATCHED"
  skip: string | null
} {
  const minGap = input.minGapMs ?? 30_000
  const maxAge = input.maxAgeMs ?? 600_000
  if (isScanObservationIncomplete(input.primaryPayload) || isScanObservationIncomplete(input.confirmPayload)) {
    return { allowEbayMutation: false, decision: "INCOMPLETE", skip: "INCOMPLETE_NO_MUTATION" }
  }
  const p = browserOfferFingerprint(input.primaryPayload)
  const c = browserOfferFingerprint(input.confirmPayload)
  if (!p.offerPageHealthy || !c.offerPageHealthy || p.publicStatus === "AMAZON_INCOMPLETE" || c.publicStatus === "AMAZON_INCOMPLETE") {
    return { allowEbayMutation: false, decision: "INCOMPLETE", skip: "INCOMPLETE_NO_MUTATION" }
  }
  if (p.captcha || c.captcha || p.timeout || c.timeout) {
    return { allowEbayMutation: false, decision: "INCOMPLETE", skip: "INCOMPLETE_NO_MUTATION" }
  }
  if (input.primaryObservedAtMs == null || input.confirmObservedAtMs == null) {
    return { allowEbayMutation: false, decision: "UNKNOWN", skip: "UNKNOWN_NO_MUTATION" }
  }
  if (input.confirmObservedAtMs - input.primaryObservedAtMs < minGap) {
    return { allowEbayMutation: false, decision: "CONFLICT", skip: "CONFIRM_TOO_SOON" }
  }
  if (input.nowMs - input.confirmObservedAtMs > maxAge || input.nowMs - input.primaryObservedAtMs > maxAge) {
    return { allowEbayMutation: false, decision: "UNKNOWN", skip: "STALE_NO_MUTATION" }
  }
  if (!fingerprintsMatch(p, c)) {
    return { allowEbayMutation: false, decision: "CONFLICT", skip: "CONFIRM_CONFLICT" }
  }
  if (input.keepaBuyBoxUsd != null && p.displayedPrice != null && p.displayedPrice === input.keepaBuyBoxUsd) {
    return { allowEbayMutation: false, decision: "NO_BUSINESS_CHANGE", skip: "NO_BUSINESS_CHANGE" }
  }
  return { allowEbayMutation: true, decision: "MATCHED", skip: null }
}
