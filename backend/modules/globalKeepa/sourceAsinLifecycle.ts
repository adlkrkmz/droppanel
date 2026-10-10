/**
 * Pure V2 lifecycle helpers. No new scheduler.
 * Hide is panel-only. qty > 0 is required for monitoring.
 * qty = 0 (any reason) is not eligible — no recovery scan.
 */

export type SourceApplyGuardResult =
  | { ok: true }
  | { ok: false; code: "STALE_SOURCE_RESULT" | "OBSOLETE_SOURCE_RESULT" }

export function isListingLiveForV2(currentStatus: string | null | undefined): boolean {
  const status = String(currentStatus ?? "live").trim().toLowerCase()
  return status === "live" || status === ""
}

export function isV2KeepaMonitorEligible(input: {
  currentStatus: string | null | undefined
  stockGuardEnabled: boolean | null | undefined
  ebayItemId: string | null | undefined
  ebayQuantity: number | null | undefined
  botZeroedAt?: string | Date | null
  sourceAsin?: string | null
  storeActive?: boolean | null
}): boolean {
  if (input.storeActive === false) return false
  if (!isListingLiveForV2(input.currentStatus)) return false
  if (input.stockGuardEnabled === false) return false
  if (!String(input.ebayItemId ?? "").trim()) return false
  if ((Number(input.ebayQuantity ?? 0) || 0) <= 0) return false
  if (input.sourceAsin !== undefined && !String(input.sourceAsin ?? "").trim()) return false
  return true
}

export function classifySourceApplyGuard(input: {
  taskAsin: string
  currentSourceAsin: string | null | undefined
  consumerAsin?: string | null
  listingLive: boolean
  stockGuardEnabled: boolean
  monitorEligible: boolean
  ebayQuantity?: number | null
}): SourceApplyGuardResult {
  const task = String(input.taskAsin ?? "").trim().toUpperCase()
  const current = String(input.currentSourceAsin ?? "").trim().toUpperCase()
  const consumer = String(input.consumerAsin ?? "").trim().toUpperCase()
  if ((Number(input.ebayQuantity ?? 0) || 0) <= 0) {
    return { ok: false, code: "OBSOLETE_SOURCE_RESULT" }
  }
  if (!input.listingLive || !input.stockGuardEnabled || !input.monitorEligible) {
    return { ok: false, code: "OBSOLETE_SOURCE_RESULT" }
  }
  if (!task || !current || current !== task) {
    return { ok: false, code: "STALE_SOURCE_RESULT" }
  }
  if (consumer && consumer !== task) {
    return { ok: false, code: "STALE_SOURCE_RESULT" }
  }
  return { ok: true }
}

export function verifiedBaselineIsSourceScoped(input: {
  lastVerifiedAsin: string | null | undefined
  currentSourceAsin: string | null | undefined
}): boolean {
  const last = String(input.lastVerifiedAsin ?? "").trim().toUpperCase()
  const current = String(input.currentSourceAsin ?? "").trim().toUpperCase()
  if (!last || !current) return false
  return last === current
}

export function activityLogicalKey(kind: string, operationId: string | number): string {
  return `v2:${kind}:${operationId}`
}

/** Same catalog + accepted Amazon cents → one logical Kâr Koruma action (Keepa or Extension). */
export function profitProtectionIdempotencyKey(
  catalogStateId: number,
  amazonAfterCents: number,
  extras?: { adRatePercent?: number | null; targetEbayCents?: number }
): string {
  const ad = extras?.adRatePercent
  const tgt = extras?.targetEbayCents
  if (ad != null && ad > 0 && tgt != null && Number.isFinite(tgt)) {
    return `v2:price_protection:${catalogStateId}:${amazonAfterCents}:ad:${Math.round(ad * 10)}:ebay:${tgt}`
  }
  return `v2:price_protection:${catalogStateId}:${amazonAfterCents}`
}

export function stockZeroIdempotencyKey(catalogStateId: number): string {
  return `v2:stock_zeroed:${catalogStateId}`
}
