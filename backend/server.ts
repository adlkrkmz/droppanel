import "dotenv/config"
import { startServer } from "./modules/http/httpServer"
import { checkQueueHealth, checkScraperHealth } from "./modules/dispatchJobs/dispatchJobsService"
import { alertHealthCheckFailed } from "./modules/notifications/telegramService"
import { query } from "./db/client"
import { syncAllStores } from "./modules/monitor/monitorSyncService"
import { refreshAccessToken } from "./modules/ebayOAuth/ebayOAuthService"

const PORT = parseInt(process.env.PORT ?? "4000", 10)

let lastHealthAlertTime = 0

async function runHealthCheck(): Promise<void> {
  try {
    await query("SELECT 1")
  } catch (err) {
    const now = Date.now()
    if (now - lastHealthAlertTime > 10 * 60 * 1000) {
      lastHealthAlertTime = now
      await alertHealthCheckFailed("PostgreSQL", err instanceof Error ? err.message : String(err))
    }
  }
}

const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)

startServer({
  port:        PORT,
  corsOrigins: CORS_ORIGINS,
})

setInterval(() => {
  checkQueueHealth().catch(console.error)
}, 5 * 60 * 1000)

setInterval(() => {
  runHealthCheck().catch(console.error)
}, 2 * 60 * 1000)

setInterval(() => {
  checkScraperHealth().catch(console.error)
}, 10 * 60 * 1000)

setInterval(() => {
  syncAllStores().catch(console.error)
}, 30 * 60 * 1000)

setTimeout(() => {
  syncAllStores().catch(console.error)
}, 2 * 60 * 1000)

setInterval(() => {
  void (async () => {
    try {
      const result = await query<{
        workspace_id: string
        store_code:   string
        expires_at:   string | null
      }>(`
      SELECT s.workspace_id, s.store_code, ea.expires_at
      FROM stores s
      JOIN ebay_accounts ea ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id
      WHERE s.status = 'active'
    `)
      for (const row of result.rows) {
        const hoursLeft = row.expires_at
          ? (new Date(row.expires_at).getTime() - Date.now()) / 1000 / 3600
          : -1
        if (hoursLeft < 4) {
          console.log(`[TokenRefresh] Auto-refreshing token for ${row.store_code}`)
          await refreshAccessToken(row.workspace_id, row.store_code, false).catch(e =>
            console.error(`[TokenRefresh] Failed for ${row.store_code}:`, e instanceof Error ? e.message : String(e))
          )
        }
      }
    } catch (e) {
      console.error("[TokenRefresh] Check failed:", e)
    }
  })()
}, 60 * 60 * 1000)
