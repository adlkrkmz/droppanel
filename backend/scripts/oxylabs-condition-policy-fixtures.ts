import assert from "node:assert/strict"
import { normalizeOxylabsAmazonProduct } from "../modules/oxylabsVerify/oxylabsProductNormalize"
import { decideOxylabsSingleQuery } from "../modules/oxylabsVerify/oxylabsProductDecision"

const asin = "B0TEST1234"
function decide(input: { condition?: string; stock?: string; prime?: boolean; returnedAsin?: string; pricingUrl?: string; featured?: Record<string, unknown>; buybox?: unknown[] }) {
  const content: Record<string, unknown> = {
    asin: input.returnedAsin ?? asin, asin_in_url: input.returnedAsin ?? asin,
    price: 10, stock: input.stock ?? "In Stock", currency: "USD", parse_status_code: 12000,
    is_prime_eligible: input.prime ?? true,
    featured_merchant: input.featured ?? { name: "Amazon.com", shipped_from: "Amazon.com", is_amazon_fulfilled: true },
  }
  if (input.condition !== undefined) content.condition = input.condition
  if (input.pricingUrl !== undefined) content.pricing_url = input.pricingUrl
  if (input.buybox !== undefined) content.buybox = input.buybox
  const n = normalizeOxylabsAmazonProduct({ requestedAsin: asin, payload: { results: [{ status_code: 200, content }] } })
  return decideOxylabsSingleQuery({ n, panel: { sourceAsin: asin, sourcePrice: 10, listingLive: true, qty: 1 }, mutationsEnabled: true })
}

assert.equal(decide({ condition: "New" }).productClass, "VALID_SOURCE")
assert.equal(decide({ condition: "New", stock: "Only 1 left in stock - order soon." }).productClass, "VALID_SOURCE")
for (const condition of ["Used", "Used - Very Good", "Renewed", "Refurbished", "Collectible"]) {
  const d = decide({ condition })
  assert.equal(d.productClass, "SOURCE_INVALID", condition)
  assert.equal(d.evidenceCode, "USED_OR_RESALE", condition)
}
const conditionUnknownHealthy = decide({})
assert.equal(conditionUnknownHealthy.productClass, "VALID_SOURCE")
assert.equal(conditionUnknownHealthy.evidenceCode, "PRICE_MATCH")
assert.equal(decide({ condition: "New", returnedAsin: "B0TEST5678" }).productClass, "ASIN_IDENTITY_MISMATCH")
assert.equal(decide({ condition: "New", stock: "Currently unavailable" }).productClass, "OUT_OF_STOCK_RISK")
assert.equal(decide({ condition: "New", prime: false }).productClass, "VALID_SOURCE")
assert.equal(decide({ condition: "New", pricingUrl: "https://amazon.test/?condition=NEW" }).evidenceCode, "PRICE_MATCH")
assert.equal(decide({ condition: "New", featured: {}, pricingUrl: "https://amazon.test/?condition=NEW" }).productClass, "PRODUCT_INCONCLUSIVE")
assert.equal(decide({ condition: "New", featured: { name: "Third party", shipped_from: "Amazon", is_amazon_fulfilled: true }, pricingUrl: "" }).productClass, "VALID_SOURCE")
const structural = decide({ condition: undefined, featured: {}, pricingUrl: "", buybox: [{}] })
assert.equal(structural.productClass, "SOURCE_INVALID")
assert.equal(structural.evidenceCode, "NO_VERIFIED_NEW_FBA_OFFER")
assert.equal(decide({ condition: undefined, featured: {}, pricingUrl: "", buybox: [{ seller_name: "Seller" }] }).productClass, "PRODUCT_INCONCLUSIVE")
console.log("PASS Oxylabs condition policy: healthy unknown-condition valid; explicit non-new invalid; Prime false neutral")
