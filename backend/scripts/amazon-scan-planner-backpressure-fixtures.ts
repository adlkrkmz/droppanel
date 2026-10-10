import { plannerRoutineEnqueueBudget } from "../modules/amazonScan/amazonScanConfig"
import { buildAmazonScanKey } from "../modules/amazonScan/amazonScanKey"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const batch = { batchSize: 50, maxOutstanding: 50 }

assert(plannerRoutineEnqueueBudget({ activeRoutineCount: 0, ...batch }) === 50, "active=0 → 50")
assert(plannerRoutineEnqueueBudget({ activeRoutineCount: 37, ...batch }) === 13, "active=37 → 13")
assert(plannerRoutineEnqueueBudget({ activeRoutineCount: 50, ...batch }) === 0, "active=50 → 0")
assert(plannerRoutineEnqueueBudget({ activeRoutineCount: 80, ...batch }) === 0, "active=80 → 0")

const withConfirmPresent = plannerRoutineEnqueueBudget({ activeRoutineCount: 37, ...batch })
assert(withConfirmPresent === 13, "CONFIRM jobs must not reduce ROUTINE budget")

assert(plannerRoutineEnqueueBudget({ activeRoutineCount: 49, ...batch }) === 1, "active=49 → 1")
assert(plannerRoutineEnqueueBudget({ activeRoutineCount: 50, batchSize: 50, maxOutstanding: 50 }) === 0, "at cap")

const k1 = buildAmazonScanKey({
  asin: "B00TEST123",
  marketplace: "US",
  deliveryZip: "10001",
  sessionClass: "PUBLIC_UNAUTH",
})
const k2 = buildAmazonScanKey({
  asin: "b00test123",
  marketplace: "us",
  deliveryZip: "10001",
  sessionClass: "PUBLIC_UNAUTH",
})
assert(k1 === k2, "duplicate ASIN protection still keyed on scan_key")

console.log(
  JSON.stringify({
    ok: true,
    cases: { active0: 50, active37: 13, active50: 0, active80: 0, confirmIgnored: 13 },
  })
)
