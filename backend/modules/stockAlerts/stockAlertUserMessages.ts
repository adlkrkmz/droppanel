export const PRICE_UNCERTAIN_GENERIC =
  "Amazon fiyatı kesinleştirilemedi."

export const PRICE_UNCERTAIN_QUEUED =
  "Amazon fiyatı kesinleştirilemedi. Extension doğrulamasına gönderildi."

export const PRICE_UNCERTAIN_WAITING =
  "Amazon doğrulaması bekliyor. Extension çevrimiçi olduğunda kontrol edilecek."

export const PRICE_UNCERTAIN_QUEUED_LEGACY =
  "Amazon fiyatı kesinleştirilemedi. Extension doğrulamasına gönderildi."

export const PRICE_UNCERTAIN_WAITING_LEGACY =
  "Amazon doğrulaması bekliyor. Extension çevrimiçi olduğunda kontrol edilecek."

export const VERIFICATION_FAILED_GENERIC = "Amazon doğrulaması başarısız oldu."

export const PRICE_INCREASE_FAILED =
  "Amazon fiyat artışı doğrulandı ancak eBay fiyatı güncellenemedi."

export const STOCK_ZERO_FAILED =
  "Amazon kaynağı geçersiz doğrulandı ancak eBay stoğu güncellenemedi."

export const VERIFIED_SOURCE_UNCHANGED_IGNORE =
  "Resolved — verified source unchanged"

export const PROFIT_PROTECTION_NOOP_IGNORE =
  "Resolved — eBay price already at protected target; no update submitted"

function money(n: number): string {
  return `$${n.toFixed(2)}`
}

export function formatPriceIncreasePendingReason(amazonBefore: number, amazonAfter: number): string {
  return `Amazon fiyatı ${money(amazonBefore)} → ${money(amazonAfter)} yükseldi. Doğrulandı; fiyat güncellemesi onay bekliyor.`
}

export type PriceConfirmationSource = "KEEPA_CONFIRMED" | "EXTENSION_VERIFIED" | "DESKTOP_AGENT" | "SERVER_BROWSER_PUBLIC" | "SERVER_BROWSER_AUTH"

function confirmationSentence(source: PriceConfirmationSource | undefined): string {
  if (source === "KEEPA_CONFIRMED") return "Keepa tarafından doğrulandı."
  if (source === "DESKTOP_AGENT") return "Desktop Agent doğrulaması tamamlandı."
  if (source === "SERVER_BROWSER_AUTH") return "Sunucu giriş worker doğrulaması tamamlandı."
  if (source === "SERVER_BROWSER_PUBLIC") return "Sunucu worker doğrulaması tamamlandı."
  return "Amazon doğrulaması tamamlandı."
}

export function formatProfitProtectionReason(input: {
  amazonBefore: number
  amazonAfter: number
  ebayBefore: number
  ebayAfter: number
  confirmation?: PriceConfirmationSource
}): string {
  if (!(input.amazonAfter > input.amazonBefore)) {
    return (
      `Amazon kaynak fiyatı ${money(input.amazonAfter)} olarak doğrulandı. ` +
      `Kâr Koruma için gerekli eBay fiyatı ${money(input.ebayAfter)} olarak hesaplandı; ` +
      `mevcut fiyat ${money(input.ebayBefore)}. ` +
      `${confirmationSentence(input.confirmation)}`
    )
  }
  return (
    `Amazon fiyatı ${money(input.amazonBefore)} → ${money(input.amazonAfter)} yükseldi. ` +
    `${confirmationSentence(input.confirmation)} ` +
    `Kâr Koruma için eBay fiyatı ${money(input.ebayBefore)} → ${money(input.ebayAfter)} olarak güncellendi.`
  )
}

