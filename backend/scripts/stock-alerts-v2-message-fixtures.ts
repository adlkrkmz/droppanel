import assert from "assert"
import fs from "fs"
import path from "path"
import {
  PRICE_INCREASE_FAILED,
  PRICE_UNCERTAIN_GENERIC,
  PRICE_UNCERTAIN_QUEUED,
  PRICE_UNCERTAIN_WAITING,
  STOCK_ZERO_FAILED,
  formatPriceIncreasePendingReason,
  formatProfitProtectionReason,
  formatProfitProtectionFailedReason,
  formatStockAlertStatusLabel,
  formatStockZeroReason,
  formatConfirmedInvalidSourcePendingReason,
  isOperationalUserReason,
  shouldPreserveUncertainReason,
  canReplacePendingReviewWithUncertain,
  verificationEnqueueReason,
} from "../modules/stockAlerts/stockAlertUserMessages"
import {
  parseAdminStockReviewStatus,
  buildAdminListStatusClause,
  STOCK_ALERTS_OPERATIONAL_FEED_SQL,
} from "../modules/stockAlerts/stockAlertListQuery"
import { isPrimaryFeedEventType, isNoOpVerifiedPlanAction } from "../modules/activity/activityFeedPolicy"
import { classifyVerifiedAmazonSource } from "../modules/amazonVerification/verifiedSourceDecision"
import { planVerifiedStockAction } from "../modules/stockGuard/verifiedStockActionPlan"

const root = path.join(__dirname, "..")

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8")
}

{
  assert.equal(verificationEnqueueReason(false), PRICE_UNCERTAIN_QUEUED)
  assert.equal(verificationEnqueueReason(true), PRICE_UNCERTAIN_WAITING)
  assert.ok(!PRICE_UNCERTAIN_GENERIC.includes("Extension"))
  assert.ok(PRICE_UNCERTAIN_QUEUED.includes("Extension doğrulamasına gönderildi"))
  assert.ok(PRICE_UNCERTAIN_WAITING.includes("Extension çevrimiçi"))
}
console.log("PASS 1-3 uncertainty / queued / waiting messages")

{
  const pending = formatPriceIncreasePendingReason(3, 4.76)
  assert.match(pending, /\$3\.00 → \$4\.76/)
  assert.match(pending, /onay bekliyor/)
  assert.equal(formatStockAlertStatusLabel({ sourceStatus: "PRICE_INCREASE", reviewStatus: "pending", reason: pending }), "Fiyat Arttı")
}
console.log("PASS 4 verified price increase manual message")

{
  const reason = formatProfitProtectionReason({
    amazonBefore: 3,
    amazonAfter: 4.76,
    ebayBefore: 8.2,
    ebayAfter: 10.45,
  })
  assert.match(reason, /\$3\.00 → \$4\.76/)
  assert.match(reason, /\$8\.20 → \$10\.45/)
  assert.match(reason, /Kâr Koruma/)
  assert.match(reason, /Amazon doğrulaması tamamlandı/)
  assert.equal(
    formatStockAlertStatusLabel({ sourceStatus: "PRICE_INCREASE", reviewStatus: "actioned", reason }),
    "Kâr Koruma"
  )
  const keepa = formatProfitProtectionReason({
    amazonBefore: 20,
    amazonAfter: 25,
    ebayBefore: 34.95,
    ebayAfter: 42.5,
    confirmation: "KEEPA_CONFIRMED",
  })
  assert.match(keepa, /Keepa tarafından doğrulandı/)
}
console.log("PASS 5 profit protection message")

