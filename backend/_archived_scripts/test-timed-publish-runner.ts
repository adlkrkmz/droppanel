import "dotenv/config"
import { closeDbPool }              from "./db/client"
import { runTimedPublishForStore }  from "./modules/publishQueue/publishQueueService"
import type { PublishItemResult }   from "./modules/publishQueue/publishQueueTypes"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) throw new Error("WORKSPACE_ID is not defined in .env")
const WORKSPACE_ID: string = workspaceId

// ─── PARAMETRELERİ ────────────────────────────────────────────

const STORE_CODE       = process.env.PUBLISH_STORE_CODE ?? "S1"
const DELAY_SECONDS    = parseInt(process.env.PUBLISH_DELAY_SEC ?? "5",    10)
const LIMIT            = parseInt(process.env.PUBLISH_LIMIT     ?? "10",   10)
const DRY_RUN          = (process.env.PUBLISH_DRY_RUN           ?? "true") !== "false"
const SIMULATION_MODE  = (process.env.SIMULATION_MODE           ?? "true") !== "false"
const EBAY_SANDBOX     = (process.env.EBAY_SANDBOX              ?? "true") !== "false"
const EBAY_OAUTH_TOKEN = process.env.EBAY_OAUTH_TOKEN           ?? "SIM_TOKEN"

// ─── HELPERS ──────────────────────────────────────────────────

function sep(len = 74): void {
  console.log("  " + "─".repeat(len))
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function statusIcon(s: PublishItemResult["status"]): string {
  switch (s) {
    case "success": return "✓"
    case "failed":  return "✗"
    case "blocked": return "⊘"
    case "skipped": return "—"
  }
}

// ─── MAIN ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(74))
  console.log("  test-timed-publish-runner")
  console.log("═".repeat(74))
  console.log(`  workspace      : ${WORKSPACE_ID}`)
  console.log(`  storeCode      : ${STORE_CODE}`)
  console.log(`  delaySeconds   : ${DELAY_SECONDS}`)
  console.log(`  limit          : ${LIMIT}`)
  console.log(`  dryRun         : ${DRY_RUN}`)
  console.log(`  simulationMode : ${SIMULATION_MODE}`)
  console.log(`  ebaySandbox    : ${EBAY_SANDBOX}`)
  console.log("")

  if (DRY_RUN) {
    console.log("  ⚠  DRY RUN — guard çalışır, eBay'e gönderim ve DB yazımı olmaz")
    console.log("")
  }

  const result = await runTimedPublishForStore({
    storeCode:      STORE_CODE,
    workspaceId:    WORKSPACE_ID,
    delaySeconds:   DELAY_SECONDS,
    limit:          LIMIT,
    dryRun:         DRY_RUN,
    ebayOauthToken: EBAY_OAUTH_TOKEN,
    ebaySandbox:    EBAY_SANDBOX,
    simulationMode: SIMULATION_MODE
  })

  // ── Run özeti ─────────────────────────────────────────────────

  console.log("")
  console.log("  ► Run Özeti")
  sep()
  console.log(`  ${"Store".padEnd(22)} ${result.storeName} (${result.storeCode}) id=${result.storeId}`)
  console.log(`  ${"Delay".padEnd(22)} ${result.delaySeconds}s`)
  console.log(`  ${"Dry Run".padEnd(22)} ${result.dryRun}`)
  console.log(`  ${"Attempted".padEnd(22)} ${result.attempted}`)
  console.log(`  ${"Succeeded".padEnd(22)} ${result.succeeded}`)
  console.log(`  ${"Failed".padEnd(22)} ${result.failed}`)
  console.log(`  ${"Blocked (guard)".padEnd(22)} ${result.blocked}`)
  console.log(`  ${"Skipped (dryRun)".padEnd(22)} ${result.skipped}`)
  console.log(`  ${"Total Time".padEnd(22)} ${fmtMs(result.totalMs)}`)

  if (result.items.length === 0) {
    console.log("")
    console.log("  Publish edilecek kayıt bulunamadı.")
    console.log("  Önce dispatch çalıştır:")
    console.log("    npx ts-node test-dispatch-fixture.ts")
    console.log("    npx ts-node test-dispatch-engine.ts")
    return
  }

  // ── Tam item tablosu ──────────────────────────────────────────

  console.log("")
  console.log(`  ► Tüm Kayıtlar (${result.items.length})`)
  console.log(
    `  ${"".padEnd(4)}` +
    `${"pool_id".padEnd(9)}` +
    `${"asin".padEnd(14)}` +
    `${"status".padEnd(10)}` +
    `${"score".padEnd(7)}` +
    `${"errs".padEnd(6)}` +
    `${"warns".padEnd(7)}` +
    `${"time".padEnd(8)}` +
    `sku`
  )
  sep()

  for (const item of result.items) {
    console.log(
      `  ${statusIcon(item.status).padEnd(4)}` +
      `${String(item.poolId).padEnd(9)}` +
      `${item.asin.padEnd(14)}` +
      `${item.status.padEnd(10)}` +
      `${String(item.guardScore ?? "-").padEnd(7)}` +
      `${String(item.guardErrors.length || "").padEnd(6)}` +
      `${String(item.guardWarnings.length || "").padEnd(7)}` +
      `${fmtMs(item.durationMs).padEnd(8)}` +
      `${item.sku}`
    )
  }

  // ── Blocked detaylar ──────────────────────────────────────────

  const blockedItems = result.items.filter(i => i.status === "blocked")
  if (blockedItems.length > 0) {
    console.log("")
    console.log(`  ► Blocked Items — Neden? (${blockedItems.length})`)
    sep()
    for (const item of blockedItems) {
      console.log(`  ⊘ ${item.asin}  score=${item.guardScore}`)
      item.guardErrors.forEach(e   => console.log(`    ✗ ${e}`))
      item.guardWarnings.forEach(w => console.log(`    ⚠ ${w}`))
    }
  }

  // ── Başarılı kayıtlar ─────────────────────────────────────────

  const successItems = result.items.filter(i => i.status === "success")
  if (successItems.length > 0) {
    console.log("")
    console.log(`  ► Published (${successItems.length})`)
    sep()
    for (const item of successItems) {
      console.log(`  ✓ ${item.asin}  sku=${item.sku}  score=${item.guardScore}`)
    }
  }

  // ── Final ─────────────────────────────────────────────────────

  const allOk = result.succeeded > 0 && result.failed === 0

  console.log("")
  console.log("═".repeat(74))
  console.log(`  startedAt   : ${result.startedAt}`)
  console.log(`  completedAt : ${result.completedAt}`)
  console.log(
    `  Sonuç       : ${
      result.attempted === 0
        ? "— Kuyrukta kayıt yok"
        : DRY_RUN
          ? `— DryRun | guard: ${result.blocked} blocked, ${result.skipped} passed`
          : allOk
            ? `✓ ${result.succeeded} kayıt başarıyla publish edildi`
            : result.blocked > 0 && result.succeeded === 0
              ? `⊘ Tüm kayıtlar guard tarafından bloklandı`
              : `~ ${result.succeeded} published, ${result.failed} failed, ${result.blocked} blocked`
    }`
  )
  console.log("  Legend: ✓ published  ✗ failed  ⊘ blocked by guard (fallback/0-img/policy/...)  — skipped (dryRun)")
  console.log("═".repeat(74))
}

main()
  .catch((err: unknown) => {
    console.error("[HATA]", err instanceof Error ? err.message : err)
    process.exit(1)
  })
  .finally(async () => {
    await closeDbPool()
  })
