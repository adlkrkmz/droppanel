import assert from "assert"
import fs from "fs"
import path from "path"
import { classifyVerifiedAmazonSource } from "../modules/amazonVerification/verifiedSourceDecision"
import { planVerifiedStockAction } from "../modules/stockGuard/verifiedStockActionPlan"
import {
  classifySourceApplyGuard,
  isV2KeepaMonitorEligible,
  verifiedBaselineIsSourceScoped,
  activityLogicalKey,
} from "../modules/globalKeepa/sourceAsinLifecycle"
import { resolveTrustedBaselinePrice } from "../modules/globalKeepa/keepaRadarCandidate"
import { GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE } from "../modules/globalKeepa/globalKeepaEligibility"
import { loadGlobalKeepaFoundationConfig } from "../modules/globalKeepa/globalKeepaConfig"
import { isPrimaryFeedEventType } from "../modules/activity/activityFeedPolicy"

const root = path.join(__dirname, "..")
function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8")
}

const settingsAuto = {
  enabled: true,
  mode: "auto" as const,
  priceAlertEnabled: true,
  autoProfitProtectionEnabled: true,
}

{
  const mig = read("migrations/058_stock_guard_v2_lifecycle.sql")
  assert.match(mig, /idempotency_key/)
  assert.match(mig, /uq_workspace_activity_idempotency/)
  assert.doesNotMatch(mig, /DROP TABLE/)
  assert.doesNotMatch(mig, /GLOBAL_KEEPA_MONITOR_ENABLED/)
}
console.log("PASS 058 additive idempotency migration")

{
  const update = read("modules/listings/listingsUpdateSourceAsinService.ts")
  assert.match(update, /withTransaction/)
  assert.match(update, /last_verified_asin = NULL/)
  assert.match(update, /source_next_check_at = CASE WHEN/)
  assert.match(update, /immediatelyDue: qtyPositive/)
  assert.match(update, /afterSourceAsinRelinked/)
  assert.match(update, /Resolved by source ASIN update/)
  assert.doesNotMatch(update, /emitActivityEvent/)
}
console.log("PASS source ASIN update: atomic relink, clear verified baseline, no bell")

{
  const upsert = read("modules/globalKeepa/globalAsinBackfillCore.ts")
  assert.match(upsert, /ON CONFLICT \(catalog_state_id\) DO UPDATE SET/)
  assert.match(upsert, /global_asin_id = EXCLUDED.global_asin_id/)
  const consumer = read("modules/globalKeepa/globalAsinConsumerSync.ts")
  assert.match(consumer, /UPSERT_GLOBAL_ASIN_CONSUMER_SQL/)
  const planner = read("modules/globalKeepa/globalKeepaPlannerState.ts")
  assert.match(planner, /markGlobalAsinImmediatelyDue/)
  assert.match(planner, /next_check_at = NOW\(\)/)
}
console.log("PASS A→B consumer unique upsert + B immediately due")

{
  assert.equal(
    isV2KeepaMonitorEligible({
      currentStatus: "live",
      stockGuardEnabled: true,
      ebayItemId: "123",
      ebayQuantity: 2,
      sourceAsin: "B0AAAAAAA1",
    }),
    true
  )
  assert.equal(
    isV2KeepaMonitorEligible({
      currentStatus: "live",
      stockGuardEnabled: true,
      ebayItemId: "123",
      ebayQuantity: 3,
      sourceAsin: "B0AAAAAAA1",
    }),
    true,
    "hidden is not a monitoring control"
  )
  assert.equal(
    isV2KeepaMonitorEligible({
      currentStatus: "ended",
      stockGuardEnabled: true,
      ebayItemId: "123",
      ebayQuantity: 4,
      sourceAsin: "B0AAAAAAA1",
    }),
    false
  )
  assert.equal(
    isV2KeepaMonitorEligible({
      currentStatus: "live",
      stockGuardEnabled: false,
      ebayItemId: "123",
      ebayQuantity: 4,
      sourceAsin: "B0AAAAAAA1",
    }),
    false
  )
  assert.equal(
    isV2KeepaMonitorEligible({
      currentStatus: "live",
      stockGuardEnabled: true,
      ebayItemId: "123",
      ebayQuantity: 0,
      sourceAsin: "B0AAAAAAA1",
    }),
    false
  )
  assert.equal(
    isV2KeepaMonitorEligible({
      currentStatus: "live",
      stockGuardEnabled: true,
      ebayItemId: "123",
      ebayQuantity: 0,
      botZeroedAt: "2026-08-21T10:00:00Z",
      sourceAsin: "B0AAAAAAA1",
    }),
    false
  )
  assert.equal(
    isV2KeepaMonitorEligible({
      currentStatus: "live",
      stockGuardEnabled: true,
      ebayItemId: "123",
      ebayQuantity: 2,
      sourceAsin: "",
    }),
    false
  )
  assert.doesNotMatch(GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE, /panel_hidden_at/)
  assert.match(GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE, /ebay_quantity, 0\) > 0/)
  assert.doesNotMatch(GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE, /bot_zeroed_at/)
}
console.log("PASS hide continues when qty>0; qty0 never monitored")

