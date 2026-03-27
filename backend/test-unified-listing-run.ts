import "dotenv/config"
import { closeDbPool } from "./db/client"
import { runDispatch }             from "./modules/dispatch/dispatchService"
import { runTimedPublishForStore } from "./modules/publishQueue/publishQueueService"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) throw new Error("WORKSPACE_ID is not defined in .env")
const WORKSPACE_ID: string = workspaceId

const STORE_CODE      = process.env.LISTING_STORE_CODE ?? "S1"
const COUNT           = parseInt(process.env.LISTING_COUNT       ?? "5",    10)
const MODE            = (process.env.LISTING_MODE                ?? "random") as "random" | "priority" | "fifo"
const DELAY_SECONDS   = parseInt(process.env.LISTING_DELAY_SEC   ?? "0",    10)
const DRY_RUN         = (process.env.LISTING_DRY_RUN             ?? "true") !== "false"
const SIMULATION_MODE = (process.env.SIMULATION_MODE             ?? "true") !== "false"
const EBAY_TOKEN      = process.env.EBAY_OAUTH_TOKEN             ?? "SIM_TOKEN"

function sep(len = 68): void { console.log("  " + "─".repeat(len)) }
function fmtMs(ms: number): string { return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms` }

async function main(): Promise<void> {
  console.log("═".repeat(68))
  console.log("  test-unified-listing-run")
  console.log("═".repeat(68))
  console.log(`  workspace  : ${WORKSPACE_ID}`)
  console.log(`  storeCode  : ${STORE_CODE}`)
  console.log(`  count      : ${COUNT}`)
  console.log(`  mode       : ${MODE}`)
  console.log(`  delay      : ${DELAY_SECONDS}s`)
  console.log(`  dryRun     : ${DRY_RUN}`)
  console.log(`  simulation : ${SIMULATION_MODE}`)
  console.log("")

  const runStart = Date.now()

  // ── ADIM 1: DISPATCH ──────────────────────────────────────────

  console.log("[1/2] Dispatch başlatılıyor...")
  sep()

  const dispatchResult = await runDispatch({
    workspaceId: WORKSPACE_ID,
    storeCode:   STORE_CODE,
    count:       COUNT,
    selectionMode: MODE,
    delaySeconds:  DELAY_SECONDS,
  })

  console.log("")
  console.log(`  Store       : ${dispatchResult.storeName} (${dispatchResult.storeCode})`)
  console.log(`  Selected    : ${dispatchResult.selectedCount}`)
  console.log(`  Skipped     : ${dispatchResult.skippedCount}  (already listed / not eligible)`)
  console.log("")

  if (dispatchResult.selectedCount === 0) {
    console.log("  Dispatch edilecek ASIN bulunamadı.")
    console.log("  Önce fixture çalıştır: npx ts-node test-dispatch-fixture.ts")
    return
  }

  console.log(`  Assigned Pool IDs: ${dispatchResult.assignedPoolIds.join(", ")}`)
  console.log("")
  console.log(`  ${"#".padEnd(4)} ${"pool_id".padEnd(10)} ASIN`)
  sep()
  dispatchResult.assignedAsins.forEach((asin, i) => {
    console.log(`  ${String(i + 1).padEnd(4)}${String(dispatchResult.assignedPoolIds[i]).padEnd(10)}${asin}`)
  })

  // ── ADIM 2: PUBLISH ───────────────────────────────────────────

  console.log("")
  console.log("[2/2] Publish başlatılıyor (targetPoolIds ile)...")
  sep()

  const publishResult = await runTimedPublishForStore({
    workspaceId:    WORKSPACE_ID,
    storeCode:      STORE_CODE,
    delaySeconds:   DELAY_SECONDS,
    limit:          COUNT,
    dryRun:         DRY_RUN,
    simulationMode: SIMULATION_MODE,
    ebayOauthToken: EBAY_TOKEN,
    ebaySandbox:    true,
    // KRİTİK: dispatch'ten gelen ID'leri doğrudan hedefle
    targetPoolIds:  dispatchResult.assignedPoolIds,
  })

  // ── SONUÇ ─────────────────────────────────────────────────────

  console.log("")
  console.log("  ► Publish Sonuçları")
  console.log(
    `  ${"".padEnd(4)}${"pool_id".padEnd(10)}${"asin".padEnd(14)}` +
    `${"status".padEnd(10)}${"score".padEnd(7)}${"time".padEnd(8)}error`
  )
  sep()

  for (const item of publishResult.items) {
    const icon = item.status === "success" ? "✓" : item.status === "blocked" ? "⊘" : item.status === "skipped" ? "—" : "✗"
    const errStr = item.guardErrors[0] ? item.guardErrors[0].slice(0, 40) : (item.error ?? "")
    console.log(
      `  ${icon.padEnd(4)}${String(item.poolId).padEnd(10)}${item.asin.padEnd(14)}` +
      `${item.status.padEnd(10)}${String(item.guardScore ?? "-").padEnd(7)}${fmtMs(item.durationMs).padEnd(8)}${errStr}`
    )
  }

  // ── Guard score dağılımı ──────────────────────────────────────

  if (publishResult.items.length > 0) {
    const scores = publishResult.items.map(i => i.guardScore ?? 0)
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    const minScore = Math.min(...scores)
    const maxScore = Math.max(...scores)

    console.log("")
    console.log("  ► Guard Score Summary")
    sep(40)
    console.log(`  ${"Avg".padEnd(10)} ${avgScore}/100`)
    console.log(`  ${"Min".padEnd(10)} ${minScore}/100`)
    console.log(`  ${"Max".padEnd(10)} ${maxScore}/100`)
    console.log(`  ${"Blocked".padEnd(10)} ${publishResult.blocked}`)
    console.log(`  ${"Skipped".padEnd(10)} ${publishResult.skipped}  (dryRun)`)
  }

  // ── Final özet ────────────────────────────────────────────────

  const totalMs = Date.now() - runStart

  console.log("")
  console.log("═".repeat(68))
  console.log(`  DISPATCH   selected=${dispatchResult.selectedCount}  skipped=${dispatchResult.skippedCount}`)
  console.log(`  PUBLISH    attempted=${publishResult.attempted}  succeeded=${publishResult.succeeded}  blocked=${publishResult.blocked}  skipped=${publishResult.skipped}  failed=${publishResult.failed}`)
  console.log(`  TOTAL TIME ${fmtMs(totalMs)}`)
  console.log("")

  const ok = dispatchResult.selectedCount > 0 && publishResult.attempted === dispatchResult.selectedCount
  console.log(
    `  Sonuç : ${
      !ok
        ? `✗ UYUŞMAZLIK — dispatch=${dispatchResult.selectedCount} publish.attempted=${publishResult.attempted}`
        : DRY_RUN
          ? `✓ DryRun — ${publishResult.attempted} kayıt işlendi (guard: ${publishResult.blocked} blocked, ${publishResult.skipped} passed)`
          : publishResult.succeeded > 0
            ? `✓ ${publishResult.succeeded} kayıt eBay'e publish edildi`
            : `✗ Hiç publish edilemedi — blocked/failed kayıtları incele`
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
