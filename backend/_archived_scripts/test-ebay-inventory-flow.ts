import "dotenv/config"
import { closeDbPool } from "./db/client"
import { buildEbayListingPayloads } from "./modules/ebay/ebayPayloadService"
import {
  runInventoryFlow,
  runInventoryFlowBatch
} from "./modules/ebay/ebayInventoryService"
import type { InventoryFlowResult } from "./modules/ebay/ebayApiTypes"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) {
  throw new Error("WORKSPACE_ID is not defined in .env")
}
const WORKSPACE_ID: string = workspaceId

// Simulation mode — gerçek eBay çağrısı yapılmaz
const SIMULATION_MODE = true

// ─── PRINT TABLE ──────────────────────────────────────────────

function printResultTable(results: InventoryFlowResult[]): void {
  const C = {
    ok:     "✓",
    failed: "✗",
    sim:    "~"
  }

  function statusIcon(s: string): string {
    if (s === "ok")        return C.ok
    if (s === "simulated") return C.sim
    return C.failed
  }

  const header =
    `  ${"ASIN".padEnd(14)}` +
    `${"SKU".padEnd(26)}` +
    `${"Inv".padEnd(5)}` +
    `${"Offer".padEnd(7)}` +
    `${"Pub".padEnd(5)}` +
    `${"OfferId".padEnd(28)}` +
    `${"ListingId".padEnd(28)}` +
    `${"ms".padEnd(6)}` +
    `Error`

  console.log("")
  console.log(header)
  console.log("  " + "─".repeat(130))

  if (results.length === 0) {
    console.log("  (sonuç yok)")
    return
  }

  for (const r of results) {
    const inv  = statusIcon(r.inventoryItemStatus)
    const off  = statusIcon(r.offerStatus)
    const pub  = statusIcon(r.publishStatus)
    const err  = r.error ? r.error.slice(0, 40) : ""

    console.log(
      `  ${String(r.asin).padEnd(14)}` +
      `${String(r.sku).padEnd(26)}` +
      `${inv.padEnd(5)}` +
      `${off.padEnd(7)}` +
      `${pub.padEnd(5)}` +
      `${String(r.ebayOfferId  ?? "-").padEnd(28)}` +
      `${String(r.ebayListingId ?? "-").padEnd(28)}` +
      `${String(r.durationMs).padEnd(6)}` +
      `${err}`
    )
  }
}

// ─── MAIN ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(70))
  console.log("  test-ebay-inventory-flow")
  console.log("═".repeat(70))
  console.log(`  workspace      : ${WORKSPACE_ID}`)
  console.log(`  simulationMode : ${SIMULATION_MODE}`)
  console.log(`  oauthToken     : ${EBAY_OAUTH_TOKEN.slice(0, 12)}...`)
  console.log("")

  // ── ADIM 1: Payload'ları DB'den çek ──────────────────────────

  console.log("[1/4] buildEbayListingPayloads çalıştırılıyor...")

  const payloads = await buildEbayListingPayloads(WORKSPACE_ID, 10)

  console.log(`  ${payloads.length} payload hazır`)

  if (payloads.length === 0) {
    console.log("")
    console.log("  Payload bulunamadı.")
    console.log("  Kontrol et:")
    console.log("    → asin_pool.status = 'ready'")
    console.log("    → asin_pool.pipeline_stage = 'ai_generated'")
    console.log("    → asin_pool.assigned_store_id NOT NULL")
    console.log("    → stores.status = 'active'")
    console.log("")
    console.log("  test-import-scraper.ts → test-scraper.ts → test-ai-generator.ts")
    console.log("  sırasıyla çalıştırılmış ve store atanmış olmalı.")
    return
  }

  // Payload listesini yazdır
  console.log("")
  console.log(`  ${"#".padEnd(4)} ${"ASIN".padEnd(14)} ${"SKU".padEnd(26)} ${"Price".padEnd(8)} ${"Store".padEnd(16)} Title`)
  console.log("  " + "─".repeat(100))

  for (let i = 0; i < payloads.length; i++) {
    const p = payloads[i]
    console.log(
      `  ${String(i + 1).padEnd(4)}` +
      `${p.asin.padEnd(14)}` +
      `${p.sku.padEnd(26)}` +
      `$${String(p.price.toFixed(2)).padEnd(7)}` +
      `${p.storeName.slice(0, 14).padEnd(16)}` +
      `${p.title.slice(0, 40)}`
    )
  }

  // ── ADIM 2: Tek payload flow testi ───────────────────────────

  console.log("")
  console.log("[2/4] Tek payload flow testi (payload[0])")
  console.log("─".repeat(50))

  const flowOpts = { sandbox: true as const, simulationMode: SIMULATION_MODE }

  const singleResult = await runInventoryFlow(payloads[0], flowOpts)

  console.log("")
  console.log("  Tek flow sonucu:")
  printResultTable([singleResult])

  // ── ADIM 3: Toplu batch flow ──────────────────────────────────

  console.log("")
  console.log(`[3/4] Toplu batch flow (${payloads.length} payload)`)
  console.log("─".repeat(50))

  const batchSummary = await runInventoryFlowBatch(payloads, flowOpts, { delayBetweenMs: 200 })

  // ── ADIM 4: Özet tablo ────────────────────────────────────────

  console.log("")
  console.log("[4/4] Batch sonuçları")
  console.log("─".repeat(50))

  printResultTable(batchSummary.results)

  // ── Final özet ───────────────────────────────────────────────

  const allOk =
    singleResult.inventoryItemStatus === "ok" &&
    singleResult.offerStatus         === "ok" &&
    singleResult.publishStatus       === "ok"

  console.log("")
  console.log("═".repeat(70))
  console.log(`  Total     : ${batchSummary.total}`)
  console.log(`  Succeeded : ${batchSummary.succeeded}`)
  console.log(`  Failed    : ${batchSummary.failed}`)
  console.log(`  Mod       : ${SIMULATION_MODE ? "SIMULATION" : "LIVE"}`)
  console.log(`  Sonuç     : ${allOk ? "✓ BAŞARILI" : "✗ SORUN VAR — yukarıdaki tabloyu kontrol et"}`)
  console.log("═".repeat(70))
}

main()
  .catch((err: unknown) => {
    console.error("[HATA]", err instanceof Error ? err.message : err)
    process.exit(1)
  })
  .finally(async () => {
    await closeDbPool()
  })
