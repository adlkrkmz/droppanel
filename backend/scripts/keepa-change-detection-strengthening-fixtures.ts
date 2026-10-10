import assert from "node:assert/strict"
import { buildGlobalKeepaProductUrl } from "../modules/globalKeepa/globalKeepaProductClient"
import {
  extractKeepaMonitoredSnapshot,
  missingKeepaMonitoredSnapshot,
  monitoredSnapshotFingerprint,
} from "../modules/keepaSensor/keepaMonitoredSnapshot"
import { diffMonitoredSnapshots, nextCandidateTransition } from "../modules/keepaSensor/keepaSnapshotDiff"
import { planKeepaCollectorObservation, type KeepaCommercialSnapshot } from "../modules/keepaSensor/keepaBaselinePanelPrice"
import { KEEPA_CSV_INDEX } from "../modules/keepa/keepaPriceTypes"

const requested = "B0G11RJS1D"
const current = Array(40).fill(-1)
current[KEEPA_CSV_INDEX.AMAZON] = 1999
current[KEEPA_CSV_INDEX.NEW] = 2099
current[KEEPA_CSV_INDEX.BUY_BOX_SHIPPING] = 2199
current[KEEPA_CSV_INDEX.COUNT_NEW_FBA] = 2
current[KEEPA_CSV_INDEX.COUNT_NEW_FBM] = 3

const complete = extractKeepaMonitoredSnapshot({
  asin: requested,
  parentAsin: "B0PARENT01",
  variationCSV: ["B0VARIANT2", "B0VARIANT1"],
  stats: { current, buyBoxIsPrimeExclusive: false },
})!
assert.equal(diffMonitoredSnapshots(complete, complete).length, 0, "A same snapshot")
for (const field of [
  "amazonPriceUsd",
  "availability",
  "newFbaCount",
  "newFbmCount",
  "buyBoxIsPrimeExclusive",
] as const) {
  const changed = { ...complete, [field]: field === "availability" ? "NO_FBA" : field === "buyBoxIsPrimeExclusive" ? true : 99 }
  assert(diffMonitoredSnapshots(complete, changed as typeof complete).includes(field), `${field} must trigger`)
}

const knownCommercial: KeepaCommercialSnapshot = {
  amazonCents: 1999, newCents: 2099, buyBoxCents: 2199, primeExclusiveCents: null,
  availability: "IN_STOCK", buyBoxIsPrimeExclusive: false, newFbaCount: 2, newFbmCount: 3,
  requestedAsin: requested, returnedAsin: requested, requestedAsinPresent: true,
  returnedAsinMismatch: false, parentAsin: "B0PARENT01", variationAsinsFingerprint: complete.variationAsinsFingerprint ?? null,
  productUnavailable: false,
}
const missing = missingKeepaMonitoredSnapshot({ requestedAsin: requested })
const missingCommercial: KeepaCommercialSnapshot = {
  amazonCents: null, newCents: null, buyBoxCents: null, primeExclusiveCents: null,
  availability: "UNKNOWN", buyBoxIsPrimeExclusive: null, newFbaCount: null, newFbmCount: null,
  requestedAsin: requested, returnedAsin: null, requestedAsinPresent: false,
  returnedAsinMismatch: false, parentAsin: null, variationAsinsFingerprint: null, productUnavailable: null,
}
const firstMissing = planKeepaCollectorObservation({ prev: knownCommercial, registryStatus: "ACTIVE", panelSourcePrice: 19.99, commercial: missingCommercial })
assert.equal(firstMissing.createCandidate, true, "G/L known to missing creates candidate")
assert.equal(firstMissing.evaluationCode, "KEEPA_REQUESTED_ASIN_MISSING")
const repeatedMissing = planKeepaCollectorObservation({ prev: missingCommercial, registryStatus: "ACTIVE", panelSourcePrice: 19.99, commercial: missingCommercial })
assert.equal(repeatedMissing.createCandidate, true, "J repeated unverified suspicious state remains plannable")
assert.equal(repeatedMissing.candidateFingerprint, firstMissing.candidateFingerprint, "H/I/Q same suspicious fingerprint dedupes")
assert.equal(nextCandidateTransition({ pending: { fingerprint: firstMissing.candidateFingerprint!, status: "PENDING" }, diff: { kind: "changed", snapshot: missing, fingerprint: firstMissing.candidateFingerprint!, changedKeys: ["requestedAsinPresent"] }, nowMs: 1 }).action, "none")

const redirected = missingKeepaMonitoredSnapshot({ requestedAsin: requested, returnedAsin: "B0H3JMWWBJ" })
assert.equal(redirected.returnedAsinMismatch, true, "M differing returned ASIN preserved")
assert(monitoredSnapshotFingerprint(redirected) !== monitoredSnapshotFingerprint(missing), "identity changes fingerprint")

const url = new URL(buildGlobalKeepaProductUrl({ apiKey: "x", domain: 1, asins: [requested] }))
assert.equal(url.searchParams.get("history"), "0")
assert.equal(url.searchParams.get("stats"), "1")
for (const forbidden of ["offers", "buybox", "stock", "update"]) assert.equal(url.searchParams.has(forbidden), false, `R no ${forbidden} request`)

console.log("PASS Keepa strengthened change detection: A-R focused planner/identity/dedupe/cost fixtures")
