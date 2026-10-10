import assert from "assert"
import fs from "fs"
import path from "path"
import {
  affordableAsins,
  avgTokensPerAsin,
  capacitySeverity,
  chunkAsins,
  dueBucket,
  dueSortKey,
  keepaBatchSize,
  nextFailureCheckAt,
  nextSuccessCheckAt,
  projectedDailyRequirement,
  requiredAsinsPerMinute,
  retryDelayMinutes,
  safeDailyCapacity,
  slaOverdue,
  splitAsinsByDomain,
  theoreticalDailyCapacity,
  tickAsinBudget,
  tokenReserve,
  utilizationPercent,
} from "../modules/globalKeepa/globalKeepaCapacity"
import { loadGlobalKeepaFoundationConfig } from "../modules/globalKeepa/globalKeepaConfig"
import { GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE } from "../modules/globalKeepa/globalKeepaEligibility"
import { buildGlobalKeepaProductUrl } from "../modules/globalKeepa/globalKeepaProductClient"
import { listingPriorityRank, globalAsinPriorityRank } from "../modules/globalKeepa/globalKeepaPriority"
import { classifyKeepaRadarProduct } from "../modules/globalKeepa/keepaRadarClassifier"

const root = path.join(__dirname, "..")
function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8")
}

const mig = read("migrations/055_global_keepa_planner.sql")
assert.match(mig, /CREATE TABLE IF NOT EXISTS global_keepa_planner_state/)
assert.match(mig, /next_check_at ASC NULLS FIRST/)
assert.match(mig, /CREATE TABLE IF NOT EXISTS keepa_platform_usage/)
assert.match(mig, /CREATE TABLE IF NOT EXISTS keepa_platform_capacity_alerts/)
assert.match(mig, /idx_global_amazon_asins_next_check_nulls/)
assert.doesNotMatch(mig, /UPDATE store_catalog_state/)
assert.doesNotMatch(mig, /ebay_quantity/)
console.log("PASS planner migration")

assert.doesNotMatch(GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE, /source_next_check_at/)
assert.doesNotMatch(GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE, /panel_hidden_at/)
assert.match(GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE, /current_status/)
assert.match(GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE, /ebay_item_id/)
assert.match(GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE, /ebay_quantity, 0\) > 0/)
assert.doesNotMatch(GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE, /bot_zeroed_at/)
console.log("PASS active eligibility: hide allowed, qty>0 required, no source_next_check_at")

{
  const now = new Date("2026-08-19T12:00:00Z")
  const policy = {
    soldMinRecheckHours: 8,
    clickedMinRecheckHours: 12,
    normalMinRecheckHours: 24,
    hardMaxCheckAgeHours: 24,
  }
  const h = (n: number) => new Date(now.getTime() - n * 3600_000)
  assert.equal(slaOverdue({ now, lastSuccessAt: null, hardMaxCheckAgeHours: 24 }), true)
  assert.equal(slaOverdue({ now, lastSuccessAt: h(23), hardMaxCheckAgeHours: 24 }), false)
  assert.equal(slaOverdue({ now, lastSuccessAt: h(24), hardMaxCheckAgeHours: 24 }), true)
  assert.equal(slaOverdue({ now, lastSuccessAt: h(26), hardMaxCheckAgeHours: 24 }), true)
  assert.equal(dueBucket({ now, lastSuccessAt: h(26), nextCheckAt: h(1), priority: 2, policy }), "SLA_OVERDUE")
  assert.equal(dueBucket({ now, lastSuccessAt: h(8), nextCheckAt: now, priority: 0, policy }), "SOLD_EARLY")
  assert.equal(dueBucket({ now, lastSuccessAt: h(12), nextCheckAt: now, priority: 1, policy }), "CLICKED_EARLY")
  assert.equal(dueBucket({ now, lastSuccessAt: h(4), nextCheckAt: new Date(now.getTime() + 3600_000), priority: 0, policy }), null)
  assert.ok(dueSortKey("SLA_OVERDUE") < dueSortKey("SOLD_EARLY"))
  assert.ok(dueSortKey("SLA_OVERDUE") < dueSortKey("SLA_SCHEDULED"))
}
console.log("PASS SLA overdue always wins")

{
  const mixed = globalAsinPriorityRank([
    listingPriorityRank({ totalSold: 0, sold30d: 0, clicks30d: 0 }),
    listingPriorityRank({ totalSold: 0, sold30d: 0, clicks30d: 3 }),
    listingPriorityRank({ totalSold: 2, sold30d: 0, clicks30d: 0 }),
  ])
  assert.equal(mixed, 0)
}
console.log("PASS mixed consumer priority MIN = SOLD")

