import "dotenv/config"
import { closeDbPool } from "./db/client"
import { runDispatch } from "./modules/dispatch/dispatchService"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) throw new Error("WORKSPACE_ID is not defined in .env")
const WORKSPACE_ID: string = workspaceId

// ─── DISPATCH PARAMETRELERİ ───────────────────────────────────

const STORE_CODE:     string = process.env.DISPATCH_STORE_CODE ?? "S1"
const COUNT:          number = parseInt(process.env.DISPATCH_COUNT      ?? "30",     10)
const SELECTION_MODE         = (process.env.DISPATCH_MODE               ?? "random") as "random" | "priority" | "fifo"
const DELAY_SECONDS:  number = parseInt(process.env.DISPATCH_DELAY_SEC  ?? "120",    10)

// ─── HELPERS ──────────────────────────────────────────────────

function sep(len = 68): void {
  console.log("  " + "─".repeat(len))
}

// ─── MAIN ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(68))
  console.log("  test-dispatch-engine")
  console.log("═".repeat(68))
  console.log(`  workspace     : ${WORKSPACE_ID}`)
  console.log(`  storeCode     : ${STORE_CODE}`)
  console.log(`  count         : ${COUNT}`)
  console.log(`  selectionMode : ${SELECTION_MODE}`)
  console.log(`  delaySeconds  : ${DELAY_SECONDS}`)
  console.log("")

  const result = await runDispatch({
    workspaceId:   WORKSPACE_ID,
    storeCode:     STORE_CODE,
    count:         COUNT,
    selectionMode: SELECTION_MODE,
    delaySeconds:  DELAY_SECONDS
  })

  // ── Sonuç tablosu ─────────────────────────────────────────────

  console.log("")
  console.log("  ► Dispatch Sonucu")
  sep()
  console.log(`  ${"Store".padEnd(20)} ${result.storeName} (${result.storeCode}) id=${result.storeId}`)
  console.log(`  ${"Selection Mode".padEnd(20)} ${result.selectionMode}`)
  console.log(`  ${"Delay".padEnd(20)} ${result.delaySeconds}s`)
  console.log(`  ${"Selected".padEnd(20)} ${result.selectedCount}`)
  console.log(`  ${"Skipped (dup)".padEnd(20)} ${result.skippedCount}`)
  console.log(`  ${"Dispatched At".padEnd(20)} ${result.dispatchedAt}`)

  // ── Atanan ASIN tablosu ───────────────────────────────────────

  if (result.assignedAsins.length === 0) {
    console.log("")
    console.log("  Atanan ASIN yok.")
    console.log("  Kontrol et:")
    console.log("    asin_pool.status         = 'ready'")
    console.log("    asin_pool.pipeline_stage = 'ai_generated'")
    console.log("    asin_pool.ai_status      = 'success'")
    console.log("    asin_pool.assigned_store_id IS NULL")
  } else {
    console.log("")
    console.log(`  ► Atanan ASIN'ler (${result.assignedAsins.length} kayıt)`)
    console.log(
      `  ${"#".padEnd(5)}` +
      `${"pool_id".padEnd(10)}` +
      `ASIN`
    )
    sep()
    result.assignedAsins.forEach((asin, i) => {
      console.log(
        `  ${String(i + 1).padEnd(5)}` +
        `${String(result.assignedPoolIds[i]).padEnd(10)}` +
        `${asin}`
      )
    })
  }

  // ── Final özet ────────────────────────────────────────────────

  console.log("")
  console.log("═".repeat(68))
  console.log(`  Atanan  : ${result.selectedCount} ASIN → ${result.storeName}`)
  console.log(`  Elenen  : ${result.skippedCount} ASIN (zaten mağazada mevcut)`)
  console.log(
    `  Sonuç   : ${
      result.selectedCount > 0
        ? `✓ Dispatch tamamlandı — worker ${result.delaySeconds}s delay ile publish edecek`
        : "— Dispatch edilecek uygun ASIN bulunamadı"
    }`
  )
  console.log("═".repeat(68))
}

main()
  .catch((err: unknown) => {
    console.error("[HATA]", err instanceof Error ? err.message : err)
    process.exit(1)
  })
  .finally(async () => {
    await closeDbPool()
  })
