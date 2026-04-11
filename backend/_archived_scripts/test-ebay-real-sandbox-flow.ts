// ─────────────────────────────────────────────────────────────
// test-ebay-real-sandbox-flow.ts
//
// eBay Sandbox entegrasyon testi
//
// Kullanım:
//   Gerçek sandbox testi:
//     EBAY_SIMULATION=false EBAY_SANDBOX=true npx ts-node test-ebay-real-sandbox-flow.ts
//
//   Simulation testi (default):
//     npx ts-node test-ebay-real-sandbox-flow.ts
//
// .env gereksinimleri (gerçek test için):
//   EBAY_CLIENT_ID=...
//   EBAY_CLIENT_SECRET=...
//   EBAY_REDIRECT_URI=http://localhost:4000/admin/ebay/callback
//   EBAY_SIMULATION=false
//   EBAY_SANDBOX=true
//   PUBLISH_STORE_CODE=S1
// ─────────────────────────────────────────────────────────────

import "dotenv/config"
import { closeDbPool }         from "./db/client"
import { EbayApiClient }       from "./modules/ebay/ebayApiClient"
import { getValidAccessToken }  from "./modules/ebayOAuth/ebayOAuthService"
import { buildEbayListingPayloads } from "./modules/ebay/ebayPayloadService"
import { runInventoryFlow }    from "./modules/ebay/ebayInventoryService"
import { getMonitorListings }  from "./modules/monitor/monitorService"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) throw new Error("WORKSPACE_ID missing")
const WID: string = workspaceId

const STORE_CODE      = process.env.PUBLISH_STORE_CODE ?? "S1"
const SIMULATION_MODE = (process.env.EBAY_SIMULATION   ?? "true") !== "false"
const SANDBOX         = (process.env.EBAY_SANDBOX      ?? "true") !== "false"

