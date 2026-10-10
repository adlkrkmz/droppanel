import assert from "assert"
import fs from "fs"
import path from "path"
import { classifyKeepaRadarProduct } from "../modules/globalKeepa/keepaRadarClassifier"
import {
  GLOBAL_ASIN_BACKFILL_SELECT_SQL,
  UPSERT_GLOBAL_AMAZON_ASIN_SQL,
  UPSERT_GLOBAL_ASIN_CONSUMER_SQL,
  accumulateDryRunMetrics,
  assertDryRunInvariants,
  emptyDryRunMetrics,
  finalizeDryRunMetrics,
  mapBackfillQueryRow,
  reduceBackfillBatch,
  resolveConsumerLink,
} from "../modules/globalKeepa/globalAsinBackfillCore"
import { inspectListingAsin } from "../modules/monitor/listingAsinResolve"
import { nextKeepaSnapshotState } from "../modules/globalKeepa/globalKeepaSnapshot"
import { loadGlobalKeepaFoundationConfig } from "../modules/globalKeepa/globalKeepaConfig"
import {
  globalAsinPriorityRank,
  listingPriorityRank,
} from "../modules/globalKeepa/globalKeepaPriority"
import {
  extractKeepaRadarProductFields,
  extractKeepaTokenFields,
  keepaCountToInt,
  keepaMinuteToUnixMs,
  mapKeepaProductsByAsin,
} from "../modules/globalKeepa/keepaRadarParser"
import { keepaCentsToUsd } from "../modules/keepa/keepaPriceSelector"
import { KEEPA_CSV_INDEX } from "../modules/keepa/keepaPriceTypes"
import type { KeepaApiProduct } from "../modules/keepa/keepaTypes"

const root = path.join(__dirname, "..")
function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8")
}

const migration = read("migrations/054_global_keepa_foundation.sql")
assert.match(migration, /CREATE TABLE IF NOT EXISTS global_amazon_asins/)
assert.match(migration, /UNIQUE \(keepa_domain, asin\)/)
assert.doesNotMatch(migration, /UNIQUE \(asin\)/)
assert.match(migration, /CONSTRAINT uq_global_amazon_asins_domain_asin UNIQUE \(keepa_domain, asin\)/)
console.log("PASS invariant C: identity is (keepa_domain, asin) not asin-only")
assert.match(migration, /CREATE TABLE IF NOT EXISTS global_asin_consumers/)
assert.match(migration, /UNIQUE \(catalog_state_id\)/)
assert.match(migration, /workspace_id\s+UUID NOT NULL/)
assert.match(migration, /CREATE TABLE IF NOT EXISTS global_keepa_snapshots/)
assert.match(migration, /PRODUCT_NOT_RETURNED/)
assert.doesNotMatch(migration, /OUT_OF_STOCK/)
assert.match(migration, /CREATE TABLE IF NOT EXISTS keepa_platform_token_state/)
assert.match(migration, /idx_global_amazon_asins_next_check/)
assert.match(migration, /idx_global_keepa_snapshots_checked_at/)
assert.doesNotMatch(migration, /DROP TABLE/)
assert.doesNotMatch(migration, /INSERT INTO store_catalog_state/)
assert.doesNotMatch(migration, /UPDATE store_catalog_state/)
console.log("PASS global Keepa migration/schema")

assert.equal(KEEPA_CSV_INDEX.NEW, 1)
assert.equal(KEEPA_CSV_INDEX.COUNT_NEW_FBA, 34)
assert.equal(KEEPA_CSV_INDEX.COUNT_NEW_FBM, 35)
assert.equal(keepaCountToInt(-1), null)
assert.equal(keepaCountToInt(0), 0)
assert.equal(keepaCentsToUsd(-1), null)
assert.equal(keepaCentsToUsd(1299), 12.99)
assert.ok(keepaMinuteToUnixMs(0) == null)
assert.ok((keepaMinuteToUnixMs(1) ?? 0) > 0)
const tokens = extractKeepaTokenFields({
  tokensLeft: 200,
  refillRate: 60,
  refillIn: 12000,
  tokensConsumed: 3,
  processingTimeInMs: 40,
})
assert.equal(tokens.tokensLeft, 200)
assert.equal(tokens.refillRate, 60)
assert.equal(tokens.refillIn, 12000)
assert.equal(tokens.tokensConsumed, 3)
console.log("PASS Keepa token + CSV helpers")

