import { OXYLABS_PRODUCT_GEO, OXYLABS_PRODUCT_SOURCE } from "./oxylabsVerifyConfig"

export type OxylabsTri = boolean | null
export type OxylabsStockClass = "IN_STOCK" | "OOS" | "UNKNOWN"
export type OxylabsSellerClass = "AMAZON" | "THIRD_PARTY_AFN" | "OTHER" | "UNKNOWN"
export type OxylabsPriceKind = "POSITIVE" | "ZERO" | "SENTINEL_NEG1" | "SENTINEL_NEG2" | "NULL" | "EMPTY" | "NON_NUMERIC"
export type OxylabsPrimeEvidence = "EXPLICIT_TRUE" | "DELIVERY_PRIME" | "EXPLICIT_FALSE" | "UNKNOWN"
export type OxylabsConditionClass = "NEW" | "NON_NEW" | "UNKNOWN"

export type OxylabsProductNormalized = {
  source: string
  requestedAsin: string
  returnedAsin: string | null
  asinInUrl: string | null
  finalAsin: string | null
  httpStatus: number | null
  parseStatus: number | null | string
  title: string | null
  productUrl: string | null
  pricingUrl: string | null
  priceRaw: unknown
  priceKind: OxylabsPriceKind
  pricePositive: number | null
  priceCents: number | null
  condition: string | null
  conditionClass: OxylabsConditionClass
  currency: string | null
  stockText: string | null
  availability: string | null
  stockClass: OxylabsStockClass
  buyboxRaw: unknown
  featuredOfferPresent: boolean
  hasFeaturedMerchant: boolean
  hasBuyboxSeller: boolean
  hasNewPricingUrl: boolean
  hasFbaSignal: boolean
  sellerId: string | null
  sellerName: string | null
  featuredMerchant: Record<string, unknown> | null
  isAmazonFulfilled: OxylabsTri
  shippedFrom: string | null
  shipsFromAmazon: OxylabsTri
  isPrimeEligible: OxylabsTri
  primeEvidence: OxylabsPrimeEvidence
  primeEvidenceStrength: "explicit" | "proxy" | "none"
  delivery: unknown
  geoLocation: string
  faulted: boolean
  notFound: boolean
  removed: boolean
  explicitUnavailable: boolean
}

const ASIN_RE = /^[A-Z0-9]{10}$/

export function asAsin(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : ""
  return ASIN_RE.test(s) ? s : null
}

export function classifyOxylabsPrice(raw: unknown): { kind: OxylabsPriceKind; positive: number | null; cents: number | null } {
  if (raw === null || raw === undefined) return { kind: "NULL", positive: null, cents: null }
  if (raw === "") return { kind: "EMPTY", positive: null, cents: null }
  if (raw === -1 || raw === "-1") return { kind: "SENTINEL_NEG1", positive: null, cents: null }
  if (raw === -2 || raw === "-2") return { kind: "SENTINEL_NEG2", positive: null, cents: null }
  if (raw === 0 || raw === "0") return { kind: "ZERO", positive: null, cents: null }
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN
  if (!Number.isFinite(n)) return { kind: "NON_NUMERIC", positive: null, cents: null }
  if (n === -1) return { kind: "SENTINEL_NEG1", positive: null, cents: null }
  if (n === -2) return { kind: "SENTINEL_NEG2", positive: null, cents: null }
  if (n === 0) return { kind: "ZERO", positive: null, cents: null }
  if (n > 0) return { kind: "POSITIVE", positive: n, cents: Math.round(n * 100) }
  if (n < 0) return { kind: "SENTINEL_NEG1", positive: null, cents: null }
  return { kind: "NON_NUMERIC", positive: null, cents: null }
}

function triBool(raw: unknown): OxylabsTri {
  if (raw === true) return true
  if (raw === false) return false
  return null
}

export function classifyOxylabsCondition(raw: unknown): OxylabsConditionClass {
  const value = String(raw ?? "").trim().toUpperCase()
  if (!value) return "UNKNOWN"
  if (/\b(USED|RENEWED|REFURBISHED|RESALE|COLLECTIBLE)\b/.test(value)) return "NON_NEW"
  return /\bNEW\b/.test(value) ? "NEW" : "UNKNOWN"
}

