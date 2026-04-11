import "dotenv/config"
import { closeDbPool, query } from "./db/client"
import { buildEbayListingPayloads } from "./modules/ebay/ebayPayloadService"
import { runInventoryFlowBatch } from "./modules/ebay/ebayInventoryService"
import {
  persistPublishResults,
  zipPayloadsAndResults
} from "./modules/ebay/ebayPublishPersistenceService"
import type { InventoryFlowResult } from "./modules/ebay/ebayApiTypes"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) {
  throw new Error("WORKSPACE_ID is not defined in .env")
}
const WORKSPACE_ID: string = workspaceId

const EBAY_OAUTH_TOKEN = process.env.EBAY_OAUTH_TOKEN ?? "SIM_TOKEN"

// ─── HELPERS ──────────────────────────────────────────────────

function sep(): void {
  console.log("  " + "─".repeat(72))
}

function icon(val: boolean | null | undefined): string {
  if (val === true)  return "✓"
  if (val === false) return "✗"
  return "-"
}

function isResultSuccess(r: InventoryFlowResult): boolean {
  return (
    r.inventoryItemStatus !== "FAILED" &&
    r.inventoryItemStatus !== "failed" &&
    r.offerStatus         !== "FAILED" &&
    r.offerStatus         !== "failed" &&
    r.publishStatus       !== "FAILED" &&
    r.publishStatus       !== "failed"
  )
}

