import assert from "assert"
import fs from "fs"
import path from "path"

const root = path.join(__dirname, "..")
const mig = fs.readFileSync(path.join(root, "migrations/059_keepa_monitor_telemetry.sql"), "utf8")
assert.match(mig, /keepa_asin_scan_events/)
assert.match(mig, /keepa_monitor_samples/)
assert.match(mig, /ADD COLUMN IF NOT EXISTS caller/)
assert.doesNotMatch(mig, /UPDATE store_catalog_state/)
assert.doesNotMatch(mig, /ebay_quantity/)
console.log("PASS keepa monitor telemetry migration is observability-only")

const dash = fs.readFileSync(path.join(root, "modules/globalKeepa/keepaMonitorDashboard.ts"), "utf8")
assert.match(dash, /countDuePlannerBuckets/)
assert.match(dash, /GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE/)
assert.match(dash, /getPlatformAmazonVerificationStatus/)
assert.doesNotMatch(dash, /fetchGlobalKeepaProducts/)
console.log("PASS dashboard reads DB/runtime, no Keepa API")

const tick = fs.readFileSync(path.join(root, "modules/globalKeepa/globalKeepaPlannerTick.ts"), "utf8")
assert.match(tick, /recordKeepaAsinScanEvent/)
assert.doesNotMatch(tick, /source_price/)
assert.doesNotMatch(tick, /reviseInventory/)
console.log("PASS planner tick still has no eBay/source_price mutation")

const http = fs.readFileSync(path.join(root, "modules/http/httpServer.ts"), "utf8")
assert.match(http, /\/admin\/platform\/keepa-monitor\/status/)
assert.match(http, /handleGetKeepaMonitorDashboard/)
console.log("PASS admin keepa-monitor route")

console.log("PASS keepa monitor fixtures")