function product(partial: Partial<KeepaApiProduct> & { current?: number[] }): KeepaApiProduct {
  const current = partial.current ?? []
  return {
    asin: partial.asin ?? "B0TEST0001",
    lastUpdate: partial.lastUpdate,
    lastPriceChange: partial.lastPriceChange,
    stats: { current },
  }
}

function csv(overrides: Record<number, number>): number[] {
  const arr = Array(36).fill(-1)
  for (const [k, v] of Object.entries(overrides)) arr[Number(k)] = v
  return arr
}

{
  const p = product({
    current: csv({ 1: 1999, 34: 4, 35: 0 }),
    lastUpdate: 1000,
    lastPriceChange: 900,
  })
  const fields = extractKeepaRadarProductFields(p)!
  assert.equal(fields.newPriceUsd, 19.99)
  assert.equal(fields.newFbaCount, 4)
  assert.equal(fields.newFbmCount, 0)
  const c = classifyKeepaRadarProduct({ requestedAsin: "B0TEST0001", product: p })
  assert.equal(c.status, "FBA_PRESENT")
  assert.equal(c.priceConfidence, "CONFIRMED_FBA")
}
{
  const p = product({ current: csv({ 1: 1999, 34: 0, 35: 3 }) })
  const c = classifyKeepaRadarProduct({ requestedAsin: "B0TEST0001", product: p })
  assert.equal(c.status, "FBA_MISSING")
  assert.equal(c.priceConfidence, "NONE")
}
{
  const p = product({ current: csv({ 1: 1999, 34: 2, 35: 5 }) })
  const c = classifyKeepaRadarProduct({ requestedAsin: "B0TEST0001", product: p })
  assert.equal(c.status, "PRICE_AMBIGUOUS")
  assert.equal(c.priceConfidence, "AMBIGUOUS")
}
{
  const p = product({ current: csv({ 1: 1999, 34: 0, 35: 0 }) })
  const c = classifyKeepaRadarProduct({ requestedAsin: "B0TEST0001", product: p })
  assert.equal(c.status, "FBA_MISSING")
}
{
  const p = product({ current: csv({ 1: -1, 34: 2, 35: 0 }) })
  const c = classifyKeepaRadarProduct({ requestedAsin: "B0TEST0001", product: p })
  assert.equal(c.status, "FBA_PRESENT")
}
{
  const p = product({ current: csv({ 1: 2000, 34: 1, 35: 0 }) })
  const up = classifyKeepaRadarProduct({
    requestedAsin: "B0TEST0001",
    product: p,
    previous: { newPriceUsd: 10 },
  })
  assert.equal(up.status, "PRICE_CHANGED")
  const same = classifyKeepaRadarProduct({
    requestedAsin: "B0TEST0001",
    product: p,
    previous: { newPriceUsd: 20 },
  })
  assert.equal(same.status, "PRICE_UNCHANGED")
}
{
  const missing = classifyKeepaRadarProduct({ requestedAsin: "B0TEST0001", product: null })
  assert.equal(missing.status, "PRODUCT_NOT_RETURNED")
  assert.notEqual(missing.status, "CHECK_FAILED")
}
{
  const failed = classifyKeepaRadarProduct({
    requestedAsin: "B0TEST0001",
    product: null,
    checkFailed: true,
  })
  assert.equal(failed.status, "CHECK_FAILED")
  assert.equal(failed.fields, null)
}
{
  const map = mapKeepaProductsByAsin([
    product({ asin: "B0TEST0001", current: csv({ 1: 100 }) }),
    product({ asin: "B0TEST0002", current: csv({ 1: 200 }) }),
  ])
  assert.equal(map.size, 2)
  assert.equal(
    classifyKeepaRadarProduct({ requestedAsin: "B0TEST0003", product: map.get("B0TEST0003") }).status,
    "PRODUCT_NOT_RETURNED"
  )
}
console.log("PASS Keepa radar parse/classify fixtures")

assert.equal(listingPriorityRank({ totalSold: 1, sold30d: 0, clicks30d: 9 }), 0)
assert.equal(listingPriorityRank({ totalSold: 0, sold30d: 2, clicks30d: 0 }), 0)
assert.equal(listingPriorityRank({ totalSold: 0, sold30d: 0, clicks30d: 3 }), 1)
assert.equal(listingPriorityRank({ totalSold: 0, sold30d: 0, clicks30d: 0 }), 2)
assert.equal(globalAsinPriorityRank([2, 1, 2]), 1)
assert.equal(globalAsinPriorityRank([1, 0, 2]), 0)
assert.equal(globalAsinPriorityRank([2]), 2)
console.log("PASS global ASIN priority")

