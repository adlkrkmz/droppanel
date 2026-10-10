import type { PurchasableTriState } from "./amazonVerificationTypes"

export type VerifiedSourceOutcome =
  | "UNKNOWN"
  | "VALID_SOURCE"
  | "CONFIRMED_NO_VALID_SOURCE"
  | "SOURCE_ASIN_REDIRECTED"

export type VerifiedSourceDecision = {
  outcome: VerifiedSourceOutcome
  code: string
  acceptedPrice: number | null
  requestedAsin: string
  finalAsin: string | null
  redirected: boolean
  validPrimeOrFba: boolean
  mutationAllowed: boolean
}

function asAsin(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : ""
  return /^[A-Z0-9]{10}$/.test(s) ? s : null
}

const OUT_OF_STOCK_TEXT_RE =
  /currently unavailable|temporarily out of stock|\bout of stock\b|we don't know when or if this item will be back/

/**
 * Destructive OOS requires explicit availability evidence.
 * purchasable=FALSE or stockStatus=OUT_OF_STOCK alone is NOT enough
 * (incomplete buybox / client OUT_OF_STOCK_OBSERVED must stay non-destructive).
 */
export function isConfirmedOutOfStockSignal(input: {
  purchasable?: PurchasableTriState | null
  stockStatus?: string | null
  availabilityText?: string | null
}): boolean {
  const text = `${input.availabilityText ?? ""}`.toLowerCase()
  return OUT_OF_STOCK_TEXT_RE.test(text)
}

function isConfirmedInStockSignal(input: {
  purchasable?: PurchasableTriState | null
  stockStatus?: string | null
  availabilityText?: string | null
}): boolean {
  const stock = String(input.stockStatus ?? "").trim().toUpperCase()
  if (stock === "IN_STOCK" || stock === "LIMITED_STOCK") return true
  if (input.purchasable === "TRUE") return true
  const text = `${input.availabilityText ?? ""}`.toLowerCase()
  return /\bin\s+stock\b/.test(text) && !OUT_OF_STOCK_TEXT_RE.test(text)
}

function conditionBucket(raw: unknown): "NEW" | "USED_OR_RESALE" | "UNKNOWN" {
  const s = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_")
  if (!s || s === "UNKNOWN") return "UNKNOWN"
  if (
    s === "USED" ||
    s === "LIKE_NEW" ||
    s === "RESALE" ||
    s === "RENEWED" ||
    s === "REFURBISHED" ||
    /USED|LIKE_NEW|RESALE|RENEWED|REFURBISHED/.test(s)
  ) {
    return "USED_OR_RESALE"
  }
  if (s === "NEW" || /\bNEW\b/.test(s)) return "NEW"
  return "UNKNOWN"
}

/**
 * Canonical fail-fast source check:
 * PAGE → ASIN → OUT_OF_STOCK (explicit text) → PRIME → SHIPS_FROM_AMAZON → CONDITION → IN_STOCK → VALID
 *
 * Explicit non-Amazon shipper → NOT_FBA (destructive).
 * Ships-from null/unknown → SHIPPER_UNKNOWN (non-destructive).
 * USED/LIKE_NEW/RESALE primary → CONFIRMED_NO_VALID_SOURCE (after alternate selection upstream).
 * Technical inability (CAPTCHA/login/timeout/incomplete) → UNKNOWN (non-destructive).
 */