{
  const stale = classifySourceApplyGuard({
    taskAsin: "B0AAAAAAA1",
    currentSourceAsin: "B0BBBBBBB2",
    consumerAsin: "B0BBBBBBB2",
    listingLive: true,
    stockGuardEnabled: true,
    monitorEligible: true,
    ebayQuantity: 4,
  })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.code, "STALE_SOURCE_RESULT")

  const ended = classifySourceApplyGuard({
    taskAsin: "B0AAAAAAA1",
    currentSourceAsin: "B0AAAAAAA1",
    consumerAsin: "B0AAAAAAA1",
    listingLive: false,
    stockGuardEnabled: true,
    monitorEligible: false,
  })
  assert.equal(ended.ok, false)
  if (!ended.ok) assert.equal(ended.code, "OBSOLETE_SOURCE_RESULT")

  const guardOff = classifySourceApplyGuard({
    taskAsin: "B0AAAAAAA1",
    currentSourceAsin: "B0AAAAAAA1",
    listingLive: true,
    stockGuardEnabled: false,
    monitorEligible: false,
  })
  assert.equal(guardOff.ok, false)

  const ok = classifySourceApplyGuard({
    taskAsin: "B0AAAAAAA1",
    currentSourceAsin: "B0AAAAAAA1",
    consumerAsin: "B0AAAAAAA1",
    listingLive: true,
    stockGuardEnabled: true,
    monitorEligible: true,
    ebayQuantity: 4,
  })
  assert.equal(ok.ok, true)

  const afterZero = classifySourceApplyGuard({
    taskAsin: "B0AAAAAAA1",
    currentSourceAsin: "B0AAAAAAA1",
    consumerAsin: "B0AAAAAAA1",
    listingLive: true,
    stockGuardEnabled: true,
    monitorEligible: true,
    ebayQuantity: 0,
  })
  assert.equal(afterZero.ok, false)
  if (!afterZero.ok) assert.equal(afterZero.code, "OBSOLETE_SOURCE_RESULT")
}
console.log("PASS stale A result after A→B / end / guard-off / qty0 discarded")

{
  const apply = read("modules/stockGuard/verifiedStockActionService.ts")
  const applyFn = apply.split("export async function applyVerifiedSourceResult")[1] ?? ""
  assert.match(applyFn, /classifySourceApplyGuard/)
  assert.match(applyFn, /applyGuard.code/)
  assert.match(read("modules/globalKeepa/sourceAsinLifecycle.ts"), /STALE_SOURCE_RESULT/)
  assert.match(read("modules/globalKeepa/sourceAsinLifecycle.ts"), /OBSOLETE_SOURCE_RESULT/)
  const persistIdx = applyFn.indexOf("await persistVerifiedCatalogState")
  const guardIdx = applyFn.indexOf("classifySourceApplyGuard")
  const acceptedIdx = applyFn.indexOf("applyAcceptedSourcePrice")
  assert.ok(guardIdx >= 0 && persistIdx > guardIdx, "persist must run after stale guard")
  assert.ok(acceptedIdx > guardIdx, "accepted price pipeline must run after stale guard")
  const queue = read("modules/amazonVerification/amazonVerificationQueue.ts")
  assert.match(queue, /obsoleteQueuedVerificationTasks/)
  assert.match(queue, /PENDING.*WAITING_FOR_WORKER.*RETRYABLE/)
  assert.match(queue, /CLAIMED|RUNNING/)
}
console.log("PASS apply-time revalidation before persist/mutation; queued tasks cancelled")

