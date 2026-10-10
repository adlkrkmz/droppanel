import type { VerifiedSourceDecision } from "../amazonVerification/verifiedSourceDecision"
import {
  isExpectedOxylabsCurrency,
  isOxylabsParseSuccess,
  oxylabsProductFingerprint,
  sellerClassOf,
  type OxylabsProductNormalized,
} from "./oxylabsProductNormalize"

export type OxylabsSingleQueryCode =
  | "NO_BUSINESS_CHANGE"
  | "PRICE_CHANGE"
  | "WOULD_APPLY_PRICE"
  | "OUT_OF_STOCK"
  | "WOULD_APPLY_STOCK"
  | "SOURCE_INVALID"
  | "NOT_PRIME"
  | "NOT_FBA"
  | "ASIN_IDENTITY_CHANGED"
  | "PRODUCT_INCONCLUSIVE"

export type OxylabsProductClass =
  | "VALID_SOURCE"
  | "ASIN_IDENTITY_MISMATCH"
  | "OUT_OF_STOCK_RISK"
  | "SOURCE_INVALID"
  | "PRODUCT_INCONCLUSIVE"

export const OXYLABS_SINGLE_QUERY_POLICY = "OXYLABS_SINGLE_QUERY_POLICY"

export type OxylabsPanelListing = {
  sourceAsin: string | null
  sourcePrice: number | null
  listingLive: boolean
  qty: number
}

export type OxylabsSingleQueryDecision = {
  productClass: OxylabsProductClass
  code: OxylabsSingleQueryCode
  evidenceCode: string
  enqueueConfirm: false
  applyMutation: boolean
  audit: OxylabsSingleQueryCode
  criticalUnknown: boolean
}

function cents(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null
  return Math.round(n * 100)
}

export function pricesWithinOneCent(a: number | null, b: number | null): boolean {
  const ca = cents(a)
  const cb = cents(b)
  if (ca == null || cb == null) return false
  return Math.abs(ca - cb) <= 1
}

export function oxylabsSourceOfferUsable(n: OxylabsProductNormalized): boolean {
  const fulfillmentOk = n.isAmazonFulfilled === true || n.shipsFromAmazon === true
  return (
    fulfillmentOk &&
    n.stockClass === "IN_STOCK" &&
    n.pricePositive != null &&
    n.pricePositive > 0
  )
}

/** Maps Oxylabs tri-state Prime/AFN/shipper onto browser NOT_PRIME / NOT_FBA / UNKNOWN. */
export function oxylabsPrimeFbaDecision(n: OxylabsProductNormalized): {
  kind: "OK" | "NOT_PRIME" | "NOT_FBA" | "UNKNOWN"
  code: string
} {
  if (n.primeEvidence === "EXPLICIT_FALSE") return { kind: "NOT_PRIME", code: "NOT_PRIME" }
  if (n.primeEvidence !== "EXPLICIT_TRUE" && n.primeEvidence !== "DELIVERY_PRIME") {
    return { kind: "UNKNOWN", code: "PRIME_UNKNOWN" }
  }
  const afn = n.isAmazonFulfilled
  const ship = n.shipsFromAmazon
  if (afn === true && ship === false) return { kind: "UNKNOWN", code: "AFN_SHIPPER_CONTRADICTION" }
  if (afn === false && ship === true) return { kind: "UNKNOWN", code: "AFN_SHIPPER_CONTRADICTION" }
  if (afn === false) return { kind: "NOT_FBA", code: "NOT_FBA" }
  if (ship === false) return { kind: "NOT_FBA", code: "NOT_FBA" }
  if (afn === true || ship === true) return { kind: "OK", code: "FBA_OK" }
  return { kind: "UNKNOWN", code: "AFN_SHIPPER_UNKNOWN" }
}

export function oxylabsIdentityOutcome(n: OxylabsProductNormalized): {
  code: "MATCH" | "ASIN_IDENTITY_CHANGED" | "INCONCLUSIVE"
} {
  const requested = n.requestedAsin
  const returned = n.returnedAsin
  const urlAsin = n.asinInUrl
  // Positive returned ASIN that differs from the requested source is a redirect.
  // URL / asin_in_url still showing the requested ASIN does not count as a match.
  if (returned && returned !== requested) {
    return { code: "ASIN_IDENTITY_CHANGED" }
  }
  if (returned && returned === requested) return { code: "MATCH" }
  if (!returned && urlAsin === requested) return { code: "MATCH" }
  if (!returned && urlAsin && urlAsin !== requested) return { code: "INCONCLUSIVE" }
  return { code: "INCONCLUSIVE" }
}

