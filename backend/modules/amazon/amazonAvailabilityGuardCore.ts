// ----------------------------------------------------------------
// amazonAvailabilityGuardCore.ts — pure Prime / stock / price signals (no DB)
// ----------------------------------------------------------------

export type PrimeStatus = "PRIME" | "NOT_PRIME" | "PRIME_UNKNOWN"
export type StockStatus = "IN_STOCK" | "LIMITED_STOCK" | "OUT_OF_STOCK" | "STOCK_UNKNOWN"
export type PriceStatus = "VALID_PRICE" | "NO_VALID_PRICE" | "PRICE_UNKNOWN"

export type AmazonAvailabilityInput = {
  asin?:              string | null
  source?:            string | null
  cacheSource?:       string | null
  isPrime?:           boolean | null
  /** Explicit normalized prime status from extension/extractor when available. */
  primeStatus?:       string | null
  /** Explicit stock status from extension: IN_STOCK | LIMITED_STOCK | OUT_OF_STOCK | UNKNOWN */
  stockStatus?:       string | null
  stockCount?:        number | null
  availabilityText?:  string | null
  hasAddToCart?:      boolean | null
  hasBuyNow?:         boolean | null
  price?:             number | null
  attributes?:        Record<string, unknown> | null
}

export type AmazonAvailabilityResult = {
  asin:          string | null
  primeStatus:   PrimeStatus
  stockStatus:   StockStatus
  stockCount:    number | null
  priceStatus:   PriceStatus
  reasons:       string[]
  evidence:      string[]
  trustedSource: boolean
}

const TRUSTED_SOURCES = new Set([
  "amazon",
  "live_extract",
  "extension",
  "chrome_extension",
])

const OUT_OF_STOCK_PATTERNS = [
  /currently\s+unavailable/i,
  /we\s+don'?t\s+know\s+when\s+or\s+if/i,
  /temporarily\s+out\s+of\s+stock/i,
  /\bout\s+of\s+stock\b/i,
]

/** "Only N left [in stock]" — must be checked BEFORE plain "in stock". */
const LIMITED_STOCK_RE = /only\s+(\d+)\s+(?:item(?:s)?\s+)?left(?:\s+in\s+stock)?/i

