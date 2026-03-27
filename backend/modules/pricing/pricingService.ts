// ─────────────────────────────────────────────────────────────
// pricingService.ts
//
// Hesap mantığı:
//
//   finalListingPrice = amazonCost
//                       + targetProfitAmount   (cost × margin%)
//                       + feeEstimateAmount    (finalPrice × fee%)
//                       + taxEstimateAmount    (finalPrice × tax%)
//
// fee ve tax finalPrice üzerinden alındığı için döngüsel bağımlılık
// vardır. Bunu çözmek için algebraik açılım kullanılır:
//
//   P = C + C×m + P×f + P×t
//   P - P×f - P×t = C + C×m
//   P × (1 - f - t) = C × (1 + m)
//   P = C × (1 + m) / (1 - f - t)
//
// Burada:
//   C = amazonCost
//   m = profitMarginPercent / 100
//   f = ebayFeePercent      / 100
//   t = taxEstimatePercent  / 100
// ─────────────────────────────────────────────────────────────

import type { PricingInput, PricingResult, PricingValidationError } from "./pricingTypes"

// ─── VALIDATION ───────────────────────────────────────────────

function validate(input: PricingInput): PricingValidationError | null {
  if (!isFinite(input.amazonCost) || input.amazonCost <= 0) {
    return "INVALID_AMAZON_COST"
  }
  if (!isFinite(input.profitMarginPercent) || input.profitMarginPercent < 0) {
    return "INVALID_PROFIT_MARGIN"
  }
  if (!isFinite(input.ebayFeePercent) || input.ebayFeePercent < 0) {
    return "INVALID_EBAY_FEE"
  }
  if (!isFinite(input.taxEstimatePercent) || input.taxEstimatePercent < 0) {
    return "INVALID_TAX_ESTIMATE"
  }
  return null
}

// ─── ROUND ────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ─── CALCULATE ────────────────────────────────────────────────

export function calculatePrice(input: PricingInput): PricingResult {
  const error = validate(input)
  if (error) throw new Error(`Pricing validation failed: ${error}`)

  const { amazonCost, profitMarginPercent, taxEstimatePercent, ebayFeePercent } = input

  const m = profitMarginPercent / 100
  const f = ebayFeePercent      / 100
  const t = taxEstimatePercent  / 100

  const divisor = 1 - f - t

  if (divisor <= 0) {
    throw new Error(
      `ebayFeePercent + taxEstimatePercent cannot equal or exceed 100% ` +
      `(got ${ebayFeePercent + taxEstimatePercent}%)`
    )
  }

  // Algebraic solution — no iteration needed
  const finalListingPrice   = round2((amazonCost * (1 + m)) / divisor)
  const targetProfitAmount  = round2(amazonCost * m)
  const feeEstimateAmount   = round2(finalListingPrice * f)
  const taxEstimateAmount   = round2(finalListingPrice * t)

  // Safety guard — should never trigger with valid inputs
  if (finalListingPrice < amazonCost) {
    throw new Error(
      `FINAL_PRICE_BELOW_COST: finalListingPrice=${finalListingPrice} < amazonCost=${amazonCost}`
    )
  }

  return {
    amazonCost,
    profitMarginPercent,
    taxEstimatePercent,
    ebayFeePercent,
    targetProfitAmount,
    feeEstimateAmount,
    taxEstimateAmount,
    finalListingPrice,
  }
}

// ─── BATCH ────────────────────────────────────────────────────

export function calculatePriceBatch(
  costs:   number[],
  margins: Pick<PricingInput, "profitMarginPercent" | "taxEstimatePercent" | "ebayFeePercent">
): PricingResult[] {
  return costs.map(cost =>
    calculatePrice({ amazonCost: cost, ...margins })
  )
}