function row(partial: {
  catalogStateId: number
  workspaceId: string
  storeId: number
  registryAsin: string | null
  sourceUrl: string | null
  internalSku: string
  totalSold?: number | null
  sold30d?: number | null
  clicks30d?: number | null
}) {
  return {
    catalogStateId: partial.catalogStateId,
    workspaceId: partial.workspaceId,
    storeId: partial.storeId,
    registryAsin: partial.registryAsin,
    sourceUrl: partial.sourceUrl,
    internalSku: partial.internalSku,
    totalSold: partial.totalSold ?? 0,
    sold30d: partial.sold30d ?? 0,
    clicks30d: partial.clicks30d ?? 0,
    ebayItemId: null,
    asinRegistryId: null,
    currentStatus: "live",
    panelHiddenAt: null,
  }
}

{
  const a = resolveConsumerLink(row({
    catalogStateId: 1,
    workspaceId: "ws-a",
    storeId: 10,
    registryAsin: "B0SAME0001",
    sourceUrl: null,
    internalSku: "SKU1",
  }))
  const b = resolveConsumerLink(row({
    catalogStateId: 2,
    workspaceId: "ws-a",
    storeId: 11,
    registryAsin: "B0SAME0001",
    sourceUrl: null,
    internalSku: "SKU2",
    totalSold: 5,
  }))
  const c = resolveConsumerLink(row({
    catalogStateId: 3,
    workspaceId: "ws-b",
    storeId: 20,
    registryAsin: null,
    sourceUrl: "https://www.amazon.com/dp/B0SAME0001",
    internalSku: "OTHER",
    clicks30d: 4,
  }))
  assert.equal(a?.asin, "B0SAME0001")
  assert.equal(b?.asin, "B0SAME0001")
  assert.equal(c?.asin, "B0SAME0001")
  assert.equal(globalAsinPriorityRank([a!.listingPriority, b!.listingPriority, c!.listingPriority]), 0)
  const d = resolveConsumerLink(row({
    catalogStateId: 4,
    workspaceId: "ws-c",
    storeId: 30,
    registryAsin: "B0SAME0001",
    sourceUrl: null,
    internalSku: "X",
  }))
  assert.equal(d?.asin, "B0SAME0001")
  const noGuess = resolveConsumerLink(row({
    catalogStateId: 5,
    workspaceId: "ws-c",
    storeId: 30,
    registryAsin: null,
    sourceUrl: "https://example.com/not-amazon",
    internalSku: "NOTANASIN",
  }))
  assert.equal(noGuess, null)
}
{
  const { links, skipped } = reduceBackfillBatch([
    mapBackfillQueryRow({
      catalog_state_id: 9,
      workspace_id: "ws-z",
      store_id: 1,
      registry_asin: null,
      source_url: null,
      internal_sku: "NOPE",
      total_sold: 0,
      sold_30d: 0,
      clicks_30d: 0,
    }),
  ])
  assert.equal(links.length, 0)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0]?.reason, "NO_SKU_ASIN")
}
console.log("PASS global ASIN dedupe + resolver (no guessed ASIN)")

