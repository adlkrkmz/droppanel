import type { KeepaVerificationSignal } from "../amazonVerification/amazonVerificationTypes"
import type { KeepaRadarProductFields } from "./globalKeepaTypes"

export type KeepaSignalClass =
  | "AMAZON_PRIMARY"
  | "FBA_NEW_FALLBACK"
  | "VERIFY_PRICE"
  | "PRICE_MISSING_VERIFY"

export type KeepaBaseCandidate = {
  candidate: number | null
  signalClass: KeepaSignalClass
}

/** Keepa -1 is unknown/null, never coerced to 0. */
export function buildKeepaBaseCandidate(input: {
  amazonPriceUsd: number | null
  newPriceUsd: number | null
  newFbaCount: number | null
}): KeepaBaseCandidate {
  if (input.amazonPriceUsd != null && input.amazonPriceUsd > 0) {
    return { candidate: input.amazonPriceUsd, signalClass: "AMAZON_PRIMARY" }
  }
  if (input.newPriceUsd != null && input.newPriceUsd > 0 && input.newFbaCount != null && input.newFbaCount > 0) {
    return { candidate: input.newPriceUsd, signalClass: "FBA_NEW_FALLBACK" }
  }
  if (input.newPriceUsd != null && input.newPriceUsd > 0) {
    return { candidate: null, signalClass: "VERIFY_PRICE" }
  }
  return { candidate: null, signalClass: "PRICE_MISSING_VERIFY" }
}

export function resolveTrustedBaselinePrice(input: {
  lastVerifiedPrice: number | null
  sourcePrice: number | null
  initialCapturedPrice?: number | null
  lastVerifiedAsin?: string | null
  currentSourceAsin?: string | null
  lastVerifiedDecision?: string | null
}): number | null {
  const lastAsin = String(input.lastVerifiedAsin ?? "").trim().toUpperCase()
  const currentAsin = String(input.currentSourceAsin ?? "").trim().toUpperCase()
  const sourceScoped = !lastAsin || !currentAsin || lastAsin === currentAsin
  const decision = String(input.lastVerifiedDecision ?? "").trim().toUpperCase()
  const lastVerifiedIsTrusted = decision === "" || decision === "VALID_SOURCE"
  if (
    sourceScoped &&
    lastVerifiedIsTrusted &&
    input.lastVerifiedPrice != null &&
    input.lastVerifiedPrice > 0
  ) {
    return input.lastVerifiedPrice
  }
  if (input.sourcePrice != null && input.sourcePrice > 0) return input.sourcePrice
  if (input.initialCapturedPrice != null && input.initialCapturedPrice > 0) return input.initialCapturedPrice
  return null
}

export function keepaPricesEqual(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a === b
  return Math.abs(a - b) < 0.01
}

export function fbaSignalHealthy(fbaCount: number | null): boolean {
  return fbaCount != null && fbaCount > 0
}

/**
 * High-confidence Keepa "no valid Prime/FBA/Amazon source" for qty0 only when:
 * - Amazon CSV price is absent (not AMAZON_PRIMARY)
 * - FBA count is not healthy (null/0)
 * - FBM offers are present
 *
 * If amazonPriceUsd > 0 / AMAZON_PRIMARY, Keepa must NOT finalize FBM_ONLY —
 * live Amazon Worker verification is required (see shouldVerifyFromKeepaRadar).
 * Technical failures never reach this.
 */
export function isKeepaConfirmedNoValidSource(input: {
  productReturned: boolean
  amazonPriceUsd?: number | null
  signalClass?: KeepaSignalClass | null
  newFbaCount: number | null
  newFbmCount: number | null
}): boolean {
  if (!input.productReturned) return false
  if (input.signalClass === "AMAZON_PRIMARY") return false
  if (input.amazonPriceUsd != null && input.amazonPriceUsd > 0) return false
  const fbm = input.newFbmCount
  if (fbm == null || fbm <= 0) return false
  return !fbaSignalHealthy(input.newFbaCount)
}

export type KeepaVerifyDecision =
  | { verify: false; code: "STABLE" | "CONFIRMED" | "NO_VALID_SOURCE" | "NO_PRODUCT_WAIT_RETRY" }
  | { verify: true; signal: KeepaVerificationSignal; code: string }

/**
 * Existing high-confidence Keepa price: Amazon buy-box CSV (AMAZON_PRIMARY) plus
 * healthy FBA and no mixed FBA+FBM. FBA_NEW_FALLBACK / VERIFY_PRICE / mixed / missing
 * stay verification-required. Technical failures never reach this (productReturned=false).
 */
export function isKeepaConfirmedPrice(input: {
  productReturned: boolean
  candidate: number | null
  signalClass: KeepaSignalClass
  newFbaCount: number | null
  newFbmCount: number | null
}): boolean {
  if (!input.productReturned) return false
  if (input.candidate == null || input.candidate <= 0) return false
  if (input.signalClass !== "AMAZON_PRIMARY") return false
  if (!fbaSignalHealthy(input.newFbaCount)) return false
  const fbm = input.newFbmCount
  if (fbm != null && fbm > 0) return false
  return true
}

/**
 * Tenant-aware Keepa → Amazon Worker verification / accepted-price trigger.
 * AMAZON_PRIMARY + healthy FBA (not mixed) is CONFIRMED and may become accepted source price.
 * AMAZON_PRIMARY / amazonPriceUsd > 0 with unhealthy or incomplete FBA counts must VERIFY
 * (never Keepa FBM_ONLY qty0).
 * True FBM-only (no Amazon price, FBA unhealthy, FBM > 0) may be Keepa NO_VALID_SOURCE.
 * Technical failures never become accepted or qty0.
 */
