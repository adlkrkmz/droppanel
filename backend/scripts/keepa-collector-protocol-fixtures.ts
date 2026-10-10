import assert from "assert"
import { applySyncEvent, openKeepaLocalDb } from "../modules/keepaSensor/keepaLocalDb"
import { eventsAfterWatermark } from "../modules/keepaSensor/keepaCollectorProtocol"
import {
  evaluateAmazonScanRejectsCollectorToken,
  evaluateKeepaCollectorRouteAuth,
  keepaCollectorProtocolEnabled,
} from "../modules/keepaSensor/keepaCollectorProtocol"

assert.equal(keepaCollectorProtocolEnabled(""), false)
assert.equal(keepaCollectorProtocolEnabled(undefined), false)
assert.equal(keepaCollectorProtocolEnabled("TRUE"), true)
assert.equal(
  evaluateKeepaCollectorRouteAuth({
    protocolEnabled: false,
    collectorTokenConfigured: true,
    presentedToken: "a".repeat(32),
    collectorToken: "a".repeat(32),
    scanWorkerToken: "b".repeat(32),
  }).status,
  503
)
assert.equal(
  evaluateKeepaCollectorRouteAuth({
    protocolEnabled: true,
    collectorTokenConfigured: false,
    presentedToken: "",
    collectorToken: "",
    scanWorkerToken: "b".repeat(32),
  }).status,
  503
)
assert.equal(
  evaluateKeepaCollectorRouteAuth({
    protocolEnabled: true,
    collectorTokenConfigured: true,
    presentedToken: "",
    collectorToken: "c".repeat(32),
    scanWorkerToken: "b".repeat(32),
  }).status,
  401
)
assert.equal(
  evaluateKeepaCollectorRouteAuth({
    protocolEnabled: true,
    collectorTokenConfigured: true,
    presentedToken: "wrong-token-wrong-token-wrong-token",
    collectorToken: "c".repeat(32),
    scanWorkerToken: "b".repeat(32),
  }).status,
  401
)
assert.equal(
  evaluateKeepaCollectorRouteAuth({
    protocolEnabled: true,
    collectorTokenConfigured: true,
    presentedToken: "b".repeat(32),
    collectorToken: "c".repeat(32),
    scanWorkerToken: "b".repeat(32),
  }).status,
  401
)
const ok = evaluateKeepaCollectorRouteAuth({
  protocolEnabled: true,
  collectorTokenConfigured: true,
  presentedToken: "c".repeat(32),
  collectorToken: "c".repeat(32),
  scanWorkerToken: "b".repeat(32),
})
assert.equal(ok.ok, true)
assert.equal(
  evaluateAmazonScanRejectsCollectorToken({
    presentedToken: "c".repeat(32),
    scanWorkerToken: "b".repeat(32),
    collectorToken: "c".repeat(32),
  }),
  true
)
console.log("PASS protocol gate 503/401 + browser token isolation")

const db = openKeepaLocalDb(":memory:")
const t0 = "2026-09-21T12:00:00.000Z"
const tMid = "2026-09-21T12:00:01.000Z"
applySyncEvent(db, {
  eventId: "11111111-1111-1111-1111-111111111111",
  asin: "B0KSSNAP01",
  eventType: "ASIN_UPSERT",
  sourceVersion: 1,
  payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
  nowMs: Date.parse(t0),
})
applySyncEvent(db, {
  eventId: "22222222-2222-2222-2222-222222222222",
  asin: "B0KSSNAP02",
  eventType: "ASIN_UPSERT",
  sourceVersion: 1,
  payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "SOLD", cadenceHours: 12 },
  nowMs: Date.parse(t0),
})
const midEvents = [
  {
    eventId: "33333333-3333-3333-3333-333333333333",
    asin: "B0KSSNAP03",
    createdAt: tMid,
    eventType: "ASIN_UPSERT",
    sourceVersion: 1,
  },
]
const replay = eventsAfterWatermark(midEvents, { snapshotStartedAt: t0 })
assert.equal(replay.length, 1)
applySyncEvent(db, {
  eventId: replay[0].eventId,
  asin: replay[0].asin,
  eventType: "ASIN_UPSERT",
  sourceVersion: 1,
  payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
  nowMs: Date.parse(tMid),
})
applySyncEvent(db, {
  eventId: replay[0].eventId,
  asin: replay[0].asin,
  eventType: "ASIN_UPSERT",
  sourceVersion: 1,
  payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
  nowMs: Date.parse(tMid),
})
const asins = db.prepare("SELECT asin FROM asin_registry ORDER BY asin").all() as { asin: string }[]
assert.deepEqual(
  asins.map(r => r.asin),
  ["B0KSSNAP01", "B0KSSNAP02", "B0KSSNAP03"]
)
const snap3 = db.prepare("SELECT next_scan_at FROM asin_registry WHERE asin = 'B0KSSNAP03'").get() as { next_scan_at: number }
const maxOlder = db.prepare("SELECT MAX(next_scan_at) AS m FROM asin_registry WHERE asin <> 'B0KSSNAP03'").get() as { m: number }
assert.ok(snap3.next_scan_at >= maxOlder.m)
console.log("PASS snapshot-during-event watermark replay unique, no duplicate, new ASIN queue tail")
console.log("PASS keepa-collector-protocol fixtures")
