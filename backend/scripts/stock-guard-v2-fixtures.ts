import assert from "assert"
import fs from "fs"
import path from "path"
import { shouldCreatePriceVerificationTask } from "../modules/amazonVerification/amazonVerificationPolicy"
import { loadAmazonVerificationConfig } from "../modules/amazonVerification/amazonVerificationConfig"
import { classifyVerifiedAmazonSource } from "../modules/amazonVerification/verifiedSourceDecision"
import {
  buildKeepaBaseCandidate,
  isKeepaConfirmedPrice,
  resolveTrustedBaselinePrice,
  shouldVerifyFromKeepaRadar,
} from "../modules/globalKeepa/keepaRadarCandidate"
import { extractKeepaRadarProductFields } from "../modules/globalKeepa/keepaRadarParser"
import { planVerifiedStockAction } from "../modules/stockGuard/verifiedStockActionPlan"
import { isVisibleInPrimaryFeed } from "../modules/activity/activityFeedPolicy"
import { claimAllowedForUser } from "../modules/amazonVerification/amazonVerificationPolicy"
import type { KeepaApiProduct } from "../modules/keepa/keepaTypes"

const root = path.join(__dirname, "..")

function csv(overrides: Record<number, number>): number[] {
  const arr = Array(36).fill(-1)
  for (const [k, v] of Object.entries(overrides)) arr[Number(k)] = v
  return arr
}

function product(current: number[]): KeepaApiProduct {
  return { asin: "B0CVVX47K8", stats: { current } }
}

delete process.env.VERIFIED_STOCK_ACTIONS_ENABLED
delete process.env.ACTIVITY_CENTER_ENABLED
delete process.env.GLOBAL_KEEPA_TO_EXTENSION_DISPATCH_ENABLED
const cfg = loadAmazonVerificationConfig()
assert.equal(cfg.verifiedStockActionsEnabled, false)
assert.equal(cfg.activityCenterEnabled, false)
assert.equal(cfg.keepaDispatchEnabled, false)
console.log("PASS v2 flags default off")

{
  const mig = fs.readFileSync(path.join(root, "migrations/057_stock_guard_v2_activity.sql"), "utf8")
  assert.match(mig, /workspace_activity_events/)
  assert.match(mig, /last_verified_source_price/)
  assert.match(mig, /FBM_ONLY/)
  assert.doesNotMatch(mig, /DROP TABLE store_catalog_state/)
}
console.log("PASS v2 migration additive")

{
  const amazonPrimary = buildKeepaBaseCandidate({ amazonPriceUsd: 22.45, newPriceUsd: 22.45, newFbaCount: 25 })
  assert.equal(amazonPrimary.signalClass, "AMAZON_PRIMARY")
  assert.equal(amazonPrimary.candidate, 22.45)
  const fbaNew = buildKeepaBaseCandidate({ amazonPriceUsd: null, newPriceUsd: 19.99, newFbaCount: 2 })
  assert.equal(fbaNew.signalClass, "FBA_NEW_FALLBACK")
  const verifyPrice = buildKeepaBaseCandidate({ amazonPriceUsd: null, newPriceUsd: 44.98, newFbaCount: null })
  assert.equal(verifyPrice.candidate, null)
  assert.equal(verifyPrice.signalClass, "VERIFY_PRICE")
  const missing = buildKeepaBaseCandidate({ amazonPriceUsd: null, newPriceUsd: null, newFbaCount: null })
  assert.equal(missing.signalClass, "PRICE_MISSING_VERIFY")
}
console.log("PASS Keepa candidate rules")

{
  const fields = extractKeepaRadarProductFields(
    product(csv({ 1: 4498, 34: -1, 35: 4 }))
  )!
  assert.equal(fields.newPriceUsd, 44.98)
  assert.equal(fields.newFbaCount, null)
  assert.equal(fields.newFbmCount, 4)
  assert.equal(fields.amazonPriceUsd, null)
  const cand = buildKeepaBaseCandidate(fields)
  const d = shouldVerifyFromKeepaRadar({
    productReturned: true,
    candidate: cand.candidate,
    signalClass: cand.signalClass,
    amazonPriceUsd: fields.amazonPriceUsd,
    newPriceUsd: fields.newPriceUsd,
    newFbaCount: fields.newFbaCount,
    newFbmCount: fields.newFbmCount,
    trustedBaselinePrice: 45.1,
    previousFbaCount: null,
  })
  assert.equal(d.verify, false)
  assert.equal(!d.verify && d.code, "NO_VALID_SOURCE")
}
console.log("PASS B0CVVX47K8-style FBM_ONLY is confirmed no-valid-source, not Extension")

