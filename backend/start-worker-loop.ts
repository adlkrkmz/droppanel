import "dotenv/config"
import { startWorkerLoop, stopWorkerLoop, getLoopState } from "./modules/runtime/runtimeService"

// ─── ENV ──────────────────────────────────────────────────────

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) {
  console.error("[Startup] WORKSPACE_ID is not defined in .env")
  process.exit(1)
}
const WORKSPACE_ID: string = workspaceId

const INTERVAL_MS      = parseInt(process.env.LOOP_INTERVAL_MS   ?? "30000", 10)
const SCRAPE_LIMIT     = parseInt(process.env.SCRAPE_LIMIT        ?? "100",   10)
const AI_LIMIT         = parseInt(process.env.AI_LIMIT            ?? "100",   10)
const PUBLISH_LIMIT    = parseInt(process.env.PUBLISH_LIMIT       ?? "20",    10)
const SIMULATION_MODE  = (process.env.SIMULATION_MODE ?? "true") !== "false"
const EBAY_SANDBOX     = (process.env.EBAY_SANDBOX    ?? "true") !== "false"
const EBAY_OAUTH_TOKEN = process.env.EBAY_OAUTH_TOKEN             ?? "SIM_TOKEN"

// ─── STARTUP ──────────────────────────────────────────────────

console.log("═".repeat(64))
console.log("  Worker Loop — starting")
console.log("═".repeat(64))
console.log(`  workspace      : ${WORKSPACE_ID}`)
console.log(`  interval       : ${INTERVAL_MS}ms`)
console.log(`  scrapeLimit    : ${SCRAPE_LIMIT}`)
console.log(`  aiLimit        : ${AI_LIMIT}`)
console.log(`  publishLimit   : ${PUBLISH_LIMIT}`)
console.log(`  simulationMode : ${SIMULATION_MODE}`)
console.log(`  ebaySandbox    : ${EBAY_SANDBOX}`)
console.log("═".repeat(64))
console.log("")

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────

function shutdown(signal: string): void {
  console.log(`\n[Startup] ${signal} received — shutting down...`)
  stopWorkerLoop()

  // Mevcut tur bitene kadar bekle, sonra çık
  const pollInterval = setInterval(() => {
    const state = getLoopState()
    if (state.status === "stopped") {
      console.log("[Startup] Loop stopped cleanly — exiting")
      clearInterval(pollInterval)
      process.exit(0)
    }
  }, 200)

  // 10 saniye içinde durmazsa zorla çık
  setTimeout(() => {
    console.warn("[Startup] Graceful shutdown timeout — forcing exit")
    process.exit(1)
  }, 10_000)
}

process.on("SIGINT",  () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

// ─── START ────────────────────────────────────────────────────

startWorkerLoop(WORKSPACE_ID, {
  intervalMs:     INTERVAL_MS,
  scrapeLimit:    SCRAPE_LIMIT,
  aiLimit:        AI_LIMIT,
  publishLimit:   PUBLISH_LIMIT,
  ebayOauthToken: EBAY_OAUTH_TOKEN,
  ebaySandbox:    EBAY_SANDBOX,
  simulationMode: SIMULATION_MODE
}).catch((err: unknown) => {
  console.error("[Startup] Failed to start loop:", err instanceof Error ? err.message : err)
  process.exit(1)
})
