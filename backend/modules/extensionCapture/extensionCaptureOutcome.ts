// ----------------------------------------------------------------
// extensionCaptureOutcome.ts — short, safe capture/publish outcome for UI
// ----------------------------------------------------------------

export type ExtensionCaptureUiStatus =
  | "uploaded"
  | "queued"
  | "already_exists"
  | "failed"
  | "unknown"

export type ExtensionCaptureOutcome = {
  ok: boolean
  status: ExtensionCaptureUiStatus
  code: string
  message: string
  retryable: boolean
  alreadyExists: boolean
}

function stripSecrets(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/access_token["']?\s*[:=]\s*["'][^"']+/gi, "access_token=[redacted]")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function ebayErrorId(raw: string): string | null {
  const m = raw.match(/"errorId"\s*:\s*(\d+)/)
  return m ? m[1] : null
}

export function summarizeExtensionCaptureOutcome(input: {
  itemStatus: string
  errorMessage?: string | null
  listingId?: string | null
}): ExtensionCaptureOutcome {
  const itemStatus = String(input.itemStatus || "")
  const listingId = String(input.listingId || "").trim()
  const err = stripSecrets(String(input.errorMessage || ""))
  const ebayId = ebayErrorId(err)

  if (itemStatus === "published" || listingId) {
    return {
      ok: true,
      status: "uploaded",
      code: "PUBLISHED",
      message: "eBay'e yüklendi",
      retryable: false,
      alreadyExists: Boolean(listingId) && itemStatus !== "published",
    }
  }

  if (itemStatus === "skipped_duplicate") {
    return {
      ok: true,
      status: "already_exists",
      code: "ALREADY_EXISTS",
      message: "Bu ASIN zaten mevcut",
      retryable: false,
      alreadyExists: true,
    }
  }

  if (
    itemStatus === "queued_for_publish" ||
    itemStatus === "queued_for_pool" ||
    itemStatus === "captured" ||
    itemStatus === "capturing" ||
    itemStatus === "capture_pending"
  ) {
    return {
      ok: true,
      status: "queued",
      code: "QUEUED",
      message: "Kuyruğa alındı",
      retryable: false,
      alreadyExists: false,
    }
  }

  if (itemStatus === "added_to_pool") {
    return {
      ok: true,
      status: "queued",
      code: "ADDED_TO_POOL",
      message: "Havuza alındı",
      retryable: false,
      alreadyExists: false,
    }
  }

  const policyHit =
    ebayId === "25019" ||
    /improper words|profanity|EBAY_HIGH_RISK|High-risk category/i.test(err)
  if (policyHit) {
    return {
      ok: false,
      status: "failed",
      code: ebayId ? `EBAY_${ebayId}` : "EBAY_POLICY",
      message: "eBay başlık/politika ihlali",
      retryable: false,
      alreadyExists: false,
    }
  }

  const httpStatus = Number(err.match(/HTTP\s+(\d{3})/i)?.[1] ?? 0)
  const localMissing = err.match(/^MISSING_REQUIRED_ITEM_SPECIFIC:\s*(.+)$/i)?.[1]?.trim()
  const invalidAspectName = /item specific name.*(?:too short|invalid)/i.test(err)
  const itemSpecificValidation =
    Boolean(localMissing) ||
    (httpStatus >= 400 && httpStatus < 500 &&
      (ebayId === "25002" || /item specific|user error has occurred/i.test(err)))
  if (itemSpecificValidation) {
    return {
      ok: false,
      status: "failed",
      code: localMissing
        ? "MISSING_REQUIRED_ITEM_SPECIFIC"
        : ebayId ? `EBAY_${ebayId}_VALIDATION` : "EBAY_VALIDATION",
      message: localMissing
        ? `Eksik zorunlu ürün özelliği: ${localMissing}`
        : invalidAspectName
          ? "Geçersiz ürün özelliği adı"
        : "eBay ürün özelliği doğrulama hatası",
      retryable: false,
      alreadyExists: false,
    }
  }

  const transient =
    httpStatus >= 500 ||
    /try again later|System error/i.test(err)
  if (transient) {
    return {
      ok: false,
      status: "failed",
      code: ebayId ? `EBAY_${ebayId}` : "EBAY_TRANSIENT",
      message: "eBay geçici sistem hatası",
      retryable: true,
      alreadyExists: false,
    }
  }

  if (/timeout|aborted|Failed to fetch|ECONNRESET/i.test(err)) {
    return {
      ok: false,
      status: "unknown",
      code: "TIMEOUT",
      message: "Sonuç bilinmiyor — tekrar kontrol ediliyor",
      retryable: true,
      alreadyExists: false,
    }
  }

  // A completed extension payload can be intentionally stopped by the Direct
  // List availability gate.  This is not an extractor/capture failure and the
  // UI must retain the specific fail-closed reason.
  if (itemStatus === "capture_blocked") {
    const availabilityBlock = err.match(/^(NOT_PRIME|PRIME_UNKNOWN|OUT_OF_STOCK|LIMITED_STOCK|STOCK_UNKNOWN):\s*(.*)$/i)
    if (availabilityBlock) {
      const reason = availabilityBlock[1].toUpperCase()
      const messages: Record<string, string> = {
        NOT_PRIME: "Prime uygunluğu doğrulanamadı",
        PRIME_UNKNOWN: "Prime uygunluğu doğrulanamadı",
        OUT_OF_STOCK: "Amazon’da stokta yok",
        LIMITED_STOCK: "Amazon’da sınırlı stok",
        STOCK_UNKNOWN: "Amazon stok durumu doğrulanamadı",
      }
      return {
        ok: false,
        status: "failed",
        code: reason,
        message: messages[reason] ?? err.slice(0, 80),
        retryable: false,
        alreadyExists: false,
      }
    }
  }

  if (itemStatus === "failed" || itemStatus === "extract_failed" || itemStatus === "capture_blocked") {
    const short = err.slice(0, 80) || "Yükleme başarısız"
    return {
      ok: false,
      status: "failed",
      code: ebayId ? `EBAY_${ebayId}` : "CAPTURE_FAILED",
      message: short,
      retryable: /retry|try again|HTTP 5/i.test(err),
      alreadyExists: false,
    }
  }

  return {
    ok: false,
    status: "unknown",
    code: "UNKNOWN",
    message: "Sonuç bilinmiyor — tekrar kontrol ediliyor",
    retryable: true,
    alreadyExists: false,
  }
}