export function formatProfitProtectionFailedReason(input: {
  amazonBefore: number
  amazonAfter: number
  currentEbay?: number
  targetEbay: number
  error: string
}): string {
  const err = input.error.trim() || "eBay API hatası"
  if (!(input.amazonAfter > input.amazonBefore)) {
    return (
      `Amazon kaynak fiyatı ${money(input.amazonAfter)} olarak doğrulandı. ` +
      `Kâr Koruma için gerekli eBay fiyatı ${money(input.targetEbay)} olarak hesaplandı; ` +
      `mevcut fiyat ${money(input.currentEbay ?? 0)}. ` +
      `eBay fiyat güncellemesi başarısız: ${err}.`
    )
  }
  return (
    `Amazon fiyatı ${money(input.amazonBefore)} → ${money(input.amazonAfter)} yükseldi. ` +
    `Kâr Koruma için eBay fiyatı ${money(input.currentEbay ?? 0)} → ${money(input.targetEbay)} olarak hesaplandı. ` +
    `eBay fiyat güncellemesi başarısız: ${err}.`
  )
}

export function safeEbayErrorMessage(err: string): string {
  let s = err
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/(authorization|token|secret|refresh)[=:\s]+\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
  if (!s) return "eBay API hatası"
  if (s.length > 480) s = `${s.slice(0, 477)}...`
  return s
}

export const CONFIRMED_NO_VALID_SOURCE_ACTION_GATED =
  "Amazon'da geçerli Prime/FBA kaynak doğrulanamadı; eBay aksiyonu kapalı, stok değiştirilmedi."

export function formatConfirmedInvalidSourcePendingReason(input: { code: string }): string {
  return formatVerifiedCheckPendingReason(input.code)
}

export function formatVerifiedCheckPendingReason(code: string): string {
  if (code === "NOT_PRIME") {
    return "Buy box'ta Prime rozeti bulunamadı. eBay stoğu değiştirilmedi; onay bekliyor."
  }
  if (code === "NOT_FBA") {
    return "Amazon'da FBA kaynak bulunamadı. eBay stoğu değiştirilmedi; onay bekliyor."
  }
  if (code === "OUT_OF_STOCK") {
    return "Amazon'da stok yok. eBay stoğu değiştirilmedi; onay bekliyor."
  }
  if (code === "PRICE_NOT_FOUND") {
    return "Amazon fiyatı okunamadı. eBay stoğu değiştirilmedi; onay bekliyor."
  }
  if (code === "SOURCE_ASIN_MISMATCH" || code === "SOURCE_ASIN_REDIRECTED") {
    return "Amazon sayfa ASIN'i beklenen üründen farklı. eBay stoğu değiştirilmedi; onay bekliyor."
  }
  if (code === "PRODUCT_UNAVAILABLE" || code === "PRODUCT_NOT_FOUND" || code === "ASIN_REMOVED") {
    return "Ürün Amazon'da artık mevcut değil. Kaynak ASIN kaldırılmış olarak değerlendirildi. eBay stoğu değiştirilmedi; onay bekliyor."
  }
  return "Amazon Prime veya fiyat doğrulanamadı. eBay stoğu değiştirilmedi; onay bekliyor."
}

export function formatStockZeroReason(input: {
  code: string
  oldQty: number
  confirmation?: PriceConfirmationSource
}): string {
  const qty = Number.isFinite(input.oldQty) ? Math.max(0, Math.round(input.oldQty)) : 0
  const confirmed =
    input.confirmation === "KEEPA_CONFIRMED"
      ? "Keepa tarafından kesin olarak tespit edildi."
      : "Amazon doğrulaması tamamlandı."
  if (input.code === "SOURCE_ASIN_MISMATCH" || input.code === "SOURCE_ASIN_REDIRECTED") {
    return `Amazon kaynak ASIN'i başka ürüne yönlendiriyor. Kaynak geçersiz; ${confirmed} eBay stoğu ${qty} → 0 çekildi.`
  }
  if (
    input.code === "PRODUCT_UNAVAILABLE" ||
    input.code === "PRODUCT_NOT_FOUND" ||
    input.code === "ASIN_REMOVED"
  ) {
    return `Ürün Amazon'da artık mevcut değil. Kaynak ASIN kaldırılmış olarak değerlendirildi. eBay stoğu ${qty} → 0 çekildi.`
  }
  if (input.code === "OUT_OF_STOCK") {
    return `Amazon'da stok yok. ${confirmed} eBay stoğu ${qty} → 0 çekildi.`
  }
  if (input.code === "NOT_PRIME") {
    return `Buy box'ta Prime rozeti bulunamadı. ${confirmed} eBay stoğu ${qty} → 0 çekildi.`
  }
  if (input.code === "NOT_FBA" || input.code === "FBM_ONLY") {
    return `Amazon'da FBA kaynak bulunamadı. ${confirmed} eBay stoğu ${qty} → 0 çekildi.`
  }
  return `Amazon'da geçerli Prime/FBA kaynak bulunamadı. ${confirmed} eBay stoğu ${qty} → 0 çekildi.`
}