export function shouldVerifyFromKeepaRadar(input: {
  productReturned: boolean
  candidate: number | null
  signalClass: KeepaSignalClass
  amazonPriceUsd?: number | null
  newPriceUsd: number | null
  newFbaCount: number | null
  newFbmCount: number | null
  trustedBaselinePrice: number | null
  previousFbaCount: number | null
  keepaFailureCount?: number
}): KeepaVerifyDecision {
  if (!input.productReturned) {
    return { verify: true, signal: "PRODUCT_NOT_RETURNED", code: "PRODUCT_NOT_RETURNED" }
  }

  const fba = input.newFbaCount
  const fbm = input.newFbmCount
  const newPrice = input.newPriceUsd
  const amazonPrice = input.amazonPriceUsd ?? null
  const hasAmazonPrimary =
    input.signalClass === "AMAZON_PRIMARY" || (amazonPrice != null && amazonPrice > 0)

  // True FBM-only only when Amazon price / AMAZON_PRIMARY is absent.
  if (
    input.signalClass !== "PRICE_MISSING_VERIFY" &&
    isKeepaConfirmedNoValidSource({
      productReturned: true,
      amazonPriceUsd: amazonPrice,
      signalClass: input.signalClass,
      newFbaCount: fba,
      newFbmCount: fbm,
    })
  ) {
    return { verify: false, code: "NO_VALID_SOURCE" }
  }

  // Amazon CSV / AMAZON_PRIMARY present but Keepa cannot confirm FBA health → live verify.
  // Prevents false FBM_ONLY when COUNT_NEW_FBA is null while Amazon price is still present.
  if (
    hasAmazonPrimary &&
    !isKeepaConfirmedPrice({
      productReturned: true,
      candidate: input.candidate,
      signalClass: input.signalClass,
      newFbaCount: fba,
      newFbmCount: fbm,
    })
  ) {
    return { verify: true, signal: "PRICE_AMBIGUOUS", code: "AMAZON_PRIMARY_AMBIGUOUS" }
  }

  if (input.previousFbaCount != null && input.previousFbaCount > 0 && !fbaSignalHealthy(fba)) {
    return { verify: true, signal: "FBA_SIGNAL_LOST", code: "FBA_SIGNAL_LOST" }
  }

  if (input.trustedBaselinePrice != null && input.candidate == null) {
    return { verify: true, signal: "PRICE_MISSING", code: "PRICE_MISSING" }
  }

  if (
    isKeepaConfirmedPrice({
      productReturned: true,
      candidate: input.candidate,
      signalClass: input.signalClass,
      newFbaCount: fba,
      newFbmCount: fbm,
    })
  ) {
    if (
      input.trustedBaselinePrice != null &&
      keepaPricesEqual(input.candidate, input.trustedBaselinePrice)
    ) {
      return { verify: false, code: "STABLE" }
    }
    return { verify: false, code: "CONFIRMED" }
  }

  if (
    input.candidate != null &&
    input.trustedBaselinePrice != null &&
    !keepaPricesEqual(input.candidate, input.trustedBaselinePrice)
  ) {
    return { verify: true, signal: "PRICE_CHANGED", code: "PRICE_CHANGED" }
  }

  if (
    input.candidate != null &&
    input.trustedBaselinePrice != null &&
    keepaPricesEqual(input.candidate, input.trustedBaselinePrice) &&
    fbaSignalHealthy(fba)
  ) {
    return { verify: false, code: "STABLE" }
  }

  if (input.candidate != null && fbaSignalHealthy(fba) && input.trustedBaselinePrice == null) {
    return { verify: false, code: "STABLE" }
  }

  if (input.signalClass === "VERIFY_PRICE" || input.signalClass === "PRICE_MISSING_VERIFY") {
    return { verify: true, signal: "PRICE_AMBIGUOUS", code: input.signalClass }
  }

  if (!fbaSignalHealthy(fba) && newPrice != null && newPrice > 0) {
    return { verify: true, signal: "PRICE_AMBIGUOUS", code: "UNTRUSTED_NEW" }
  }

  return { verify: false, code: "STABLE" }
}

export function candidateFromRadarFields(fields: KeepaRadarProductFields): KeepaBaseCandidate {
  return buildKeepaBaseCandidate({
    amazonPriceUsd: fields.amazonPriceUsd,
    newPriceUsd: fields.newPriceUsd,
    newFbaCount: fields.newFbaCount,
  })
}

export function keepaConfirmedNoValidSourceDecision(asin: string): {
  outcome: "CONFIRMED_NO_VALID_SOURCE"
  code: "FBM_ONLY"
  acceptedPrice: null
  requestedAsin: string
  finalAsin: string
  redirected: false
  validPrimeOrFba: false
  mutationAllowed: true
} {
  const requested = String(asin ?? "").trim().toUpperCase()
  return {
    outcome: "CONFIRMED_NO_VALID_SOURCE",
    code: "FBM_ONLY",
    acceptedPrice: null,
    requestedAsin: requested,
    finalAsin: requested,
    redirected: false,
    validPrimeOrFba: false,
    mutationAllowed: true,
  }
}

export function keepaConfirmedSourceDecision(
  asin: string,
  acceptedPrice: number
): {
  outcome: "VALID_SOURCE"
  code: "KEEPA_CONFIRMED"
  acceptedPrice: number
  requestedAsin: string
  finalAsin: string
  redirected: false
  validPrimeOrFba: true
  mutationAllowed: true
} {
  const requested = String(asin ?? "").trim().toUpperCase()
  return {
    outcome: "VALID_SOURCE",
    code: "KEEPA_CONFIRMED",
    acceptedPrice,
    requestedAsin: requested,
    finalAsin: requested,
    redirected: false,
    validPrimeOrFba: true,
    mutationAllowed: true,
  }
}
