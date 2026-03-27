// ─────────────────────────────────────────────────────────────
// pricingTypes.ts
// ─────────────────────────────────────────────────────────────

export type PricingInput = {
  amazonCost:           number
  profitMarginPercent:  number
  taxEstimatePercent:   number
  ebayFeePercent:       number
}

export type PricingResult = {
  amazonCost:           number
  profitMarginPercent:  number
  taxEstimatePercent:   number
  ebayFeePercent:       number
  targetProfitAmount:   number
  feeEstimateAmount:    number
  taxEstimateAmount:    number
  finalListingPrice:    number
}

export type PricingValidationError =
  | "INVALID_AMAZON_COST"
  | "INVALID_PROFIT_MARGIN"
  | "INVALID_EBAY_FEE"
  | "INVALID_TAX_ESTIMATE"
  | "FINAL_PRICE_BELOW_COST"
