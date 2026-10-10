import dotenv from "dotenv"
dotenv.config()
import { startServer } from "./modules/http/httpServer"
import { validateTokenEncryptionKeyAtStartup } from "./modules/security/tokenEncryption"
import { checkQueueHealth, checkScraperHealth } from "./modules/dispatchJobs/dispatchJobsService"
import { alertHealthCheckFailed } from "./modules/notifications/telegramService"
import { query } from "./db/client"
import { refreshAccessTokenByStoreId } from "./modules/ebayOAuth/ebayOAuthService"
import { startStoreSyncScheduler } from "./modules/storeSync/storeSyncScheduleService"
import { startStockGuardScheduler } from "./modules/stockGuard/stockGuardSchedulerService"
import { startScheduledPublishSimulationAutoRunner } from "./modules/scheduledPublish/scheduledPublishAutoRunnerService"
import { startScheduledPublishLiveAutoRunner } from "./modules/scheduledPublish/scheduledPublishLiveAutoRunnerService"
import { startScheduledPublishCleanupScheduler } from "./modules/scheduledPublish/scheduledPublishCleanupSchedulerService"
import { startSoldItemAutoRestockScheduler } from "./modules/orders/soldItemAutoRestockScheduler"
import { startEbayRecentOrderPollScheduler } from "./modules/orders/ebayRecentOrderPollScheduler"
import { startGlobalKeepaPlannerScheduler } from "./modules/globalKeepa/globalKeepaScheduler"
import { startAmazonBrowserPlannerScheduler } from "./modules/amazonScan/amazonScanPlanner"
import { startAmazonScanApplyProcessor } from "./modules/amazonScan/amazonScanApplyProcessor"
import { startKeepaVerifyPrimaryFeeder } from "./modules/keepaSensor/keepaVerifyPrimaryFeeder"
import { startOxylabsVerifyPrimaryFeeder } from "./modules/oxylabsVerify/oxylabsVerifyChain"
import { startOxylabsVerifyApplyProcessor } from "./modules/oxylabsVerify/oxylabsVerifyApplyProcessor"
import { importPoolCategoryPreferencesFromJsonIfNeeded } from "./modules/pool/poolCategoryPreferencesService"
import { startMailboxIngestScheduler } from "./modules/mailbox/mailboxIngestService"
import { startCustomerServiceSendScheduler } from "./modules/customerService/csSendScheduler"
import { startZeroStockAnomalyDetector } from "./modules/oxylabsVerify/zeroStockAnomalyDetector"

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

validateTokenEncryptionKeyAtStartup()

startServer({
  port:        PORT,
  corsOrigins: CORS_ORIGINS,
})

startStoreSyncScheduler()
startSoldItemAutoRestockScheduler()
startEbayRecentOrderPollScheduler()

const workspaceId = process.env.WORKSPACE_ID
if (workspaceId) {
  startStockGuardScheduler(workspaceId)
  startScheduledPublishSimulationAutoRunner(workspaceId)
  startScheduledPublishCleanupScheduler(workspaceId)
} else {
  console.warn("[StockGuardScheduler] WORKSPACE_ID missing — scheduler not started")
  console.warn("[ScheduledPublishSimRunner] WORKSPACE_ID missing — auto runner not started")
  console.warn("[ScheduledPublishCleanup] WORKSPACE_ID missing — cleanup scheduler not started")
}

startMailboxIngestScheduler()
startCustomerServiceSendScheduler()
startScheduledPublishLiveAutoRunner()
startGlobalKeepaPlannerScheduler()
startAmazonBrowserPlannerScheduler()
startAmazonScanApplyProcessor()
startKeepaVerifyPrimaryFeeder()
startOxylabsVerifyPrimaryFeeder()
startOxylabsVerifyApplyProcessor()
startZeroStockAnomalyDetector()
console.log("[Keepa] runtime flags loaded; scheduler start is gated (see [Keepa] disabled if off)")

void importPoolCategoryPreferencesFromJsonIfNeeded().catch((e) => {
  console.error("[PoolCategoryPreferences] startup import failed:", e instanceof Error ? e.message : String(e))
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
  void (async () => {
    try {
      const result = await query<{
        workspace_id: string
        store_id:     number
        store_code:   string
        store_name:   string
        expires_at:   string | null
      }>(`
      SELECT s.workspace_id, s.id AS store_id, s.store_code, s.name AS store_name, ea.expires_at
      FROM stores s
      JOIN ebay_accounts ea ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id
      WHERE s.status = 'active'
    `)
      for (const row of result.rows) {
        const hoursLeft = row.expires_at
          ? (new Date(row.expires_at).getTime() - Date.now()) / 1000 / 3600
          : -1
        if (hoursLeft < 4) {
          const label = `${row.store_code} · ${row.store_name} · store_id=${row.store_id}`
          console.log(`[TokenRefresh] Auto-refreshing token for ${label}`)
          await refreshAccessTokenByStoreId(row.workspace_id, row.store_id, false).catch(e =>
            console.error(`[TokenRefresh] Failed for ${label}:`, e instanceof Error ? e.message : String(e))
          )
        }
      }
    } catch (e) {
      console.error("[TokenRefresh] Check failed:", e)
    }
  })()
}, 60 * 60 * 1000)
