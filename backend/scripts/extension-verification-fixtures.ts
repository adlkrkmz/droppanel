import assert from "assert"
import fs from "fs"
import path from "path"
import {
  claimAllowedForUser,
  isKeepaOutage,
  keepaRetryExhausted,
  nextVerificationRetryAt,
  shouldCreatePriceVerificationTask,
  verificationRetryDelayMinutes,
  workerIsOnline,
} from "../modules/amazonVerification/amazonVerificationPolicy"
import { loadAmazonVerificationConfig } from "../modules/amazonVerification/amazonVerificationConfig"
import {
  derivePurchasable,
  detectAmazonAccessFailure,
  isTrustedNewAmazonOffer,
  normalizeDisplayedPrice,
  shipsFromAmazon,
} from "../modules/amazonVerification/amazonVerificationNormalize"
import { AMAZON_VERIFICATION_CLAIM_SQL } from "../modules/amazonVerification/amazonVerificationClaimSql"

const root = path.join(__dirname, "..")
function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8")
}

const mig = read("migrations/056_amazon_price_verification.sql")
assert.match(mig, /CREATE TABLE IF NOT EXISTS extension_workers/)
assert.match(mig, /CREATE TABLE IF NOT EXISTS amazon_price_verification_tasks/)
assert.match(mig, /uq_amazon_verification_active/)
assert.match(mig, /preferred_user_id/)
assert.doesNotMatch(mig, /extension_capture_items/)
assert.doesNotMatch(mig, /ebay_quantity/)
assert.doesNotMatch(mig, /source_price/)
console.log("PASS verification migration isolated from capture/eBay")

delete process.env.GLOBAL_EXTENSION_VERIFICATION_ENABLED
delete process.env.GLOBAL_KEEPA_TO_EXTENSION_DISPATCH_ENABLED
delete process.env.GLOBAL_EXTENSION_APPLY_SOURCE_PRICE
const cfg = loadAmazonVerificationConfig()
assert.equal(cfg.verificationEnabled, false)
assert.equal(cfg.keepaDispatchEnabled, false)
assert.equal(cfg.applySourcePrice, false)
assert.equal(cfg.verifiedStockActionsEnabled, false)
assert.equal(cfg.heartbeatIntervalSeconds, 30)
assert.equal(cfg.workerOfflineAfterSeconds, 90)
assert.equal(cfg.leaseSeconds, 120)
assert.equal(cfg.maxConcurrentTasksPerWorker, 1)
console.log("PASS flags default safe")

const base = {
  keepaFailureCount: 0,
  dispatchEnabled: true,
  verificationEnabled: true,
  keepaOutage: false,
  pendingTaskCount: 0,
  fallbackTasksLastMinute: 0,
  keepaMaxRetries: 3,
  maxPending: 400,
  maxPerMinute: 20,
  source: "planner" as const,
}
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "PRICE_AMBIGUOUS" }).create, true)
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "PRICE_AMBIGUOUS", dispatchEnabled: false }).create, false)
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "FBA_MISSING" }).create, false)
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "CHECK_FAILED", keepaFailureCount: 1 }).create, false)
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "CHECK_FAILED", keepaFailureCount: 3 }).create, true)
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "CHECK_FAILED", keepaFailureCount: 3, keepaOutage: true }).create, false)
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "PRODUCT_NOT_RETURNED", keepaFailureCount: 1 }).create, false)
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "PRODUCT_NOT_RETURNED", keepaFailureCount: 3 }).reason, "KEEPA_PRODUCT_UNRESOLVED")
assert.equal(
  shouldCreatePriceVerificationTask({
    ...base,
    signal: "PRICE_AMBIGUOUS",
    pendingTaskCount: 400,
  }).code,
  "PENDING_BACKPRESSURE"
)
assert.equal(
  shouldCreatePriceVerificationTask({
    ...base,
    signal: "PRICE_AMBIGUOUS",
    fallbackTasksLastMinute: 20,
  }).code,
  "RATE_BACKPRESSURE"
)
assert.equal(shouldCreatePriceVerificationTask({ ...base, signal: "PRICE_AMBIGUOUS", source: "admin_test" }).reason, "ADMIN_TEST")
{
  let floodCreates = 0
  for (let i = 0; i < 1000; i++) {
    const d = shouldCreatePriceVerificationTask({
      ...base,
      signal: "CHECK_FAILED",
      keepaFailureCount: 3,
      keepaOutage: true,
      pendingTaskCount: i,
    })
    if (d.create) floodCreates++
  }
  assert.equal(floodCreates, 0)
}
console.log("PASS Keepa bridge policy + outage flood protection")

assert.equal(keepaRetryExhausted(2, 3), false)
assert.equal(keepaRetryExhausted(3, 3), true)
assert.equal(verificationRetryDelayMinutes(1), 5)
assert.equal(verificationRetryDelayMinutes(2), 15)
assert.equal(verificationRetryDelayMinutes(3), 30)
assert.equal(nextVerificationRetryAt({ now: new Date("2026-08-19T00:00:00Z"), attemptCount: 1 }).toISOString(), "2026-08-19T00:05:00.000Z")
assert.equal(
  workerIsOnline({
    lastHeartbeatAt: new Date("2026-08-19T00:00:00Z"),
    now: new Date("2026-08-19T00:01:20Z"),
    offlineAfterSeconds: 90,
  }),
  true
)
assert.equal(
  workerIsOnline({
    lastHeartbeatAt: new Date("2026-08-19T00:00:00Z"),
    now: new Date("2026-08-19T00:01:31Z"),
    offlineAfterSeconds: 90,
  }),
  false
)
assert.equal(isKeepaOutage({ checks: 20, failedChecks: 12, failureRateThreshold: 0.5 }), true)
assert.equal(isKeepaOutage({ checks: 3, failedChecks: 3, failureRateThreshold: 0.5 }), false)
console.log("PASS heartbeat online/offline + retry delays")