{
  // AMAZON_PRIMARY + null FBA + FBM>0 must VERIFY (never Keepa FBM_ONLY qty0).
  const cand = buildKeepaBaseCandidate({ amazonPriceUsd: 14.99, newPriceUsd: 14.99, newFbaCount: null })
  assert.equal(cand.signalClass, "AMAZON_PRIMARY")
  const d = shouldVerifyFromKeepaRadar({
    productReturned: true,
    candidate: cand.candidate,
    signalClass: cand.signalClass,
    amazonPriceUsd: 14.99,
    newPriceUsd: 14.99,
    newFbaCount: null,
    newFbmCount: 2,
    trustedBaselinePrice: 14.99,
    previousFbaCount: null,
  })
  assert.equal(d.verify, true)
  assert.equal(d.verify && d.signal, "PRICE_AMBIGUOUS")
  assert.equal(d.verify && d.code, "AMAZON_PRIMARY_AMBIGUOUS")
}
console.log("PASS AMAZON_PRIMARY with null FBA count verifies instead of FBM_ONLY")

{
  const cand = buildKeepaBaseCandidate({ amazonPriceUsd: null, newPriceUsd: 22.45, newFbaCount: 25 })
  assert.equal(cand.signalClass, "FBA_NEW_FALLBACK")
  const d = shouldVerifyFromKeepaRadar({
    productReturned: true,
    candidate: cand.candidate,
    signalClass: cand.signalClass,
    amazonPriceUsd: null,
    newPriceUsd: 22.45,
    newFbaCount: 25,
    newFbmCount: 0,
    trustedBaselinePrice: 25,
    previousFbaCount: 25,
  })
  assert.equal(d.verify, true)
  assert.equal(d.verify && d.signal, "PRICE_CHANGED")
  assert.equal(isKeepaConfirmedPrice({
    productReturned: true,
    candidate: cand.candidate,
    signalClass: cand.signalClass,
    newFbaCount: 25,
    newFbmCount: 0,
  }), false)
  assert.notEqual(cand.candidate, 25)
}
console.log("PASS B00367HAV6-style Keepa candidate must not become accepted price")

{
  const cand = buildKeepaBaseCandidate({ amazonPriceUsd: 19.99, newPriceUsd: 19.99, newFbaCount: 3 })
  const d = shouldVerifyFromKeepaRadar({
    productReturned: true,
    candidate: cand.candidate,
    signalClass: cand.signalClass,
    amazonPriceUsd: 19.99,
    newPriceUsd: 19.99,
    newFbaCount: 3,
    newFbmCount: 0,
    trustedBaselinePrice: 19.99,
    previousFbaCount: 3,
  })
  assert.equal(d.verify, false)
  assert.equal(!d.verify && d.code, "STABLE")
}
console.log("PASS stable ASIN no verification")

{
  const d = shouldVerifyFromKeepaRadar({
    productReturned: false,
    candidate: null,
    signalClass: "PRICE_MISSING_VERIFY",
    amazonPriceUsd: null,
    newPriceUsd: null,
    newFbaCount: null,
    newFbmCount: null,
    trustedBaselinePrice: 10,
    previousFbaCount: 1,
  })
  assert.equal(d.verify && d.signal, "PRODUCT_NOT_RETURNED")
}
console.log("PASS missing Keepa product is verify, not OOS")

const base = {
  keepaFailureCount: 0,
  dispatchEnabled: true,
  verificationEnabled: true,
  keepaOutage: false,
  pendingTaskCount: 0,
  fallbackTasksLastMinute: 0,
  keepaMaxRetries: 3,
  maxPending: 400,
  maxPerMinute: 20,
  source: "planner" as const,
}
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "PRICE_CHANGED" }).create, true)
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "FBM_ONLY" }).reason, "FBM_ONLY")
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "CHECK_FAILED", keepaFailureCount: 1 }).create, false)
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "FBA_MISSING" }).create, false)
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "PRICE_CHANGED", dispatchEnabled: false }).create, false)
console.log("PASS Keepa signal enqueue policy")

