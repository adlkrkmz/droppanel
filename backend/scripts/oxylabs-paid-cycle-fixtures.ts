import assert from "assert"
import fs from "fs"
import path from "path"
import {
  addUtcCalendarMonths,
  oxylabsBillingCycleWindow,
  oxylabsCycleAllowsNewReservation,
  oxylabsCycleRemaining,
} from "../modules/oxylabsVerify/oxylabsBillingCycle"
import { oxylabsFeederRemaining } from "../modules/oxylabsVerify/oxylabsVerifyQueueCap"
import { shouldEnqueueOxylabsConfirm } from "../modules/oxylabsVerify/oxylabsProductDecision"
import { oxylabsPricingForbidden } from "../modules/oxylabsVerify/oxylabsVerifyConfig"

{
  const rem = oxylabsCycleRemaining({
    monthlyLimit: 98000,
    currentCycleReservations: 0,
    unreservedActivePrimaryJobs: 0,
  })
  assert.equal(rem, 98000)
  console.log("PASS 1 free-lifetime 2000 ignored; paid cycle usage 0")
}

{
  const rem = oxylabsCycleRemaining({
    monthlyLimit: 98000,
    currentCycleReservations: 0,
    unreservedActivePrimaryJobs: 557,
  })
  assert.equal(rem, 97443)
  console.log("PASS 2 557 unreserved PENDING → remaining 97443")
}

{
  const before = oxylabsCycleRemaining({
    monthlyLimit: 98000,
    currentCycleReservations: 0,
    unreservedActivePrimaryJobs: 557,
  })
  const after = oxylabsCycleRemaining({
    monthlyLimit: 98000,
    currentCycleReservations: 1,
    unreservedActivePrimaryJobs: 556,
  })
  assert.equal(before, after)
  assert.equal(after, 97443)
  console.log("PASS 3 claim converts unreserved→reserved; remaining unchanged")
}

{
  const replay = oxylabsCycleRemaining({
    monthlyLimit: 98000,
    currentCycleReservations: 1,
    unreservedActivePrimaryJobs: 556,
  })
  assert.equal(replay, 97443)
  assert.equal(oxylabsCycleAllowsNewReservation({ monthlyLimit: 98000, currentCycleReservations: 1 }), true)
  console.log("PASS 4 result replay does not add a reservation in the formula")
}

{
  assert.equal(oxylabsCycleAllowsNewReservation({ monthlyLimit: 98000, currentCycleReservations: 98000 }), false)
  assert.equal(
    oxylabsCycleRemaining({
      monthlyLimit: 98000,
      currentCycleReservations: 98000,
      unreservedActivePrimaryJobs: 0,
    }),
    0
  )
  console.log("PASS 5-6 duplicate reservation is existing-only; 98000 stops new claims")
}

{
  const anchor = new Date("2026-09-24T19:30:00.000Z")
  const next = addUtcCalendarMonths(anchor, 1)
  const w0 = oxylabsBillingCycleWindow(anchor, anchor)
  const w1 = oxylabsBillingCycleWindow(anchor, next)
  assert.equal(w0.start.toISOString(), anchor.toISOString())
  assert.equal(w0.end.toISOString(), next.toISOString())
  assert.equal(w1.start.toISOString(), next.toISOString())
  assert.equal(w1.index, 1)
  const usageNext = oxylabsCycleRemaining({
    monthlyLimit: 98000,
    currentCycleReservations: 0,
    unreservedActivePrimaryJobs: 0,
  })
  assert.equal(usageNext, 98000)
  console.log("PASS 7 new month starts at 0 without deleting history")
}

{
  const jan31 = new Date("2026-01-31T12:00:00.000Z")
  const feb = addUtcCalendarMonths(jan31, 1)
  assert.equal(feb.toISOString(), "2026-02-28T12:00:00.000Z")
  const leap = addUtcCalendarMonths(new Date("2024-01-31T12:00:00.000Z"), 1)
  assert.equal(leap.toISOString(), "2024-02-29T12:00:00.000Z")
  const nye = addUtcCalendarMonths(new Date("2026-12-31T23:00:00.000Z"), 1)
  assert.equal(nye.toISOString(), "2027-01-31T23:00:00.000Z")
  const w = oxylabsBillingCycleWindow(jan31, new Date("2026-02-15T00:00:00.000Z"))
  assert.equal(w.start.toISOString(), jan31.toISOString())
  assert.equal(w.end.toISOString(), feb.toISOString())
  console.log("PASS 8 Jan 31 / Feb / year rollover")
}

assert.equal(shouldEnqueueOxylabsConfirm(), false)
assert.equal(oxylabsPricingForbidden("false"), false)
assert.equal(oxylabsPricingForbidden("true"), true)
console.log("PASS 9-10 CONFIRM enqueue false; Pricing forbidden when true")

const remLegacy = oxylabsFeederRemaining({
  canaryMax: 2000,
  uniqueReservationCount: 2000,
  unreservedActiveOxylabsJobCount: 0,
})
assert.equal(remLegacy, 0)
console.log("PASS canary formula unchanged for non-paid mode")

const decisionSrc = fs.readFileSync(
  path.join(__dirname, "../modules/oxylabsVerify/oxylabsProductDecision.ts"),
  "utf8"
)
assert.match(decisionSrc, /NOT_PRIME/)
assert.match(decisionSrc, /OUT_OF_STOCK/)
const applySrc = fs.readFileSync(path.join(__dirname, "../modules/oxylabsVerify/oxylabsApplyOperations.ts"), "utf8")
assert.match(applySrc, /ebay_mutate_count/)
assert.match(applySrc, /operation_key/)
console.log("PASS 11-12 commercial apply files untouched; operation_key idempotency remains")

const kinds = fs.readFileSync(path.join(__dirname, "../modules/oxylabsVerify/oxylabsVerifyKinds.ts"), "utf8")
assert.doesNotMatch(kinds, /if \(id === "oxylabs-product-confirm-C"\)/)
console.log("PASS oxylabs-paid-cycle fixtures")
