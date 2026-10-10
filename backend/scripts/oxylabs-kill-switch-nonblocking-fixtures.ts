import assert from "node:assert/strict"
import { isAutomaticZeroDecisionSafe, type VerifiedSourceDecision } from "../modules/amazonVerification/verifiedSourceDecision"
import { planVerifiedStockAction } from "../modules/stockGuard/verifiedStockActionPlan"

process.env.DATABASE_URL ??= "postgresql://fixture:fixture@127.0.0.1:1/fixture"
const { zeroStockTelemetryAllowsMutation } = require("../modules/oxylabsVerify/oxylabsApplyOperations") as typeof import("../modules/oxylabsVerify/oxylabsApplyOperations")

for (const state of [
  { consecutiveSuccesses: 0, reservedSlots: 0, active: false },
  { consecutiveSuccesses: 9, reservedSlots: 0, active: false },
  { consecutiveSuccesses: 10, reservedSlots: 0, active: true },
  { consecutiveSuccesses: 25, reservedSlots: 0, active: true },
]) {
  assert.equal(zeroStockTelemetryAllowsMutation(state), true, JSON.stringify(state))
}

const decision = (
  code: string,
  outcome: VerifiedSourceDecision["outcome"] = "CONFIRMED_NO_VALID_SOURCE",
  mutationAllowed = true
): VerifiedSourceDecision => {
  const mismatch = code === "SOURCE_ASIN_MISMATCH"
  return {
    outcome,
    code,
    acceptedPrice: null,
    requestedAsin: "B00TEST001",
    finalAsin: mismatch ? "B00TEST002" : "B00TEST001",
    redirected: mismatch,
    validPrimeOrFba: false,
    mutationAllowed,
  }
}

const plan = (d: VerifiedSourceDecision) => planVerifiedStockAction({
  decision: d,
  settings: { enabled: true, mode: "auto", priceAlertEnabled: true, autoProfitProtectionEnabled: true },
  currentEbayQuantity: 1,
  trustedBaselinePrice: 10,
  lastVerifiedDecision: "VALID_SOURCE",
  verifiedActionsEnabled: true,
  lastVerifiedAsin: "B00TEST001",
  currentSourceAsin: "B00TEST001",
})

for (const code of [
  "NO_VERIFIED_NEW_FBA_OFFER",
  "USED_OR_RESALE",
  "OUT_OF_STOCK",
  "SOURCE_ASIN_MISMATCH",
]) {
  const d = decision(code)
  assert.equal(isAutomaticZeroDecisionSafe(d), true, code)
  assert.equal(plan(d).action, "zero_stock", code)
}

const unapproved = decision("ARBITRARY_SOURCE_INVALID")
assert.equal(isAutomaticZeroDecisionSafe(unapproved), false, "unsafe_confirmed_result")

const inconclusive = decision("PRODUCT_INCONCLUSIVE", "UNKNOWN", false)
assert.equal(isAutomaticZeroDecisionSafe(inconclusive), false, inconclusive.code)
assert.notEqual(plan(inconclusive).action, "zero_stock", inconclusive.code)

console.log("PASS Oxylabs kill-switch telemetry is non-blocking; source and Stock Guard safety remain enforced")