{
  assert.equal(theoreticalDailyCapacity(20), 28800)
  assert.equal(safeDailyCapacity(20, 0.95), 27360)
  assert.equal(utilizationPercent(10000, 27360), 36.55)
  assert.equal(capacitySeverity(36.55, 10000, 27360), "HEALTHY")
  assert.equal(capacitySeverity(utilizationPercent(21000, 27360), 21000, 27360), "INFO")
  assert.equal(capacitySeverity(utilizationPercent(23500, 27360), 23500, 27360), "NOTICE")
  assert.equal(capacitySeverity(utilizationPercent(25000, 27360), 25000, 27360), "WARNING")
  assert.equal(capacitySeverity(utilizationPercent(27000, 27360), 27000, 27360), "CRITICAL")
  assert.equal(capacitySeverity(utilizationPercent(28000, 27360), 28000, 27360), "CRITICAL")
  assert.equal(capacitySeverity(utilizationPercent(40000, 27360), 40000, 27360), "CRITICAL")
  assert.equal(capacitySeverity(50, 40000, 27360), "CRITICAL")
  assert.equal(capacitySeverity(utilizationPercent(40000, safeDailyCapacity(60, 0.95)), 40000, safeDailyCapacity(60, 0.95)), "HEALTHY")
  assert.equal(tokenReserve(20), 5)
  assert.equal(tokenReserve(60), 15)
  assert.equal(tokenReserve(4), 5)
  assert.equal(affordableAsins({ tokensLeft: 20, refillRate: 20 }), 15)
  assert.equal(keepaBatchSize({ productBatchMax: 100, affordableAsins: 15, dueAsins: 40 }), 15)
  assert.equal(keepaBatchSize({ productBatchMax: 100, affordableAsins: 200, dueAsins: 1 }), 1)
  assert.equal(keepaBatchSize({ productBatchMax: 100, affordableAsins: 200, dueAsins: 20 }), 20)
  assert.equal(keepaBatchSize({ productBatchMax: 100, affordableAsins: 200, dueAsins: 100 }), 100)
  assert.equal(keepaBatchSize({ productBatchMax: 100, affordableAsins: 200, dueAsins: 101 }), 100)
  assert.equal(keepaBatchSize({ productBatchMax: 100, affordableAsins: 200, dueAsins: 250 }), 100)
  assert.equal(chunkAsins(Array.from({ length: 101 }, (_, i) => `B${String(i).padStart(9, "0")}`), 100).length, 2)
  const domains = splitAsinsByDomain([
    { keepaDomain: 1, asin: "B0AAA00001" },
    { keepaDomain: 2, asin: "B0AAA00002" },
    { keepaDomain: 1, asin: "B0AAA00003" },
  ])
  assert.equal(domains.get(1)?.length, 2)
  assert.equal(domains.get(2)?.length, 1)
  assert.equal(avgTokensPerAsin(12, 10), 1.2)
  const proj10k = projectedDailyRequirement(10000, 1)
  assert.equal(proj10k.baseChecks, 10000)
  assert.equal(proj10k.observedTokens, 10000)
  assert.equal(capacitySeverity(utilizationPercent(10000, 27360), 10000, 27360), "HEALTHY")
  assert.equal(capacitySeverity(utilizationPercent(25000, 27360), 25000, 27360), "WARNING")
  assert.equal(capacitySeverity(utilizationPercent(27000, 27360), 27000, 27360), "CRITICAL")
  assert.equal(capacitySeverity(utilizationPercent(28000, 27360), 28000, 27360), "CRITICAL")
  assert.equal(capacitySeverity(utilizationPercent(40000, 27360), 40000, 27360), "CRITICAL")
  assert.equal(capacitySeverity(utilizationPercent(40000, safeDailyCapacity(60, 0.95)), 40000, safeDailyCapacity(60, 0.95)), "HEALTHY")
  const pace10k = requiredAsinsPerMinute({
    remainingDueUntilSla: 0,
    remainingMinutesUntilSlaWindow: 1440,
    activeUniqueAsins: 10000,
    hardMaxCheckAgeHours: 24,
  })
  assert.ok(Math.abs(pace10k - 10000 / 1440) < 0.01)
  const budget10k = tickAsinBudget({
    requiredAsinsPerMinute: pace10k,
    tickIntervalMs: 60_000,
    affordableAsins: 100,
    dueAsins: 10000,
    productBatchMax: 100,
    overdueCount: 0,
    extraDueCount: 10000,
  })
  assert.equal(budget10k, 7)
  const overdueBudget = tickAsinBudget({
    requiredAsinsPerMinute: pace10k,
    tickIntervalMs: 60_000,
    affordableAsins: 100,
    dueAsins: 10000,
    productBatchMax: 100,
    overdueCount: 500,
    extraDueCount: 0,
  })
  assert.equal(overdueBudget, 7)
  const t0 = new Date("2026-08-19T00:00:00Z")
  const wait429 = nextFailureCheckAt({ now: t0, failureCount: 1, refillInMs: 45_000 })
  assert.equal(wait429.toISOString(), "2026-08-19T00:00:45.000Z")
  const waitBackoffWins = nextFailureCheckAt({ now: t0, failureCount: 1, refillInMs: null })
  assert.equal(waitBackoffWins.toISOString(), "2026-08-19T00:05:00.000Z")
}
console.log("PASS capacity / batch / pacing / refill 20 vs 60")

