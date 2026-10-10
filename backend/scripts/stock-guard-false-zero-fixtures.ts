import assert from "node:assert/strict"
import {
  classifyVerifiedAmazonSource,
  isAutomaticZeroDecisionSafe,
} from "../modules/amazonVerification/verifiedSourceDecision"
import { mapPublicObservationToVerificationPayload } from "../modules/amazonPublicWorker/mapPublicObservationToVerificationPayload"
import { STOCK_ALERTS_ROUTINE_DESKTOP_WAITING_SQL } from "../modules/stockAlerts/stockAlertListQuery"

const requestedAsin = "B000000001"
const finalAsin = requestedAsin

function classify(overrides: Record<string, unknown> = {}) {
  return classifyVerifiedAmazonSource({
    requestedAsin,
    finalAsin,
    displayedPrice: 19.99,
    condition: "NEW",
    isPrime: true,
    shipsFromAmazon: true,
    purchasable: "TRUE",
    stockStatus: "IN_STOCK",
    availabilityText: "In Stock",
    offerPageHealthy: true,
    ...overrides,
  })
}

function assertUnknown(overrides: Record<string, unknown>, code: string): void {
  const decision = classify(overrides)
  assert.equal(decision.outcome, "UNKNOWN")
  assert.equal(decision.code, code)
  assert.equal(isAutomaticZeroDecisionSafe(decision), false)
}

const incomplete = mapPublicObservationToVerificationPayload({
  requestedAsin,
  publicStatus: "AMAZON_INCOMPLETE",
  observation: {
    actualAsin: null, pageExists: true, mainPrice: null, priceMissing: true,
    primeMemberPrice: null, regularPrice: null, primeVisible: null,
    shipsFrom: null, soldBy: null, availability: null, inStock: null,
    offerLabel: null, offerCondition: "UNKNOWN", newOfferAvailable: null,
    finalUrl: `https://www.amazon.com/dp/${requestedAsin}`,
  },
})
assert.equal(classifyVerifiedAmazonSource({
  requestedAsin,
  finalAsin: incomplete.payload.finalAsin,
  condition: incomplete.payload.condition as string | null | undefined,
  isPrime: incomplete.payload.isPrime as boolean | null,
  shipsFromAmazon: incomplete.shipsFromAmazon,
  purchasable: "UNKNOWN",
  offerPageHealthy: false,
}).outcome, "UNKNOWN")

assertUnknown({ isPrime: null }, "PRIME_UNKNOWN")
assertUnknown({ isPrime: undefined }, "PRIME_UNKNOWN")
assertUnknown({ shipsFromAmazon: null }, "SHIPPER_UNKNOWN")
assertUnknown({ purchasable: "UNKNOWN", stockStatus: null, availabilityText: null }, "STOCK_UNKNOWN")
assertUnknown({ condition: null }, "CONDITION_UNKNOWN")
assertUnknown({ finalAsin: null }, "ASIN_UNKNOWN")
assertUnknown({ finalAsin: "" }, "ASIN_UNKNOWN")
assertUnknown({ offerPageHealthy: false, shipsFromAmazon: null }, "SHIPPER_UNKNOWN")

const nonPrime = classify({ isPrime: false })
assert.equal(nonPrime.code, "NOT_PRIME")
assert.equal(isAutomaticZeroDecisionSafe(nonPrime), true)

const merchantFulfillment = classify({ shipsFromAmazon: false })
assert.equal(merchantFulfillment.code, "NOT_FBA")
assert.equal(isAutomaticZeroDecisionSafe(merchantFulfillment), true)

const outOfStock = classify({
  purchasable: "FALSE", stockStatus: "OUT_OF_STOCK", availabilityText: "Currently unavailable",
})
assert.equal(outOfStock.code, "OUT_OF_STOCK")
assert.equal(isAutomaticZeroDecisionSafe(outOfStock), true)

const mismatch = classify({ finalAsin: "B000000002" })
assert.equal(mismatch.code, "SOURCE_ASIN_MISMATCH")
assert.equal(isAutomaticZeroDecisionSafe(mismatch), true)

const used = classify({ condition: "USED" })
assert.equal(used.code, "USED_OR_RESALE")
assert.equal(isAutomaticZeroDecisionSafe(used), true)

const failedAod = classify({ condition: null, shipsFromAmazon: null, purchasable: "UNKNOWN", stockStatus: null })
assert.equal(failedAod.outcome, "UNKNOWN")
assert.equal(isAutomaticZeroDecisionSafe(failedAod), false)

assert.match(STOCK_ALERTS_ROUTINE_DESKTOP_WAITING_SQL, /amazon_price_verification_tasks/)
assert.match(STOCK_ALERTS_ROUTINE_DESKTOP_WAITING_SQL, /PENDING.*CLAIMED.*RUNNING/s)
assert.match(STOCK_ALERTS_ROUTINE_DESKTOP_WAITING_SQL, /ORDER BY latest_task\.updated_at DESC, latest_task\.id DESC/)
assert.doesNotMatch(STOCK_ALERTS_ROUTINE_DESKTOP_WAITING_SQL, /Amazon doğrulaması|Extension çevrimiçi/i)

console.log("stock-guard-false-zero-fixtures: PASS")
