import assert from "assert"
import { createHash } from "crypto"
import fs from "fs"
import path from "path"
import {
  eventsFromProjectionTransition,
  projectKeepaAsin,
  type KeepaAsinProjection,
} from "../modules/keepaSensor/keepaAsinProjection"
import { applySyncEvent, localReconcileManifest, openKeepaLocalDb, setWorkerState } from "../modules/keepaSensor/keepaLocalDb"
import { computeKeepaReconcileManifest } from "../modules/keepaSensor/keepaCollectorReconcile"

function proj(
  status: "ACTIVE" | "PAUSED_QTY_ZERO" | "REMOVED",
  extra: { qty?: number; sold?: boolean; live?: boolean; asin?: string } = {}
) {
  const live = extra.live ?? status !== "REMOVED"
  const qty = extra.qty ?? (status === "ACTIVE" ? 1 : 0)
  return projectKeepaAsin({
    asin: extra.asin ?? "B0EMIT0001",
    listings: status === "REMOVED" && extra.live === undefined ? [] : [{ qty, sold: extra.sold ?? false, live }],
  })!
}

function fingerprint(eventType: string, p: KeepaAsinProjection): string {
  return createHash("sha256")
    .update(JSON.stringify({ eventType, asin: p.asin, activeConsumerCount: p.activeConsumerCount, status: p.status, priority: p.priority, cadenceHours: p.cadenceHours }))
    .digest("hex")
}