{
  const sameWsStores = [
    resolveConsumerLink(row({ catalogStateId: 10, workspaceId: "ws-a", storeId: 1, registryAsin: "B0MULTI001", sourceUrl: null, internalSku: "A" })),
    resolveConsumerLink(row({ catalogStateId: 11, workspaceId: "ws-a", storeId: 2, registryAsin: "B0MULTI001", sourceUrl: null, internalSku: "B" })),
  ]
  assert.equal(sameWsStores[0]?.asin, sameWsStores[1]?.asin)
  assert.notEqual(sameWsStores[0]?.storeId, sameWsStores[1]?.storeId)
  const unique = new Set(sameWsStores.map(l => `1:${l!.asin}`))
  assert.equal(unique.size, 1)
  const metrics = emptyDryRunMetrics()
  const keys = new Set<string>()
  const counts = new Map<string, number>()
  accumulateDryRunMetrics(metrics, { links: sameWsStores as NonNullable<typeof sameWsStores[0]>[], skipped: [], processed: 2 }, keys, counts, 1)
  finalizeDryRunMetrics(metrics, keys, counts)
  assert.equal(metrics.uniqueGlobalAsins, 1)
  assert.equal(metrics.globalConsumersToCreate, 2)
  assert.equal(metrics.dedupSavingCount, 1)
  const inv = assertDryRunInvariants({ links: sameWsStores as NonNullable<typeof sameWsStores[0]>[], uniqueAsinCount: 1, keepaDomain: 1 })
  assert.equal(inv.ok, true)
}
assert.equal(inspectListingAsin({ registryAsin: "B0OLD00001", sourceUrl: null, internalSku: "x" }).asin, "B0OLD00001")
assert.equal(inspectListingAsin({ registryAsin: "B0NEW00001", sourceUrl: "https://www.amazon.com/dp/B0NEW00001", internalSku: "x" }).asin, "B0NEW00001")
assert.match(UPSERT_GLOBAL_ASIN_CONSUMER_SQL, /global_asin_id = EXCLUDED\.global_asin_id/)
assert.match(UPSERT_GLOBAL_ASIN_CONSUMER_SQL, /ON CONFLICT \(catalog_state_id\) DO UPDATE SET/)
assert.match(UPSERT_GLOBAL_AMAZON_ASIN_SQL, /RETURNING id, \(xmax = 0\) AS inserted/)
assert.match(UPSERT_GLOBAL_ASIN_CONSUMER_SQL, /RETURNING id, \(xmax = 0\) AS inserted/)
const listingsSrc = read("modules/listings/listingsUpdateSourceAsinService.ts")
assert.match(listingsSrc, /SET asin_registry_id = \$1::bigint/)
assert.match(listingsSrc, /source_url = \$2::text/)
assert.match(listingsSrc, /WHERE workspace_id = \$4::uuid/)
assert.match(listingsSrc, /AND id = \$6::bigint/)
assert.match(listingsSrc, /syncGlobalAsinConsumerForCatalog/)
assert.match(listingsSrc, /withTransaction/)
assert.match(listingsSrc, /source_next_check_at = CASE WHEN/)
assert.doesNotMatch(listingsSrc, /INSERT INTO store_catalog_state/)
const consumerSync = read("modules/globalKeepa/globalAsinConsumerSync.ts")
assert.match(consumerSync, /UPSERT_GLOBAL_ASIN_CONSUMER_SQL/)
assert.match(consumerSync, /trySyncGlobalAsinConsumerFromCatalog/)
assert.doesNotMatch(consumerSync, /UPDATE store_catalog_state/)
assert.doesNotMatch(consumerSync, /INSERT INTO store_catalog_state/)
console.log("PASS consumer uniqueness + source-ASIN change lifecycle SQL")

{
  const t0 = new Date("2026-08-01T00:00:00Z")
  const t1 = new Date("2026-08-02T00:00:00Z")
  const snap1 = nextKeepaSnapshotState(null, {
    newPrice: 24.99,
    newFbaCount: 2,
    newFbmCount: 0,
    keepaLastUpdate: t0,
    keepaLastPriceChange: t0,
    keepaLastUpdateMinutes: 1,
    keepaLastPriceChangeMinutes: 1,
    checkedAt: t0,
    status: "KEEPA_OK",
    priceConfidence: "CONFIRMED_FBA",
  })
  assert.equal(snap1.previousNewPrice, null)
  const snap2 = nextKeepaSnapshotState(snap1, {
    newPrice: 29.99,
    newFbaCount: 1,
    newFbmCount: 3,
    keepaLastUpdate: t1,
    keepaLastPriceChange: t1,
    keepaLastUpdateMinutes: 2,
    keepaLastPriceChangeMinutes: 2,
    checkedAt: t1,
    status: "PRICE_AMBIGUOUS",
    priceConfidence: "AMBIGUOUS",
  })
  assert.equal(snap2.newPrice, 29.99)
  assert.equal(snap2.newFbaCount, 1)
  assert.equal(snap2.newFbmCount, 3)
  assert.equal(snap2.previousNewPrice, 24.99)
  assert.equal(snap2.previousNewFbaCount, 2)
  assert.equal(snap2.previousNewFbmCount, 0)
}
console.log("PASS snapshot previous/current fixture")

