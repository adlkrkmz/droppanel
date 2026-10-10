import assert from "node:assert/strict"
import {
  calculateListingPrice,
  defaultLegacyUiRanges,
  defaultTierTargetProfit,
  estimatePromotedAdFee,
  normalizeTieredProfitOverrides,
  PricingValidationError,
} from "../modules/pricing/pricingService"
import {
  adRatePercentForPricing,
  shouldSkipEbayPriceForAdRateChange,
} from "../modules/pricing/promotionPricingContext"

function formulaRangesUpTo(maxStart: number) {
  const ranges = []
  for (let start = 0; start <= maxStart; start += 10) {
    ranges.push({
      minPrice: start,
      maxPrice: Math.round((start + 9.99) * 100) / 100,
      minNetProfit: defaultTierTargetProfit(start),
    })
  }
  return ranges
}

const fullLegacyRanges = formulaRangesUpTo(1000)

const tierFixtures = [
  [2.13, 2, 5.70], [4.29, 2, 8.35], [8.97, 2, 14.10], [10, 4, 17.83],
  [16.49, 4, 25.80], [20, 6, 32.58], [27, 6, 41.18], [39.99, 8, 59.60],
  [47.98, 10, 71.88], [48, 10, 71.91], [73, 16, 110.01], [99.99, 20, 148.10],
  [119.99, 24, 177.60], [1000, 202, 1477.99],
] as const

for (const [cost, target, expected] of tierFixtures) {
  const result = calculateListingPrice({
    amazonCost: cost,
    pricingMode: "TIERED_MIN_NET_PROFIT",
    percentageNetProfitPercent: 35,
    tieredProfitOverrides: fullLegacyRanges,
  })
  assert.equal(result.targetNetProfit, target, `tier target cost=${cost}`)
  assert.equal(result.calculatedListingPrice, expected, `tier price cost=${cost}`)
  assert.ok(result.calculatedNetProfit + 1e-9 >= result.targetNetProfit, `tier net floor cost=${cost}`)
}

for (const [cost, expectedTarget] of [[9.99, 2], [10, 4], [19.99, 4], [20, 6], [99.99, 20], [100, 22], [1000, 202]] as const) {
  assert.equal(defaultTierTargetProfit(Math.floor(cost / 10) * 10), expectedTarget)
}

const percentageFixtures = [
  [10, 20, 2, 15.37], [10, 30, 3, 16.60], [16.49, 30, 4.947, 26.97], [50, 30, 15, 80.51],
] as const
for (const [cost, percentage, target, expected] of percentageFixtures) {
  const result = calculateListingPrice({
    amazonCost: cost,
    pricingMode: "PERCENTAGE_NET_PROFIT",
    percentageNetProfitPercent: percentage,
  })
  assert.ok(Math.abs(result.targetNetProfit - target) < 1e-9)
  assert.equal(result.calculatedListingPrice, expected)
  assert.ok(result.calculatedNetProfit + 1e-9 >= result.targetNetProfit)
}

const overridden = calculateListingPrice({
  amazonCost: 4.29,
  pricingMode: "TIERED_MIN_NET_PROFIT",
  percentageNetProfitPercent: 35,
  tieredProfitOverrides: [{ minPrice: 0, maxPrice: 9.99, minNetProfit: 3 }],
})
assert.equal(overridden.targetNetProfit, 3)
assert.equal(overridden.calculatedListingPrice, 9.58)

// Outside manual ranges → percentage fallback
const fallback = calculateListingPrice({
  amazonCost: 25,
  pricingMode: "TIERED_MIN_NET_PROFIT",
  percentageNetProfitPercent: 40,
  tieredProfitOverrides: [{ minPrice: 0, maxPrice: 9.99, minNetProfit: 2 }],
})
assert.equal(fallback.targetNetProfit, 10)

// Legacy map normalize
const fromLegacy = normalizeTieredProfitOverrides({ "0": 3, "10": 5 })
assert.deepEqual(fromLegacy, [
  { minPrice: 0, maxPrice: 9.99, minNetProfit: 3 },
  { minPrice: 10, maxPrice: 19.99, minNetProfit: 5 },
])

assert.deepEqual(defaultLegacyUiRanges().length, 10)

assert.throws(
  () => normalizeTieredProfitOverrides([
    { minPrice: 0, maxPrice: 10, minNetProfit: 2 },
    { minPrice: 5, maxPrice: 15, minNetProfit: 4 },
  ]),
  (err: unknown) => err instanceof PricingValidationError && /overlap/i.test(err.message)
)

