import "dotenv/config"
import { closeDbPool } from "./db/client"
import {
  handleGetSummary,
  handleGetQueue,
  handleGetHistory,
  handleGetStores
} from "./modules/admin/adminRoutes"
import type { AdminRequest } from "./modules/admin/adminTypes"

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) {
  throw new Error("WORKSPACE_ID is not defined in .env")
}

// ─── HELPERS ──────────────────────────────────────────────────

const EMPTY_REQ: AdminRequest = { query: {}, params: {} }

function sep(len = 68): void {
  console.log("  " + "─".repeat(len))
}

function row(label: string, value: string | number | null | undefined): void {
  console.log(`  ${String(label).padEnd(28)} ${value ?? "-"}`)
}

function isErrorBody(body: unknown): body is { error: string; message: string } {
  return typeof body === "object" && body !== null && "error" in body
}

// ─── MAIN ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(68))
  console.log("  test-admin-api-plan")
  console.log("═".repeat(68))
  console.log(`  workspace : ${workspaceId}`)
  console.log("")

  // ── 1. GET /admin/summary ─────────────────────────────────────

  console.log("[1/4] GET /admin/summary")
  sep()

  const summaryRes = await handleGetSummary(EMPTY_REQ)
  console.log(`  status : ${summaryRes.status}`)

  if (summaryRes.status === 200 && !isErrorBody(summaryRes.body)) {
    const { dashboard, runtime } = summaryRes.body as {
      dashboard: import("./modules/admin/adminTypes").DashboardSummary
      runtime: {
        loopStatus: string
        turn: number
        startedAt: string | null
        lastTurnAt: string | null
        recentTurns: number
      }
    }

    console.log("")
    console.log("  Pipeline")
    sep()
    row("asin_registry total",   dashboard.asinRegistryTotal)
    row("asin_pool total",        dashboard.asinPoolTotal)
    row("pool ready",             dashboard.poolReady)
    row("pool completed",         dashboard.poolCompleted)

    console.log("")
    console.log("  Pipeline Stages")
    sep()
    row("validated",              dashboard.pipelineStages.validated)
    row("scraped",                dashboard.pipelineStages.scraped)
    row("ai_generated",           dashboard.pipelineStages.ai_generated)
    row("listed",                 dashboard.pipelineStages.listed)

    console.log("")
    console.log("  Stores")
    sep()
    row("stores total",           dashboard.storesTotal)
    row("stores active",          dashboard.storesActive)

    console.log("")
    console.log("  Runtime (Worker Loop)")
    sep()
    row("loop status",            runtime.loopStatus)
    row("turn",                   runtime.turn)
    row("startedAt",              runtime.startedAt ?? "—")
    row("lastTurnAt",             runtime.lastTurnAt ?? "—")
    row("recentTurns (in memory)", runtime.recentTurns)
  } else if (isErrorBody(summaryRes.body)) {
    console.log(`  ERROR: ${summaryRes.body.message}`)
  }

  // ── 2. GET /admin/queue ───────────────────────────────────────

  console.log("")
  console.log("[2/4] GET /admin/queue")
  sep()

  const queueRes = await handleGetQueue(EMPTY_REQ)
  console.log(`  status : ${queueRes.status}`)

  if (queueRes.status === 200 && !isErrorBody(queueRes.body)) {
    const q = queueRes.body as import("./modules/admin/adminTypes").AdminQueueSummary
    row("scrape queue",   q.scrapeQueueCount)
    row("ai queue",       q.aiQueueCount)
    row("publish queue",  q.publishQueueCount)
    sep(40)
    row("TOTAL",          q.total)
  } else if (isErrorBody(queueRes.body)) {
    console.log(`  ERROR: ${queueRes.body.message}`)
  }

  // ── 3. GET /admin/history ─────────────────────────────────────

  console.log("")
  console.log("[3/4] GET /admin/history  (limit=10)")
  sep()

  const historyReq: AdminRequest = { query: { limit: "10" }, params: {} }
  const historyRes = await handleGetHistory(historyReq)
  console.log(`  status : ${historyRes.status}`)

  if (historyRes.status === 200 && !isErrorBody(historyRes.body)) {
    const h = historyRes.body as import("./modules/admin/adminTypes").AdminListingHistoryResult
    console.log(`  total  : ${h.total}`)
    console.log("")

    if (h.rows.length === 0) {
      console.log("  (kayıt yok)")
    } else {
      console.log(
        `  ${"id".padEnd(6)} ${"asin".padEnd(14)} ${"internal_sku".padEnd(26)}` +
        ` ${"status".padEnd(10)} listedAt`
      )
      sep()
      for (const r of h.rows) {
        console.log(
          `  ${String(r.id).padEnd(6)}` +
          `${r.asin.padEnd(14)}` +
          `${String(r.internalSku ?? "-").padEnd(26)}` +
          `${r.status.padEnd(10)}` +
          `${r.listedAt ?? "-"}`
        )
      }
    }
  } else if (isErrorBody(historyRes.body)) {
    console.log(`  ERROR: ${historyRes.body.message}`)
  }

  // ── 4. GET /admin/stores ──────────────────────────────────────

  console.log("")
  console.log("[4/4] GET /admin/stores")
  sep()

  const storesRes = await handleGetStores(EMPTY_REQ)
  console.log(`  status : ${storesRes.status}`)

  if (storesRes.status === 200 && !isErrorBody(storesRes.body)) {
    const s = storesRes.body as import("./modules/admin/adminTypes").AdminStoresResult
    console.log(`  total  : ${s.total}`)
    console.log("")

    if (s.rows.length === 0) {
      console.log("  (kayıt yok)")
    } else {
      console.log(
        `  ${"id".padEnd(6)} ${"store_code".padEnd(14)} ${"name".padEnd(24)} status`
      )
      sep()
      for (const r of s.rows) {
        console.log(
          `  ${String(r.id).padEnd(6)}` +
          `${r.storeCode.padEnd(14)}` +
          `${r.name.padEnd(24)}` +
          `${r.status}`
        )
      }
    }
  } else if (isErrorBody(storesRes.body)) {
    console.log(`  ERROR: ${storesRes.body.message}`)
  }

  // ── Admin Panel Hazır Datalar ─────────────────────────────────

  console.log("")
  console.log("═".repeat(68))
  console.log("  Admin Panel — Hazır Endpointler")
  console.log("═".repeat(68))
  console.log("  GET /admin/summary  →  dashboard + pipeline stages + runtime")
  console.log("  GET /admin/queue    →  scrape / ai / publish queue counts")
  console.log("  GET /admin/history  →  son listing history (limit param)")
  console.log("  GET /admin/stores   →  workspace store listesi")
  console.log("")
  console.log("  Express eklendiğinde adminRouteMap ile otomatik bağlanır:")
  console.log("  import { adminRouteMap } from './modules/admin/adminRoutes'")
  console.log("  adminRouteMap.forEach(r => app[r.method.toLowerCase()](r.path, ...))")
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