/** Plain in-stock wording. Do NOT treat "Only N left in stock" as normal IN_STOCK. */
const NORMAL_IN_STOCK_RE = /\bin\s+stock\b/i

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export function asBool(v: unknown): boolean | null {
  if (v === true || v === false) return v
  if (v === "true") return true
  if (v === "false") return false
  return null
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim()) {
    const n = parseFloat(v.replace(/[^0-9.]/g, ""))
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function isTrustedAmazonExtractSource(source: string | null | undefined): boolean {
  if (!source?.trim()) return false
  const s = source.trim().toLowerCase()
  if (s === "simulation") return false
  if (TRUSTED_SOURCES.has(s)) return true
  return s.includes("amazon") || s.includes("extension")
}

/** Availability / stock text only — never description/bullets (false positives). */
function collectStockTextEvidence(input: AmazonAvailabilityInput): string {
  const parts: string[] = []
  if (input.availabilityText) parts.push(input.availabilityText)
  const attrs = input.attributes ?? {}
  for (const key of ["availabilityText", "availability", "stockText"]) {
    const v = attrs[key]
    if (typeof v === "string" && v.trim()) parts.push(v)
  }
  return parts.join("\n")
}

function hasOutOfStockTextEvidence(text: string): boolean {
  return OUT_OF_STOCK_PATTERNS.some(p => p.test(text))
}

function parseLimitedStockCount(text: string): number | null {
  const m = text.match(LIMITED_STOCK_RE)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

function hasNormalInStockTextEvidence(text: string): boolean {
  if (parseLimitedStockCount(text) != null) return false
  return NORMAL_IN_STOCK_RE.test(text)
}

function normalizeExplicitStockStatus(raw: string | null | undefined): StockStatus | null {
  if (!raw?.trim()) return null
  const s = raw.trim().toUpperCase()
  if (s === "IN_STOCK") return "IN_STOCK"
  if (s === "LIMITED_STOCK") return "LIMITED_STOCK"
  if (s === "OUT_OF_STOCK") return "OUT_OF_STOCK"
  if (s === "UNKNOWN" || s === "STOCK_UNKNOWN") return "STOCK_UNKNOWN"
  return null
}

export function normalizeAmazonAvailabilitySignals(
  input: AmazonAvailabilityInput
): AmazonAvailabilityResult {
  const attrs = asRecord(input.attributes) ?? {}
  const source = input.source ?? input.cacheSource ?? (typeof attrs.source === "string" ? attrs.source : null)
  const trustedSource = isTrustedAmazonExtractSource(source)

  const isPrime = input.isPrime ?? asBool(attrs.isPrime)
  const availabilityText = input.availabilityText
    ?? (typeof attrs.availabilityText === "string" ? attrs.availabilityText : null)
    ?? (typeof attrs.availability === "string" ? attrs.availability : null)
  const hasAddToCart = input.hasAddToCart ?? asBool(attrs.hasAddToCart)
  const hasBuyNow = input.hasBuyNow ?? asBool(attrs.hasBuyNow)
  const price = input.price ?? asNumber(attrs.price) ?? asNumber(attrs.buyboxPrice)

  const stockTextBlob = collectStockTextEvidence({ ...input, availabilityText, attributes: attrs })
  const reasons: string[] = []
  const evidence: string[] = []

  let priceStatus: PriceStatus = "PRICE_UNKNOWN"
  if (price != null) {
    if (price > 0) {
      priceStatus = "VALID_PRICE"
      evidence.push("current_price")
    } else {
      priceStatus = "NO_VALID_PRICE"
      reasons.push("price_zero_or_invalid")
    }
  } else if (!trustedSource && !stockTextBlob.trim()) {
    priceStatus = "PRICE_UNKNOWN"
    reasons.push("no_price_in_cache")
  } else if (trustedSource && price == null) {
    priceStatus = "PRICE_UNKNOWN"
    reasons.push("price_not_in_extract")
  }

  // ── Stock: OOS → LIMITED → IN_STOCK → UNKNOWN (never promote "Only N left" via "in stock") ──
  const explicitStock = normalizeExplicitStockStatus(
    (typeof input.stockStatus === "string" ? input.stockStatus : null)
    ?? (typeof attrs.stockStatus === "string" ? attrs.stockStatus : null)
  )
  const attrStockCount = input.stockCount ?? asNumber(attrs.stockCount)
  const textLimitedCount = parseLimitedStockCount(stockTextBlob)
  const oosText = hasOutOfStockTextEvidence(stockTextBlob)
  const normalInStockText = hasNormalInStockTextEvidence(stockTextBlob)

  let stockStatus: StockStatus = "STOCK_UNKNOWN"
  let stockCount: number | null = null

  if (explicitStock === "OUT_OF_STOCK" || oosText) {
    stockStatus = "OUT_OF_STOCK"
    evidence.push(explicitStock === "OUT_OF_STOCK" ? "stockStatus_OUT_OF_STOCK" : "unavailable_text")
    reasons.push("availability_unavailable")
  } else if (
    explicitStock === "LIMITED_STOCK"
    || textLimitedCount != null
    || (explicitStock === "IN_STOCK" && attrStockCount != null)
  ) {
    // IN_STOCK + stockCount filled is a conflict → treat as LIMITED (fail-closed).
    stockStatus = "LIMITED_STOCK"
    stockCount = attrStockCount ?? textLimitedCount
    evidence.push(
      explicitStock === "LIMITED_STOCK"
        ? "stockStatus_LIMITED_STOCK"
        : (textLimitedCount != null ? `availability_only_${textLimitedCount}_left` : "in_stock_with_stockCount")
    )
    reasons.push("limited_stock")
    if (explicitStock === "IN_STOCK" && attrStockCount != null) {
      evidence.push("contradiction_IN_STOCK_with_stockCount")
      reasons.push("stock_signal_contradiction")
    }
  } else if (explicitStock === "IN_STOCK") {
    stockStatus = "IN_STOCK"
    stockCount = null
    evidence.push("stockStatus_IN_STOCK")
  } else if (explicitStock === "STOCK_UNKNOWN") {
    stockStatus = "STOCK_UNKNOWN"
    evidence.push("stockStatus_UNKNOWN")
    reasons.push("explicit_stock_unknown")
  } else if (normalInStockText) {
    stockStatus = "IN_STOCK"
    stockCount = null
    evidence.push("in_stock_text")
  } else if (hasAddToCart === true || hasBuyNow === true) {
    // ATC/BuyNow alone must NOT invent IN_STOCK (limited offers also have ATC).
    stockStatus = "STOCK_UNKNOWN"
    reasons.push(stockTextBlob.trim() ? "stock_text_unclassified" : "purchase_buttons_without_availability_text")
    if (hasAddToCart) evidence.push("add_to_cart")
    if (hasBuyNow) evidence.push("buy_now")
  } else if (hasAddToCart === false && hasBuyNow === false && trustedSource) {
    stockStatus = "OUT_OF_STOCK"
    evidence.push("no_purchase_buttons")
    reasons.push("no_add_to_cart_or_buy_now")
  } else {
    stockStatus = "STOCK_UNKNOWN"
    reasons.push("stock_evidence_missing")
  }

  const stockEvidence = attrs.stockEvidence
  if (Array.isArray(stockEvidence) && stockEvidence.length > 0) {
    evidence.push(...stockEvidence.filter((e): e is string => typeof e === "string").slice(0, 8))
  }

  let primeStatus: PrimeStatus = "PRIME_UNKNOWN"

  const rawPrimeStatus =
    (typeof input.primeStatus === "string" ? input.primeStatus : null)
    ?? (typeof attrs.primeStatus === "string" ? attrs.primeStatus : null)
  const normalizedExplicit = rawPrimeStatus?.trim().toUpperCase() ?? ""
  const explicitPrime =
    normalizedExplicit === "PRIME" ? "PRIME" as const
    : normalizedExplicit === "NOT_PRIME" ? "NOT_PRIME" as const
    : (normalizedExplicit === "UNKNOWN" || normalizedExplicit === "PRIME_UNKNOWN")
      ? "PRIME_UNKNOWN" as const
      : null

  // ASIN integrity: selectedAsin (when present) must match cache/payload asin.
  const selectedAsinRaw =
    (typeof attrs.selectedAsin === "string" ? attrs.selectedAsin : null)
    ?? (typeof attrs.pageUrlAsin === "string" ? attrs.pageUrlAsin : null)
  const selectedAsin = selectedAsinRaw?.trim().toUpperCase() || null
  const inputAsin = input.asin?.trim().toUpperCase() || null
  if (selectedAsin && inputAsin && selectedAsin !== inputAsin) {
    primeStatus = "PRIME_UNKNOWN"
    stockStatus = "STOCK_UNKNOWN"
    evidence.push("ASIN_MISMATCH")
    reasons.push("asin_mismatch_selected_vs_payload")
  } else if (explicitPrime === "PRIME" && isPrime === false) {
    primeStatus = "PRIME_UNKNOWN"
    evidence.push("contradiction_primeStatus_PRIME_isPrime_false")
    reasons.push("prime_signal_contradiction")
  } else if (explicitPrime === "NOT_PRIME" && isPrime === true) {
    primeStatus = "PRIME_UNKNOWN"
    evidence.push("contradiction_primeStatus_NOT_PRIME_isPrime_true")
    reasons.push("prime_signal_contradiction")
  } else if (explicitPrime === "PRIME_UNKNOWN" && isPrime === true) {
    // Never invent PRIME from isPrime=true when status is UNKNOWN.
    primeStatus = "PRIME_UNKNOWN"
    evidence.push("contradiction_primeStatus_UNKNOWN_isPrime_true")
    reasons.push("prime_signal_contradiction")
  } else if (explicitPrime === "PRIME") {
    // Only explicit primeStatus=PRIME may publish. isPrime alone is never enough.
    primeStatus = "PRIME"
    evidence.push("primeStatus_PRIME")
    if (isPrime === true) evidence.push("isPrime_true")
  } else if (explicitPrime == null && isPrime === true) {
    // Fail-closed: do NOT promote isPrime=true → PRIME without explicit primeStatus.
    primeStatus = "PRIME_UNKNOWN"
    evidence.push("isPrime_true_without_explicit_primeStatus")
    reasons.push("prime_untrusted_true")
  } else if (explicitPrime === "NOT_PRIME" || (explicitPrime == null && isPrime === false)) {
    if (trustedSource || explicitPrime === "NOT_PRIME") {
      primeStatus = "NOT_PRIME"
      evidence.push(explicitPrime === "NOT_PRIME" ? "primeStatus_NOT_PRIME" : "isPrime_false_trusted")
      reasons.push("live_extract_isPrime_false")
    } else {
      primeStatus = "PRIME_UNKNOWN"
      reasons.push("isPrime_false_untrusted_source")
    }
  } else if (explicitPrime === "PRIME_UNKNOWN") {
    primeStatus = "PRIME_UNKNOWN"
    evidence.push("primeStatus_UNKNOWN")
    reasons.push("explicit_prime_unknown")
  } else {
    primeStatus = "PRIME_UNKNOWN"
    reasons.push("prime_evidence_missing")
  }

  // Buy-box-scoped evidence from extension (never header/banner text).
  const primeEvidence = attrs.primeEvidence
  if (Array.isArray(primeEvidence) && primeEvidence.length > 0) {
    evidence.push(...primeEvidence.filter((e): e is string => typeof e === "string").slice(0, 8))
  }

  const result: AmazonAvailabilityResult = {
    asin:          input.asin ?? null,
    primeStatus,
    stockStatus,
    stockCount,
    priceStatus,
    reasons,
    evidence,
    trustedSource,
  }

  console.log("[AmazonAvailabilityGuard] result", {
    asin:         result.asin,
    primeStatus:  result.primeStatus,
    stockStatus:  result.stockStatus,
    stockCount:   result.stockCount,
    priceStatus:  result.priceStatus,
    evidence:     result.evidence,
    reasons:      result.reasons,
  })

  return result
}

export function isPublishReadyFromAvailability(r: AmazonAvailabilityResult): boolean {
  return r.primeStatus === "PRIME"
    && r.stockStatus === "IN_STOCK"
    && r.priceStatus === "VALID_PRICE"
}

export function resolveAvailabilitySkipReason(r: AmazonAvailabilityResult): string | null {
  if (r.primeStatus === "NOT_PRIME") return "NOT_PRIME"
  if (r.stockStatus === "OUT_OF_STOCK") return "OUT_OF_STOCK"
  if (r.stockStatus === "LIMITED_STOCK") return "LIMITED_STOCK"
  if (r.priceStatus === "NO_VALID_PRICE") return "NO_VALID_PRICE"
  if (isPublishReadyFromAvailability(r)) return null
  if (r.primeStatus === "PRIME_UNKNOWN") return "PRIME_UNKNOWN"
  if (r.stockStatus === "STOCK_UNKNOWN") return "STOCK_UNKNOWN"
  if (r.priceStatus === "PRICE_UNKNOWN") return "PRICE_UNKNOWN"
  return "NEEDS_AMAZON_VALIDATION"
}

/** Direct List alone permits observable, explicitly unknown stock. */
export function resolveDirectListAvailabilitySkipReason(r: AmazonAvailabilityResult): string | null {
  const reason = resolveAvailabilitySkipReason(r)
  return reason === "STOCK_UNKNOWN" ? null : reason
}

export function resolveAvailabilityJobErrorMessage(reason: string): string {
  return reason
}