export function formatStockZeroFailedReason(input: {
  oldQty?: number
  error: string
}): string {
  const err = input.error.trim() || "eBay API hatası"
  return `Amazon'da geçerli kaynak bulunamadı ancak eBay stok güncellemesi başarısız oldu: ${err}`
}

export function verificationEnqueueReason(waitingForWorker: boolean): string {
  return waitingForWorker ? PRICE_UNCERTAIN_WAITING : PRICE_UNCERTAIN_QUEUED
}

export function formatVerificationFailedReason(code: string, message?: string): string {
  const detail = (message ?? "").replace(/\s+/g, " ").trim()
  if (detail && !/worker_error|unexpected token|page\.evaluate/i.test(detail)) {
    const clipped = detail.length > 180 ? `${detail.slice(0, 177)}...` : detail
    return `Amazon doğrulaması başarısız oldu: ${clipped}`
  }
  if (code === "MAX_ATTEMPTS_EXCEEDED") return VERIFICATION_FAILED_GENERIC
  return VERIFICATION_FAILED_GENERIC
}

const PRESERVED_UNCERTAIN_REASONS = new Set([
  PRICE_UNCERTAIN_QUEUED,
  PRICE_UNCERTAIN_WAITING,
  PRICE_UNCERTAIN_QUEUED_LEGACY,
  PRICE_UNCERTAIN_WAITING_LEGACY,
])

export function shouldPreserveUncertainReason(
  existing: string | null | undefined,
  incoming: string | null | undefined
): boolean {
  const prev = existing?.trim() ?? ""
  const next = incoming?.trim() ?? ""
  if (!PRESERVED_UNCERTAIN_REASONS.has(prev)) return false
  if (PRESERVED_UNCERTAIN_REASONS.has(next)) return false
  return true
}

export function canReplacePendingReviewWithUncertain(sourceStatus: string | null | undefined): boolean {
  const s = String(sourceStatus ?? "").trim().toUpperCase()
  if (!s) return true
  return s === "PRICE_UNCERTAIN" || s === "CHECK_FAILED" || s === "NO_PRICE"
}

export function isOperationalUserReason(reason: string | null | undefined): boolean {
  const r = reason?.trim() ?? ""
  if (!r) return false
  return (
    r === PRICE_UNCERTAIN_GENERIC ||
    r === PRICE_UNCERTAIN_QUEUED ||
    r === PRICE_UNCERTAIN_WAITING ||
    r === PRICE_UNCERTAIN_QUEUED_LEGACY ||
    r === PRICE_UNCERTAIN_WAITING_LEGACY ||
    r === VERIFICATION_FAILED_GENERIC ||
    r.startsWith("Amazon doğrulaması başarısız oldu") ||
    r === PRICE_INCREASE_FAILED ||
    r === STOCK_ZERO_FAILED ||
    r.startsWith("Amazon fiyatı $") ||
    r.startsWith("Amazon'da geçerli Prime/FBA") ||
    r.startsWith("Amazon'da geçerli kaynak bulunamadı ancak") ||
    r.startsWith("Ürün Amazon'da artık mevcut değil") ||
    r.startsWith("Amazon kaynak ASIN") ||
    r.startsWith("Buy box'ta Prime") ||
    r.startsWith("Amazon'da stok yok") ||
    r.startsWith("Amazon'da FBA kaynak") ||
    r.startsWith("Amazon fiyatı okunamadı") ||
    r.startsWith("Amazon sayfa ASIN") ||
    r.startsWith("Amazon Prime veya fiyat")
  )
}

export function formatStockAlertStatusLabel(input: {
  sourceStatus: string | null | undefined
  reviewStatus: string | null | undefined
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
    if (reason.includes("Kâr Koruma") || status === "PRICE_INCREASE") return "Kâr Koruma"
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
