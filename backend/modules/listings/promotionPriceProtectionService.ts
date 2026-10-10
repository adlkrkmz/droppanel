import {
  persistCatalogEbayPrice,
  loadCatalogListingForPrice,
  updateListingPriceOnEbay,
} from "./listingsEbayPriceService"
import { calculateRecommendedEbayPrice } from "../pricing/pricingCalculatorService"
import {
  promotionPriceProtectionKey,
  shouldSkipEbayPriceForAdRateChange,
} from "../pricing/promotionPricingContext"

export type PromotionPriceProtectionResult =
  | { ok: true; mutated: boolean; currentEbayPrice: number; targetEbayPrice: number; operationKey: string }
  | { ok: false; code: "PROMOTION_PRICE_PROTECTION_FAILED"; message: string }

/** pg bigint and JSON often arrive as strings; Number.isFinite("22346") is false. */
export function parseCatalogStateId(raw: unknown): number | null {
  if (raw == null || raw === "") return null
  const n = typeof raw === "number" ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) return null
  return n
}

/**
 * Raise-only price guard before enabling or increasing a Promoted Listing rate.
 * Uses the existing eBay offer resolver + updateListingPriceOnEbay path.
 */
export async function raiseEbayPriceForPromotionRate(input: {
  workspaceId: string
  storeId: number
  storeCode: string
  catalogStateId: number | null
  nextAdRatePercent: number
  currentPricingRate?: number
}): Promise<PromotionPriceProtectionResult> {
  if (shouldSkipEbayPriceForAdRateChange(input.currentPricingRate ?? 0, input.nextAdRatePercent)) {
    return {
      ok: true,
      mutated: false,
      currentEbayPrice: 0,
      targetEbayPrice: 0,
      operationKey: "",
    }
  }
  const catalogStateId = parseCatalogStateId(input.catalogStateId)
  if (catalogStateId == null) {
    return {
      ok: false,
      code: "PROMOTION_PRICE_PROTECTION_FAILED",
      message: "Listing eşlemesi güvenilir değil — reklam açılmadı",
    }
  }
  try {
    const listing = await loadCatalogListingForPrice(
      input.workspaceId,
      input.storeCode,
      catalogStateId
    )
    if (!listing) {
      return {
        ok: false,
        code: "PROMOTION_PRICE_PROTECTION_FAILED",
        message: "Listing bulunamadı — reklam açılmadı",
      }
    }
    if (!listing.internalSku && !listing.ebayItemId && !listing.ebayOfferId) {
      return {
        ok: false,
        code: "PROMOTION_PRICE_PROTECTION_FAILED",
        message: "Listing eşlemesi güvenilir değil — reklam açılmadı",
      }
    }
    const amazon = listing.sourcePrice
    if (amazon == null || amazon <= 0) {
      return {
        ok: false,
        code: "PROMOTION_PRICE_PROTECTION_FAILED",
        message: "Kaynak fiyat yok — reklam açılmadı",
      }
    }
    const calc = await calculateRecommendedEbayPrice({
      workspaceId: input.workspaceId,
      storeId: listing.storeId,
      amazonPrice: amazon,
      promotion: { enabled: true, adRatePercent: input.nextAdRatePercent },
    })
    if (calc.pricingSource === "unavailable" || calc.recommendedEbayPrice <= 0) {
      return {
        ok: false,
        code: "PROMOTION_PRICE_PROTECTION_FAILED",
        message: "Güvenli fiyat hesaplanamadı — reklam açılmadı",
      }
    }
    const current = listing.ebayPrice ?? 0
    const target = calc.recommendedEbayPrice
    const operationKey = promotionPriceProtectionKey({
      storeId: listing.storeId,
      catalogStateId: listing.id,
      sourcePriceCents: Math.round(amazon * 100),
      adRatePercent: input.nextAdRatePercent,
      targetEbayCents: Math.round(target * 100),
    })
    if (current > 0 && Math.round(target * 100) <= Math.round(current * 100)) {
      return {
        ok: true,
        mutated: false,
        currentEbayPrice: current,
        targetEbayPrice: target,
        operationKey,
      }
    }
    const mutation = await updateListingPriceOnEbay(input.workspaceId, input.storeCode, {
      internalSku: listing.internalSku,
      ebayItemId: listing.ebayItemId,
      ebayOfferId: listing.ebayOfferId,
      newPrice: target,
      catalogStateId: listing.id,
      storeId: listing.storeId,
    })
    const readback = mutation.readbackPrice
    if (readback == null || Math.round(readback * 100) < Math.round(target * 100)) {
      return {
        ok: false,
        code: "PROMOTION_PRICE_PROTECTION_FAILED",
        message: "Fiyat yükseltme doğrulanamadı — reklam açılmadı",
      }
    }
    await persistCatalogEbayPrice({
      workspaceId: input.workspaceId,
      storeId: listing.storeId,
      catalogStateId: listing.id,
      newPrice: readback,
      manual: false,
      oldPrice: current,
      autoReason: "Promotion price protection",
    })
    return {
      ok: true,
      mutated: mutation.mutated === true,
      currentEbayPrice: current,
      targetEbayPrice: readback,
      operationKey,
    }
  } catch (e) {
    return {
      ok: false,
      code: "PROMOTION_PRICE_PROTECTION_FAILED",
      message: e instanceof Error ? e.message : "Fiyat koruması başarısız — reklam açılmadı",
    }
  }
}