{
  const valid = classifyVerifiedAmazonSource({
    requestedAsin: "B0VALID0001",
    finalAsin: "B0VALID0001",
    displayedPrice: 18.4,
    condition: "NEW",
    isPrime: true,
    isFba: true,
    shipsFromAmazon: true,
    purchasable: "TRUE",
  })
  assert.equal(valid.outcome, "VALID_SOURCE")
  assert.equal(valid.acceptedPrice, 18.4)
  assert.equal(valid.mutationAllowed, false)

  const fbm = classifyVerifiedAmazonSource({
    requestedAsin: "B0FBMONLY01",
    displayedPrice: 45.1,
    condition: "NEW",
    isPrime: false,
    isFba: false,
    shipsFromAmazon: false,
    purchasable: "TRUE",
  })
  assert.equal(fbm.outcome, "CONFIRMED_NO_VALID_SOURCE")
  assert.equal(fbm.code, "NOT_PRIME")
  assert.equal(fbm.mutationAllowed, true)

  const noPrimeWithFba = classifyVerifiedAmazonSource({
    requestedAsin: "B0NOPRIME01",
    displayedPrice: 10,
    condition: "NEW",
    isPrime: false,
    isFba: true,
    shipsFromAmazon: true,
    purchasable: "TRUE",
  })
  assert.equal(noPrimeWithFba.outcome, "CONFIRMED_NO_VALID_SOURCE")
  assert.equal(noPrimeWithFba.code, "NOT_PRIME")

  const currentlyUnavail = classifyVerifiedAmazonSource({
    requestedAsin: "B0OOS000001",
    displayedPrice: 12,
    isPrime: false,
    isFba: false,
    purchasable: "FALSE",
    stockStatus: "OUT_OF_STOCK",
    availabilityText:
      "Currently unavailable. We don't know when or if this item will be back in stock.",
  })
  assert.equal(currentlyUnavail.outcome, "CONFIRMED_NO_VALID_SOURCE")
  assert.equal(currentlyUnavail.code, "OUT_OF_STOCK")

  const notFba = classifyVerifiedAmazonSource({
    requestedAsin: "B0NOTFBA001",
    displayedPrice: 18,
    isPrime: true,
    isFba: false,
    shipsFromAmazon: false,
    purchasable: "TRUE",
  })
  assert.equal(notFba.outcome, "CONFIRMED_NO_VALID_SOURCE")
  assert.equal(notFba.code, "NOT_FBA")

  const unavail = classifyVerifiedAmazonSource({
    requestedAsin: "B0UNAVAIL01",
    pageUnavailable: true,
    purchasable: "FALSE",
  })
  assert.equal(unavail.outcome, "CONFIRMED_NO_VALID_SOURCE")
  assert.equal(unavail.code, "PRODUCT_UNAVAILABLE")

  const redirect = classifyVerifiedAmazonSource({
    requestedAsin: "B0CKXGVG2G",
    finalAsin: "B0BNZXRCK9",
    displayedPrice: 9.99,
    condition: "NEW",
    isPrime: true,
    shipsFromAmazon: true,
    purchasable: "TRUE",
  })
  assert.equal(redirect.outcome, "UNKNOWN")
  assert.equal(redirect.code, "SOURCE_ASIN_MISMATCH")
  assert.equal(redirect.mutationAllowed, false)

  const captcha = classifyVerifiedAmazonSource({
    requestedAsin: "B0CAPTCHA01",
    captcha: true,
  })
  assert.equal(captcha.outcome, "UNKNOWN")
  assert.equal(captcha.mutationAllowed, false)

  const login = classifyVerifiedAmazonSource({
    requestedAsin: "B0LOGIN0001",
    loginRequired: true,
  })
  assert.equal(login.outcome, "UNKNOWN")

  const timeout = classifyVerifiedAmazonSource({
    requestedAsin: "B0TIMEOUT01",
    timeout: true,
  })
  assert.equal(timeout.outcome, "UNKNOWN")
}
console.log("PASS extension source decision fixtures")

