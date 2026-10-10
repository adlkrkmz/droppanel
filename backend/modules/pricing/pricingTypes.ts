export const PRICING_MODES = [
  "PERCENTAGE_NET_PROFIT",
  "TIERED_MIN_NET_PROFIT",
] as const

export type PricingMode = (typeof PRICING_MODES)[number]

/** Manual Amazon cost range → minimum net profit ($) */
export type TieredProfitRange = {
  minPrice: number
  maxPrice: number
  minNetProfit: number
}

/** @deprecated Legacy bucket map shape — accepted on read/migrate only */
export type LegacyTieredProfitOverrides = Record<string, number>

/** Stored / API shape: ordered list of manual price ranges */
export type TieredProfitOverrides = TieredProfitRange[]

export type PromotionPricingContext = {
  enabled?: boolean
  adRatePercent?: number | null
  adFeeTaxPercent?: number | null
}

export type ListingPriceInput = {
  amazonCost: number
  pricingMode: PricingMode
  percentageNetProfitPercent: number
  tieredProfitOverrides?: TieredProfitOverrides | LegacyTieredProfitOverrides
  promotion?: PromotionPricingContext | null
}

export type ListingPriceResult = {
  amazonCost: number
  pricingMode: PricingMode
  targetNetProfit: number
  calculatedListingPrice: number
  estimatedFeeAmount: number
  calculatedNetProfit: number
  assumedTaxRate: number
  assumedFeeRate: number
  fixedOrderFee: number
  promotionApplied: boolean
  promotionAdRatePercent: number | null
  adFeeTaxPercent: number | null
  effectiveAdCostPercent: number | null
  estimatedAdFeeAmount: number
  unpromotedCalculatedListingPrice: number
  promotedCalculatedListingPrice: number | null
}

export type PricingValidationErrorCode =
  | "INVALID_AMAZON_COST"
  | "INVALID_PRICING_MODE"
  | "INVALID_PERCENTAGE_NET_PROFIT"
  | "INVALID_TIER_OVERRIDE"
  | "INVALID_PROMOTION_AD_RATE"
  | "INVALID_PROMOTION_AD_FEE_TAX"

export class PricingValidationError extends Error {
  constructor(public readonly code: PricingValidationErrorCode, message: string) {
    super(message)
    this.name = "PricingValidationError"
  }
}