assert.throws(
  () => normalizeTieredProfitOverrides([{ minPrice: -1, maxPrice: 5, minNetProfit: 2 }]),
  (err: unknown) => err instanceof PricingValidationError && /negative/i.test(err.message)
)

const adjacentOk = normalizeTieredProfitOverrides([
  { minPrice: 0, maxPrice: 5, minNetProfit: 2 },
  { minPrice: 5.01, maxPrice: 10, minNetProfit: 4 },
])
assert.equal(adjacentOk.length, 2)

const parityInput = {
  amazonCost: 27,
  pricingMode: "TIERED_MIN_NET_PROFIT" as const,
  percentageNetProfitPercent: 30,
  tieredProfitOverrides: [{ minPrice: 20, maxPrice: 29.99, minNetProfit: 7 }],
}
const standard = calculateListingPrice(parityInput).calculatedListingPrice
const variation = calculateListingPrice(parityInput).calculatedListingPrice
const repricing = calculateListingPrice(parityInput).calculatedListingPrice
assert.equal(standard, variation)
assert.equal(variation, repricing)

const percentBase = {
  amazonCost: 23.99,
  pricingMode: "PERCENTAGE_NET_PROFIT" as const,
  percentageNetProfitPercent: 15,
}
const unpromotedA = calculateListingPrice(percentBase)
assert.equal(unpromotedA.calculatedListingPrice, 34.53)
const unpromotedAoff = calculateListingPrice({
  ...percentBase,
  promotion: { enabled: false, adRatePercent: 5 },
})
assert.equal(unpromotedAoff.calculatedListingPrice, unpromotedA.calculatedListingPrice)
assert.equal(unpromotedAoff.estimatedFeeAmount, unpromotedA.estimatedFeeAmount)
assert.equal(unpromotedAoff.calculatedNetProfit, unpromotedA.calculatedNetProfit)
const unpromotedAzero = calculateListingPrice({
  ...percentBase,
  promotion: { enabled: true, adRatePercent: 0 },
})
assert.equal(unpromotedAzero.calculatedListingPrice, 34.53)

const promotedB = calculateListingPrice({
  ...percentBase,
  promotion: { enabled: true, adRatePercent: 5, adFeeTaxPercent: 20 },
})
assert.equal(promotedB.calculatedListingPrice, 37.55)
assert.equal(promotedB.unpromotedCalculatedListingPrice, 34.53)
assert.equal(promotedB.promotedCalculatedListingPrice, 37.55)
assert.equal(promotedB.promotionAdRatePercent, 5)
assert.equal(promotedB.adFeeTaxPercent, 20)
assert.equal(promotedB.effectiveAdCostPercent, 6.54)

const liveAdFee = estimatePromotedAdFee(11.03, 5, 20)
assert.equal(liveAdFee, 0.72)

const rate8 = calculateListingPrice({
  ...percentBase,
  promotion: { enabled: true, adRatePercent: 8 },
})
assert.ok(rate8.calculatedListingPrice > promotedB.calculatedListingPrice)

assert.equal(shouldSkipEbayPriceForAdRateChange(8, 5), true)
assert.equal(shouldSkipEbayPriceForAdRateChange(5, 8), false)
assert.equal(shouldSkipEbayPriceForAdRateChange(0, 5), false)
assert.equal(shouldSkipEbayPriceForAdRateChange(5, 5), false)

assert.equal(adRatePercentForPricing({ status: "OFF", requestedRate: 5, effectiveRate: 5 }), null)
assert.equal(adRatePercentForPricing({ status: "ACTIVE", requestedRate: 5, effectiveRate: 5 }), 5)
assert.equal(adRatePercentForPricing({ status: "PENDING", requestedRate: 8, effectiveRate: null }), 8)
assert.equal(adRatePercentForPricing({
  status: "FAILED",
  requested: true,
  requestedRate: 5,
  effectiveRate: null,
}), 5)

assert.throws(
  () => calculateListingPrice({ ...percentBase, promotion: { enabled: true, adRatePercent: 1 } }),
  (err: unknown) => err instanceof PricingValidationError && err.code === "INVALID_PROMOTION_AD_RATE"
)

console.log(JSON.stringify({
  ok: true,
  tierFixtures: tierFixtures.length,
  percentageFixtures: percentageFixtures.length,
  override: overridden.calculatedListingPrice,
  fallback: fallback.calculatedListingPrice,
  parity: standard,
}))
