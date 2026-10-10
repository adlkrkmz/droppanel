import assert from "assert"
import fs from "fs"
import path from "path"
import {
  getStockGuardScannerMode,
  legacyAutomatedKeepaScanBlocked,
  v2OwnsAutomatedKeepaScan,
} from "../modules/stockGuard/stockGuardScannerOwnership"
import { loadGlobalKeepaFoundationConfig } from "../modules/globalKeepa/globalKeepaConfig"

const root = path.join(__dirname, "..")
function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8")
}

delete process.env.GLOBAL_KEEPA_MONITOR_ENABLED
delete process.env.GLOBAL_KEEPA_PLANNER_ENABLED
{
  const cfg = loadGlobalKeepaFoundationConfig()
  assert.equal(cfg.monitorEnabled, false)
  assert.equal(cfg.plannerEnabled, false)
  assert.equal(getStockGuardScannerMode(cfg), "legacy")
  assert.equal(v2OwnsAutomatedKeepaScan(cfg), false)
  assert.equal(legacyAutomatedKeepaScanBlocked(cfg), false)
}
console.log("PASS V2 off → legacy owns automated Keepa scan")

process.env.GLOBAL_KEEPA_MONITOR_ENABLED = "true"
process.env.GLOBAL_KEEPA_PLANNER_ENABLED = "true"
{
  const cfg = loadGlobalKeepaFoundationConfig()
  assert.equal(getStockGuardScannerMode(cfg), "v2")
  assert.equal(v2OwnsAutomatedKeepaScan(cfg), true)
  assert.equal(legacyAutomatedKeepaScanBlocked(cfg), true)
}
console.log("PASS V2 monitor+planner on → V2 is authoritative scanner")

delete process.env.GLOBAL_KEEPA_MONITOR_ENABLED
delete process.env.GLOBAL_KEEPA_PLANNER_ENABLED

{
  const scheduler = read("modules/stockGuard/stockGuardSchedulerService.ts")
  assert.match(scheduler, /legacyAutomatedKeepaScanBlocked/)
  assert.match(scheduler, /v2OwnsScan/)
  assert.match(scheduler, /V2 owns automated Keepa scan/)
  const scanJob = read("modules/stockGuard/stockGuardScanService.ts")
  assert.doesNotMatch(scanJob, /legacyAutomatedKeepaScanBlocked/)
  const adminKeepa = read("modules/keepa/keepaStoreScanService.ts")
  assert.doesNotMatch(adminKeepa, /legacyAutomatedKeepaScanBlocked/)
  const tick = read("modules/globalKeepa/globalKeepaPlannerTick.ts")
  assert.match(tick, /loadGlobalKeepaFoundationConfig/)
  assert.match(tick, /runGlobalKeepaPlannerForAsins/)
  const plannerSched = read("modules/globalKeepa/globalKeepaScheduler.ts")
  assert.match(plannerSched, /GLOBAL_KEEPA_CONTROLLED_RUN/)
  assert.doesNotMatch(scheduler, /DROP TABLE/)
}
console.log("PASS legacy scheduler gated, not deleted; admin Keepa scan ungated")

console.log("PASS stock-guard v2 scanner ownership fixtures")
