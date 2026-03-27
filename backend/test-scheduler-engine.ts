import "dotenv/config"
import { closeDbPool } from "./db/client"
import { getSchedulerSummary } from "./modules/scheduler/schedulerService"
import type { SchedulerCandidate } from "./modules/scheduler/schedulerTypes"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) {
  throw new Error("WORKSPACE_ID is not defined in .env")
}
const WORKSPACE_ID: string = workspaceId

// ─── HELPERS ──────────────────────────────────────────────────

function sep(len = 70): void {
  console.log("  " + "─".repeat(len))
}

function stageLabel(stage: string): string {
  if (stage === "scrape")  return "SCRAPE"
  if (stage === "ai")      return "AI    "
  if (stage === "publish") return "PUBLI "
  return stage.toUpperCase().slice(0, 6)
}

function printCandidateTable(
  title: string,
  candidates: SchedulerCandidate[]
): void {
  console.log(`\n  ► ${title} (${candidates.length} kayıt)`)

  if (candidates.length === 0) {
    console.log("    (aday yok)")
    return
  }

  console.log(
    `  ${"pool_id".padEnd(10)}` +
    `${"asin".padEnd(14)}` +
    `${"stage".padEnd(10)}` +
    `${"priority".padEnd(10)}` +
    `store_id`
  )
  sep()

  for (const c of candidates) {
    console.log(
      `  ${String(c.poolId).padEnd(10)}` +
      `${c.asin.padEnd(14)}` +
      `${stageLabel(c.stage).padEnd(10)}` +
      `${String(c.priority).padEnd(10)}` +
      `${c.assignedStoreId ?? "-"}`
    )
  }
}

// ─── MAIN ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(70))
  console.log("  test-scheduler-engine")
  console.log("═".repeat(70))
  console.log(`  workspace : ${WORKSPACE_ID}`)
  console.log(`  mode      : summary only (no execution)`)
  console.log("")

  const summary = await getSchedulerSummary(WORKSPACE_ID)

  // ── Queue Counts ──────────────────────────────────────────────

  console.log("\n[1] Queue Sayıları")
  sep()
  console.log(`  ${"Aşama".padEnd(20)} Aday Sayısı`)
  sep()
  console.log(`  ${"Scrape Queue".padEnd(20)} ${summary.counts.scrapeQueueCount}`)
  console.log(`  ${"AI Queue".padEnd(20)} ${summary.counts.aiQueueCount}`)
  console.log(`  ${"Publish Queue".padEnd(20)} ${summary.counts.publishQueueCount}`)
  sep()
  console.log(`  ${"TOPLAM".padEnd(20)} ${summary.counts.total}`)

  // ── Execution Plan ────────────────────────────────────────────

  console.log("\n[2] Execution Plan")
  sep()
  console.log(`  scrapeQueueCount  : ${summary.plan.scrapeQueueCount}`)
  console.log(`  aiQueueCount      : ${summary.plan.aiQueueCount}`)
  console.log(`  publishQueueCount : ${summary.plan.publishQueueCount}`)
  console.log(`  totalQueued       : ${summary.plan.totalQueued}`)
  console.log(`  generatedAt       : ${summary.plan.generatedAt}`)

  // ── Candidate Tables ──────────────────────────────────────────

  console.log("\n[3] Aday Listeleri (önizleme)")

  const scrapeCandidates  = summary.candidates.filter(c => c.stage === "scrape")
  const aiCandidates      = summary.candidates.filter(c => c.stage === "ai")
  const publishCandidates = summary.candidates.filter(c => c.stage === "publish")

  printCandidateTable("Scrape Adayları",  scrapeCandidates)
  printCandidateTable("AI Adayları",      aiCandidates)
  printCandidateTable("Publish Adayları", publishCandidates)

  // ── Final Özet ────────────────────────────────────────────────

  const hasWork = summary.counts.total > 0

  console.log("")
  console.log("═".repeat(70))
  console.log(`  summaryAt : ${summary.summaryAt}`)
  console.log(`  Durum     : ${hasWork ? `✓ ${summary.counts.total} iş hazır` : "— Kuyrukta bekleyen iş yok"}`)
  console.log("═".repeat(70))
}

main()
  .catch((err: unknown) => {
  console.error("[HATA FULL]", err)
  if (err instanceof Error) {
    console.error("[HATA MESSAGE]", err.message)
    console.error("[HATA STACK]", err.stack)
  }
  process.exit(1)
})