const settingsManual = {
  enabled: true,
  mode: "manual" as const,
  priceAlertEnabled: true,
  autoProfitProtectionEnabled: false,
}
const settingsAuto = {
  enabled: true,
  mode: "auto" as const,
  priceAlertEnabled: true,
  autoProfitProtectionEnabled: true,
}
{
  const decision = classifyVerifiedAmazonSource({
    requestedAsin: "B0ZERO0001",
    pageUnavailable: true,
    purchasable: "FALSE",
  })
  const plan = planVerifiedStockAction({
    decision,
    settings: settingsManual,
    currentEbayQuantity: 4,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: null,
    verifiedActionsEnabled: true,
  })
  assert.equal(plan.action, "zero_stock")
  if (plan.action === "zero_stock") assert.equal(plan.evenInManual, true)
  const again = planVerifiedStockAction({
    decision,
    settings: settingsManual,
    currentEbayQuantity: 0,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: "CONFIRMED_NO_VALID_SOURCE",
    verifiedActionsEnabled: true,
  })
  assert.equal(again.action, "none")
  const unknown = planVerifiedStockAction({
    decision: classifyVerifiedAmazonSource({ requestedAsin: "B0CAP000001", captcha: true }),
    settings: settingsAuto,
    currentEbayQuantity: 4,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: null,
    verifiedActionsEnabled: true,
  })
  assert.equal(unknown.action, "none")

  const notPrimePlan = planVerifiedStockAction({
    decision: classifyVerifiedAmazonSource({
      requestedAsin: "B0NOPRIME01",
      displayedPrice: 10,
      isPrime: false,
      isFba: true,
      purchasable: "TRUE",
    }),
    settings: settingsManual,
    currentEbayQuantity: 3,
    trustedBaselinePrice: 10,
    lastVerifiedDecision: "VALID_SOURCE",
    verifiedActionsEnabled: true,
  })
  assert.equal(notPrimePlan.action, "zero_stock")

  const oosPlan = planVerifiedStockAction({
    decision: classifyVerifiedAmazonSource({
      requestedAsin: "B0OOS000001",
      availabilityText: "Currently unavailable. We don't know when or if this item will be back in stock.",
    }),
    settings: settingsManual,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: "VALID_SOURCE",
    verifiedActionsEnabled: true,
  })
  assert.equal(oosPlan.action, "zero_stock")

  const mismatchPlan = planVerifiedStockAction({
    decision: classifyVerifiedAmazonSource({
      requestedAsin: "B0CKXGVG2G",
      finalAsin: "B0BNZXRCK9",
      displayedPrice: 9.99,
      isPrime: true,
      shipsFromAmazon: true,
      purchasable: "TRUE",
    }),
    settings: settingsAuto,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 9.99,
    lastVerifiedDecision: "VALID_SOURCE",
    verifiedActionsEnabled: true,
  })
  assert.equal(mismatchPlan.action, "approval_required")
}
console.log("PASS amazon gone page / Prime missing / OOS zero even in manual; captcha no mutation; ASIN mismatch stays approval")

{
  const decision = classifyVerifiedAmazonSource({
    requestedAsin: "B0PRICE0001",
    finalAsin: "B0PRICE0001",
    displayedPrice: 23,
    condition: "NEW",
    isPrime: true,
    shipsFromAmazon: true,
    purchasable: "TRUE",
  })
  const manual = planVerifiedStockAction({
    decision,
    settings: settingsManual,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: "VALID_SOURCE",
    verifiedActionsEnabled: true,
  })
  assert.equal(manual.action, "price_approval_required")
  const auto = planVerifiedStockAction({
    decision,
    settings: settingsAuto,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: "VALID_SOURCE",
    verifiedActionsEnabled: true,
  })
  assert.equal(auto.action, "profit_protection")
  const manualPpOn = planVerifiedStockAction({
    decision,
    settings: { ...settingsManual, autoProfitProtectionEnabled: true },
    currentEbayQuantity: 2,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: "VALID_SOURCE",
    verifiedActionsEnabled: true,
  })
  assert.equal(manualPpOn.action, "profit_protection")
  const down = planVerifiedStockAction({
    decision: { ...decision, acceptedPrice: 18 },
    settings: settingsAuto,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: "VALID_SOURCE",
    verifiedActionsEnabled: true,
  })
  assert.equal(down.action, "verified_ok")
}
console.log("PASS manual price approval / auto profit protection / manual mode does not block toggle / no auto decrease")

