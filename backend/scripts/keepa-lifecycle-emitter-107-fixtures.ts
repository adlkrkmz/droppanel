import assert from "assert"
import fs from "fs"
import path from "path"
import { eventsFromProjectionTransition, projectKeepaAsin } from "../modules/keepaSensor/keepaAsinProjection"

function proj(status: "ACTIVE" | "PAUSED_QTY_ZERO" | "REMOVED", extra: { qty?: number; sold?: boolean; live?: boolean } = {}) {
  const live = extra.live ?? status !== "REMOVED"
  const qty = extra.qty ?? (status === "ACTIVE" ? 1 : 0)
  return projectKeepaAsin({
    asin: "B0EMIT0001",
    listings: status === "REMOVED" && extra.live === undefined ? [] : [{ qty, sold: extra.sold ?? false, live }],
  })!
}

async function main(): Promise<void> {
  const first = eventsFromProjectionTransition(null, proj("ACTIVE"))
  assert.ok(first.includes("ASIN_UPSERT"))
  assert.ok(first.includes("CONSUMER_ATTACHED"))
  assert.equal(first.includes("ASIN_REMOVED"), false)

  const paused = eventsFromProjectionTransition(proj("ACTIVE"), proj("PAUSED_QTY_ZERO", { qty: 0, live: true }))
  assert.deepEqual(paused, ["CONSUMER_DETACHED", "QTY_ZERO_PAUSED"])

  const resume = eventsFromProjectionTransition(
    proj("PAUSED_QTY_ZERO", { qty: 0, live: true }),
    proj("ACTIVE")
  )
  assert.ok(resume.includes("QTY_POSITIVE_RESUMED"))
  assert.ok(resume.includes("CONSUMER_ATTACHED"))

  const sold = eventsFromProjectionTransition(proj("ACTIVE"), proj("ACTIVE", { sold: true }))
  assert.deepEqual(sold, ["SOLD_PRIORITY_CHANGED"])

  const removed = eventsFromProjectionTransition(proj("ACTIVE"), projectKeepaAsin({ asin: "B0EMIT0001", listings: [] })!)
  assert.deepEqual(removed, ["ASIN_REMOVED"])

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
  assert.equal(sharedNext.status, "ACTIVE")
  assert.equal(sharedNext.activeConsumerCount, 1)
  const sharedEv = eventsFromProjectionTransition(sharedPrev, sharedNext)
  assert.ok(sharedEv.includes("CONSUMER_DETACHED"))
  assert.equal(sharedEv.includes("ASIN_REMOVED"), false)

  const noop = eventsFromProjectionTransition(proj("ACTIVE"), proj("ACTIVE"))
  assert.deepEqual(noop, [])

  const syncSrc = fs.readFileSync(path.join(__dirname, "../modules/listings/listingsSyncService.ts"), "utf8")
  const byItemIdx = syncSrc.indexOf("trim(ebay_item_id) = $3")
  const byItemEmit = syncSrc.indexOf("emitKeepaAfterCatalogChange", byItemIdx)
  const bySkuIdx = syncSrc.indexOf("AND internal_sku = $3")
  const insertIdx = syncSrc.indexOf("ebay_trading_sync")
  assert.ok(byItemEmit > byItemIdx && byItemEmit < bySkuIdx)
  assert.ok(syncSrc.indexOf("emitKeepaAfterCatalogChange", insertIdx) > insertIdx)
  assert.ok(syncSrc.includes("reconcileEndedNotOnEbay"))
  assert.ok(syncSrc.includes("emitKeepaAsinSyncForCatalog"))
  const trySyncOnlyByItem = syncSrc.slice(byItemIdx, bySkuIdx)
  assert.equal(trySyncOnlyByItem.includes("trySyncGlobalAsinConsumerFromCatalog"), false)

  const hooksSrc = fs.readFileSync(path.join(__dirname, "../modules/stockGuard/stockGuardV2LifecycleHooks.ts"), "utf8")
  assert.ok(hooksSrc.includes("keepa projection emit after stop"))
  assert.ok(hooksSrc.includes("emitKeepaAsinSyncForCatalog"))

  const persistSrc = fs.readFileSync(path.join(__dirname, "../modules/ebay/ebayPublishPersistenceService.ts"), "utf8")
  assert.ok(persistSrc.includes("emitKeepaAsinSyncForCatalog"))

  console.log("PASS keepa lifecycle emitter insert/update/end/qty0/resume/sold/shared/no-op")
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})