function mutationsAudit(code: OxylabsSingleQueryCode, mutationsEnabled: boolean): {
  audit: OxylabsSingleQueryCode
  applyMutation: boolean
} {
  if (code === "PRICE_CHANGE") {
    return mutationsEnabled
      ? { audit: "PRICE_CHANGE", applyMutation: true }
      : { audit: "WOULD_APPLY_PRICE", applyMutation: false }
  }
  if (code === "OUT_OF_STOCK") {
    return mutationsEnabled
      ? { audit: "OUT_OF_STOCK", applyMutation: true }
      : { audit: "WOULD_APPLY_STOCK", applyMutation: false }
  }
  if (
    code === "SOURCE_INVALID" ||
    code === "NOT_PRIME" ||
    code === "NOT_FBA" ||
    code === "ASIN_IDENTITY_CHANGED"
  ) {
    return { audit: code, applyMutation: mutationsEnabled }
  }
  return { audit: code, applyMutation: false }
}

export function decideOxylabsSingleQuery(input: {
  n: OxylabsProductNormalized
  panel: OxylabsPanelListing | null
  mutationsEnabled: boolean
}): OxylabsSingleQueryDecision {
  const n = input.n
  const finish = (
    productClass: OxylabsProductClass,
    code: OxylabsSingleQueryCode,
    evidenceCode: string,
    criticalUnknown: boolean
  ): OxylabsSingleQueryDecision => {
    const mut = mutationsAudit(code, input.mutationsEnabled)
    return {
      productClass,
      code: mut.audit,
      evidenceCode,
      enqueueConfirm: false,
      applyMutation: mut.applyMutation,
      audit: mut.audit,
      criticalUnknown,
    }
  }

  if (n.httpStatus === 404 || n.notFound) {
    return finish("OUT_OF_STOCK_RISK", "OUT_OF_STOCK", "NOT_FOUND", false)
  }
  if (n.httpStatus == null) return finish("PRODUCT_INCONCLUSIVE", "PRODUCT_INCONCLUSIVE", "HTTP_STATUS_UNKNOWN", true)
  if (n.httpStatus !== 200) return finish("PRODUCT_INCONCLUSIVE", "PRODUCT_INCONCLUSIVE", "HTTP_NOT_OK", true)
  if (!isOxylabsParseSuccess(n.parseStatus)) {
    return finish("PRODUCT_INCONCLUSIVE", "PRODUCT_INCONCLUSIVE", "PARSE_NOT_SUCCESS", true)
  }
  if (n.explicitUnavailable || n.removed) {
    return finish("OUT_OF_STOCK_RISK", "OUT_OF_STOCK", n.removed ? "REMOVED" : "OUT_OF_STOCK", false)
  }
  if (n.faulted && n.notFound) {
    return finish("OUT_OF_STOCK_RISK", "OUT_OF_STOCK", "NOT_FOUND", false)
  }
  if (n.faulted) return finish("PRODUCT_INCONCLUSIVE", "PRODUCT_INCONCLUSIVE", "PROVIDER_FAULTED", true)

  const identity = oxylabsIdentityOutcome(n)
  if (identity.code === "ASIN_IDENTITY_CHANGED") {
    return finish("ASIN_IDENTITY_MISMATCH", "ASIN_IDENTITY_CHANGED", "ASIN_IDENTITY_CHANGED", false)
  }
  if (identity.code === "INCONCLUSIVE") {
    return finish("PRODUCT_INCONCLUSIVE", "PRODUCT_INCONCLUSIVE", "ASIN_IDENTITY_INCONCLUSIVE", true)
  }

  if (n.conditionClass === "NON_NEW") return finish("SOURCE_INVALID", "SOURCE_INVALID", "USED_OR_RESALE", false)
  // Exact, production-validated absence pattern. Individual missing fields are
  // deliberately not sufficient evidence for an invalid offer.
  if (
    identity.code === "MATCH" &&
    n.priceKind === "POSITIVE" && n.pricePositive != null &&
    n.stockClass === "IN_STOCK" &&
    !n.hasNewPricingUrl &&
    !n.hasFeaturedMerchant &&
    !n.hasBuyboxSeller &&
    !n.hasFbaSignal
  ) return finish("SOURCE_INVALID", "SOURCE_INVALID", "NO_VERIFIED_NEW_FBA_OFFER", false)

  // Prime false is observational only for Oxylabs. It must never become an
  // automatic zero-stock decision by itself. Explicit non-FBA remains an
  // existing source-safety outcome; unknown FBA remains non-destructive.
  const primeFba = oxylabsPrimeFbaDecision(n)
  if (primeFba.kind === "NOT_FBA") return finish("SOURCE_INVALID", "NOT_FBA", "NOT_FBA", false)
  if (primeFba.kind === "UNKNOWN") return finish("PRODUCT_INCONCLUSIVE", "PRODUCT_INCONCLUSIVE", primeFba.code, true)

  // Oxylabs does not consistently expose a condition on otherwise usable
  // product offers.  NON_NEW above remains a hard source rejection, but an
  // absent or unrecognised condition is not independently disqualifying.
  // The remaining checks still require a matched, in-stock, positive-price,
  // USD, usable source before a valid-source decision can be reached.

  if (!n.featuredOfferPresent) {
    return finish("PRODUCT_INCONCLUSIVE", "PRODUCT_INCONCLUSIVE", "NO_FEATURED_OFFER", true)
  }
  if (n.stockClass !== "IN_STOCK") {
    return finish("PRODUCT_INCONCLUSIVE", "PRODUCT_INCONCLUSIVE", "STOCK_UNKNOWN", true)
  }
  if (n.priceKind !== "POSITIVE" || n.pricePositive == null) {
    return finish("PRODUCT_INCONCLUSIVE", "PRODUCT_INCONCLUSIVE", "PRICE_NOT_POSITIVE", true)
  }
  if (!isExpectedOxylabsCurrency(n.currency)) {
    return finish("PRODUCT_INCONCLUSIVE", "PRODUCT_INCONCLUSIVE", "CURRENCY_NOT_VALID", true)
  }
  if (!oxylabsSourceOfferUsable(n)) {
    return finish("PRODUCT_INCONCLUSIVE", "PRODUCT_INCONCLUSIVE", "SOURCE_NOT_USABLE", true)
  }

  const panel = input.panel
  const asinOk = Boolean(panel?.sourceAsin && panel.sourceAsin === n.requestedAsin)
  if (!asinOk || panel?.sourcePrice == null) {
    return finish("VALID_SOURCE", "PRICE_CHANGE", "NO_PANEL_SOURCE_PRICE", false)
  }
  if (pricesWithinOneCent(n.pricePositive, panel.sourcePrice)) {
    return finish("VALID_SOURCE", "NO_BUSINESS_CHANGE", "PRICE_MATCH", false)
  }
  return finish("VALID_SOURCE", "PRICE_CHANGE", "PRICE_CHANGE", false)
}

