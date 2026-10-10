/**
 * UI-only mapping for Keepa / source_status_reason — DB values unchanged.
 */

export function formatVerificationSourceLabel(source: string | null | undefined): string {
  switch (source?.trim().toUpperCase()) {
    case "DESKTOP_AGENT": return "Desktop Agent"
    case "SERVER_BROWSER_PUBLIC":
    case "SERVER_BROWSER":
    case "SERVER": return "Sunucu Worker"
    case "SERVER_BROWSER_AUTH": return "Sunucu Giriş Worker"
    case "KEEPA_CONFIRMED": return "Keepa"
    default: return "Kaynak bilinmiyor"
  }
}

const RISK_STATUSES = new Set(["NO_PRICE", "UNAVAILABLE", "REMOVED", "PRICE_UNCERTAIN"])

const COPY = {
  riskReason: {
    tr: "Yeni fiyat / ASIN-kaynak değişikliği",
    en: "New price / ASIN-source change",
  },
  priceIncrease: {
    tr: "Amazon fiyatı arttı",
    en: "Amazon price increased",
  },
  priceUncertain: {
    tr: "Amazon fiyatı kesinleştirilemedi.",
    en: "Amazon price could not be confirmed.",
  },
  amazonOk: {
    tr: "Amazon OK",
    en: "Amazon OK",
  },
  checkFailed: {
    tr: "Kontrol edilemedi",
    en: "Check failed",
  },
} as const

export function isUiTurkish(): boolean {
  if (typeof navigator === "undefined") return false
  return navigator.language?.toLowerCase().startsWith("tr") ?? false
}

function pickCopy(key: keyof typeof COPY): string {
  return isUiTurkish() ? COPY[key].tr : COPY[key].en
}

/** Technical Keepa reasons — never show verbatim in UI */
export function isTechnicalKeepaReason(reason: string | null | undefined): boolean {
  const r = reason?.trim() ?? ""
  if (!r) return false
  return (
    /no new price/i.test(r) ||
    /buybox signal/i.test(r) ||
    /offer signal/i.test(r) ||
    /yeni fiyat\s*\/\s*buybox/i.test(r) ||
    /buybox sinyali/i.test(r) ||
    /availability\s*\/\s*offer/i.test(r) ||
    /kullanılabilirlik/i.test(r) ||
    /no trusted current amazon price/i.test(r) ||
    /active price found:/i.test(r)
  )
}

export function isUserSafeStockAlertReason(reason: string | null | undefined): boolean {
  const r = reason?.trim() ?? ""
  if (!r) return false
  if (isTechnicalKeepaReason(r)) return false
  return (
    r.startsWith("Amazon doğrulaması") ||
    r.startsWith("Amazon fiyatı") ||
    r.startsWith("Amazon'da geçerli Prime/FBA") ||
    r.startsWith("Amazon'da geçerli kaynak bulunamadı") ||
    r.startsWith("Ürün Amazon'da artık mevcut değil") ||
    r.startsWith("Amazon kaynak ASIN") ||
    r.startsWith("Buy box'ta Prime") ||
    r.startsWith("Amazon'da stok yok") ||
    r.startsWith("Amazon'da FBA kaynak") ||
    r.startsWith("Amazon fiyat artışı") ||
    r.startsWith("Amazon kaynağı geçersiz") ||
    r.startsWith("Keepa ")
  )
}

/**
 * User-facing reason for a source status row.
 * Prefer a stored user-safe DB reason. Do not overwrite PRICE_UNCERTAIN with a hardcoded label.
 */
export function formatSourceStatusReasonForUi(
  sourceStatus: string | null | undefined,
  rawReason?: string | null | undefined
): string {
  const status = sourceStatus?.trim().toUpperCase() ?? ""
  const raw = rawReason?.trim() ?? ""

  if (raw && isUserSafeStockAlertReason(raw)) return raw
  if (raw && !isTechnicalKeepaReason(raw)) return raw

  if (status === "PRICE_INCREASE") return pickCopy("priceIncrease")
  if (status === "PRICE_UNCERTAIN") return pickCopy("priceUncertain")
  if (RISK_STATUSES.has(status)) return pickCopy("riskReason")
  if (status === "AMAZON_OK") return pickCopy("amazonOk")
  if (status === "CHECK_FAILED") return pickCopy("checkFailed")

  if (/amazon price increased/i.test(raw)) return pickCopy("priceIncrease")
  if (!raw) return "—"
  return pickCopy("riskReason")
}

export function formatStockAlertStatusLabel(input: {
  sourceStatus: string | null | undefined
  reviewStatus?: string | null
  reason?: string | null
}): string {
  const review = input.reviewStatus?.trim().toLowerCase() ?? ""
  const status = input.sourceStatus?.trim().toUpperCase() ?? ""
  const reason = input.reason?.trim() ?? ""

  if (review === "failed") {
    if (
      status === "PRICE_INCREASE" ||
      reason.includes("Hedef eBay") ||
      (reason.includes("Kâr Koruma") && reason.includes("başarısız"))
    ) {
      return "Kâr Koruma Başarısız"
    }
    if (
      reason.includes("eBay stok güncellemesi başarısız") ||
      reason.includes("eBay stoğu güncellenemedi")
    ) {
      return "Stok Güncellemesi Başarısız"
    }
    return "İşlem Başarısız"
  }
  if (review === "actioned") {
    if (reason.includes("Kâr Koruma")) return "Kâr Koruma"
    if (
      reason.includes("eBay stoğu") ||
      reason.includes("Prime/FBA") ||
      reason.includes("yönlendiriyor") ||
      reason.includes("artık mevcut değil")
    ) {
      return "Stok Sıfırlandı"
    }
    if (status === "PRICE_INCREASE") return "Kâr Koruma"
    return "Stok Sıfırlandı"
  }
  if (status === "PRICE_INCREASE") return "Fiyat Arttı"
  if (status === "PRICE_UNCERTAIN") return "Doğrulama Bekliyor"
  if (status === "REMOVED" || status === "UNAVAILABLE") return "Kaynak yok"
  if (status === "NO_PRICE") return "Fiyat yok"
  if (status === "CHECK_FAILED") return "Kontrol başarısız"
  return status || "Needs review"
}

/** Sanitize free-form notification / message bodies */
export function scrubTechnicalReasonInText(text: string | null | undefined): string {
  const t = text?.trim() ?? ""
  if (!t) return ""
  if (isTechnicalKeepaReason(t)) return pickCopy("riskReason")
  return t
    .split("\n")
    .map(line => (isTechnicalKeepaReason(line) ? pickCopy("riskReason") : line))
    .join("\n")
}