const tokenSql = read("modules/globalKeepa/keepaPlatformTokenState.ts")
assert.match(tokenSql, /rolling_tokens_consumed_1h/)
assert.match(tokenSql, /keepa_platform_token_state/)
assert.doesNotMatch(tokenSql, /keepa_token_state WHERE/)
console.log("PASS platform token-state fixture")
console.log("PASS global ASIN dedupe + resolver (no guessed ASIN)")

assert.match(GLOBAL_ASIN_BACKFILL_SELECT_SQL, /ar\.workspace_id = scs\.workspace_id/)
assert.match(UPSERT_GLOBAL_ASIN_CONSUMER_SQL, /workspace_id/)
assert.match(UPSERT_GLOBAL_ASIN_CONSUMER_SQL, /ON CONFLICT \(catalog_state_id\)/)
assert.match(UPSERT_GLOBAL_AMAZON_ASIN_SQL, /ON CONFLICT \(keepa_domain, asin\)/)
assert.match(UPSERT_GLOBAL_AMAZON_ASIN_SQL, /keepa_domain/)
console.log("PASS tenant isolation SQL")

delete process.env.GLOBAL_KEEPA_MONITOR_ENABLED
delete process.env.GLOBAL_KEEPA_ACTIONS_ENABLED
const cfg = loadGlobalKeepaFoundationConfig()
assert.equal(cfg.monitorEnabled, false)
assert.equal(cfg.actionsEnabled, false)
assert.equal(cfg.plannerEnabled, false)
assert.equal(cfg.shadowMode, true)
assert.equal(cfg.tokenCostPerAsin, 1)
assert.equal(cfg.productBatchMax, 100)
process.env.GLOBAL_KEEPA_MONITOR_ENABLED = "true"
process.env.GLOBAL_KEEPA_ACTIONS_ENABLED = "false"
assert.equal(loadGlobalKeepaFoundationConfig().monitorEnabled, true)
assert.equal(loadGlobalKeepaFoundationConfig().actionsEnabled, false)
delete process.env.GLOBAL_KEEPA_MONITOR_ENABLED
delete process.env.GLOBAL_KEEPA_ACTIONS_ENABLED
console.log("PASS feature flags default false")

const keepaClient = read("modules/keepa/keepaClient.ts")
assert.doesNotMatch(keepaClient, /history=0/)
assert.match(keepaClient, /searchParams\.set\("stats", "1"\)/)
const decision = read("modules/keepa/keepaDecisionService.ts")
assert.doesNotMatch(decision, /globalKeepa/)
assert.doesNotMatch(decision, /classifyKeepaRadarProduct/)
const scan = read("modules/stockGuard/stockGuardScanService.ts")
assert.doesNotMatch(scan, /globalKeepa/)
assert.doesNotMatch(scan, /global_keepa_snapshots/)
const autoZero = read("modules/stockGuard/stockGuardAutoActionService.ts")
assert.doesNotMatch(autoZero, /globalKeepa/)
const profit = read("modules/stockGuard/autoProfitProtectionService.ts")
assert.doesNotMatch(profit, /globalKeepa/)
const scheduler = read("modules/stockGuard/stockGuardSchedulerService.ts")
assert.doesNotMatch(scheduler, /globalKeepa/)
const server = read("server.ts")
assert.match(server, /startGlobalKeepaPlannerScheduler/)
assert.doesNotMatch(server, /stockGuardAutoAction/)
const httpServer = read("modules/http/httpServer.ts")
assert.match(httpServer, /\/admin\/platform\/keepa-monitor\/status/)
assert.doesNotMatch(httpServer, /getWorkspaceId\(\).*keepa-monitor/)
const newClient = read("modules/globalKeepa/globalKeepaProductClient.ts")
assert.match(newClient, /history/)
assert.match(newClient, /"0"/)
assert.doesNotMatch(newClient, /offers/)
const oldClient = read("modules/keepa/keepaClient.ts")
assert.doesNotMatch(oldClient, /history=0/)
const selector = read("modules/keepa/keepaPriceSelector.ts")
assert.match(selector, /PRIME_EXCLUSIVE_CURRENT/)
assert.match(selector, /BUY_BOX_CURRENT/)
const monitor = read("modules/monitor/monitorService.ts")
assert.match(monitor, /from "\.\/listingAsinResolve"/)
console.log("PASS existing Keepa/Stock Guard paths unchanged")

console.log("PASS global Keepa Phase 1 foundation fixtures")
