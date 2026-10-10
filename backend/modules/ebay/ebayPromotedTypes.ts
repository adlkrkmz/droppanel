export const EBAY_PROMOTED_MARKETPLACE = "EBAY_US"
export const EBAY_PROMOTED_STRATEGY = "GENERAL"
export const EBAY_PROMOTED_FUNDING = "COST_PER_SALE"
export const EBAY_PROMOTED_MIN_RATE = 2
export const EBAY_PROMOTED_MAX_RATE = 100

export type PromotedListingStatus = "OFF" | "PENDING" | "ACTIVE" | "FAILED" | "UNKNOWN"

export type PromotedParseResult =
  | { ok: true; enabled: false; rate: null }
  | { ok: true; enabled: true; rate: number }
  | { ok: false; code: string; message: string }

export type PromotionPublic = {
  requested: boolean
  requestedRate: number | null
  status: PromotedListingStatus
  effectiveRate: number | null
  campaignId: string | null
  adId: string | null
  code: string | null
  message: string
  retryable: boolean
}

function formatRate(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return String(Math.round(n * 10) / 10)
}

export function ebayBidPercentage(rate: number): string {
  if (Number.isInteger(rate)) return `${rate}.0`
  return formatRate(rate)
}

export function parsePromotedRequest(input: {
  promotedEnabled?: unknown
  promotedAdRate?: unknown
}): PromotedParseResult {
  const rawEnabled = input.promotedEnabled
  const enabled =
    rawEnabled === true ||
    rawEnabled === "true" ||
    rawEnabled === 1 ||
    rawEnabled === "1"
  if (!enabled) {
    return { ok: true, enabled: false, rate: null }
  }
  const raw = input.promotedAdRate
  if (raw === null || raw === undefined || raw === "") {
    return { ok: false, code: "INVALID_AD_RATE", message: "Reklam oranı 2 ile 100 arasında olmalıdır" }
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim().replace("%", ""))
  if (!Number.isFinite(n) || n < EBAY_PROMOTED_MIN_RATE || n > EBAY_PROMOTED_MAX_RATE) {
    return { ok: false, code: "INVALID_AD_RATE", message: "Reklam oranı 2 ile 100 arasında olmalıdır" }
  }
  const rate = Number.isInteger(n) ? n : Math.round(n * 10) / 10
  return { ok: true, enabled: true, rate }
}

export function promotionUserMessage(input: {
  status: PromotedListingStatus
  requested: boolean
  rate?: number | null
  code?: string | null
}): string {
  if (!input.requested && input.status === "OFF") return "Reklam kapalı"
  if (input.status === "ACTIVE" && input.rate != null) return `Reklam %${formatRate(input.rate)} aktif`
  if (input.status === "PENDING") {
    if (input.code === "NEW_LISTING_MARKETING_VISIBILITY_DELAY") {
      return "Ürün yayınlandı. Reklam bağlantısı eBay tarafından hazırlanıyor."
    }
    return "Reklam bağlantısı bekleniyor"
  }
  if (input.status === "UNKNOWN") return "Reklam durumu bilinmiyor"
  if (input.code === "MARKETING_SCOPE_REQUIRED") {
    return "Bu mağazada reklam yetkisi yok. eBay bağlantısını yenileyin."
  }
  if (input.code === "PROMOTION_PRICE_PROTECTION_FAILED") {
    return "Fiyat koruması başarısız — reklam açılmadı"
  }
  if (input.status === "FAILED") {
    return "Ürün yayınlandı, reklam bağlantısı tamamlanamadı"
  }
  return "Reklam kapalı"
}

export function promotionRetryable(status: PromotedListingStatus, code: string | null): boolean {
  if (status !== "FAILED" && status !== "UNKNOWN" && status !== "PENDING") return false
  if (
    code === "INVALID_AD_RATE" ||
    code === "LISTING_NOT_ELIGIBLE" ||
    code === "PROMOTION_PRICE_PROTECTION_FAILED" ||
    code === "MARKETING_SCOPE_REQUIRED" ||
    code === "CAMPAIGN_INVALID_OR_NOT_RUNNING" ||
    code === "AD_CREATE_PAYLOAD_INVALID" ||
    code === "CAMPAIGN_CREATE_PAYLOAD_INVALID"
  ) {
    return false
  }
  if (code === "NEW_LISTING_MARKETING_VISIBILITY_DELAY") return true
  return status === "PENDING" || status === "UNKNOWN" || status === "FAILED"
}