assert.equal(retryDelayMinutes(1), 5)
assert.equal(retryDelayMinutes(2), 15)
assert.equal(retryDelayMinutes(3), 30)
assert.equal(retryDelayMinutes(9), 30)
{
  const t0 = new Date("2026-08-19T00:00:00Z")
  const n = nextSuccessCheckAt({
    lastSuccessAt: t0,
    priority: 2,
    policy: {
      soldMinRecheckHours: 8,
      clickedMinRecheckHours: 12,
      normalMinRecheckHours: 24,
      hardMaxCheckAgeHours: 24,
    },
  })
  assert.equal(n.toISOString(), "2026-08-20T00:00:00.000Z")
  const fail = nextFailureCheckAt({ now: t0, failureCount: 1 })
  assert.equal(fail.toISOString(), "2026-08-19T00:05:00.000Z")
}
console.log("PASS retry backoff + next check")

{
  const url = buildGlobalKeepaProductUrl({
    apiKey: "secret-key",
    domain: 1,
    asins: ["B0TEST0001", "B0TEST0002"],
  })
  assert.match(url, /stats=1/)
  assert.match(url, /history=0/)
  assert.doesNotMatch(url, /offers/)
  assert.doesNotMatch(url, /buybox/)
  assert.doesNotMatch(url, /stock/)
  assert.doesNotMatch(url, /update=0/)
  assert.match(url, /domain=1/)
}
console.log("PASS 1-token Keepa URL contract")

{
  const c = classifyKeepaRadarProduct({
    requestedAsin: "B0TEST0001",
    product: null,
  })
  assert.equal(c.status, "PRODUCT_NOT_RETURNED")
  const failed = classifyKeepaRadarProduct({
    requestedAsin: "B0TEST0001",
    product: null,
    checkFailed: true,
  })
  assert.equal(failed.status, "CHECK_FAILED")
}
console.log("PASS missing product != OOS/REMOVED")

delete process.env.GLOBAL_KEEPA_PLANNER_ENABLED
delete process.env.GLOBAL_KEEPA_MONITOR_ENABLED
delete process.env.GLOBAL_KEEPA_SHADOW_MODE
const cfg = loadGlobalKeepaFoundationConfig()
assert.equal(cfg.plannerEnabled, false)
assert.equal(cfg.monitorEnabled, false)
assert.equal(cfg.shadowMode, true)
assert.equal(cfg.actionsEnabled, false)
const dueFinder = read("modules/stockGuard/stockGuardDueFinder.ts")
assert.match(dueFinder, /scs.panel_hidden_at IS NULL/)
assert.match(dueFinder, /source_next_check_at IS NOT NULL/)
const plannerState = read("modules/globalKeepa/globalKeepaPlannerState.ts")
assert.match(plannerState, /p.next_check_at IS NULL/)
assert.match(plannerState, /FOR UPDATE OF p SKIP LOCKED/)
assert.match(plannerState, /claimed_until IS NULL OR p.claimed_until < NOW\(\)/)
assert.match(plannerState, /pg_try_advisory_lock/)
const snapshotMod = read("modules/globalKeepa/globalKeepaSnapshot.ts")
assert.match(snapshotMod, /previous_new_price = global_keepa_snapshots.new_price/)
console.log("PASS claim/lease/lock + snapshot previous shift SQL")

const oldClient = read("modules/keepa/keepaClient.ts")
assert.doesNotMatch(oldClient, /history=0/)
const scan = read("modules/stockGuard/stockGuardScanService.ts")
assert.doesNotMatch(scan, /globalKeepaPlannerTick/)
const auto = read("modules/stockGuard/stockGuardAutoActionService.ts")
assert.doesNotMatch(auto, /globalKeepa/)
const tick = read("modules/globalKeepa/globalKeepaPlannerTick.ts")
assert.doesNotMatch(tick, /source_price/)
assert.doesNotMatch(tick, /ebay_quantity/)
assert.doesNotMatch(tick, /reviseInventory/)
const snap = read("modules/globalKeepa/globalKeepaSnapshot.ts")
assert.match(snap, /MARK_GLOBAL_KEEPA_SNAPSHOT_FAILURE_SQL/)
assert.doesNotMatch(snap.split("MARK_GLOBAL_KEEPA_SNAPSHOT_FAILURE_SQL")[1] ?? "", /new_price = EXCLUDED/)
console.log("PASS legacy Keepa/eBay paths unchanged + failure snapshot preserves prices")

console.log("PASS global Keepa Phase 2 planner fixtures")
