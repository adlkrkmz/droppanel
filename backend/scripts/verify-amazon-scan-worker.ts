import { AmazonPublicWorker } from "../modules/amazonPublicWorker/amazonPublicWorker"
import { mapPublicObservationToVerificationPayload } from "../modules/amazonPublicWorker/mapPublicObservationToVerificationPayload"
import { resolvePublicWorkerIdentity } from "../modules/amazonPublicWorker/amazonPublicWorkerPool"
import { amazonPublicObserveHardTimeoutMs } from "../modules/amazonBrowserWorker/amazonBrowserWorkerConstants"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

assert(typeof AmazonPublicWorker === "function", "AmazonPublicWorker")
assert(typeof mapPublicObservationToVerificationPayload === "function", "map payload")
assert(typeof amazonPublicObserveHardTimeoutMs() === "number", "timeout")
process.env.AMAZON_PUBLIC_WORKER_COUNT = "1"
process.env.AMAZON_PUBLIC_WORKER_SLOT = "A"
const id = resolvePublicWorkerIdentity()
assert(id.slot === "A", "slot")
assert(id.profileDir.includes("amazon-public-browser-profile"), "public profile path")
assert(!process.env.DATABASE_URL, "DATABASE_URL must be unset on the scan host")
const launchSrc = require("fs").readFileSync(require("path").join(__dirname, "../modules/amazonPublicWorker/amazonPublicWorker.ts"), "utf8")
assert(/chromiumSandbox:\s*true/.test(launchSrc), "chromiumSandbox true")
assert(/recoverContinueShoppingInterstitial/.test(launchSrc), "continue-shopping recovery")
const versionSrc = require("fs").readFileSync(require("path").join(__dirname, "../modules/amazonPublicWorker/amazonScanWorkerVersion.ts"), "utf8")
assert(/1\.0\.5/.test(versionSrc), "worker version 1.0.5")
const withoutIgnore = launchSrc.replace(/ignoreDefaultArgs:\s*\[[^\]]*\]/g, "ignoreDefaultArgs:[]")
assert(!/--no-sandbox/.test(withoutIgnore), "no --no-sandbox launch arg")
assert(!/chromiumSandbox:\s*false/.test(launchSrc), "sandbox not disabled")
console.log("amazon-scan-worker import check ok")
console.log("required env: AMAZON_SCAN_API_BASE AMAZON_SCAN_WORKER_TOKEN AMAZON_PUBLIC_US_ZIP AMAZON_PUBLIC_WORKER_SLOT AMAZON_PUBLIC_WORKER_COUNT AMAZON_SCAN_WORKER_ROLE")
