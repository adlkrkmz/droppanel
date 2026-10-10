import {
  EBAY_PROMOTED_MAX_RATE,
  EBAY_PROMOTED_MIN_RATE,
} from "../ebay/ebayPromotedTypes"
import {
  PRICING_MODES,
  PricingValidationError,
  type ListingPriceInput,
  type ListingPriceResult,
  type PricingMode,
  type PromotionPricingContext,
  type TieredProfitOverrides,
  type TieredProfitRange,
} from "./pricingTypes"

export { PricingValidationError }
export type { PromotionPricingContext, TieredProfitRange, TieredProfitOverrides }

export const BUYER_TAX_RATE_ASSUMPTION = 0.09
export const EBAY_FINAL_VALUE_FEE_RATE = 0.171
export const EBAY_FIXED_ORDER_FEE = 0.50

const PERCENTAGE_FEE_BASE_RATE =
  (1 + BUYER_TAX_RATE_ASSUMPTION) * EBAY_FINAL_VALUE_FEE_RATE
const LISTING_PRICE_DIVISOR = 1 - PERCENTAGE_FEE_BASE_RATE
const CENT_EPSILON = 1e-9

/** Named ad-fee sales-tax policy. Do not scatter 1.20 as a magic number. */
export const DEFAULT_AD_FEE_TAX_PERCENT = 20
export const DEFAULT_AD_FEE_TAX_RATE = DEFAULT_AD_FEE_TAX_PERCENT / 100
export const SALES_TAX_MULTIPLIER = 1 + BUYER_TAX_RATE_ASSUMPTION

export function isPricingMode(value: unknown): value is PricingMode {
  return typeof value === "string" && (PRICING_MODES as readonly string[]).includes(value)
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function toCents(value: number): number {
  return Math.round(value * 100)
}

/** Legacy $10 floor helper — kept for migration / fixtures only */
export function normalizeBucketStart(cost: number): number {
  if (!Number.isFinite(cost) || cost < 0) {
    throw new PricingValidationError("INVALID_AMAZON_COST", "Amazon cost must be a finite non-negative number")
  }
  return Math.floor(cost / 10) * 10
}

/** Legacy default formula for $10 buckets — kept for migration of existing stores */
export function defaultTierTargetProfit(bucketStart: number): number {
  const normalized = normalizeBucketStart(bucketStart)
  return 2 * (Math.floor(normalized / 10) + 1)
}

/** Default UI buckets ($0–9.99 … $90–99.99) with legacy formula profits */
export function defaultLegacyUiRanges(): TieredProfitRange[] {
  return Array.from({ length: 10 }, (_, i) => {
    const start = i * 10
    return {
      minPrice: start,
      maxPrice: roundMoney(start + 9.99),
      minNetProfit: defaultTierTargetProfit(start),
    }
  })
}

export function legacyBucketMapToRanges(map: Record<string, number>): TieredProfitRange[] {
  const ranges: TieredProfitRange[] = []
  for (const [rawKey, rawValue] of Object.entries(map)) {
    const keyNumber = Number(rawKey)
    const amount = Number(rawValue)
    if (!Number.isFinite(keyNumber) || keyNumber < 0 || !Number.isFinite(amount) || amount < 0) {
      throw new PricingValidationError(
        "INVALID_TIER_OVERRIDE",
        "Enter valid non-negative numbers for all price ranges."
      )
    }
    const bucketStart = normalizeBucketStart(keyNumber)
    ranges.push({
      minPrice: bucketStart,
      maxPrice: roundMoney(bucketStart + 9.99),
      minNetProfit: roundMoney(amount),
    })
  }
  return ranges
}

function parseMoneyField(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const s = value.trim().replace(/\s/g, "")
    if (!s) return NaN
    let normalized = s
    if (s.includes(",") && s.includes(".")) {
      const lastComma = s.lastIndexOf(",")
      const lastDot = s.lastIndexOf(".")
      if (lastComma > lastDot) {
        normalized = s.replace(/\./g, "").replace(",", ".")
      } else {
        normalized = s.replace(/,/g, "")
      }
    } else if (s.includes(",")) {
      normalized = s.replace(",", ".")
    }
    return Number(normalized)
  }
  return Number(value)
}

function parseRangeRow(raw: unknown, index: number): TieredProfitRange {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PricingValidationError(
      "INVALID_TIER_OVERRIDE",
      `Price range #${index + 1} is invalid.`
    )
  }
  const row = raw as Record<string, unknown>
  const minPrice = parseMoneyField(row.minPrice ?? row.min ?? row.amazonMinPrice)
  const maxPrice = parseMoneyField(row.maxPrice ?? row.max ?? row.amazonMaxPrice)
  const minNetProfit = parseMoneyField(row.minNetProfit ?? row.profit ?? row.minimumNetProfit)
  if (![minPrice, maxPrice, minNetProfit].every(Number.isFinite)) {
    throw new PricingValidationError(
      "INVALID_TIER_OVERRIDE",
      "Enter valid numbers for min, max, and profit."
    )
  }
  if (minPrice < 0 || maxPrice < 0 || minNetProfit < 0) {
    throw new PricingValidationError(
      "INVALID_TIER_OVERRIDE",
      "Values cannot be negative."
    )
  }
  if (toCents(minPrice) >= toCents(maxPrice)) {
    throw new PricingValidationError(
      "INVALID_TIER_OVERRIDE",
      "Min price must be less than max price."
    )
  }
  return {
    minPrice: roundMoney(minPrice),
    maxPrice: roundMoney(maxPrice),
    minNetProfit: roundMoney(minNetProfit),
  }
}

