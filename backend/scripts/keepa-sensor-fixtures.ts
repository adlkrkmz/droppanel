import assert from "assert"
import { DatabaseSync } from "node:sqlite"
import { extractKeepaMonitoredSnapshot, monitoredSnapshotFingerprint } from "../modules/keepaSensor/keepaMonitoredSnapshot"
import {
  applyBrowserCandidateOutcome,
  evaluateKeepaRead,
  nextCandidateTransition,
} from "../modules/keepaSensor/keepaSnapshotDiff"
import {
  eventsFromProjectionTransition,
  nextScanAtForNewAsin,
  projectKeepaAsin,
} from "../modules/keepaSensor/keepaAsinProjection"
import { evaluateKeepaDualBrowserGate } from "../modules/keepaSensor/keepaVerifyPolicy"
import { resolveScanClaimKind, scanJobClaimableByWorker, evaluateScanApplyMutationGate } from "../modules/amazonScan/amazonScanApplyPolicy"
import { applySyncEvent, dueAsins, openKeepaLocalDb } from "../modules/keepaSensor/keepaLocalDb"
import { KEEPA_CSV_INDEX } from "../modules/keepa/keepaPriceTypes"
import type { KeepaApiProduct } from "../modules/keepa/keepaTypes"

function product(asin: string, current: number[]): KeepaApiProduct {
  return { asin, stats: { current } }
}

function csv(partial: { amazon?: number; neu?: number; buyBox?: number; fba?: number; fbm?: number }): number[] {
  const cur = Array(40).fill(-1)
  if (partial.amazon != null) cur[KEEPA_CSV_INDEX.AMAZON] = partial.amazon
  if (partial.neu != null) cur[KEEPA_CSV_INDEX.NEW] = partial.neu
  if (partial.buyBox != null) cur[KEEPA_CSV_INDEX.BUY_BOX_SHIPPING] = partial.buyBox
  if (partial.fba != null) cur[KEEPA_CSV_INDEX.COUNT_NEW_FBA] = partial.fba
  if (partial.fbm != null) cur[KEEPA_CSV_INDEX.COUNT_NEW_FBM] = partial.fbm
  return cur
}

function payload(p: { price: number | null; healthy?: boolean; status?: string; prime?: boolean; fba?: boolean; stock?: string }) {
  return {
    displayedPrice: p.price,
    isPrime: p.prime ?? true,
    isFba: p.fba ?? true,
    stockStatus: p.stock ?? "IN_STOCK",
    captcha: false,
    timeout: false,
    metadata: { offerPageHealthy: p.healthy ?? true, publicStatus: p.status ?? "AMAZON_CHECKED" },
  }
}

// lifecycle
const shared = projectKeepaAsin({
  asin: "B0TESTASIN",
  listings: [
    { qty: 3, sold: false, live: true },
    { qty: 2, sold: false, live: true },
  ],
})!
assert.equal(shared.activeConsumerCount, 2)
assert.equal(shared.status, "ACTIVE")
const afterDetach = projectKeepaAsin({
  asin: "B0TESTASIN",
  listings: [{ qty: 3, sold: false, live: true }],
})!
assert.deepEqual(eventsFromProjectionTransition(shared, afterDetach), ["CONSUMER_DETACHED"])
const removed = projectKeepaAsin({ asin: "B0TESTASIN", listings: [] })!
assert.equal(removed.status, "REMOVED")
assert.deepEqual(eventsFromProjectionTransition(afterDetach, removed), ["ASIN_REMOVED"])
console.log("PASS lifecycle attach/detach/shared ASIN")

const paused = projectKeepaAsin({ asin: "B0TESTASIN", listings: [{ qty: 0, sold: false, live: true }] })!
assert.equal(paused.status, "PAUSED_QTY_ZERO")
assert.ok(eventsFromProjectionTransition(afterDetach, paused).includes("QTY_ZERO_PAUSED"))
const resumed = projectKeepaAsin({ asin: "B0TESTASIN", listings: [{ qty: 4, sold: false, live: true }] })!
assert.ok(eventsFromProjectionTransition(paused, resumed).includes("QTY_POSITIVE_RESUMED"))
console.log("PASS qty0 pause / qty positive resume")

const sold = projectKeepaAsin({ asin: "B0TESTASIN", listings: [{ qty: 1, sold: true, live: true }] })!
assert.equal(sold.priority, "SOLD")
assert.equal(sold.cadenceHours, 12)
const std = projectKeepaAsin({ asin: "B0TESTASIN", listings: [{ qty: 1, sold: false, live: true }] })!
assert.equal(std.priority, "STANDARD")
assert.equal(std.cadenceHours, 24)
assert.ok(eventsFromProjectionTransition(std, sold).includes("SOLD_PRIORITY_CHANGED"))
console.log("PASS sold priority 12h / standard 24h")

