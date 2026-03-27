import "dotenv/config"
import { closeDbPool }   from "./db/client"
import { updatePrice, updateStock, blindListing } from "./modules/monitorActions/monitorActionsService"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) throw new Error("WORKSPACE_ID missing")
const WID: string = workspaceId

const STORE_CODE      = "S1"
const SIMULATION_MODE = (process.env.EBAY_SIMULATION ?? "true") !== "false"
const SANDBOX         = (process.env.EBAY_SANDBOX    ?? "true") !== "false"

// pool'da S1'e atanmış gerçek bir SKU bul
async function findTestSku(): Promise<string> {
  const { query } = await import("./db/client")
  const result = await query<{ asin: string }>(
    `SELECT ar.asin FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     INNER JOIN stores s ON s.id = ap.assigned_store_id
     WHERE ap.workspace_id = $1 AND s.store_code = $2
     LIMIT 1`,
    [WID, STORE_CODE]
  )
  if (!result.rows[0]) throw new Error(`No ASINs assigned to store ${STORE_CODE} — run test-dispatch-fixture.ts first`)
  return `DP${result.rows[0].asin}${STORE_CODE}`
}

function sep(len = 56): void { console.log("  " + "─".repeat(len)) }

async function main(): Promise<void> {
  console.log("═".repeat(56))
  console.log("  test-monitor-actions")
  console.log("═".repeat(56))
  console.log(`  workspace  : ${WID}`)
  console.log(`  storeCode  : ${STORE_CODE}`)
  console.log(`  simulation : ${SIMULATION_MODE}`)
  console.log("")

  const sku = await findTestSku()
  console.log(`  test SKU   : ${sku}`)
  console.log("")

  // ── Test 1: Update Price ─────────────────────────────────────

  console.log("[1/3] Update Price")
  sep()
  const priceResult = await updatePrice(WID, {
    storeCode: STORE_CODE,
    sku,
    newPrice:  49.99,
  }, SIMULATION_MODE, SANDBOX)

  console.log(`  success    : ${priceResult.success}`)
  console.log(`  simulation : ${priceResult.simulation}`)
  console.log(`  newPrice   : $${priceResult.newPrice.toFixed(2)}`)
  console.log(`  message    : ${priceResult.message}`)
  console.log(priceResult.success ? "  ✓ success" : "  ✗ failed")

  // ── Test 2: Update Stock ──────────────────────────────────────

  console.log("")
  console.log("[2/3] Update Stock")
  sep()
  const stockResult = await updateStock(WID, {
    storeCode: STORE_CODE,
    sku,
    quantity:  5,
  }, SIMULATION_MODE, SANDBOX)

  console.log(`  success    : ${stockResult.success}`)
  console.log(`  simulation : ${stockResult.simulation}`)
  console.log(`  quantity   : ${stockResult.quantity}`)
  console.log(`  message    : ${stockResult.message}`)
  console.log(stockResult.success ? "  ✓ success" : "  ✗ failed")

  // ── Test 3: Blind ─────────────────────────────────────────────

  console.log("")
  console.log("[3/3] Blind Listing")
  sep()
  const blindResult = await blindListing(WID, {
    storeCode: STORE_CODE,
    sku,
  }, SIMULATION_MODE, SANDBOX)

  console.log(`  success    : ${blindResult.success}`)
  console.log(`  simulation : ${blindResult.simulation}`)
  console.log(`  message    : ${blindResult.message}`)
  console.log(blindResult.success ? "  ✓ success" : "  ✗ failed")

  // ── Özet ──────────────────────────────────────────────────────

  const allOk = priceResult.success && stockResult.success && blindResult.success

  console.log("")
  console.log("═".repeat(56))
  console.log(`  Test Update Price : ${priceResult.success ? "✓" : "✗"}`)
  console.log(`  Test Update Stock : ${stockResult.success ? "✓" : "✗"}`)
  console.log(`  Test Blind        : ${blindResult.success ? "✓" : "✗"}`)
  console.log(`  Genel sonuç       : ${allOk ? "✓ Tüm testler geçti" : "✗ Bazı testler başarısız"}`)
  console.log("═".repeat(56))
}

main()
  .catch((e: unknown) => { console.error("[HATA]", e instanceof Error ? e.message : e); process.exit(1) })
  .finally(async () => { await closeDbPool() })