export function validateTieredProfitRanges(ranges: TieredProfitRange[]): TieredProfitRange[] {
  if (!Array.isArray(ranges)) {
    throw new PricingValidationError("INVALID_TIER_OVERRIDE", "Price ranges must be a list.")
  }

  const normalized = ranges.map((r, i) => parseRangeRow(r, i))
  const sorted = [...normalized].sort((a, b) => {
    const byMin = toCents(a.minPrice) - toCents(b.minPrice)
    if (byMin !== 0) return byMin
    return toCents(a.maxPrice) - toCents(b.maxPrice)
  })

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]
      const b = sorted[j]
      if (toCents(a.minPrice) === toCents(b.minPrice) && toCents(a.maxPrice) === toCents(b.maxPrice)) {
        throw new PricingValidationError(
          "INVALID_TIER_OVERRIDE",
          "Duplicate price ranges are not allowed."
        )
      }
      // Inclusive endpoints: 0–5 and 5–10 overlap at $5; 0–5 and 5.01–10 do not.
      if (toCents(a.maxPrice) >= toCents(b.minPrice) && toCents(b.maxPrice) >= toCents(a.minPrice)) {
        throw new PricingValidationError(
          "INVALID_TIER_OVERRIDE",
          "Price ranges cannot overlap."
        )
      }
    }
  }

  return sorted
}

/**
 * Normalize stored/API tiered profit config to a validated range list.
 * Accepts new range arrays and legacy $10-bucket maps.
 */
export function normalizeTieredProfitOverrides(value: unknown): TieredProfitOverrides {
  if (value == null) return []

  if (Array.isArray(value)) {
    return validateTieredProfitRanges(value as TieredProfitRange[])
  }

  if (typeof value === "object") {
    const map: Record<string, number> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const amount = Number(v)
      if (!Number.isFinite(amount)) {
        throw new PricingValidationError(
          "INVALID_TIER_OVERRIDE",
          "Enter valid numbers for all price ranges."
        )
      }
      map[k] = amount
    }
    if (Object.keys(map).length === 0) return []
    return validateTieredProfitRanges(legacyBucketMapToRanges(map))
  }

  throw new PricingValidationError(
    "INVALID_TIER_OVERRIDE",
    "Price ranges must be a list."
  )
}

export function findMatchingTierProfit(
  amazonCost: number,
  ranges: TieredProfitRange[]
): number | null {
  if (!Number.isFinite(amazonCost) || amazonCost < 0) return null
  const costCents = toCents(amazonCost)
  for (const range of ranges) {
    if (costCents >= toCents(range.minPrice) && costCents <= toCents(range.maxPrice)) {
      return range.minNetProfit
    }
  }
  return null
}

function resolveTargetNetProfit(input: ListingPriceInput): number {
  if (input.pricingMode === "PERCENTAGE_NET_PROFIT") {
    if (!Number.isFinite(input.percentageNetProfitPercent) || input.percentageNetProfitPercent <= 0) {
      throw new PricingValidationError(
        "INVALID_PERCENTAGE_NET_PROFIT",
        "Percentage net profit must be greater than zero"
      )
    }
    return input.amazonCost * input.percentageNetProfitPercent / 100
  }

  const ranges = normalizeTieredProfitOverrides(input.tieredProfitOverrides ?? [])
  const matched = findMatchingTierProfit(input.amazonCost, ranges)
  if (matched != null) return matched

  // No manual range → Percentage Net Profit (%) fallback (fee engine unchanged)
  if (!Number.isFinite(input.percentageNetProfitPercent) || input.percentageNetProfitPercent <= 0) {
    throw new PricingValidationError(
      "INVALID_PERCENTAGE_NET_PROFIT",
      "Percentage net profit must be greater than zero"
    )
  }
  return input.amazonCost * input.percentageNetProfitPercent / 100
}

function ceilToCent(value: number): number {
  return Math.ceil(value * 100 - CENT_EPSILON) / 100
}