const tail = nextScanAtForNewAsin({ nowMs: 1_000, latestQueueMs: 5_000 })
assert.equal(tail, 6_000)
const emptyTail = nextScanAtForNewAsin({ nowMs: 1_000, latestQueueMs: null })
assert.equal(emptyTail, 1_000)
console.log("PASS new ASIN queue tail")

const first = extractKeepaMonitoredSnapshot(product("B0FLXJHGR7", csv({ amazon: 1000, buyBox: 1000, fba: 2 })))!
const second = extractKeepaMonitoredSnapshot(product("B0FLXJHGR7", csv({ amazon: 1000, neu: 980, buyBox: 1000, fba: 2 })))!
assert.equal(first.newPriceUsd, null)
assert.equal(second.newPriceUsd, 9.8)
const baseline = evaluateKeepaRead({ outcome: "OK", snapshot: first, previous: null })
assert.equal(baseline.kind, "baseline")
const changed = evaluateKeepaRead({ outcome: "OK", snapshot: second, previous: first })
assert.equal(changed.kind, "changed")
assert.ok(changed.kind === "changed" && changed.changedKeys.includes("newPriceUsd"))
const same = evaluateKeepaRead({ outcome: "OK", snapshot: second, previous: second })
assert.equal(same.kind, "unchanged")
const err = evaluateKeepaRead({ outcome: "API_ERROR", snapshot: null, previous: first })
assert.equal(err.kind, "ignored_error")
console.log("PASS first baseline / monitored diff / same snapshot / parse-error no false change")

const t1 = nextCandidateTransition({ pending: null, diff: changed, nowMs: 10 })
assert.equal(t1.action, "create")
const tDup = nextCandidateTransition({
  pending: { fingerprint: changed.kind === "changed" ? changed.fingerprint : "", status: "PENDING" },
  diff: changed,
  nowMs: 11,
})
assert.equal(tDup.action, "none")
const third = extractKeepaMonitoredSnapshot(product("B0FLXJHGR7", csv({ amazon: 1000, neu: 970, buyBox: 1000, fba: 2 })))!
const changed2 = evaluateKeepaRead({ outcome: "OK", snapshot: third, previous: second })
const tSup = nextCandidateTransition({
  pending: { fingerprint: changed.kind === "changed" ? changed.fingerprint : "x", status: "PENDING" },
  diff: changed2,
  nowMs: 12,
})
assert.equal(tSup.action, "supersede_and_create")
console.log("PASS candidate create / no duplicate / superseded")

assert.equal(applyBrowserCandidateOutcome({ status: "PENDING", browser: "INCOMPLETE" }), "RETRYABLE")
assert.equal(applyBrowserCandidateOutcome({ status: "RETRYABLE", browser: "NO_BUSINESS_CHANGE" }), "NO_BUSINESS_CHANGE")
console.log("PASS INCOMPLETE keeps retry / NO_BUSINESS_CHANGE terminal")

const now = 1_000_000
const dual = evaluateKeepaDualBrowserGate({
  primaryPayload: payload({ price: 10 }),
  confirmPayload: payload({ price: 10 }),
  primaryObservedAtMs: now - 45_000,
  confirmObservedAtMs: now - 5_000,
  nowMs: now,
  keepaBuyBoxUsd: 10,
})
assert.equal(dual.decision, "NO_BUSINESS_CHANGE")
assert.equal(dual.allowEbayMutation, false)
const match = evaluateKeepaDualBrowserGate({
  primaryPayload: payload({ price: 9.7 }),
  confirmPayload: payload({ price: 9.7 }),
  primaryObservedAtMs: now - 45_000,
  confirmObservedAtMs: now - 5_000,
  nowMs: now,
  keepaBuyBoxUsd: 10,
})
assert.equal(match.allowEbayMutation, true)
assert.equal(match.decision, "MATCHED")
const conflict = evaluateKeepaDualBrowserGate({
  primaryPayload: payload({ price: 9.7 }),
  confirmPayload: payload({ price: 10 }),
  primaryObservedAtMs: now - 45_000,
  confirmObservedAtMs: now - 5_000,
  nowMs: now,
})
assert.equal(conflict.decision, "CONFLICT")
assert.equal(conflict.allowEbayMutation, false)
const incomplete = evaluateKeepaDualBrowserGate({
  primaryPayload: payload({ price: null, healthy: false, status: "AMAZON_INCOMPLETE" }),
  confirmPayload: payload({ price: 10 }),
  primaryObservedAtMs: now - 45_000,
  confirmObservedAtMs: now - 5_000,
  nowMs: now,
})
assert.equal(incomplete.decision, "INCOMPLETE")
assert.equal(incomplete.allowEbayMutation, false)
console.log("PASS double fresh browser match / NO_BUSINESS_CHANGE / conflict/incomplete cannot mutate")