function sep(len = 64): void { console.log("  " + "─".repeat(len)) }
function fmtMs(ms: number): string { return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms` }

async function main(): Promise<void> {
  console.log("═".repeat(64))
  console.log("  test-ebay-real-sandbox-flow")
  console.log("═".repeat(64))
  console.log(`  workspace  : ${WID}`)
  console.log(`  storeCode  : ${STORE_CODE}`)
  console.log(`  simulation : ${SIMULATION_MODE}`)
  console.log(`  sandbox    : ${SANDBOX}`)
  console.log("")

  if (SIMULATION_MODE) {
    console.log("  ⚠  SIMULATION MODE — gerçek eBay çağrısı yapılmaz")
    console.log("  Gerçek test için: EBAY_SIMULATION=false npx ts-node test-ebay-real-sandbox-flow.ts")
    console.log("")
  } else {
    console.log("  🔴 LIVE MODE — gerçek eBay Sandbox API çağrıları yapılacak")
    console.log("")
  }

  const t0 = Date.now()

  // ── ADIM 1: Token al ──────────────────────────────────────────

  console.log("[1/5] Access Token")
  sep()

  const accessToken = await getValidAccessToken(WID, STORE_CODE, SIMULATION_MODE)
  const tokenPreview = accessToken.length > 30
    ? accessToken.slice(0, 30) + "..."
    : accessToken

  console.log(`  token    : ${tokenPreview}`)
  console.log(`  type     : ${SIMULATION_MODE ? "simulation" : "real OAuth token"}`)

  // ── ADIM 2: eBay Client ───────────────────────────────────────

  const client = new EbayApiClient({
    oauthToken:     accessToken,
    sandbox:        SANDBOX,
    simulationMode: SIMULATION_MODE,
  })

  console.log("")
  console.log("[2/5] eBay Client")
  sep()
  console.log(`  baseUrl    : ${SANDBOX ? "https://api.sandbox.ebay.com" : "https://api.ebay.com"}`)
  console.log(`  simulation : ${client.isSimulation()}`)

  // ── ADIM 3: Payload üret ──────────────────────────────────────

  console.log("")
  console.log("[3/5] Listing Payloads")
  sep()

  const payloads = await buildEbayListingPayloads(WID, 3)
  console.log(`  Payloads found: ${payloads.length}`)

  if (payloads.length === 0) {
    console.log("  ⚠  Payload bulunamadı — önce dispatch çalıştır:")
    console.log("     npx ts-node test-dispatch-fixture.ts")
    console.log("     npx ts-node test-dispatch-engine.ts")
    return
  }

  for (const p of payloads.slice(0, 3)) {
    console.log(`  • ${p.asin.padEnd(14)} ${p.sku.padEnd(25)} $${p.price.toFixed(2).padStart(7)} ${p.pricingSource}`)
  }

  // ── ADIM 4: Inventory Flow ────────────────────────────────────

  console.log("")
  console.log("[4/5] Inventory Flow (createItem → createOffer → publish)")
  sep()

  const testPayload = payloads[0]
  console.log(`  Testing with: ${testPayload.asin} / ${testPayload.sku}`)
  console.log("")

  const flowResult = await runInventoryFlow(testPayload, {
    sandbox:        SANDBOX,
    simulationMode: SIMULATION_MODE,
  })

  const statusIcon = (s: string): string =>
    s === "ok" || s === "simulated" ? "✓" : "✗"

  console.log(`  ${statusIcon(flowResult.inventoryItemStatus)} inventoryItem : ${flowResult.inventoryItemStatus}`)
  console.log(`  ${statusIcon(flowResult.offerStatus)}         offer         : ${flowResult.offerStatus}  offerId=${flowResult.ebayOfferId ?? "—"}`)
  console.log(`  ${statusIcon(flowResult.publishStatus)}       publish       : ${flowResult.publishStatus}  listingId=${flowResult.ebayListingId ?? "—"}`)
  console.log(`  duration: ${fmtMs(flowResult.durationMs)}`)

  if (flowResult.error) {
    console.log("")
    console.log(`  ✗ Error: ${flowResult.error}`)
  }

  // ── ADIM 5: Monitor listings ──────────────────────────────────

  console.log("")
  console.log("[5/5] Monitor Listings (getInventoryItems + getOffers)")
  sep()

  const monitorResult = await getMonitorListings(WID, STORE_CODE, {
    oauthToken:     accessToken,
    sandbox:        SANDBOX,
    simulationMode: SIMULATION_MODE,
  })

  console.log(`  Store      : ${monitorResult.store}`)
  console.log(`  Total      : ${monitorResult.total}`)
  console.log(`  Tracked    : ${monitorResult.tracked}`)
  console.log(`  Untracked  : ${monitorResult.untracked}`)
  console.log(`  Mode       : ${monitorResult.simulationMode ? "simulation" : "live"}`)

  if (monitorResult.items.length > 0) {
    console.log("")
    console.log(`  Sample items:`)
    for (const item of monitorResult.items.slice(0, 5)) {
      const margin = item.margin !== null ? `${item.margin.toFixed(1)}%` : "—"
      console.log(`  ${item.status === "TRACKED" ? "✓" : "—"} ${item.sku.padEnd(28)} $${String(item.ebayPrice.toFixed(2)).padStart(7)} margin=${margin}`)
    }
  }

  // ── Final ─────────────────────────────────────────────────────

  const totalMs = Date.now() - t0
  const allOk = flowResult.publishStatus === "ok" ||
                flowResult.publishStatus === "simulated"

  console.log("")
  console.log("═".repeat(64))
  console.log(`  Token         : ✓`)
  console.log(`  Client        : ✓`)
  console.log(`  Payloads      : ${payloads.length} found`)
  console.log(`  Inventory flow: ${allOk ? "✓" : "✗"} ${flowResult.publishStatus}`)
  console.log(`  Monitor       : ${monitorResult.total} listings`)
  console.log(`  Total time    : ${fmtMs(totalMs)}`)
  console.log("")

  if (SIMULATION_MODE) {
    console.log("  Gerçek sandbox testi için:")
    console.log("  1. eBay Developer Account aç: https://developer.ebay.com")
    console.log("  2. Sandbox app oluştur, Client ID + Secret al")
    console.log("  3. .env'e ekle: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET")
    console.log("  4. localhost:3000/stores → Connect eBay (sandbox)")
    console.log("  5. EBAY_SIMULATION=false npx ts-node test-ebay-real-sandbox-flow.ts")
  } else {
    console.log(`  Sandbox test ${allOk ? "başarılı ✓" : "başarısız ✗"}`)
    if (flowResult.ebayListingId) {
      console.log(`  eBay Listing: https://www.sandbox.ebay.com/itm/${flowResult.ebayListingId}`)
    }
  }

  console.log("═".repeat(64))
}

main()
  .catch((e: unknown) => {
    console.error("[HATA]", e instanceof Error ? e.message : e)
    process.exit(1)
  })
  .finally(async () => { await closeDbPool() })
