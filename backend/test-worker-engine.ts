import "dotenv/config"
import { closeDbPool } from "./db/client"
import { getSchedulerSummary } from "./modules/scheduler/schedulerService"
import { runWorker } from "./modules/worker/workerService"
import type { WorkerStageResult } from "./modules/worker/workerTypes"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) {
  throw new Error("WORKSPACE_ID is not defined in .env")
}
const WORKSPACE_ID: string = workspaceId

const EBAY_OAUTH_TOKEN = process.env.EBAY_OAUTH_TOKEN ?? "SIM_TOKEN"

// ─── HELPERS ──────────────────────────────────────────────────

function sep(len = 70): void {
  console.log("  " + "─".repeat(len))
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function printStageRow(r: WorkerStageResult): void {
  const ok  = r.succeeded === r.attempted && r.attempted > 0
  const icon = r.attempted === 0 ? "—" : ok ? "✓" : r.failed > 0 ? "✗" : "~"
  console.log(
    `  ${icon} ${String(r.stage.toUpperCase()).padEnd(10)}` +
    `attempted=${String(r.attempted).padEnd(5)}` +
    `succeeded=${String(r.succeeded).padEnd(5)}` +
    `failed=${String(r.failed).padEnd(5)}` +
    `skipped=${String(r.skipped).padEnd(5)}` +
    `${fmtMs(r.durationMs)}`
  )
}

// ─── MAIN ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(70))
  console.log("  test-worker-engine")
  console.log("═".repeat(70))
  console.log(`  workspace : ${WORKSPACE_ID}`)
  console.log(`  mode      : SIMULATION`)
  console.log("")

  // ── ADIM 1: Scheduler özeti ───────────────────────────────────

  console.log("[1/3] Scheduler summary çekiliyor...")

  const summary = await getSchedulerSummary(WORKSPACE_ID)

  console.log("")
  console.log(`  ${"Aşama".padEnd(22)} Aday`)
  sep(40)
  console.log(`  ${"Scrape Queue".padEnd(22)} ${summary.counts.scrapeQueueCount}`)
  console.log(`  ${"AI Queue".padEnd(22)} ${summary.counts.aiQueueCount}`)
  console.log(`  ${"Publish Queue".padEnd(22)} ${summary.counts.publishQueueCount}`)
  sep(40)
  console.log(`  ${"TOPLAM".padEnd(22)} ${summary.counts.total}`)

  if (summary.counts.total === 0) {
    console.log("")
    console.log("  Kuyrukta iş yok.")
    console.log("  Pipeline'ı hazırlamak için şu sırayı çalıştır:")
    console.log("    1. npx ts-node test-import-scraper.ts")
    console.log("    2. npx ts-node test-scraper.ts")
    console.log("    3. npx ts-node test-ai-generator.ts")
    return
  }

  // ── ADIM 2: Worker çalıştır ───────────────────────────────────

  console.log("")
  console.log("[2/3] Worker çalıştırılıyor...")
  console.log("")

  const result = await runWorker(WORKSPACE_ID, {
    scrapeLimit:     20,
    aiLimit:         20,
    publishLimit:    10,
    publishDelayMs:  200,
    ebayOauthToken:  EBAY_OAUTH_TOKEN,
    ebaySandbox:     true,
    simulationMode:  true
  })

  // ── ADIM 3: Sonuç tablosu ─────────────────────────────────────

  console.log("")
  console.log("[3/3] Worker sonuçları")
  sep()
  console.log(
    `  ${"".padEnd(4)}` +
    `${"Stage".padEnd(12)}` +
    `${"attempted".padEnd(12)}` +
    `${"succeeded".padEnd(12)}` +
    `${"failed".padEnd(9)}` +
    `${"skipped".padEnd(9)}` +
    `duration`
  )
  sep()

  printStageRow(result.scrape)
  printStageRow(result.ai)
  printStageRow(result.publish)

  sep()

  const totalSucceeded = result.scrape.succeeded + result.ai.succeeded + result.publish.succeeded
  const totalFailed    = result.scrape.failed    + result.ai.failed    + result.publish.failed
  const totalAttempted = result.scrape.attempted + result.ai.attempted + result.publish.attempted

  console.log(
    `  ${"TOPLAM".padEnd(16)}` +
    `${String(totalAttempted).padEnd(12)}` +
    `${String(totalSucceeded).padEnd(12)}` +
    `${String(totalFailed).padEnd(9)}`
  )

  // ── Final özet ────────────────────────────────────────────────

  const allOk = totalFailed === 0 && totalAttempted > 0

  console.log("")
  console.log("═".repeat(70))
  console.log(`  startedAt   : ${result.startedAt}`)
  console.log(`  completedAt : ${result.completedAt}`)
  console.log(`  totalTime   : ${fmtMs(result.totalDurationMs)}`)
  console.log("")
  console.log(`  Scrape   : ${result.scrape.succeeded}/${result.scrape.attempted} başarılı`)
  console.log(`  AI       : ${result.ai.succeeded}/${result.ai.attempted} başarılı`)
  console.log(`  Publish  : ${result.publish.succeeded}/${result.publish.attempted} başarılı`)
  console.log("")
  console.log(`  Sonuç    : ${allOk ? "✓ BAŞARILI" : totalAttempted === 0 ? "— İşlenecek iş bulunamadı" : "✗ SORUN VAR — yukarıdaki tabloyu kontrol et"}`)
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