const OOS_RE =
  /currently unavailable|temporarily out of stock|\bout of stock\b|we don't know when or if this item will be back/i
const IN_STOCK_RE = /\bin\s+stock\b|\bonly\s+\d+\s+left\b/i
const OXYLABS_PARSE_OK = new Set([200, 12000])

export function isOxylabsParseSuccess(parseStatus: unknown): boolean {
  if (parseStatus == null || parseStatus === "") return false
  const n = Number(parseStatus)
  if (Number.isFinite(n) && OXYLABS_PARSE_OK.has(n)) return true
  const s = String(parseStatus).trim().toLowerCase()
  return s === "ok" || s === "done" || s === "success"
}

export function isExpectedOxylabsCurrency(currency: string | null | undefined): boolean {
  return String(currency ?? "").trim().toUpperCase() === "USD"
}
const AMAZON_SHIP_RE = /^(amazon(\.com)?)$/i
const AMAZON_SELLER_RE = /^(amazon(\.com)?)$/i
const NOT_FOUND_RE = /page not found|not found|sorry, we couldn't find/i
const REMOVED_RE = /not available for purchase|no longer available/i

export function classifyOxylabsStock(stockText: string | null, availability: string | null): OxylabsStockClass {
  const blob = `${stockText ?? ""} ${availability ?? ""}`.trim()
  if (!blob) return "UNKNOWN"
  if (OOS_RE.test(blob) && !IN_STOCK_RE.test(blob)) return "OOS"
  if (IN_STOCK_RE.test(blob) && !OOS_RE.test(blob)) return "IN_STOCK"
  if (OOS_RE.test(blob)) return "UNKNOWN"
  return "UNKNOWN"
}

export function shipsFromAmazonValue(shippedFrom: string | null): OxylabsTri {
  if (shippedFrom == null || shippedFrom === "") return null
  return AMAZON_SHIP_RE.test(shippedFrom.trim()) ? true : false
}

function walkDeliveryTypes(node: unknown, out: string[], depth = 0): void {
  if (node == null || depth > 5) return
  if (Array.isArray(node)) {
    for (const item of node) walkDeliveryTypes(item, out, depth + 1)
    return
  }
  if (typeof node !== "object") return
  const rec = node as Record<string, unknown>
  if (typeof rec.type === "string") out.push(rec.type)
  if (typeof rec.delivery_type === "string") out.push(rec.delivery_type)
  for (const key of ["delivery_details", "delivery"]) {
    if (key in rec) walkDeliveryTypes(rec[key], out, depth + 1)
  }
}

export function isStructuredPrimeMembersType(raw: string): boolean {
  const n = raw.trim().replace(/\s+/g, " ").toLowerCase()
  return n === "prime members" || n === "prime member"
}

export function collectDesignatedDeliveryTypes(input: {
  featuredMerchant: Record<string, unknown> | null
  buyboxRaw: unknown
  contentDelivery: unknown
}): string[] {
  const out: string[] = []
  if (input.featuredMerchant) {
    walkDeliveryTypes(input.featuredMerchant.delivery_details, out)
    walkDeliveryTypes(input.featuredMerchant.delivery, out)
  }
  walkDeliveryTypes(input.buyboxRaw, out)
  walkDeliveryTypes(input.contentDelivery, out)
  return out
}

export function classifyOxylabsPrimeEvidence(input: {
  explicitPrime: OxylabsTri
  designatedDeliveryTypes: string[]
}): OxylabsPrimeEvidence {
  if (input.explicitPrime === true) return "EXPLICIT_TRUE"
  if (input.explicitPrime === false) return "EXPLICIT_FALSE"
  if (input.designatedDeliveryTypes.some(isStructuredPrimeMembersType)) return "DELIVERY_PRIME"
  return "UNKNOWN"
}

export function primeEligibleFromEvidence(evidence: OxylabsPrimeEvidence): OxylabsTri {
  if (evidence === "EXPLICIT_TRUE" || evidence === "DELIVERY_PRIME") return true
  if (evidence === "EXPLICIT_FALSE") return false
  return null
}

export function primeEvidenceStrengthOf(evidence: OxylabsPrimeEvidence): "explicit" | "proxy" | "none" {
  if (evidence === "EXPLICIT_TRUE") return "explicit"
  if (evidence === "DELIVERY_PRIME") return "proxy"
  return "none"
}

