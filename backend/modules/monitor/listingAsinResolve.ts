/** Shared ASIN resolution — no DB. Reused by monitor + global Keepa backfill. */

export function parseAsinFromSku(sku: string): string | null {
  const trimmed = sku.trim().toUpperCase()
  if (/^[A-Z0-9]{10}$/.test(trimmed)) return trimmed
  const match1 = sku.match(/^DP-([A-Z0-9]{10})-[A-Z0-9]+$/)
  if (match1) return match1[1]
  const match2 = sku.match(/^DP([A-Z0-9]{10})[A-Z0-9]{1,4}$/)
  if (match2) return match2[1]
  return null
}

export function parseAsinFromSourceUrl(url: string | null | undefined): string | null {
  if (!url?.trim()) return null
  const m =
    url.match(/amazon\.com\/dp\/([A-Z0-9]{10})/i) ??
    url.match(/amazon\.com\/gp\/product\/([A-Z0-9]{10})/i)
  return m?.[1]?.toUpperCase() ?? null
}

/** 1. asin_registry  2. source_url  3. SKU parse */
export function resolveListingAsin(input: {
  registryAsin: string | null | undefined
  sourceUrl:    string | null | undefined
  internalSku:  string
}): string | null {
  return inspectListingAsin(input).asin
}

/** Listing ASIN, then matching consumer ASIN — apply path only, not Keepa radar. */
export function resolveApplySourceAsin(input: {
  registryAsin: string | null | undefined
  sourceUrl: string | null | undefined
  internalSku: string
  consumerAsin?: string | null
}): string | null {
  const listing = resolveListingAsin(input)
  if (listing) return listing
  const consumer = String(input.consumerAsin ?? "").trim().toUpperCase()
  return /^[A-Z0-9]{10}$/.test(consumer) ? consumer : null
}

export type AsinResolutionSource = "REGISTRY" | "SOURCE_URL" | "SKU"

export type UnresolvedAsinReason =
  | "NO_REGISTRY"
  | "NO_SOURCE_URL_ASIN"
  | "NO_SKU_ASIN"
  | "INVALID_ASIN_FORMAT"
  | "OTHER"

export type ListingAsinInspection =
  | { asin: string; source: AsinResolutionSource; reason: null }
  | { asin: null; source: null; reason: UnresolvedAsinReason }

/** Same chain as resolveListingAsin, plus unresolved reason (no guessing). */
export function inspectListingAsin(input: {
  registryAsin: string | null | undefined
  sourceUrl:    string | null | undefined
  internalSku:  string
}): ListingAsinInspection {
  const registryRaw = input.registryAsin?.trim().toUpperCase() ?? ""
  if (registryRaw) {
    if (/^[A-Z0-9]{10}$/.test(registryRaw)) {
      return { asin: registryRaw, source: "REGISTRY", reason: null }
    }
  }

  const fromUrl = parseAsinFromSourceUrl(input.sourceUrl)
  if (fromUrl) return { asin: fromUrl, source: "SOURCE_URL", reason: null }

  const fromSku = parseAsinFromSku(input.internalSku?.trim() ?? "")
  if (fromSku) return { asin: fromSku, source: "SKU", reason: null }

  if (registryRaw && !/^[A-Z0-9]{10}$/.test(registryRaw)) {
    return { asin: null, source: null, reason: "INVALID_ASIN_FORMAT" }
  }
  if (input.sourceUrl?.trim()) {
    return { asin: null, source: null, reason: "NO_SOURCE_URL_ASIN" }
  }
  if (input.internalSku?.trim()) {
    return { asin: null, source: null, reason: "NO_SKU_ASIN" }
  }
  if (!registryRaw) return { asin: null, source: null, reason: "NO_REGISTRY" }
  return { asin: null, source: null, reason: "OTHER" }
}