{
  const noFba = formatStockZeroReason({ code: "NO_VALID_PRIME_FBA", oldQty: 3 })
  assert.match(noFba, /3 → 0/)
  assert.match(noFba, /Prime\/FBA/)
  const redirect = formatStockZeroReason({ code: "SOURCE_ASIN_REDIRECTED", oldQty: 1 })
  assert.match(redirect, /yönlendiriyor/)
  assert.match(redirect, /1 → 0/)
  const unavail = formatStockZeroReason({ code: "PRODUCT_UNAVAILABLE", oldQty: 2 })
  assert.match(unavail, /artık mevcut değil/)
  const oos = formatStockZeroReason({ code: "OUT_OF_STOCK", oldQty: 4 })
  assert.match(oos, /Amazon'da stok yok/)
  assert.match(oos, /4 → 0/)
  const noPrime = formatStockZeroReason({ code: "NOT_PRIME", oldQty: 2 })
  assert.match(noPrime, /Prime rozeti bulunamadı/)
  const notFba = formatStockZeroReason({ code: "NOT_FBA", oldQty: 1 })
  assert.match(notFba, /FBA kaynak bulunamadı/)
  assert.equal(
    formatStockAlertStatusLabel({ sourceStatus: "PRICE_UNCERTAIN", reviewStatus: "actioned", reason: noFba }),
    "Stok Sıfırlandı"
  )
  assert.equal(
    formatStockAlertStatusLabel({ sourceStatus: "UNAVAILABLE", reviewStatus: "actioned", reason: oos }),
    "Stok Sıfırlandı"
  )
}
console.log("PASS 6-7 stock zero reasons")

{
  const gated = formatConfirmedInvalidSourcePendingReason({ code: "NO_VALID_PRIME_FBA" })
  assert.doesNotMatch(gated, /çekildi/)
  assert.doesNotMatch(gated, /sıfırlandı/)
  assert.match(gated, /onay bekliyor/)
  assert.equal(
    formatStockAlertStatusLabel({ sourceStatus: "UNAVAILABLE", reviewStatus: "pending", reason: gated }),
    "Kaynak yok"
  )
  assert.equal(isOperationalUserReason(gated), true)
}
console.log("PASS gated no-valid-source pending reason")

{
  assert.equal(
    formatStockAlertStatusLabel({ sourceStatus: "PRICE_UNCERTAIN", reviewStatus: "failed", reason: STOCK_ZERO_FAILED }),
    "Stok Güncellemesi Başarısız"
  )
  assert.ok(STOCK_ZERO_FAILED.includes("eBay stoğu güncellenemedi"))
  assert.ok(PRICE_INCREASE_FAILED.includes("eBay fiyatı güncellenemedi"))
  assert.equal(
    formatStockAlertStatusLabel({
      sourceStatus: "PRICE_INCREASE",
      reviewStatus: "failed",
      reason: formatProfitProtectionFailedReason({
        amazonBefore: 20,
        amazonAfter: 25,
        targetEbay: 42.5,
        error: "timeout",
      }),
    }),
    "Kâr Koruma Başarısız"
  )
}
console.log("PASS 8 failed action message")

{
  assert.equal(isPrimaryFeedEventType("STOCK_ZEROED"), true)
  assert.equal(isPrimaryFeedEventType("PRICE_APPROVAL_REQUIRED"), true)
  assert.equal(isPrimaryFeedEventType("PRICE_PROTECTION_APPLIED"), true)
  assert.equal(isPrimaryFeedEventType("VERIFICATION_QUEUED"), true)
  assert.equal(isPrimaryFeedEventType("STOCK_ZERO_FAILED"), true)
  assert.equal(isPrimaryFeedEventType("ACTION_FAILED"), true)
  assert.equal(isPrimaryFeedEventType("SOURCE_VERIFICATION_COMPLETED"), false)
  assert.equal(isPrimaryFeedEventType("SOURCE_RESTORED"), true)
  assert.equal(isNoOpVerifiedPlanAction("verified_ok"), true)
  assert.equal(isNoOpVerifiedPlanAction("source_restored"), false)
  assert.equal(isNoOpVerifiedPlanAction("zero_stock"), false)
}
console.log("PASS 9 no-op events suppressed from primary feed")

{
  const pendingClause = buildAdminListStatusClause("pending")
  assert.match(pendingClause, /review_status = 'pending'/)
  assert.match(pendingClause, /24 hours/)
  assert.match(pendingClause, /actioned/)
  assert.doesNotMatch(pendingClause, /ignored/)
  const actionedClause = buildAdminListStatusClause("actioned")
  assert.match(actionedClause, /review_status = \$3/)
  assert.doesNotMatch(actionedClause, /24 hours/)
  assert.match(STOCK_ALERTS_OPERATIONAL_FEED_SQL, /24 hours/)
}
console.log("PASS 10-11 operational feed 24h actioned / actioned filter unchanged")

{
  const summarySql = read("modules/stockAlerts/stockAlertsService.ts")
  assert.match(summarySql, /review_status = 'pending' AND \$\{STOCK_GUARD_SCAN_ELIGIBLE_QTY\}/)
  assert.match(summarySql, /buildAdminListStatusClause/)
}
console.log("PASS 12 pending count remains pending-only")

{
  assert.equal(shouldPreserveUncertainReason(PRICE_UNCERTAIN_QUEUED, PRICE_UNCERTAIN_GENERIC), true)
  assert.equal(shouldPreserveUncertainReason(PRICE_UNCERTAIN_QUEUED, PRICE_UNCERTAIN_WAITING), false)
  assert.equal(shouldPreserveUncertainReason(PRICE_UNCERTAIN_GENERIC, PRICE_UNCERTAIN_QUEUED), false)
  const repo = read("modules/stockAlerts/stockAlertsRepository.ts")
  assert.match(repo, /Extension doğrulamasına gönderildi/)
}
console.log("PASS 13 pending unique preserve queued reason")

{
  assert.equal(parseAdminStockReviewStatus("processing"), "processing")
  assert.equal(parseAdminStockReviewStatus("pending"), "pending")
  assert.equal(parseAdminStockReviewStatus("nope"), "pending")
  const admin = read("modules/admin/adminRoutes.ts")
  assert.match(admin, /parseAdminStockReviewStatus/)
}
console.log("PASS 14 processing filter")

{
  const display = read("panel/src/lib/sourceStatusDisplay.ts")
  assert.match(display, /isUserSafeStockAlertReason/)
  assert.doesNotMatch(display, /Amazon aktif fiyatı doğrulanamadı/)
  const v2 = read("modules/stockGuard/verifiedStockActionService.ts")
  assert.match(v2, /applyConfirmedNoValidSource/)
  assert.match(v2, /applyAcceptedSourcePrice/)
  const pipeline = read("modules/stockGuard/acceptedSourcePricePipeline.ts")
  assert.match(pipeline, /markActiveReviewActioned/)
  assert.match(pipeline, /markActiveReviewFailed/)
  const zeroPipe = read("modules/stockGuard/confirmedNoValidSourcePipeline.ts")
  assert.match(zeroPipe, /markActiveReviewActioned/)
  assert.match(zeroPipe, /markActiveReviewFailed/)
  assert.doesNotMatch(v2, /formatSourceVerifiedMessage/)
  const activity = read("modules/activity/activityEventService.ts")
  assert.doesNotMatch(activity, /addNotification/)
  assert.match(activity, /isPrimaryFeedEventType/)
  assert.match(activity, /idempotency_key/)
  assert.doesNotMatch(
    activity,
    /catalog_state_id = \$2::bigint[\s\S]{0,180}event_type = \$3[\s\S]{0,120}INTERVAL '24 hours'/
  )
  const bridge = read("modules/amazonVerification/amazonVerificationKeepaBridge.ts")
  assert.match(bridge, /syncReviewAfterVerificationEnqueue/)
  const lifecycle = read("modules/stockAlerts/stockAlertReviewLifecycle.ts")
  assert.match(lifecycle, /canReplacePendingReviewWithUncertain/)
  assert.equal(canReplacePendingReviewWithUncertain("PRICE_INCREASE"), false)
  assert.equal(canReplacePendingReviewWithUncertain("UNAVAILABLE"), false)
  assert.equal(canReplacePendingReviewWithUncertain("PRICE_UNCERTAIN"), true)
  const appFilters = read("modules/app/appStockAlertFilters.ts")
  assert.match(appFilters, /24 hours/)
  assert.match(appFilters, /STOCK_ALERTS_APP_CREATED_LAST_24H_SQL/)
  assert.match(appFilters, /STOCK_ALERTS_OPERATIONAL_FEED_SQL/)
  assert.match(appFilters, /String\(raw \?\? "all"\)/)
  const appList = read("modules/app/appStockAlertsService.ts")
  assert.match(appList, /STOCK_ALERTS_APP_CREATED_LAST_24H_SQL/)
  assert.match(appList, /created_at >= NOW\(\) - INTERVAL '24 hours'|STOCK_ALERTS_APP_CREATED_LAST_24H_SQL/)
}
console.log("PASS wiring: display override, V2 row link, enqueue sync, no dual-write")

{
  const stable = classifyVerifiedAmazonSource({
    requestedAsin: "B0STABLE001",
    finalAsin: "B0STABLE001",
    displayedPrice: 10,
    condition: "NEW",
    isPrime: true,
    shipsFromAmazon: true,
    purchasable: "TRUE",
  })
  const plan = planVerifiedStockAction({
    decision: stable,
    settings: { enabled: true, mode: "manual", priceAlertEnabled: true, autoProfitProtectionEnabled: false },
    currentEbayQuantity: 2,
    trustedBaselinePrice: 10,
    lastVerifiedDecision: "VALID_SOURCE",
    verifiedActionsEnabled: true,
  })
  assert.equal(plan.action, "verified_ok")
  assert.equal(isNoOpVerifiedPlanAction(plan.action), true)
}
console.log("PASS stable verified source is no-op")

{
  assert.equal(isOperationalUserReason(PRICE_UNCERTAIN_QUEUED), true)
  assert.equal(isOperationalUserReason("No trusted current Amazon price found"), false)
  assert.equal(
    formatStockAlertStatusLabel({ sourceStatus: "PRICE_UNCERTAIN", reviewStatus: "pending" }),
    "Doğrulama Bekliyor"
  )
}

console.log("PASS stock-alerts v2 message fixtures")