// ─── MAIN ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(72))
  console.log("  test-ebay-publish-persistence")
  console.log("═".repeat(72))
  console.log(`  workspace : ${WORKSPACE_ID}`)
  console.log(`  mode      : SIMULATION`)
  console.log("")

  // ── ADIM 1: Payload'ları çek ──────────────────────────────────

  console.log("[1/4] Payload'lar çekiliyor...")

  const payloads = await buildEbayListingPayloads(WORKSPACE_ID, 10)
  console.log(`  ${payloads.length} payload bulundu`)

  if (payloads.length === 0) {
    console.log("")
    console.log("  Payload yok. Şunları kontrol et:")
    console.log("    asin_pool.status         = 'ready'")
    console.log("    asin_pool.pipeline_stage = 'ai_generated'")
    console.log("    asin_pool.assigned_store_id IS NOT NULL")
    console.log("    stores.status            = 'active'")
    return
  }

  console.log("")
  console.log(`  ${"#".padEnd(4)} ${"ASIN".padEnd(14)} ${"SKU".padEnd(26)} ${"Price".padEnd(8)} ${"storeId".padEnd(10)} Store`)
  sep()
  payloads.forEach((p, i) => {
    console.log(
      `  ${String(i + 1).padEnd(4)}` +
      `${p.asin.padEnd(14)}` +
      `${p.sku.padEnd(26)}` +
      `$${String(p.price.toFixed(2)).padEnd(7)}` +
      `${String(p.assignedStoreId).padEnd(10)}` +
      `${p.storeName}`
    )
  })

  // ── ADIM 2: eBay inventory flow (simulation) ──────────────────

  console.log("")
  console.log("[2/4] eBay inventory flow çalıştırılıyor (simulation)...")

  const batchSummary = await runInventoryFlowBatch(
    payloads,
    { sandbox: true, simulationMode: true },
    { delayBetweenMs: 100 }
  )

  console.log("")
  console.log(`  ${"ASIN".padEnd(14)} ${"Inv".padEnd(6)} ${"Offer".padEnd(7)} ${"Pub".padEnd(6)} OfferId`)
  sep()

  for (const r of batchSummary.results) {
    const inv = (r.inventoryItemStatus === "FAILED" || r.inventoryItemStatus === "failed") ? "✗" : "✓"
    const off = (r.offerStatus         === "FAILED" || r.offerStatus         === "failed") ? "✗" : "✓"
    const pub = (r.publishStatus       === "FAILED" || r.publishStatus       === "failed") ? "✗" : "✓"
    console.log(
      `  ${r.asin.padEnd(14)}` +
      `${inv.padEnd(6)}` +
      `${off.padEnd(7)}` +
      `${pub.padEnd(6)}` +
      `${r.ebayOfferId ?? "-"}`
    )
  }

  const successfulResults = batchSummary.results.filter(isResultSuccess)

  console.log(
    `\n  total=${batchSummary.total} | ` +
    `başarılı=${successfulResults.length} | ` +
    `başarısız=${batchSummary.failed}`
  )

  // ── ADIM 3: Persistence ───────────────────────────────────────

  console.log("")
  console.log("[3/4] Publish sonuçları DB'ye yazılıyor...")
  console.log(`  workspace_id = ${WORKSPACE_ID}`)

  const inputs  = zipPayloadsAndResults(payloads, successfulResults)
  const summary = await persistPublishResults(inputs)

  console.log("")
  console.log(
    `  ${"ASIN".padEnd(14)} ${"internal_sku".padEnd(26)} ` +
    `${"Pool".padEnd(6)} ${"HistID".padEnd(8)} ${"CatID".padEnd(8)} Error`
  )
  sep()

  for (const row of summary.rows) {
    console.log(
      `  ${String(row.asin).padEnd(14)}` +
      `${String(row.sku).padEnd(26)}` +
      `${icon(row.poolUpdated).padEnd(6)}` +
      `${String(row.listingHistoryId ?? "-").padEnd(8)}` +
      `${String(row.catalogStateId  ?? "-").padEnd(8)}` +
      `${row.error ? row.error.slice(0, 40) : ""}`
    )
  }

  // ── ADIM 4: DB doğrulama sorguları ───────────────────────────

  console.log("")
  console.log("[4/4] DB doğrulama sorguları...")

  // asin_pool
  console.log("")
  console.log("  ► asin_pool (pipeline_stage = 'listed')")
  console.log(
    `  ${"pool_id".padEnd(8)} ${"asin".padEnd(14)} ` +
    `${"status".padEnd(12)} ${"listing_status".padEnd(16)} pipeline_stage`
  )
  sep()

  const poolRows = await query<{
    id:             number
    asin:           string
    status:         string
    listing_status: string
    pipeline_stage: string
  }>(
    `SELECT ap.id, ar.asin, ap.status, ap.listing_status, ap.pipeline_stage
     FROM   asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE  ap.workspace_id   = $1
       AND  ap.pipeline_stage = 'listed'
     ORDER  BY ap.id ASC`,
    [WORKSPACE_ID]
  )

  if (poolRows.rows.length === 0) {
    console.log("  (kayıt yok)")
  } else {
    for (const r of poolRows.rows) {
      console.log(
        `  ${String(r.id).padEnd(8)}` +
        `${r.asin.padEnd(14)}` +
        `${r.status.padEnd(12)}` +
        `${r.listing_status.padEnd(16)}` +
        `${r.pipeline_stage}`
      )
    }
  }

  // listing_history
  console.log("")
  console.log("  ► listing_history")
  console.log(
    `  ${"id".padEnd(6)} ${"asin".padEnd(14)} ${"internal_sku".padEnd(26)} ` +
    `${"ebay_item_id".padEnd(32)} status`
  )
  sep()

  const historyRows = await query<{
    id:           number
    asin:         string
    internal_sku: string | null
    ebay_item_id: string | null
    status:       string
  }>(
    `SELECT lh.id, ar.asin, lh.internal_sku, lh.ebay_item_id, lh.status
     FROM   listing_history lh
     INNER JOIN asin_registry ar ON ar.id = lh.asin_registry_id
     WHERE  lh.workspace_id = $1
     ORDER  BY lh.id DESC
     LIMIT  20`,
    [WORKSPACE_ID]
  )

  if (historyRows.rows.length === 0) {
    console.log("  (kayıt yok)")
  } else {
    for (const r of historyRows.rows) {
      console.log(
        `  ${String(r.id).padEnd(6)}` +
        `${r.asin.padEnd(14)}` +
        `${String(r.internal_sku ?? "-").padEnd(26)}` +
        `${String(r.ebay_item_id ?? "-").padEnd(32)}` +
        `${r.status}`
      )
    }
  }

  // store_catalog_state
  console.log("")
  console.log("  ► store_catalog_state")
  console.log(
    `  ${"id".padEnd(6)} ${"asin".padEnd(14)} ${"internal_sku".padEnd(26)} ` +
    `${"current_status".padEnd(16)} last_seen_live_at`
  )
  sep()

  const catalogRows = await query<{
    id:                number
    asin:              string
    internal_sku:      string | null
    current_status:    string
    last_seen_live_at: string | null
  }>(
    `SELECT scs.id, ar.asin, scs.internal_sku, scs.current_status, scs.last_seen_live_at
     FROM   store_catalog_state scs
     INNER JOIN asin_registry ar ON ar.id = scs.asin_registry_id
     WHERE  scs.workspace_id = $1
     ORDER  BY scs.id DESC
     LIMIT  20`,
    [WORKSPACE_ID]
  )

  if (catalogRows.rows.length === 0) {
    console.log("  (kayıt yok)")
  } else {
    for (const r of catalogRows.rows) {
      console.log(
        `  ${String(r.id).padEnd(6)}` +
        `${r.asin.padEnd(14)}` +
        `${String(r.internal_sku ?? "-").padEnd(26)}` +
        `${r.current_status.padEnd(16)}` +
        `${r.last_seen_live_at ?? "-"}`
      )
    }
  }

  // ── Final özet ────────────────────────────────────────────────

  const allOk = summary.succeeded > 0 && summary.failed === 0

  console.log("")
  console.log("═".repeat(72))
  console.log(`  workspace_id : ${WORKSPACE_ID}`)
  console.log(`  Flow         : total=${batchSummary.total} başarılı=${successfulResults.length} başarısız=${batchSummary.failed}`)
  console.log(`  Persist      : total=${summary.total} başarılı=${summary.succeeded} başarısız=${summary.failed}`)
  console.log(`  Pool         : ${poolRows.rows.length} satır pipeline_stage=listed`)
  console.log(`  History      : ${historyRows.rows.length} satır`)
  console.log(`  Catalog      : ${catalogRows.rows.length} satır`)
  console.log(`  Sonuç        : ${allOk ? "✓ BAŞARILI" : "✗ SORUN VAR — yukarıdaki tabloları kontrol et"}`)
  console.log("═".repeat(72))
}

main()
  .catch((err: unknown) => {
    console.error("[HATA]", err instanceof Error ? err.message : err)
    process.exit(1)
  })
  .finally(async () => {
    await closeDbPool()
  })