assert.equal(resolveScanClaimKind("amazon-public-browser-worker-A"), "ROUTINE")
assert.equal(resolveScanClaimKind("amazon-scan-confirm-C"), "CONFIRM")
assert.equal(resolveScanClaimKind("amazon-keepa-verify-primary-A"), "KEEPA_VERIFY_PRIMARY")
assert.equal(resolveScanClaimKind("amazon-keepa-verify-confirm-A"), "KEEPA_VERIFY_CONFIRM")
assert.equal(scanJobClaimableByWorker("amazon-public-browser-worker-A", "KEEPA_VERIFY_PRIMARY"), false)
assert.equal(scanJobClaimableByWorker("amazon-keepa-verify-primary-A", "ROUTINE"), false)
assert.equal(scanJobClaimableByWorker("amazon-scan-confirm-C", "KEEPA_VERIFY_CONFIRM"), false)
const verifySkip = evaluateScanApplyMutationGate({
  kind: "KEEPA_VERIFY_CONFIRM",
  incomplete: false,
  decisionOutcome: "VALID_SOURCE",
  fingerprintMatch: true,
  hasParent: true,
  parentObservedAtMs: now - 10_000,
  resultObservedAtMs: now - 1_000,
  nowMs: now,
  maxAgeMs: 600_000,
  mutationCandidate: true,
})
assert.equal(verifySkip.allowEbayMutation, true)
assert.equal(verifySkip.skip, null)
console.log("PASS ROUTINE/CONFIRM/KEEPA_VERIFY cross-kind isolation")

const db: DatabaseSync = openKeepaLocalDb(":memory:")
const nowMs = 10_000
applySyncEvent(db, {
  eventId: "11111111-1111-1111-1111-111111111111",
  asin: "B0B42JG5T5",
  eventType: "ASIN_UPSERT",
  sourceVersion: 1,
  payload: { activeConsumerCount: 1, status: "ACTIVE", priority: "STANDARD", cadenceHours: 24 },
  nowMs,
})
const replay = applySyncEvent(db, {
  eventId: "11111111-1111-1111-1111-111111111111",
  asin: "B0B42JG5T5",
  eventType: "ASIN_UPSERT",
  sourceVersion: 1,
  payload: { activeConsumerCount: 1, status: "ACTIVE", priority: "STANDARD", cadenceHours: 24 },
  nowMs: nowMs + 5,
})
assert.equal(replay, false)
applySyncEvent(db, {
  eventId: "22222222-2222-2222-2222-222222222222",
  asin: "B0DC61BVDS",
  eventType: "ASIN_UPSERT",
  sourceVersion: 1,
  payload: { activeConsumerCount: 1, status: "ACTIVE", priority: "STANDARD", cadenceHours: 24 },
  nowMs: nowMs + 10,
})
const a = db.prepare("SELECT next_scan_at FROM asin_registry WHERE asin='B0B42JG5T5'").get() as { next_scan_at: number }
const b = db.prepare("SELECT next_scan_at FROM asin_registry WHERE asin='B0DC61BVDS'").get() as { next_scan_at: number }
assert.ok(b.next_scan_at > a.next_scan_at)
applySyncEvent(db, {
  eventId: "33333333-3333-3333-3333-333333333333",
  asin: "B0B42JG5T5",
  eventType: "QTY_ZERO_PAUSED",
  sourceVersion: 2,
  payload: { activeConsumerCount: 0, status: "PAUSED_QTY_ZERO", priority: "STANDARD", cadenceHours: 24 },
  nowMs: nowMs + 20,
})
assert.equal(dueAsins(db, nowMs + 50_000, 10).find(r => r.asin === "B0B42JG5T5"), undefined)
console.log("PASS event replay/idempotency + paused not due")

assert.notEqual(monitoredSnapshotFingerprint(first), monitoredSnapshotFingerprint(second))
console.log("PASS keepa-sensor fixtures")