export function sellerClassOf(input: {
  sellerName: string | null
  isAmazonFulfilled: OxylabsTri
}): OxylabsSellerClass {
  if (input.sellerName && AMAZON_SELLER_RE.test(input.sellerName.trim())) return "AMAZON"
  if (input.isAmazonFulfilled === true) return "THIRD_PARTY_AFN"
  if (input.sellerName) return "OTHER"
  return "UNKNOWN"
}

function firstResult(payload: Record<string, unknown>): Record<string, unknown> | null {
  const results = payload.results
  if (!Array.isArray(results) || results.length === 0) return null
  const row = results[0]
  return row && typeof row === "object" ? (row as Record<string, unknown>) : null
}

function contentOf(result: Record<string, unknown> | null): Record<string, unknown> | null {
  const content = result?.content
  if (content && typeof content === "object" && !Array.isArray(content)) return content as Record<string, unknown>
  return null
}

export function normalizeOxylabsAmazonProduct(input: {
  requestedAsin: string
  geoLocation?: string
  httpStatus?: number | null
  payload: Record<string, unknown>
}): OxylabsProductNormalized {
  const requestedAsin = asAsin(input.requestedAsin) ?? String(input.requestedAsin ?? "").trim().toUpperCase()
  const result = firstResult(input.payload)
  const content = contentOf(result)
  const featuredRaw =
    content?.featured_merchant && typeof content.featured_merchant === "object" && !Array.isArray(content.featured_merchant)
      ? (content.featured_merchant as Record<string, unknown>)
      : null
  const featured = featuredRaw && Object.keys(featuredRaw).length > 0 ? featuredRaw : null
  const httpStatus =
    typeof result?.status_code === "number"
      ? result.status_code
      : typeof input.httpStatus === "number"
        ? input.httpStatus
        : null
  const parseStatus =
    content?.parse_status_code ?? result?.parse_status_code ?? input.payload.parse_status_code ?? null
  const returnedAsin = asAsin(content?.asin)
  const asinInUrl = asAsin(content?.asin_in_url)
  const url = typeof content?.url === "string" ? content.url : null
  const pricingUrl = typeof content?.pricing_url === "string" ? content.pricing_url : null
  const urlAsinMatch = url ? url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i) : null
  const finalAsin = returnedAsin ?? asinInUrl ?? asAsin(urlAsinMatch?.[1] ?? null)
  const title = typeof content?.title === "string" ? content.title : null
  const stockText = typeof content?.stock === "string" ? content.stock : content?.stock == null ? null : String(content.stock)
  const availability =
    typeof content?.availability === "string"
      ? content.availability
      : typeof featured?.availability === "string"
        ? featured.availability
        : null
  const priceRaw = content?.price ?? null
  const classified = classifyOxylabsPrice(priceRaw)
  const firstBuybox = Array.isArray(content?.buybox) && content.buybox[0] && typeof content.buybox[0] === "object"
    ? content.buybox[0] as Record<string, unknown>
    : null
  const pricingCondition = pricingUrl?.match(/[?&]condition=([^&]+)/i)?.[1]
  const conditionRaw = content?.condition ?? content?.condition_text ?? featured?.condition ?? firstBuybox?.condition ?? firstBuybox?.condition_text ?? pricingCondition ?? null
  const condition = typeof conditionRaw === "string" ? conditionRaw : null
  const currency = typeof content?.currency === "string" ? content.currency : null
  const isAmazonFulfilled = triBool(featured?.is_amazon_fulfilled)
  const shippedFrom = typeof featured?.shipped_from === "string" ? featured.shipped_from : featured?.shipped_from == null ? null : String(featured.shipped_from)
  const isPrimeEligibleRaw = triBool(content?.is_prime_eligible ?? featured?.is_prime_eligible)
  const sellerName = typeof featured?.name === "string" ? featured.name : null
  const sellerId = featured?.seller_id == null || featured.seller_id === "" ? null : String(featured.seller_id)
  const buyboxRaw = content?.buybox ?? content?.price_buybox ?? null
  const buyboxRows = Array.isArray(content?.buybox) ? content.buybox : []
  const hasBuyboxSeller = buyboxRows.some(row => {
    if (!row || typeof row !== "object") return false
    const r = row as Record<string, unknown>
    return (typeof r.seller_name === "string" && r.seller_name.trim() !== "") ||
      (typeof r.seller_id === "string" && r.seller_id.trim() !== "")
  })
  const contentDelivery = content?.delivery ?? content?.delivery_details ?? null
  const designatedDeliveryTypes = collectDesignatedDeliveryTypes({
    featuredMerchant: featured,
    buyboxRaw,
    contentDelivery,
  })
  const primeEvidence = classifyOxylabsPrimeEvidence({
    explicitPrime: isPrimeEligibleRaw,
    designatedDeliveryTypes,
  })
  const isPrimeEligible = primeEligibleFromEvidence(primeEvidence)
  const featuredOfferPresent = Boolean(featured && (sellerName || sellerId || isAmazonFulfilled !== null))
  const hasFeaturedMerchant = Boolean(sellerName || sellerId || (shippedFrom && shippedFrom.trim() !== ""))
  const hasFbaSignal = isAmazonFulfilled === true || shipsFromAmazonValue(shippedFrom) === true
  const blob = `${stockText ?? ""} ${availability ?? ""} ${title ?? ""}`
  const notFound =
    httpStatus === 404 ||
    String(parseStatus) === "404" ||
    NOT_FOUND_RE.test(blob) ||
    (String(input.payload.status ?? "").toLowerCase() === "faulted" &&
      /not.?found/i.test(String(input.payload.message ?? "")))
  const removed = REMOVED_RE.test(blob)
  const faulted =
    String(input.payload.status ?? "").toLowerCase() === "faulted" ||
    String(result?.status ?? "").toLowerCase() === "faulted" ||
    (typeof httpStatus === "number" && httpStatus >= 500)
  const explicitUnavailable = OOS_RE.test(`${stockText ?? ""} ${availability ?? ""}`)
  const stockClass = classifyOxylabsStock(stockText, availability)

  return {
    source: OXYLABS_PRODUCT_SOURCE,
    requestedAsin,
    returnedAsin,
    asinInUrl,
    finalAsin,
    httpStatus,
    parseStatus: parseStatus as number | null | string,
    title,
    productUrl: url,
    pricingUrl,
    priceRaw,
    priceKind: classified.kind,
    pricePositive: classified.positive,
    priceCents: classified.cents,
    condition,
    conditionClass: classifyOxylabsCondition(condition),
    currency,
    stockText,
    availability,
    stockClass,
    buyboxRaw,
    featuredOfferPresent,
    hasFeaturedMerchant,
    hasBuyboxSeller,
    hasNewPricingUrl: /[?&]condition=NEW(?:&|$)/i.test(pricingUrl ?? ""),
    hasFbaSignal,
    sellerId,
    sellerName,
    featuredMerchant: featured,
    isAmazonFulfilled,
    shippedFrom,
    shipsFromAmazon: shipsFromAmazonValue(shippedFrom),
    isPrimeEligible,
    primeEvidence,
    primeEvidenceStrength: primeEvidenceStrengthOf(primeEvidence),
    delivery: contentDelivery,
    geoLocation: input.geoLocation ?? OXYLABS_PRODUCT_GEO,
    faulted,
    notFound,
    removed,
    explicitUnavailable,
  }
}

export function oxylabsProductFingerprint(n: OxylabsProductNormalized, productClass = ""): string {
  const seller = sellerClassOf({ sellerName: n.sellerName, isAmazonFulfilled: n.isAmazonFulfilled })
  const prime =
    n.isPrimeEligible === true ? "1" : n.isPrimeEligible === false ? "0" : "u"
  return [
    n.requestedAsin,
    n.returnedAsin ?? n.finalAsin ?? "",
    n.priceCents == null ? "" : String(n.priceCents),
    n.stockClass,
    n.isAmazonFulfilled === true ? "1" : n.isAmazonFulfilled === false ? "0" : "u",
    n.shipsFromAmazon === true ? "1" : n.shipsFromAmazon === false ? "0" : "u",
    prime,
    seller,
    productClass,
  ].join("|")
}

export function stripOxylabsSecrets(payload: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
  delete clone.username
  delete clone.password
  delete clone.token
  delete clone.authorization
  const job = clone.job
  if (job && typeof job === "object") {
    const j = job as Record<string, unknown>
    delete j.username
    delete j.password
    delete j.headers
  }
  return clone
}