/** @deprecated kept as alias for single-query evidence class */
export function classifyOxylabsProduct(
  n: OxylabsProductNormalized
): { productClass: OxylabsProductClass; code: string; criticalUnknown: boolean } {
  const d = decideOxylabsSingleQuery({ n, panel: null, mutationsEnabled: false })
  return { productClass: d.productClass, code: d.evidenceCode, criticalUnknown: d.criticalUnknown }
}

export function mapOxylabsToVerifiedDecision(input: {
  n: OxylabsProductNormalized
  productClass: OxylabsProductClass
  code: string
}): VerifiedSourceDecision {
  const redirected = input.productClass === "ASIN_IDENTITY_MISMATCH"
  const oos = input.productClass === "OUT_OF_STOCK_RISK" || input.productClass === "SOURCE_INVALID"
  const valid = input.productClass === "VALID_SOURCE"
  // Browser classifier uses CONFIRMED_NO_VALID_SOURCE + SOURCE_ASIN_MISMATCH for a
  // positive different final ASIN. That code is what isAutomaticZeroDecisionSafe allows.
  const domainCode = redirected
    ? "SOURCE_ASIN_MISMATCH"
    : input.code === "NOT_PRIME" || input.code === "NOT_FBA"
      ? input.code
      : oos && (input.code === "OUT_OF_STOCK" || input.code === "NOT_FOUND" || input.code === "REMOVED")
        ? "OUT_OF_STOCK"
        : input.code
  return {
    outcome: redirected || oos ? "CONFIRMED_NO_VALID_SOURCE" : valid ? "VALID_SOURCE" : "UNKNOWN",
    code: domainCode,
    acceptedPrice: valid ? input.n.pricePositive : null,
    requestedAsin: input.n.requestedAsin,
    finalAsin: input.n.returnedAsin ?? input.n.finalAsin,
    redirected,
    validPrimeOrFba: valid,
    mutationAllowed: valid || oos || redirected,
  }
}

export function oxylabsOperationKey(input: {
  provider: string
  candidateId: number | null
  fingerprint: string
}): string {
  return [input.provider, input.candidateId ?? 0, input.fingerprint].join(":")
}

export function shouldEnqueueOxylabsConfirm(): false {
  return false
}

export { oxylabsProductFingerprint }
