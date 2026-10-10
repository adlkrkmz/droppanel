import { query } from "../../db/client"
import type { PromotedListingStatus } from "../ebay/ebayPromotedTypes"
import type { PromotionPricingContext } from "./pricingTypes"

export function adRatePercentForPricing(input: {
  status: PromotedListingStatus | null | undefined
  requested?: boolean
  requestedRate: number | null
  effectiveRate: number | null
}): number | null {
  const status = input.status
  if (!status || status === "OFF") return null
  if (status === "ACTIVE") return input.effectiveRate ?? input.requestedRate
  if (status === "PENDING") return input.requestedRate
  if ((status === "UNKNOWN" || status === "FAILED") && input.requested) {
    return input.requestedRate ?? input.effectiveRate
  }
  return null
}

export function shouldSkipEbayPriceForAdRateChange(currentPricingRate: number, nextRate: number): boolean {
  if (!Number.isFinite(nextRate) || nextRate <= 0) return true
  return Number.isFinite(currentPricingRate) && currentPricingRate > 0 && nextRate < currentPricingRate
}

export function promotionRequiresPriceRaise(currentPricingRate: number, nextRate: number): boolean {
  return !shouldSkipEbayPriceForAdRateChange(currentPricingRate, nextRate)
}

export function promotionPriceProtectionKey(input: {
  storeId: number
  catalogStateId: number
  sourcePriceCents: number
  adRatePercent: number
  targetEbayCents: number
}): string {
  return [
    "v2:promo_price",
    input.storeId,
    input.catalogStateId,
    input.sourcePriceCents,
    Math.round(input.adRatePercent * 10),
    input.targetEbayCents,
  ].join(":")
}

function nRate(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export async function loadPromotionPricingContext(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
}): Promise<PromotionPricingContext | undefined> {
  const res = await query<{
    status: PromotedListingStatus
    requested: boolean
    requested_rate: string | null
    effective_rate: string | null
  }>(
    `SELECT status, requested, requested_rate::text, effective_rate::text
     FROM ebay_listing_promotions
     WHERE workspace_id = $1::uuid AND store_id = $2 AND catalog_state_id = $3
     LIMIT 1`,
    [input.workspaceId, input.storeId, input.catalogStateId]
  )
  const row = res.rows[0]
  if (!row) return undefined
  const rate = adRatePercentForPricing({
    status: row.status,
    requested: row.requested,
    requestedRate: nRate(row.requested_rate),
    effectiveRate: nRate(row.effective_rate),
  })
  if (rate == null || rate <= 0) return undefined
  return { enabled: true, adRatePercent: rate }
}
