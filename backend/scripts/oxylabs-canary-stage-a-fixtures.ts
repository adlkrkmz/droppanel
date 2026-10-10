import assert from "assert"
import { oxylabsFeederRemaining, simulateOxylabsPrimaryFeederTicks } from "../modules/oxylabsVerify/oxylabsVerifyQueueCap"
import { loadOxylabsVerifyConfig } from "../modules/oxylabsVerify/oxylabsVerifyConfig"
import { shouldEnqueueOxylabsConfirm } from "../modules/oxylabsVerify/oxylabsProductDecision"

{
  const t1 = simulateOxylabsPrimaryFeederTicks({ candidateCount: 20, canaryMax: 5, ticks: 1 })
  assert.equal(t1.created[0], 5)
  assert.equal(t1.totalActiveUnreserved, 5)
  assert.equal(t1.remainingAfter, 0)
}

{
  const t2 = simulateOxylabsPrimaryFeederTicks({ candidateCount: 20, canaryMax: 5, ticks: 2 })
  assert.equal(t2.created[0], 5)
  assert.equal(t2.created[1], 0)
  assert.equal(t2.totalActiveUnreserved, 5)
}

{
  const rem = oxylabsFeederRemaining({
    canaryMax: 5,
    uniqueReservationCount: 2,
    unreservedActiveOxylabsJobCount: 3,
  })
  assert.equal(rem, 0)
  const t = simulateOxylabsPrimaryFeederTicks({
    candidateCount: 20,
    canaryMax: 5,
    uniqueReservationCount: 2,
    unreservedActiveOxylabsJobCount: 3,
    ticks: 1,
  })
  assert.equal(t.created[0], 0)
}

{
  const rem = oxylabsFeederRemaining({
    canaryMax: 5,
    uniqueReservationCount: 1,
    unreservedActiveOxylabsJobCount: 0,
  })
  assert.equal(rem, 4)
  const afterTerminal = simulateOxylabsPrimaryFeederTicks({
    candidateCount: 20,
    canaryMax: 5,
    uniqueReservationCount: 1,
    unreservedActiveOxylabsJobCount: 0,
    ticks: 1,
  })
  assert.equal(afterTerminal.created[0], 4)
  assert.equal(1 + afterTerminal.created[0], 5)
}

{
  const remForConfirm = oxylabsFeederRemaining({
    canaryMax: 10,
    uniqueReservationCount: 5,
    unreservedActiveOxylabsJobCount: 0,
  })
  assert.equal(remForConfirm, 5)
  assert.equal(shouldEnqueueOxylabsConfirm(), false)
}

{
  process.env.OXYLABS_VERIFY_MUTATIONS_ENABLED = "false"
  process.env.OXYLABS_PRICING_ENABLED = "false"
  process.env.OXYLABS_CANARY_MAX_SUCCESS_RESULTS = "5"
  process.env.OXYLABS_VERIFY_PROTOCOL_ENABLED = "true"
  const cfg = loadOxylabsVerifyConfig()
  assert.equal(cfg.mutationsEnabled, false)
  assert.equal(cfg.canaryMaxSuccessResults, 5)
  assert.equal(cfg.source, "amazon_product")
}

console.log("PASS oxylabs canary stage-A queue cap fixtures")