{
  assert.equal(verifiedBaselineIsSourceScoped({ lastVerifiedAsin: "B0AAAAAAA1", currentSourceAsin: "B0BBBBBBB2" }), false)
  assert.equal(
    resolveTrustedBaselinePrice({
      lastVerifiedPrice: 10,
      sourcePrice: 25,
      lastVerifiedAsin: "B0AAAAAAA1",
      currentSourceAsin: "B0BBBBBBB2",
    }),
    25
  )
  const firstB = classifyVerifiedAmazonSource({
    requestedAsin: "B0BBBBBBB2",
    finalAsin: "B0BBBBBBB2",
    displayedPrice: 25,
    condition: "NEW",
    isPrime: true,
    shipsFromAmazon: true,
    purchasable: "TRUE",
  })
  const newBaseline = planVerifiedStockAction({
    decision: firstB,
    settings: settingsAuto,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 10,
    lastVerifiedDecision: "VALID_SOURCE",
    lastVerifiedAsin: "B0AAAAAAA1",
    currentSourceAsin: "B0BBBBBBB2",
    verifiedActionsEnabled: true,
  })
  assert.equal(newBaseline.action, "verified_ok")

  const later = planVerifiedStockAction({
    decision: { ...firstB, acceptedPrice: 28 },
    settings: settingsAuto,
    currentEbayQuantity: 2,
    trustedBaselinePrice: 25,
    lastVerifiedDecision: "VALID_SOURCE",
    lastVerifiedAsin: "B0BBBBBBB2",
    currentSourceAsin: "B0BBBBBBB2",
    verifiedActionsEnabled: true,
  })
  assert.equal(later.action, "profit_protection")
}
console.log("PASS A $10 → B $25 is new baseline, not profit protection; later B $25→$28 is")

{
  const restoredDecision = classifyVerifiedAmazonSource({
    requestedAsin: "B0AAAAAAA1",
    finalAsin: "B0AAAAAAA1",
    displayedPrice: 19.99,
    condition: "NEW",
    isPrime: true,
    shipsFromAmazon: true,
    purchasable: "TRUE",
  })
  const restore = planVerifiedStockAction({
    decision: restoredDecision,
    settings: settingsAuto,
    currentEbayQuantity: 0,
    trustedBaselinePrice: 19.99,
    lastVerifiedDecision: "CONFIRMED_NO_VALID_SOURCE",
    lastVerifiedAsin: "B0AAAAAAA1",
    currentSourceAsin: "B0AAAAAAA1",
    verifiedActionsEnabled: true,
  })
  assert.equal(restore.action, "verified_ok")
  assert.equal(isPrimaryFeedEventType("SOURCE_RESTORED"), true)
  const apply = read("modules/stockGuard/verifiedStockActionService.ts")
  assert.doesNotMatch(apply, /eventType: "SOURCE_RESTORED"/)
  const zeroPipe = read("modules/stockGuard/confirmedNoValidSourcePipeline.ts")
  assert.match(zeroPipe, /afterListingMonitoringStopped/)
}
console.log("PASS qty0 is not SOURCE_RESTORED-scanned; historical enum kept")

{
  const activity = read("modules/activity/activityEventService.ts")
  assert.match(activity, /idempotency_key/)
  assert.doesNotMatch(
    activity,
    /catalog_state_id = \$2::bigint[\s\S]{0,180}event_type = \$3[\s\S]{0,120}INTERVAL '24 hours'/
  )
  assert.equal(activityLogicalKey("stock_zeroed", 99), "v2:stock_zeroed:99")
  assert.notEqual(
    activityLogicalKey("price_protection", 11),
    activityLogicalKey("price_protection", 12)
  )
  assert.match(activity, /INTERVAL '24 hours'/)
  assert.doesNotMatch(activity, /INTERVAL '24 seconds'/)
  const alerts = read("modules/stockAlerts/stockAlertListQuery.ts")
  assert.match(alerts, /INTERVAL '24 hours'/)
  assert.doesNotMatch(alerts, /INTERVAL '24 seconds'/)
}
console.log("PASS activity idempotency by logical action; feed window is 24 hours")

{
  const cfg = loadGlobalKeepaFoundationConfig()
  assert.equal(cfg.monitorEnabled, false)
  assert.equal(cfg.plannerEnabled, false)
  const envExample = read(".env.example")
  assert.match(envExample, /GLOBAL_KEEPA_MONITOR_ENABLED=false/)
  const tick = read("modules/globalKeepa/globalKeepaPlannerTick.ts")
  assert.doesNotMatch(tick, /zeroListingQuantityOnEbay/)
  const hooks = read("modules/stockGuard/stockGuardV2LifecycleHooks.ts")
  assert.match(hooks, /bot_zeroed_at = NULL/)
  assert.match(hooks, /source_next_check_at = NOW\(\)/)
  assert.match(hooks, /quantity <= 0/)
}
console.log("PASS qty restore clears bot_zeroed and is immediately due; flags unchanged")

console.log("PASS stock-guard v2 source lifecycle fixtures")