assert.equal(
  claimAllowedForUser({
    taskWorkspaceId: "ws-a",
    taskPreferredUserId: "user-a",
    workerWorkspaceId: "ws-a",
    workerUserId: "user-a",
  }),
  true
)
assert.equal(
  claimAllowedForUser({
    taskWorkspaceId: "ws-a",
    taskPreferredUserId: "user-a",
    workerWorkspaceId: "ws-a",
    workerUserId: "user-b",
  }),
  false
)
assert.equal(
  claimAllowedForUser({
    taskWorkspaceId: "ws-a",
    taskPreferredUserId: "user-a",
    workerWorkspaceId: "ws-b",
    workerUserId: "user-a",
  }),
  false
)
console.log("PASS user/workspace ownership")

assert.equal(normalizeDisplayedPrice("$24.99"), 24.99)
assert.equal(normalizeDisplayedPrice("1,234.50"), 1234.5)
assert.equal(shipsFromAmazon("Ships from Amazon"), true)
assert.equal(shipsFromAmazon("Ships from Acme LLC"), false)
assert.equal(derivePurchasable({ hasAddToCart: true }), "TRUE")
assert.equal(derivePurchasable({ hasAddToCart: true, availabilityText: "Currently unavailable" }), "TRUE")
assert.equal(derivePurchasable({ stockStatus: "IN_STOCK" }), "TRUE")
assert.equal(derivePurchasable({ availabilityText: "Currently unavailable" }), "FALSE")
assert.equal(derivePurchasable({}), "UNKNOWN")
assert.equal(isTrustedNewAmazonOffer({ condition: "NEW", shipsFromAmazon: true }), true)
assert.equal(isTrustedNewAmazonOffer({ condition: "NEW", shipsFromAmazon: false }), false)
assert.equal(detectAmazonAccessFailure({ captcha: true })?.code, "CAPTCHA")
assert.equal(detectAmazonAccessFailure({ url: "https://www.amazon.com/ap/signin" })?.code, "LOGIN_REQUIRED")
console.log("PASS extract normalize + captcha/login codes")

assert.match(AMAZON_VERIFICATION_CLAIM_SQL, /FOR UPDATE OF t SKIP LOCKED/)
assert.match(AMAZON_VERIFICATION_CLAIM_SQL, /preferred_user_id = \$2::uuid/)
assert.match(AMAZON_VERIFICATION_CLAIM_SQL, /workspace_id = \$1::uuid/)
assert.match(AMAZON_VERIFICATION_CLAIM_SQL, /lease_expires_at < NOW\(\)/)
console.log("PASS claim/lease SQL")

const queue = read("modules/amazonVerification/amazonVerificationQueue.ts")
assert.match(queue, /alreadyCompleted/)
assert.match(queue, /WRONG_WORKER/)
assert.match(queue, /23505/)
assert.doesNotMatch(queue, /source_price/)
assert.doesNotMatch(queue, /ebay_quantity/)
assert.doesNotMatch(queue, /reviseInventory/)
const bridge = read("modules/amazonVerification/amazonVerificationKeepaBridge.ts")
assert.match(bridge, /keepaDispatchEnabled/)
const handlers = read("modules/amazonVerification/amazonVerificationExtensionHandlers.ts")
assert.doesNotMatch(handlers, /active listings/)
assert.doesNotMatch(handlers, /getActiveGlobalAsins/)
assert.match(handlers, /NO_WORK/)
const extRoutes = read("modules/app/extensionRoutes.ts")
assert.match(extRoutes, /\/app\/extension\/verification\/claim-next/)
assert.match(extRoutes, /\/app\/extension\/capture-jobs\/claim-next/)
const http = read("modules/http/httpServer.ts")
assert.match(http, /\/admin\/platform\/amazon-verification\/test-task/)
assert.doesNotMatch(http, /getWorkspaceId\(\).*amazon-verification/)
const bg = read("../extension/background.js")
assert.match(bg, /verification\/claim-next/)
assert.match(bg, /droppanel_device_id/)
assert.doesNotMatch(bg, /\/app\/listings/)
assert.doesNotMatch(bg, /getActiveGlobalAsins/)
assert.match(bg, /VERIFY_PRICE/)
assert.match(bg, /active: false/)
const content = read("../extension/content.js")
assert.match(content, /VERIFY_PRICE/)
const captureSvc = read("modules/extensionCapture/extensionCaptureService.ts")
assert.doesNotMatch(captureSvc, /amazon_price_verification_tasks/)
const auto = read("modules/stockGuard/stockGuardAutoActionService.ts")
assert.doesNotMatch(auto, /amazonVerification/)
console.log("PASS existing capture/eBay isolation + extension task-only")

console.log("PASS extension verification Phase 3A fixtures")
