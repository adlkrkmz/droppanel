import "dotenv/config"
import { validateTokenEncryptionKeyAtStartup } from "./modules/security/tokenEncryption"
import {
  startAmazonPublicBrowserWorkerLoop,
  stopAmazonPublicBrowserWorkerLoop,
} from "./modules/amazonPublicWorker/amazonPublicBrowserWorkerLoop"
import { resolvePublicWorkerIdentity } from "./modules/amazonPublicWorker/amazonPublicWorkerPool"

validateTokenEncryptionKeyAtStartup()

const identity = resolvePublicWorkerIdentity()
console.log(
  `Amazon PUBLIC browser worker starting slot=${identity.slot} (VERIFY_SOURCE via public read)`
)

function shutdown(signal: string): void {
  console.log(`[amazon-public-browser-worker-${identity.slot}] ${signal} — shutting down`)
  void stopAmazonPublicBrowserWorkerLoop().finally(() => process.exit(0))
  setTimeout(() => process.exit(1), 15_000)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

startAmazonPublicBrowserWorkerLoop().catch((err: unknown) => {
  console.error(
    `[amazon-public-browser-worker-${identity.slot}] fatal:`,
    err instanceof Error ? err.message : err
  )
  process.exit(1)
})
