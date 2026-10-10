import type { PurchasableTriState } from "./amazonVerificationTypes"

export function normalizeDisplayedPrice(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw * 100) / 100
  }
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const cleaned = trimmed.replace(/[^0-9.,]/g, "")
  if (!cleaned) return null
  let normalized = cleaned
  if (cleaned.includes(",") && cleaned.includes(".")) {
    normalized = cleaned.replace(/,/g, "")
  } else if (/^\d{1,3}(,\d{3})+(?:\.\d+)?$/.test(cleaned)) {
    normalized = cleaned.replace(/,/g, "")
  } else if (cleaned.includes(",") && !cleaned.includes(".")) {
    normalized = cleaned.replace(",", ".")
  }
  const n = Number(normalized)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100) / 100
}

export function normalizeCurrency(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : ""
  if (s === "USD" || s === "EUR" || s === "GBP") return s
  if (s.includes("$") || s === "") return "USD"
  return "USD"
}

export function normalizeCondition(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  if (!s) return "NEW"
  if (/\bnew\b/.test(s)) return "NEW"
  if (/used|refurbished|renewed|open[\s-]?box/.test(s)) return "USED"
  return s.slice(0, 40).toUpperCase()
}

function normalizeMerchantBlob(raw: unknown): string {
  if (typeof raw !== "string") return ""
  return raw
    .trim()
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[\u2007\u202f]/g, " ")
    .replace(/\s+/g, " ")
}

function isMerchantLabelOnly(s: string): boolean {
  return /^(ships\s*from|shipper(\s*\/\s*seller)?|sold\s*by|seller|fulfiller|fulfilled\s*by)[:\s]*$/i.test(
    s
  )
}

/**
 * Canonical Ships-from-Amazon evidence only.
 * Does NOT accept Resale marketing / "Fulfilled by Amazon" blurbs / bare FBA mentions.
 */
function mentionsAmazonShipper(s: string): boolean {
  if (/^amazon(\.com)?$/.test(s)) return true
  if (/ships\s*from\s*:?\s*amazon(\.com)?\b/.test(s)) return true
  if (/shipper(?:\s*\/\s*seller)?\s*:?\s*amazon(\.com)?\b/.test(s)) return true
  return false
}

/** true = Ships from/Shipper Amazon; false = non-Amazon shipper value; null = missing/unreadable. */
export function shipsFromAmazon(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw
  const s = normalizeMerchantBlob(raw)
  if (!s || isMerchantLabelOnly(s)) return null
  if (mentionsAmazonShipper(s)) return true
  return false
}

/** Tri-state seller identity — does not alone prove Ships from Amazon. */
export function soldByAmazon(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw
  const s = normalizeMerchantBlob(raw)
  if (!s || isMerchantLabelOnly(s)) return null
  return /amazon\.?com|\bamazon\b/.test(s)
}

/**
 * Fulfillment = Ships from Amazon only.
 * Seller-alone Amazon is never enough.
 */
export function deriveIsFba(input: {
  shipsFromAmazon: boolean | null
  soldByAmazon: boolean | null
  isFba?: boolean | null
}): boolean | null {
  if (input.isFba === true || input.isFba === false) return input.isFba
  if (input.shipsFromAmazon === true) return true
  if (input.shipsFromAmazon === false) return false
  return null
}

export function derivePurchasable(input: {
  hasAddToCart?: boolean | null
  hasBuyNow?: boolean | null
  availabilityText?: string | null
  stockStatus?: string | null
}): PurchasableTriState {
  if (input.hasAddToCart === true || input.hasBuyNow === true) return "TRUE"
  const stock = String(input.stockStatus ?? "").trim().toUpperCase()
  if (stock === "IN_STOCK" || stock === "LIMITED_STOCK") return "TRUE"
  const text = `${input.availabilityText ?? ""}`.toLowerCase()
  if (
    /currently unavailable|temporarily out of stock|\bout of stock\b|we don't know when or if this item will be back/.test(
      text
    )
  ) {
    return "FALSE"
  }
  if (stock === "OUT_OF_STOCK") return "FALSE"
  if (/in stock/.test(text)) return "TRUE"
  return "UNKNOWN"
}

export function isTrustedNewAmazonOffer(input: {
  condition: string | null
  shipsFromAmazon: boolean | null
}): boolean {
  return input.condition === "NEW" && input.shipsFromAmazon === true
}

export function detectAmazonAccessFailure(input: {
  pageTitle?: string | null
  url?: string | null
  bodyText?: string | null
  captcha?: boolean | null
}): { code: "CAPTCHA" | "LOGIN_REQUIRED" | "AMAZON_SESSION_UNAVAILABLE" } | null {
  if (input.captcha === true) return { code: "CAPTCHA" }
  const blob = `${input.pageTitle ?? ""} ${input.url ?? ""} ${input.bodyText ?? ""}`.toLowerCase()
  if (/opfcaptcha|validatecaptcha|enter the characters you see|type the characters/.test(blob)) {
    return { code: "CAPTCHA" }
  }
  if (/ap\/signin|amazon.*sign[\s-]?in|auth-workflow/.test(blob)) return { code: "LOGIN_REQUIRED" }
  if (/something went wrong on our end|service unavailable for this request/.test(blob)) {
    return { code: "AMAZON_SESSION_UNAVAILABLE" }
  }
  return null
}