export function toPromotionPublic(row: {
  requested: boolean
  requestedRate: number | null
  status: PromotedListingStatus
  effectiveRate: number | null
  campaignId: string | null
  adId: string | null
  lastErrorCode: string | null
  lastErrorMessage?: string | null
}): PromotionPublic {
  const rate = row.effectiveRate ?? row.requestedRate
  const failedMsg = row.lastErrorMessage?.trim() || promotionUserMessage({
    status: row.status,
    requested: row.requested,
    rate,
    code: row.lastErrorCode,
  })
  return {
    requested: row.requested,
    requestedRate: row.requestedRate,
    status: row.status,
    effectiveRate: row.effectiveRate,
    campaignId: row.campaignId,
    adId: row.adId,
    code: row.lastErrorCode,
    message: row.status === "FAILED" || row.status === "UNKNOWN"
      ? failedMsg
      : promotionUserMessage({
          status: row.status,
          requested: row.requested,
          rate,
          code: row.lastErrorCode,
        }),
    retryable: promotionRetryable(row.status, row.lastErrorCode),
  }
}

export function sanitizeMarketingError(raw: string, errorId?: number | null): {
  code: string
  message: string
  retryable: boolean
} {
  const id = errorId ?? (() => {
    const m = String(raw).match(/\b(35\d{3}|250\d{2})\b/)
    return m ? Number(m[1]) : null
  })()
  const text = String(raw || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  const prefix = (why: string) => `Reklam bağlantısı tamamlanamadı: ${why}`
  if (id === 35031 || /listing.*(not found|does not exist|not (yet )?available|invalid)/i.test(text)) {
    return {
      code: "NEW_LISTING_MARKETING_VISIBILITY_DELAY",
      message: "Ürün yayınlandı. Reklam bağlantısı eBay tarafından hazırlanıyor.",
      retryable: true,
    }
  }
  if (id === 35008 || id === 35007) {
    return { code: "CAMPAIGN_CREATE_PAYLOAD_INVALID", message: prefix("kampanya oluşturulamadı"), retryable: false }
  }
  if (id === 35060) {
    return { code: "CAMPAIGN_CREATE_PAYLOAD_INVALID", message: prefix("kampanya başlangıç zamanı geçersiz"), retryable: false }
  }
  if (id === 35051 || id === 35110 || id === 35115 || id === 25002) {
    return { code: "LISTING_NOT_ELIGIBLE", message: prefix("bu listing eBay reklamına uygun değil"), retryable: false }
  }
  if (id === 35024 || /already exists|duplicate/i.test(text)) {
    return { code: "AD_ALREADY_EXISTS", message: prefix("bu listing için reklam zaten var"), retryable: true }
  }
  if (/invalid_scope|insufficient.?scope|sell\.marketing/i.test(text)) {
    return {
      code: "MARKETING_SCOPE_REQUIRED",
      message: "Bu mağazada reklam yetkisi yok. eBay bağlantısını yenileyin.",
      retryable: false,
    }
  }
  if (/not found|does not exist/i.test(text)) {
    return {
      code: "NEW_LISTING_MARKETING_VISIBILITY_DELAY",
      message: "Ürün yayınlandı. Reklam bağlantısı eBay tarafından hazırlanıyor.",
      retryable: true,
    }
  }
  if (/missing campaignid/i.test(text)) {
    return { code: "CAMPAIGN_ALREADY_CREATED_DB_NOT_SAVED", message: prefix("kampanya kimliği alınamadı"), retryable: false }
  }
  return { code: "MARKETING_API_ERROR", message: prefix("eBay reklam işlemi tamamlanamadı"), retryable: false }
}