export function resolvePromotionPricing(raw?: PromotionPricingContext | null): {
  applied: boolean
  adRatePercent: number
  adRateDecimal: number
  adFeeTaxPercent: number
  adFeeTaxRate: number
} {
  const off = {
    applied: false,
    adRatePercent: 0,
    adRateDecimal: 0,
    adFeeTaxPercent: DEFAULT_AD_FEE_TAX_PERCENT,
    adFeeTaxRate: DEFAULT_AD_FEE_TAX_RATE,
  }
  if (!raw || raw.enabled === false) return off
  const rate = raw.adRatePercent
  if (rate == null || rate === 0) return off
  if (!Number.isFinite(rate) || rate < EBAY_PROMOTED_MIN_RATE || rate > EBAY_PROMOTED_MAX_RATE) {
    throw new PricingValidationError(
      "INVALID_PROMOTION_AD_RATE",
      "Reklam oranı 2 ile 100 arasında olmalıdır"
    )
  }
  const taxPct = raw.adFeeTaxPercent == null ? DEFAULT_AD_FEE_TAX_PERCENT : raw.adFeeTaxPercent
  if (!Number.isFinite(taxPct) || taxPct < 0 || taxPct > 100) {
    throw new PricingValidationError(
      "INVALID_PROMOTION_AD_FEE_TAX",
      "Reklam gider vergisi oranı geçersiz"
    )
  }
  return {
    applied: true,
    adRatePercent: rate,
    adRateDecimal: rate / 100,
    adFeeTaxPercent: taxPct,
    adFeeTaxRate: taxPct / 100,
  }
}

export function listingPriceDivisorForPromotion(adRateDecimal: number, adFeeTaxRate: number): number {
  if (adRateDecimal <= 0) return LISTING_PRICE_DIVISOR
  const adFeeTaxMultiplier = 1 + adFeeTaxRate
  return 1 - SALES_TAX_MULTIPLIER * (EBAY_FINAL_VALUE_FEE_RATE + adRateDecimal * adFeeTaxMultiplier)
}

export function estimatePromotedAdFee(itemPrice: number, adRatePercent: number, adFeeTaxPercent = DEFAULT_AD_FEE_TAX_PERCENT): number {
  if (!Number.isFinite(itemPrice) || itemPrice <= 0 || !Number.isFinite(adRatePercent) || adRatePercent <= 0) {
    return 0
  }
  const adFeeTaxMultiplier = 1 + adFeeTaxPercent / 100
  return roundMoney(itemPrice * SALES_TAX_MULTIPLIER * (adRatePercent / 100) * adFeeTaxMultiplier)
}

export function calculateListingPrice(input: ListingPriceInput): ListingPriceResult {
  if (!Number.isFinite(input.amazonCost) || input.amazonCost <= 0) {
    throw new PricingValidationError("INVALID_AMAZON_COST", "Amazon cost must be greater than zero")
  }
  if (!isPricingMode(input.pricingMode)) {
    throw new PricingValidationError("INVALID_PRICING_MODE", "Unsupported pricing mode")
  }

  const promo = resolvePromotionPricing(input.promotion)
  const targetNetProfit = resolveTargetNetProfit(input)
  const numerator = input.amazonCost + targetNetProfit + EBAY_FIXED_ORDER_FEE
  const unpromotedCalculatedListingPrice = ceilToCent(numerator / LISTING_PRICE_DIVISOR)
  const divisor = listingPriceDivisorForPromotion(promo.adRateDecimal, promo.adFeeTaxRate)
  const calculatedListingPrice = promo.applied
    ? ceilToCent(numerator / divisor)
    : unpromotedCalculatedListingPrice
  const adFeeTaxMultiplier = 1 + promo.adFeeTaxRate
  const percentageFeeRate = promo.applied
    ? SALES_TAX_MULTIPLIER * (EBAY_FINAL_VALUE_FEE_RATE + promo.adRateDecimal * adFeeTaxMultiplier)
    : PERCENTAGE_FEE_BASE_RATE
  const estimatedFeeAmount =
    calculatedListingPrice * percentageFeeRate + EBAY_FIXED_ORDER_FEE
  const calculatedNetProfit =
    calculatedListingPrice - estimatedFeeAmount - input.amazonCost
  const estimatedAdFeeAmount = promo.applied
    ? estimatePromotedAdFee(calculatedListingPrice, promo.adRatePercent, promo.adFeeTaxPercent)
    : 0
  const effectiveAdCostPercent = promo.applied
    ? roundMoney(promo.adRatePercent * adFeeTaxMultiplier * SALES_TAX_MULTIPLIER)
    : null

  return {
    amazonCost: input.amazonCost,
    pricingMode: input.pricingMode,
    targetNetProfit,
    calculatedListingPrice,
    estimatedFeeAmount,
    calculatedNetProfit,
    assumedTaxRate: BUYER_TAX_RATE_ASSUMPTION,
    assumedFeeRate: EBAY_FINAL_VALUE_FEE_RATE,
    fixedOrderFee: EBAY_FIXED_ORDER_FEE,
    promotionApplied: promo.applied,
    promotionAdRatePercent: promo.applied ? promo.adRatePercent : null,
    adFeeTaxPercent: promo.applied ? promo.adFeeTaxPercent : null,
    effectiveAdCostPercent,
    estimatedAdFeeAmount,
    unpromotedCalculatedListingPrice,
    promotedCalculatedListingPrice: promo.applied ? calculatedListingPrice : null,
  }
}