export function classifyVerifiedAmazonSource(input: {
  requestedAsin: string
  finalAsin?: unknown
  displayedPrice?: number | null
  condition?: string | null
  isPrime?: boolean | null
  isFba?: boolean | null
  shipsFromAmazon?: boolean | null
  purchasable?: PurchasableTriState | null
  stockStatus?: string | null
  availabilityText?: string | null
  pageUnavailable?: boolean | null
  redirected?: boolean | null
  captcha?: boolean | null
  loginRequired?: boolean | null
  timeout?: boolean | null
  uncertain?: boolean | null
  /**
   * When true AND ships-from is explicitly false, missing Amazon fulfillment is NOT_FBA.
   * Null ships-from never becomes NOT_FBA via this flag alone.
   */
  offerPageHealthy?: boolean | null
}): VerifiedSourceDecision {
  const requested = asAsin(input.requestedAsin) ?? ""
  const finalAsin = asAsin(input.finalAsin)
  const redirected =
    input.redirected === true || (Boolean(requested) && Boolean(finalAsin) && requested !== finalAsin)

  const base = {
    acceptedPrice: null as number | null,
    requestedAsin: requested,
    finalAsin,
    redirected,
    validPrimeOrFba: false,
    mutationAllowed: false,
  }

  const confirmed = (code: string, acceptedPrice: number | null = null): VerifiedSourceDecision => ({
    outcome: "CONFIRMED_NO_VALID_SOURCE",
    code,
    ...base,
    acceptedPrice,
    mutationAllowed: true,
  })

  const unknown = (code: string): VerifiedSourceDecision => ({
    outcome: "UNKNOWN",
    code,
    ...base,
  })

  if (
    input.captcha === true ||
    input.loginRequired === true ||
    input.timeout === true ||
    input.uncertain === true
  ) {
    return unknown(
      input.captcha ? "CAPTCHA" : input.loginRequired ? "LOGIN_REQUIRED" : input.timeout ? "TIMEOUT" : "UNKNOWN"
    )
  }

  // 1) Real product page exists
  if (input.pageUnavailable === true) {
    return confirmed("PRODUCT_NOT_FOUND")
  }

  // 2) ASIN match (positive evidence only)
  if (redirected) {
    const sawDifferentAsin = Boolean(requested) && Boolean(finalAsin) && requested !== finalAsin
    if (!sawDifferentAsin) {
      return unknown("ASIN_UNKNOWN")
    }
    return confirmed("SOURCE_ASIN_MISMATCH")
  }
  if (requested && !finalAsin) {
    return unknown("ASIN_UNKNOWN")
  }

  const price = input.displayedPrice != null && input.displayedPrice > 0 ? input.displayedPrice : null

  // Explicit unavailable before Prime — requires availability text evidence
  if (
    isConfirmedOutOfStockSignal({
      purchasable: input.purchasable,
      stockStatus: input.stockStatus,
      availabilityText: input.availabilityText,
    })
  ) {
    return confirmed("OUT_OF_STOCK", price)
  }

  // 3) Prime
  if (input.isPrime == null) {
    return unknown("PRIME_UNKNOWN")
  }
  if (input.isPrime === false) {
    return confirmed("NOT_PRIME", price)
  }

  // 4) Ships from Amazon — only explicit non-Amazon shipper is NOT_FBA.
  //    Null/unknown ships-from → SHIPPER_UNKNOWN (never invent NOT_FBA from price/Prime alone).
  const shipsExplicit =
    input.shipsFromAmazon === true || input.shipsFromAmazon === false
      ? input.shipsFromAmazon
      : null
  const fbaExplicit = input.isFba === true ? true : null
  if (shipsExplicit === true || fbaExplicit === true) {
    // pass
  } else if (shipsExplicit === false) {
    return confirmed("NOT_FBA", price)
  } else {
    return unknown("SHIPPER_UNKNOWN")
  }

  // 5) Condition — USED/LIKE_NEW/RESALE primary cannot be VALID_SOURCE
  //    (alternate NEW+Amazon-fulfilled selection happens upstream before this classifier)
  const bucket = conditionBucket(input.condition)
  if (bucket === "USED_OR_RESALE") {
    return confirmed("USED_OR_RESALE", price)
  }
  if (bucket === "UNKNOWN") {
    return unknown("CONDITION_UNKNOWN")
  }

  // 6) In stock required for VALID
  if (
    !isConfirmedInStockSignal({
      purchasable: input.purchasable,
      stockStatus: input.stockStatus,
      availabilityText: input.availabilityText,
    })
  ) {
    return unknown("STOCK_UNKNOWN")
  }

  if (price == null) {
    return { ...unknown("PRICE_NOT_FOUND"), validPrimeOrFba: true }
  }

  return {
    outcome: "VALID_SOURCE",
    code: "VALID_SOURCE",
    acceptedPrice: price,
    requestedAsin: requested,
    finalAsin,
    redirected: false,
    validPrimeOrFba: true,
    mutationAllowed: false,
  }
}

export function isConfirmedSourceFailure(outcome: VerifiedSourceOutcome): boolean {
  return outcome === "CONFIRMED_NO_VALID_SOURCE" || outcome === "SOURCE_ASIN_REDIRECTED"
}

export function isAutomaticZeroDecisionSafe(decision: VerifiedSourceDecision): boolean {
  if (decision.outcome !== "CONFIRMED_NO_VALID_SOURCE" || !decision.mutationAllowed) return false
  switch (decision.code) {
    case "SOURCE_ASIN_MISMATCH":
    case "SOURCE_ASIN_REDIRECTED":
      return Boolean(decision.requestedAsin && decision.finalAsin && decision.requestedAsin !== decision.finalAsin)
    case "PRODUCT_NOT_FOUND":
    case "PRODUCT_UNAVAILABLE":
    case "ASIN_REMOVED":
    case "OUT_OF_STOCK":
    case "NOT_PRIME":
    case "NOT_FBA":
    case "FBM_ONLY":
    case "USED_OR_RESALE":
    // Oxylabs computes this only after the exact matched-ASIN, positive-price,
    // in-stock, all-four-absence structural test. Keep the final guard
    // allowlist explicit; arbitrary SOURCE_INVALID codes remain unsafe.
    case "NO_VERIFIED_NEW_FBA_OFFER":
      return true
    default:
      return false
  }
}

export function verificationNeedsUserApproval(code: string): boolean {
  return code === "PRICE_NOT_FOUND" || code === "SOURCE_ASIN_REDIRECTED"
}
