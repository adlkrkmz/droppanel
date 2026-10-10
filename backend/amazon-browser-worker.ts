import "dotenv/config"
import { validateTokenEncryptionKeyAtStartup } from "./modules/security/tokenEncryption"
import {
  startAmazonBrowserWorkerLoop,
  stopAmazonBrowserWorkerLoop,
} from "./modules/amazonBrowserWorker/amazonBrowserWorkerLoop"

const authDisabled = String(process.env.AMAZON_AUTH_WORKER_DISABLED ?? "true").toLowerCase() === "true"
if (authDisabled) {
  console.log("[amazon-browser-worker] AMAZON_AUTH_WORKER_DISABLED=true — not starting login/auth worker")
  process.exit(0)
}

validateTokenEncryptionKeyAtStartup()

console.log("Amazon browser worker starting (VERIFY_SOURCE only)")

function shutdown(signal: string): void {
  console.log(`[amazon-browser-worker] ${signal} — shutting down`)
  void stopAmazonBrowserWorkerLoop().finally(() => process.exit(0))
  setTimeout(() => process.exit(1), 15_000)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

startAmazonBrowserWorkerLoop().catch((err: unknown) => {
  console.error("[amazon-browser-worker] fatal:", err instanceof Error ? err.message : err)
  process.exit(1)
})