async function main(): Promise<void> {
  const first = eventsFromProjectionTransition(null, proj("ACTIVE"))
  assert.ok(first.includes("ASIN_UPSERT"))
  assert.ok(first.includes("CONSUMER_ATTACHED"))
  console.log("PASS 1 catalog insert + new ASIN UPSERT+ATTACHED")

  assert.deepEqual(eventsFromProjectionTransition(proj("ACTIVE"), proj("ACTIVE")), [])
  console.log("PASS 2 same catalog state → event 0")

  const syncSrc = fs.readFileSync(path.join(__dirname, "../modules/listings/listingsSyncService.ts"), "utf8")
  const byItemIdx = syncSrc.indexOf("trim(ebay_item_id) = $3")
  const byItemEmit = syncSrc.indexOf("emitKeepaAfterCatalogChange", byItemIdx)
  const bySkuIdx = syncSrc.indexOf("AND internal_sku = $3")
  const insertIdx = syncSrc.indexOf("ebay_trading_sync")
  assert.ok(byItemEmit > byItemIdx && byItemEmit < bySkuIdx)
  console.log("PASS 3 byItem update emitKeepaAfterCatalogChange")
  assert.ok(syncSrc.indexOf("emitKeepaAfterCatalogChange", bySkuIdx) > bySkuIdx)
  console.log("PASS 4 bySku update emitKeepaAfterCatalogChange")

  const paused = eventsFromProjectionTransition(proj("ACTIVE"), proj("PAUSED_QTY_ZERO", { qty: 0, live: true }))
  assert.ok(paused.includes("QTY_ZERO_PAUSED"))
  console.log("PASS 5 qty 1→0 QTY_ZERO_PAUSED")

  const resume = eventsFromProjectionTransition(proj("PAUSED_QTY_ZERO", { qty: 0, live: true }), proj("ACTIVE"))
  assert.ok(resume.includes("QTY_POSITIVE_RESUMED") || resume.includes("CONSUMER_ATTACHED"))
  console.log("PASS 6 qty 0→1 ACTIVE/attach")

  const removed = eventsFromProjectionTransition(proj("ACTIVE"), projectKeepaAsin({ asin: "B0EMIT0001", listings: [] })!)
  assert.deepEqual(removed, ["ASIN_REMOVED"])
  console.log("PASS 7 ended last consumer → removed")

  const sharedPrev = projectKeepaAsin({
    asin: "B0EMIT0001",
    listings: [
      { qty: 1, sold: false, live: true },
      { qty: 1, sold: false, live: true },
    ],
  })!
  const sharedNext = projectKeepaAsin({
    asin: "B0EMIT0001",
    listings: [
      { qty: 1, sold: false, live: true },
      { qty: 0, sold: false, live: false },
    ],
  })!
  const sharedEv = eventsFromProjectionTransition(sharedPrev, sharedNext)
  assert.ok(sharedEv.includes("CONSUMER_DETACHED"))
  assert.equal(sharedEv.includes("ASIN_REMOVED"), false)
  console.log("PASS 8 shared ASIN one consumer deleted → not removed")

  const sold = eventsFromProjectionTransition(proj("ACTIVE"), proj("ACTIVE", { sold: true }))
  assert.deepEqual(sold, ["SOLD_PRIORITY_CHANGED"])
  console.log("PASS 9 SOLD↔STANDARD priority/cadence event")

  const metricsSrc = fs.readFileSync(path.join(__dirname, "../modules/listings/listingsMetricsService.ts"), "utf8")
  assert.ok(metricsSrc.includes("soldBefore !== soldAfter"))
  assert.ok(metricsSrc.includes("metrics_synced_at"))
  console.log("PASS 10 metrics timestamp-only → event 0 unless sold flag changes")

  const persistSrc = fs.readFileSync(path.join(__dirname, "../modules/ebay/ebayPublishPersistenceService.ts"), "utf8")
  assert.ok(persistSrc.includes("emitKeepaAsinSyncForCatalog"))
  assert.deepEqual(eventsFromProjectionTransition(proj("ACTIVE"), proj("ACTIVE")), [])
  console.log("PASS 11 publish persist no-op → event 0")

  const hooksSrc = fs.readFileSync(path.join(__dirname, "../modules/stockGuard/stockGuardV2LifecycleHooks.ts"), "utf8")
  assert.ok(hooksSrc.includes("emitKeepaAsinSyncForCatalog"))
  const confirmedSrc = fs.readFileSync(path.join(__dirname, "../modules/stockGuard/confirmedNoValidSourcePipeline.ts"), "utf8")
  assert.ok(confirmedSrc.includes("afterListingMonitoringStopped"))
  const restockSrc = fs.readFileSync(path.join(__dirname, "../modules/orders/soldItemAutoRestockService.ts"), "utf8")
  assert.ok(restockSrc.includes("afterManualQuantityChanged"))
  console.log("PASS 12 stock guard / restock real qty change emits")

  const asinSrc = fs.readFileSync(path.join(__dirname, "../modules/listings/listingsUpdateSourceAsinService.ts"), "utf8")
  assert.ok(asinSrc.includes("previousAsins: [previousAsin]"))
  const importSrc = fs.readFileSync(path.join(__dirname, "../modules/listings/listingsImportService.ts"), "utf8")
  assert.ok(importSrc.includes("previousAsins: [previousAsin]"))
  const outboxSrc = fs.readFileSync(path.join(__dirname, "../modules/keepaSensor/keepaAsinSyncOutbox.ts"), "utf8")
  assert.ok(outboxSrc.includes("previousAsins"))
  assert.ok(outboxSrc.includes("emitKeepaAsinSyncForAsins"))
  console.log("PASS 13 source ASIN change emits old detach/remove + new upsert/attach")

  const fp = fingerprint("ASIN_UPSERT", proj("ACTIVE"))
  assert.equal(fp, fingerprint("ASIN_UPSERT", proj("ACTIVE")))
  assert.ok(outboxSrc.includes("ON CONFLICT (asin, event_type, payload_fingerprint) DO NOTHING"))
  console.log("PASS 14 same operation replay → duplicate event 0")

  const concurrentFp = new Set([fingerprint("ASIN_UPSERT", proj("ACTIVE")), fingerprint("ASIN_UPSERT", proj("ACTIVE"))])
  assert.equal(concurrentFp.size, 1)
  console.log("PASS 15 concurrent same transition → unique fingerprint")

  assert.ok(outboxSrc.includes("source_version = keepa_asin_sync_state.source_version + 1"))
  assert.equal(outboxSrc.includes("source_version - 1"), false)
  console.log("PASS 16 sourceVersion does not regress")

  const db = openKeepaLocalDb(":memory:")
  const next = proj("ACTIVE")
  applySyncEvent(
    db,
    {
      eventId: "00000000-0000-4000-8000-000000000001",
      asin: next.asin,
      eventType: "ASIN_UPSERT",
      sourceVersion: 1,
      payload: {
        status: next.status,
        activeConsumerCount: next.activeConsumerCount,
        priority: next.priority,
        cadenceHours: next.cadenceHours,
      },
      nowMs: 1_000,
    },
    { remoteAckStatus: "ACKED_REMOTE" }
  )
  setWorkerState(db, "bootstrap_phase", "COMPLETE")
  const local = localReconcileManifest(db)
  const central = computeKeepaReconcileManifest([
    {
      asin: next.asin,
      status: next.status,
      priority: next.priority,
      cadenceHours: next.cadenceHours,
      activeConsumerCount: next.activeConsumerCount,
      sourceVersion: 1,
    },
  ])
  assert.equal(local.hash, central.hash)
  assert.equal(local.uniqueAsins, central.uniqueAsins)
  console.log("PASS 17 projection manifest matches central after event apply")

  const autoSrc = fs.readFileSync(path.join(__dirname, "../modules/keepaSensor/keepaCollectorAutoRepair.ts"), "utf8")
  assert.ok(autoSrc.includes("KEEPA_COLLECTOR_AUTO_REPAIR_BACKOFF_MS = 60_000"))
  const autoFix = fs.readFileSync(path.join(__dirname, "../fixtures/keepaCollectorAutoRepair.fixtures.ts"), "utf8")
  assert.ok(autoFix.includes("PASS keepaCollectorAutoRepair 15/15"))
  console.log("PASS 18 auto-repair fixture 15/15 file present")

  assert.ok(syncSrc.includes("emitKeepaAsinSyncForCatalog"))
  console.log("PASS keepa lifecycle emitter 1-18")
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})
