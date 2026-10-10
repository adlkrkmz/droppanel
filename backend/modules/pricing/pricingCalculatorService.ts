import { getSettingsByStore } from "../storeSettings/storeSettingsRepository"
import { calculateListingPrice } from "./pricingService"
import type { PromotionPricingContext } from "./pricingTypes"

export type RecommendedEbayPriceResult = {
  amazonPrice: number
  storeMarkupPercent: number
  recommendedEbayPrice: number
  pricingSource: "existing_listing_pricing_calculator" | "unavailable"
  promotionApplied: boolean
  promotionAdRatePercent: number | null
  adFeeTaxPercent: number | null
  effectiveAdCostPercent: number | null
  estimatedAdFeeAmount: number
  unpromotedRecommendedEbayPrice: number
  promotedRecommendedEbayPrice: number | null
}

function parsePositivePrice(value: unknown): number | null {
  if (value == null || value === "") return null
  const n = typeof value === "number" ? value : parseFloat(String(value).trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

function unavailable(amazon: number, percentage: number): RecommendedEbayPriceResult {
  return {
    amazonPrice: amazon,
    storeMarkupPercent: percentage,
    recommendedEbayPrice: 0,
    pricingSource: "unavailable",
    promotionApplied: false,
    promotionAdRatePercent: null,
    adFeeTaxPercent: null,
    effectiveAdCostPercent: null,
    estimatedAdFeeAmount: 0,
    unpromotedRecommendedEbayPrice: 0,
    promotedRecommendedEbayPrice: null,
  }
}

export async function calculateRecommendedEbayPrice(input: {
  workspaceId: string
  storeId: number
  amazonPrice: number
  promotion?: PromotionPricingContext | null
}): Promise<RecommendedEbayPriceResult> {
  const amazon = parsePositivePrice(input.amazonPrice)
  if (amazon == null) return unavailable(0, 0)
  const settings = await getSettingsByStore(input.workspaceId, input.storeId)
  const percentage = settings?.percentageNetProfitPercent ?? 0
  if (!settings?.enabled || percentage <= 0) {
    return unavailable(amazon, percentage)
  }
  const result = calculateListingPrice({
    amazonCost: amazon,
    pricingMode: settings.pricingMode,
    percentageNetProfitPercent: percentage,
    tieredProfitOverrides: settings.tieredProfitOverrides,
    promotion: input.promotion,
  })
  return {
    amazonPrice: amazon,
    storeMarkupPercent: percentage,
    recommendedEbayPrice: result.calculatedListingPrice,
    pricingSource: "existing_listing_pricing_calculator",
    promotionApplied: result.promotionApplied,
    promotionAdRatePercent: result.promotionAdRatePercent,
    adFeeTaxPercent: result.adFeeTaxPercent,
    effectiveAdCostPercent: result.effectiveAdCostPercent,
    estimatedAdFeeAmount: result.estimatedAdFeeAmount,
    unpromotedRecommendedEbayPrice: result.unpromotedCalculatedListingPrice,
    promotedRecommendedEbayPrice: result.promotedCalculatedListingPrice,
  }
}
