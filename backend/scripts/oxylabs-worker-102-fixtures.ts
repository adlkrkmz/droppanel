import assert from "assert"
import fs from "fs"
import path from "path"
import { oxylabsFeederRemaining } from "../modules/oxylabsVerify/oxylabsVerifyQueueCap"
import {
  mayOxylabsOwnerTerminalFail,
  oxylabsIsExpiredOwnedClaim,
  oxylabsWorkerHasUnexpiredBusyJob,
} from "../modules/oxylabsVerify/oxylabsExpiredClaim"

const now = Date.parse("2026-09-24T16:00:00Z")
const future = "2026-09-24T16:05:00Z"
const past = "2026-09-24T12:46:22Z"

assert.equal(
  oxylabsWorkerHasUnexpiredBusyJob([{ status: "CLAIMED", leaseExpiresAt: past }], now),
  false
)
assert.equal(
  oxylabsWorkerHasUnexpiredBusyJob([{ status: "CLAIMED", leaseExpiresAt: future }], now),
  true
)
assert.equal(
  oxylabsWorkerHasUnexpiredBusyJob([{ status: "CLAIMED", leaseExpiresAt: null }], now),
  false
)
console.log("PASS expired CLAIMED is not WORKER_BUSY")

assert.equal(
  oxylabsIsExpiredOwnedClaim({
    status: "CLAIMED",
    workerId: "oxylabs-product-primary-A",
    requestWorkerId: "oxylabs-product-primary-A",
    leaseExpiresAt: past,
    nowMs: now,
  }),
  true
)
assert.equal(
  oxylabsIsExpiredOwnedClaim({
    status: "CLAIMED",
    workerId: "oxylabs-product-primary-A",
    requestWorkerId: "oxylabs-product-confirm-C",
    leaseExpiresAt: past,
    nowMs: now,
  }),
  false
)
console.log("PASS only owning workerId recovers expired claim")

assert.equal(
  mayOxylabsOwnerTerminalFail({
    jobWorkerId: "oxylabs-product-primary-A",
    requestWorkerId: "oxylabs-product-primary-A",
    status: "CLAIMED",
  }),
  true
)
assert.equal(
  mayOxylabsOwnerTerminalFail({
    jobWorkerId: "oxylabs-product-primary-A",
    requestWorkerId: "oxylabs-product-confirm-C",
    status: "CLAIMED",
  }),
  false
)
console.log("PASS foreign workerId cannot terminal-fail")

assert.equal(
  oxylabsFeederRemaining({
    canaryMax: 2000,
    uniqueReservationCount: 1443,
    unreservedActiveOxylabsJobCount: 557,
  }),
  0
)
assert.equal(
  oxylabsFeederRemaining({
    canaryMax: 2000,
    uniqueReservationCount: 1443,
    unreservedActiveOxylabsJobCount: 0,
  }),
  557
)
console.log("PASS feeder remaining formula unchanged")

const queueSrc = fs.readFileSync(path.join(__dirname, "../modules/oxylabsVerify/oxylabsVerifyJobQueue.ts"), "utf8")
assert.match(queueSrc, /lease_expires_at > NOW\(\)/)
assert.match(queueSrc, /expiredRecovery: true/)
assert.match(queueSrc, /FOR UPDATE OF t SKIP LOCKED/)
assert.doesNotMatch(queueSrc, /DELETE FROM oxylabs_verify_call_reservations/)
{
  const recoveredBlock = queueSrc.slice(queueSrc.indexOf("const recovered = await client.query"))
  const firstReturn = recoveredBlock.indexOf("expiredRecovery: true")
  const firstReserve = recoveredBlock.indexOf("reserveOxylabsProviderCall")
  assert.ok(firstReturn >= 0 && firstReserve > firstReturn)
}
console.log("PASS claim SQL busy-lease + skip locked + recovery before reserve")

const handlerSrc = fs.readFileSync(path.join(__dirname, "../modules/oxylabsVerify/oxylabsVerifyHandlers.ts"), "utf8")
assert.match(handlerSrc, /expiredRecovery: claimed\.expiredRecovery === true/)
assert.match(handlerSrc, /if \(!done\.alreadyCompleted\)/)
assert.match(handlerSrc, /runOwnedOxylabsApply/)
console.log("PASS result replay skips second apply")

const kindsSrc = fs.readFileSync(path.join(__dirname, "../modules/oxylabsVerify/oxylabsVerifyKinds.ts"), "utf8")
assert.match(kindsSrc, /oxylabs-product-primary-A/)
assert.doesNotMatch(kindsSrc, /if \(id === "oxylabs-product-confirm-C"\)/)
console.log("PASS CONFIRM claim kind remains disabled")

const workerSrc = fs.readFileSync(
  path.join(__dirname, "../deploy/oxylabs-worker/oxylabs-verify-worker.mjs"),
  "utf8"
)
assert.match(workerSrc, /VERSION = "1\.0\.2"/)
assert.match(workerSrc, /expiredRecovery: job\.expiredRecovery === true/)
assert.doesNotMatch(workerSrc, /source:\s*"amazon_pricing"/)
console.log("PASS worker 1.0.2 expiredRecovery flag")

console.log("PASS oxylabs-worker-102 expired claim policy")
