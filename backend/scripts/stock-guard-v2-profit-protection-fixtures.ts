import assert from "assert"
import fs from "fs"
import path from "path"
import { classifyVerifiedAmazonSource } from "../modules/amazonVerification/verifiedSourceDecision"
import {
  buildKeepaBaseCandidate,
  isKeepaConfirmedPrice,
  keepaConfirmedSourceDecision,
  shouldVerifyFromKeepaRadar,
} from "../modules/globalKeepa/keepaRadarCandidate"
import { profitProtectionIdempotencyKey } from "../modules/globalKeepa/sourceAsinLifecycle"
import { planVerifiedStockAction } from "../modules/stockGuard/verifiedStockActionPlan"
import {
  formatProfitProtectionFailedReason,
  formatProfitProtectionReason,
  formatStockAlertStatusLabel,
  safeEbayErrorMessage,
} from "../modules/stockAlerts/stockAlertUserMessages"

const root = path.join(__dirname, "..")
function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8")
}

const settingsPpOnManual = {
  enabled: true,
  mode: "manual" as const,
  priceAlertEnabled: true,
  autoProfitProtectionEnabled: true,
}
const settingsPpOff = {
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

function radar(input: {
  amazonPriceUsd: number | null
  newPriceUsd: number | null
  newFbaCount: number | null
  newFbmCount: number | null
  trusted: number | null
  previousFba?: number | null
  productReturned?: boolean
}) {
  const cand = buildKeepaBaseCandidate({
    amazonPriceUsd: input.amazonPriceUsd,
    newPriceUsd: input.newPriceUsd,
    newFbaCount: input.newFbaCount,
  })
  const confirmed = isKeepaConfirmedPrice({
    productReturned: input.productReturned !== false,
    candidate: cand.candidate,
    signalClass: cand.signalClass,
    newFbaCount: input.newFbaCount,
    newFbmCount: input.newFbmCount,
  })
  const decision = shouldVerifyFromKeepaRadar({
    productReturned: input.productReturned !== false,
    candidate: cand.candidate,
    signalClass: cand.signalClass,
    newPriceUsd: input.newPriceUsd,
    newFbaCount: input.newFbaCount,
    newFbmCount: input.newFbmCount,
    trustedBaselinePrice: input.trusted,
    previousFbaCount: input.previousFba ?? input.newFbaCount,
  })
  return { cand, confirmed, decision }
}

function validDecision(price: number, asin = "B0PRICE0001") {
  return classifyVerifiedAmazonSource({
    requestedAsin: asin,
    finalAsin: asin,
    displayedPrice: price,
    condition: "NEW",
    isPrime: true,
    shipsFromAmazon: true,
    purchasable: "TRUE",
  })
}

{
  const a = radar({
    amazonPriceUsd: 25,
    newPriceUsd: 25,
    newFbaCount: 8,
    newFbmCount: 0,
    trusted: 20,
  })
  assert.equal(a.cand.signalClass, "AMAZON_PRIMARY")
  assert.equal(a.confirmed, true)
  assert.equal(a.decision.verify, false)
  assert.equal(!a.decision.verify && a.decision.code, "CONFIRMED")
  const plan = planVerifiedStockAction({
    decision: keepaConfirmedSourceDecision("B0KEEPA0001", 25),
    settings: settingsPpOnManual,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: "VALID_SOURCE",
    lastVerifiedAsin: "B0KEEPA0001",
    currentSourceAsin: "B0KEEPA0001",
    verifiedActionsEnabled: true,
  })
  assert.equal(plan.action, "profit_protection")
  if (plan.action === "profit_protection") {
    assert.equal(plan.amazonBefore, 20)
    assert.equal(plan.amazonAfter, 25)
  }
  const bridge = read("modules/amazonVerification/amazonVerificationKeepaBridge.ts")
  const dispatch = bridge.split("export async function dispatchKeepaRadarVerification")[1] ?? ""
  assert.match(dispatch, /confirmationSource: "KEEPA_CONFIRMED"/)
  assert.match(dispatch, /applyAcceptedSourcePrice/)
  assert.match(dispatch, /decision.code === "CONFIRMED"/)
  const enqueueIdx = dispatch.indexOf("enqueueFromKeepaSignal")
  const confirmedIdx = dispatch.indexOf('decision.code === "CONFIRMED"')
  assert.ok(confirmedIdx >= 0 && enqueueIdx > confirmedIdx)
}
console.log("PASS A Keepa confirmed 20→25 + PP on: CONFIRMED, no Extension enqueue, same PP plan")

{
  const b = radar({
    amazonPriceUsd: 20,
    newPriceUsd: 20,
    newFbaCount: 8,
    newFbmCount: 0,
    trusted: 20,
  })
  assert.equal(b.confirmed, true)
  assert.equal(b.decision.verify, false)
  assert.equal(!b.decision.verify && b.decision.code, "STABLE")
  const plan = planVerifiedStockAction({
    decision: keepaConfirmedSourceDecision("B0KEEPA0001", 20),
    settings: settingsPpOnManual,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: "VALID_SOURCE",
    lastVerifiedAsin: "B0KEEPA0001",
    currentSourceAsin: "B0KEEPA0001",
    verifiedActionsEnabled: true,
  })
  assert.equal(plan.action, "profit_protection")
  if (plan.action === "profit_protection") {
    assert.equal(plan.amazonBefore, 20)
    assert.equal(plan.amazonAfter, 20)
  }
  const bridgeStable = read("modules/amazonVerification/amazonVerificationKeepaBridge.ts")
  const dispatchStable = bridgeStable.split("export async function dispatchKeepaRadarVerification")[1] ?? ""
  const stableIdx = dispatchStable.indexOf('decision.code === "STABLE"')
  const persistIdx = dispatchStable.indexOf("persistVerifiedCatalogState")
  assert.ok(stableIdx >= 0)
  assert.ok(persistIdx < 0 || persistIdx < stableIdx)
  assert.match(dispatchStable.slice(stableIdx), /applyAcceptedSourcePrice/)
}
console.log("PASS B Keepa confirmed 20→20: STABLE still checks profitability via accepted-price pipeline")

{
  const c = radar({
    amazonPriceUsd: null,
    newPriceUsd: 25,
    newFbaCount: 8,
    newFbmCount: 0,
    trusted: 20,
  })
  assert.equal(c.cand.signalClass, "FBA_NEW_FALLBACK")
  assert.equal(c.confirmed, false)
  assert.equal(c.decision.verify, true)
  assert.equal(c.decision.verify && c.decision.signal, "PRICE_CHANGED")
}
console.log("PASS C Keepa uncertain candidate: not accepted, existing Extension path")

{
  const d = planVerifiedStockAction({
    decision: validDecision(25),
    settings: settingsPpOnManual,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: "VALID_SOURCE",
    lastVerifiedAsin: "B0PRICE0001",
    currentSourceAsin: "B0PRICE0001",
    verifiedActionsEnabled: true,
  })
  assert.equal(d.action, "profit_protection")
  const apply = read("modules/stockGuard/verifiedStockActionService.ts")
  assert.match(apply, /confirmationSource: "EXTENSION_VERIFIED"/)
  assert.match(apply, /applyAcceptedSourcePrice/)
}
console.log("PASS D Extension VALID_SOURCE 20→25 + PP on: same common PP plan")

{
  const e = planVerifiedStockAction({
    decision: validDecision(25),
    settings: settingsPpOff,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: "VALID_SOURCE",
    verifiedActionsEnabled: true,
  })
  assert.equal(e.action, "price_approval_required")
}
console.log("PASS E Extension VALID_SOURCE + PP off: manual PRICE_INCREASE, no auto PP")

{
  const f = planVerifiedStockAction({
    decision: keepaConfirmedSourceDecision("B0KEEPA0001", 25),
    settings: settingsPpOff,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: "VALID_SOURCE",
    lastVerifiedAsin: "B0KEEPA0001",
    currentSourceAsin: "B0KEEPA0001",
    verifiedActionsEnabled: true,
  })
  assert.equal(f.action, "price_approval_required")
}
console.log("PASS F Keepa confirmed + PP off: no auto eBay mutation, pending increase")

{
  const gRadar = radar({
    amazonPriceUsd: 20,
    newPriceUsd: 20,
    newFbaCount: 8,
    newFbmCount: 0,
    trusted: 25,
  })
  assert.equal(gRadar.confirmed, true)
  assert.equal(!gRadar.decision.verify && gRadar.decision.code, "CONFIRMED")
  const g = planVerifiedStockAction({
    decision: keepaConfirmedSourceDecision("B0KEEPA0001", 20),
    settings: settingsAuto,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 25,
    lastVerifiedDecision: "VALID_SOURCE",
    lastVerifiedAsin: "B0KEEPA0001",
    currentSourceAsin: "B0KEEPA0001",
    verifiedActionsEnabled: true,
  })
  assert.equal(g.action, "verified_ok")
}
console.log("PASS G Amazon 25→20: no automatic eBay decrease")

{
  const h = planVerifiedStockAction({
    decision: keepaConfirmedSourceDecision("B0BBBBBBB2", 25),
    settings: settingsAuto,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 20,
    lastVerifiedDecision: "VALID_SOURCE",
    lastVerifiedAsin: "B0AAAAAAA1",
    currentSourceAsin: "B0BBBBBBB2",
    verifiedActionsEnabled: true,
  })
  assert.equal(h.action, "profit_protection")
  if (h.action === "profit_protection") {
    assert.equal(h.amazonBefore, 25)
    assert.equal(h.amazonAfter, 25)
  }
}
console.log("PASS H A→B first confirmed price is bootstrap, not A→B increase; PP still checks required eBay")

{
  const reason = formatProfitProtectionFailedReason({
    amazonBefore: 20,
    amazonAfter: 25,
    targetEbay: 42.5,
    error: "eBay inventory 500",
  })
  assert.match(reason, /\$20\.00 → \$25\.00/)
  assert.match(reason, /\$42\.50/)
  assert.match(reason, /başarısız/)
  assert.doesNotMatch(reason, /Kâr Koruma eBay fiyatını .* güncelledi/)
  assert.equal(
    formatStockAlertStatusLabel({
      sourceStatus: "PRICE_INCREASE",
      reviewStatus: "failed",
      reason,
    }),
    "Kâr Koruma Başarısız"
  )
  const pipeline = read("modules/stockGuard/acceptedSourcePricePipeline.ts")
  const ebayIdx = pipeline.indexOf("await updateListingPriceOnEbay")
  const persistEbayAfter = pipeline.indexOf("await persistCatalogEbayPrice", ebayIdx)
  const persistSrcAfter = pipeline.indexOf("await persistAccepted()", ebayIdx)
  const catchIdx = pipeline.indexOf("} catch (e) {", ebayIdx)
  const failedReturn = pipeline.indexOf('planAction: "profit_protection_failed"', catchIdx)
  const catchBlock = pipeline.slice(catchIdx, failedReturn + 80)
  assert.ok(ebayIdx > 0 && persistEbayAfter > ebayIdx, "local eBay persist only after mutation")
  assert.ok(persistSrcAfter > ebayIdx, "accepted Amazon persist after eBay mutation for PP")
  assert.match(catchBlock, /formatProfitProtectionFailedReason/)
  assert.doesNotMatch(catchBlock, /persistCatalogEbayPrice/)
  assert.match(catchBlock, /persistAccepted/)
  assert.match(pipeline, /formatProfitProtectionFailedReason/)
}
console.log("PASS I eBay update fail: source persists, eBay stays unchanged, failed state")

{
  const k1 = profitProtectionIdempotencyKey(99, 2500)
  const k2 = profitProtectionIdempotencyKey(99, 2500)
  const k3 = profitProtectionIdempotencyKey(99, 2600)
  assert.equal(k1, k2)
  assert.notEqual(k1, k3)
  const pipeline = read("modules/stockGuard/acceptedSourcePricePipeline.ts")
  assert.match(pipeline, /profitProtectionIdempotencyKey/)
  assert.match(pipeline, /findActivityByIdempotencyKey/)
  assert.match(pipeline, /alreadyCompleted: true/)
}
console.log("PASS J same logical PP action is idempotent by catalog+amazon cents")

{
  const k = radar({
    amazonPriceUsd: 25,
    newPriceUsd: 25,
    newFbaCount: 8,
    newFbmCount: 0,
    trusted: 20,
    productReturned: false,
  })
  assert.equal(k.confirmed, false)
  assert.equal(k.decision.verify, true)
  assert.equal(k.decision.verify && k.decision.signal, "PRODUCT_NOT_RETURNED")
  const tick = read("modules/globalKeepa/globalKeepaPlannerTick.ts")
  const failIdx = tick.indexOf("persistKeepaSnapshotFailure")
  const dispatchIdx = tick.indexOf("dispatchKeepaRadarVerification")
  assert.ok(failIdx > 0 && dispatchIdx > failIdx)
  const failReturn = tick.indexOf("errorCode: fetched.code")
  assert.ok(failReturn > 0 && failReturn < dispatchIdx, "HTTP/technical Keepa failure returns before dispatch")
}
console.log("PASS K technical Keepa failure is never accepted and never reprices")

{
  const keepaReason = formatProfitProtectionReason({
    amazonBefore: 20,
    amazonAfter: 25,
    ebayBefore: 34.95,
    ebayAfter: 42.5,
    confirmation: "KEEPA_CONFIRMED",
  })
  assert.match(keepaReason, /Keepa tarafından doğrulandı/)
  assert.match(keepaReason, /\$34\.95 → \$42\.50/)
  assert.equal(
    formatStockAlertStatusLabel({
      sourceStatus: "PRICE_INCREASE",
      reviewStatus: "actioned",
      reason: keepaReason,
    }),
    "Kâr Koruma"
  )
  const extReason = formatProfitProtectionReason({
    amazonBefore: 20,
    amazonAfter: 25,
    ebayBefore: 34.95,
    ebayAfter: 42.5,
    confirmation: "EXTENSION_VERIFIED",
  })
  assert.match(extReason, /Amazon doğrulaması tamamlandı/)
  assert.doesNotMatch(safeEbayErrorMessage("Bearer secret-token oops"), /secret-token/)
}
console.log("PASS Stock Alert Kâr Koruma wording Keepa vs Extension")

{
  const mixed = radar({
    amazonPriceUsd: 25,
    newPriceUsd: 25,
    newFbaCount: 8,
    newFbmCount: 3,
    trusted: 20,
  })
  assert.equal(mixed.confirmed, false)
  assert.equal(mixed.decision.verify, true)
  assert.equal(mixed.decision.verify && mixed.decision.signal, "PRICE_CHANGED")
}
console.log("PASS mixed FBA+FBM Amazon CSV is not Keepa confirmed")

{
  const pipeline = read("modules/stockGuard/acceptedSourcePricePipeline.ts")
  const apply = read("modules/stockGuard/verifiedStockActionService.ts")
  assert.match(pipeline, /calculateRecommendedEbayPrice/)
  assert.doesNotMatch(pipeline, /function calculateListingPrice/)
  assert.match(apply, /applyAcceptedSourcePrice/)
  assert.doesNotMatch(apply, /await updateListingPriceOnEbay/)
  const tick = read("modules/globalKeepa/globalKeepaPlannerTick.ts")
  assert.doesNotMatch(tick, /updateListingPriceOnEbay/)
}
console.log("PASS common pricing pipeline; Keepa planner tick has no eBay mutation")

console.log("PASS stock-guard v2 profit protection fixtures")