{
  const now = new Date("2026-08-21T12:00:00Z")
  assert.equal(isVisibleInPrimaryFeed({ createdAt: new Date("2026-08-21T01:00:00Z"), now }), true)
  assert.equal(isVisibleInPrimaryFeed({ createdAt: new Date("2026-08-20T11:00:00Z"), now }), false)
}
console.log("PASS 24h feed visibility without delete")

assert.equal(
  claimAllowedForUser({
    taskWorkspaceId: "ws-a",
    taskPreferredUserId: "user-a",
    workerWorkspaceId: "ws-b",
    workerUserId: "user-a",
  }),
  false
)
assert.equal(
  resolveTrustedBaselinePrice({ lastVerifiedPrice: 25, sourcePrice: 22.45 }),
  25
)
assert.equal(
  resolveTrustedBaselinePrice({
    lastVerifiedPrice: 31.99,
    sourcePrice: 9.99,
    lastVerifiedDecision: "UNKNOWN",
  }),
  9.99
)
assert.equal(
  resolveTrustedBaselinePrice({
    lastVerifiedPrice: 31.99,
    sourcePrice: 9.99,
    lastVerifiedDecision: "VALID_SOURCE",
  }),
  31.99
)
console.log("PASS tenant claim isolation + trusted baseline priority")

const planner = fs.readFileSync(path.join(root, "modules/globalKeepa/globalKeepaPlannerTick.ts"), "utf8")
assert.doesNotMatch(planner, /zeroListingQuantityOnEbay/)
assert.doesNotMatch(planner, /updateListingPriceOnEbay/)
assert.doesNotMatch(planner, /applyAcceptedSourcePrice/)
const autoZero = fs.readFileSync(path.join(root, "modules/stockGuard/verifiedStockActionService.ts"), "utf8")
assert.match(autoZero, /approval_required/)
assert.match(autoZero, /applyConfirmedNoValidSource/)
assert.match(autoZero, /applyAcceptedSourcePrice/)
const zeroPipe = fs.readFileSync(path.join(root, "modules/stockGuard/confirmedNoValidSourcePipeline.ts"), "utf8")
assert.match(zeroPipe, /zeroListingQuantityOnEbay/)
assert.match(zeroPipe, /verified_source_safety/)
const persistSrc = fs.readFileSync(path.join(root, "modules/stockGuard/acceptedSourcePricePipeline.ts"), "utf8")
assert.match(persistSrc, /WHEN \$4 = 'VALID_SOURCE' AND \$3::numeric IS NOT NULL/)
assert.match(persistSrc, /updateListingPriceOnEbay/)
assert.match(persistSrc, /calculateRecommendedEbayPrice/)
const planSrc = fs.readFileSync(path.join(root, "modules/stockGuard/verifiedStockActionPlan.ts"), "utf8")
assert.match(planSrc, /approval_required/)
assert.match(planSrc, /zero_stock/)
console.log("PASS Keepa planner has no eBay mutation; confirmed source failures can zero")

{
  const restore = planVerifiedStockAction({
    decision: classifyVerifiedAmazonSource({
      requestedAsin: "B0REST00001",
      finalAsin: "B0REST00001",
      displayedPrice: 12,
      condition: "NEW",
      isPrime: true,
      shipsFromAmazon: true,
      purchasable: "TRUE",
    }),
    settings: settingsManual,
    currentEbayQuantity: 0,
    trustedBaselinePrice: 12,
    lastVerifiedDecision: "CONFIRMED_NO_VALID_SOURCE",
    verifiedActionsEnabled: true,
  })
  assert.equal(restore.action, "verified_ok")
}
console.log("PASS confirmed-failure recovery is verified_ok, not SOURCE_RESTORED scan")

console.log("PASS stock-guard v2 fixtures")
