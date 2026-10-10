import assert from "node:assert/strict"
import { isAutomaticZeroDecisionSafe, type VerifiedSourceDecision } from "../modules/amazonVerification/verifiedSourceDecision"
import { planVerifiedStockAction } from "../modules/stockGuard/verifiedStockActionPlan"
import { normalizeOxylabsAmazonProduct } from "../modules/oxylabsVerify/oxylabsProductNormalize"
import { decideOxylabsSingleQuery } from "../modules/oxylabsVerify/oxylabsProductDecision"

const base = (code: string, outcome: VerifiedSourceDecision["outcome"] = "CONFIRMED_NO_VALID_SOURCE"): VerifiedSourceDecision => ({
  outcome,
  code,
  acceptedPrice: null,
  requestedAsin: "B00TEST001",
  finalAsin: "B00TEST001",
  redirected: false,
  validPrimeOrFba: false,
  mutationAllowed: true,
})

const plan = (decision: VerifiedSourceDecision) => planVerifiedStockAction({
  decision,
  settings: { enabled: true, mode: "auto", priceAlertEnabled: true, autoProfitProtectionEnabled: true },
  currentEbayQuantity: 1,
  trustedBaselinePrice: 10,
  lastVerifiedDecision: "VALID_SOURCE",
  verifiedActionsEnabled: true,
  lastVerifiedAsin: "B00TEST001",
  currentSourceAsin: "B00TEST001",
})

for (const code of ["NO_VERIFIED_NEW_FBA_OFFER", "USED_OR_RESALE", "OUT_OF_STOCK"]) {
  const d = base(code)
  assert.equal(isAutomaticZeroDecisionSafe(d), true, code)
  assert.equal(plan(d).action, "zero_stock", code)
}

const mismatch: VerifiedSourceDecision = { ...base("SOURCE_ASIN_MISMATCH"), finalAsin: "B00TEST002", redirected: true }
assert.equal(isAutomaticZeroDecisionSafe(mismatch), true)
assert.equal(plan(mismatch).action, "zero_stock")

assert.equal(isAutomaticZeroDecisionSafe(base("ARBITRARY_SOURCE_INVALID")), false)
assert.equal(isAutomaticZeroDecisionSafe({ ...base("PRODUCT_INCONCLUSIVE", "UNKNOWN"), mutationAllowed: false }), false)

function structural(input: { prime?: boolean; pricingUrl?: string; stock?: string }) {
  const asin = "B00TEST001"
  const content: Record<string, unknown> = {
    asin, asin_in_url: asin, price: 10, currency: "USD", stock: input.stock ?? "In Stock", parse_status_code: 12000,
    is_prime_eligible: input.prime ?? true, featured_merchant: {}, buybox: [{}],
  }
  if (input.pricingUrl !== undefined) content.pricing_url = input.pricingUrl
  const n = normalizeOxylabsAmazonProduct({ requestedAsin: asin, payload: { results: [{ status_code: 200, content }] } })
  return decideOxylabsSingleQuery({ n, panel: { sourceAsin: asin, sourcePrice: 10, listingLive: true, qty: 1 }, mutationsEnabled: true })
}

// Prime=false alone, a condition=NEW URL alone, and low stock alone do not form the all-four-absence pattern.
assert.notEqual(structural({ prime: false, pricingUrl: "https://amazon.test/?condition=NEW" }).evidenceCode, "NO_VERIFIED_NEW_FBA_OFFER")
assert.notEqual(structural({ pricingUrl: "https://amazon.test/?condition=NEW" }).evidenceCode, "NO_VERIFIED_NEW_FBA_OFFER")
assert.notEqual(structural({ stock: "Only 1 left in stock - order soon.", pricingUrl: "https://amazon.test/?condition=NEW" }).evidenceCode, "NO_VERIFIED_NEW_FBA_OFFER")

console.log("oxylabs-unsafe-confirmed-result-fixtures: PASS")
