import "dotenv/config"
import { startServer } from "./modules/http/httpServer"
import { checkQueueHealth, checkScraperHealth } from "./modules/dispatchJobs/dispatchJobsService"
import { alertHealthCheckFailed } from "./modules/notifications/telegramService"
import { query } from "./db/client"

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
