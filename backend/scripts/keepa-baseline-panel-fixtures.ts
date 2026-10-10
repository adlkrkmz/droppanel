import assert from "assert"
import fs from "fs"
import path from "path"
import {
  BASELINE_PANEL_PRICE_MISSING,
  BASELINE_PRICE_CONSISTENT,
  BASELINE_PRICE_MISMATCH,
  CONFIRMED_PRICE_MISMATCH,
  confirmedPriceMismatchFingerprint,
  evaluateKeepaBaselinePanelPrice,
  keepaBaselineMismatchFingerprint,
  planKeepaCollectorObservation,
} from "../modules/keepaSensor/keepaBaselinePanelPrice"
import { shouldEnqueueKeepaVerifyPrimary } from "../modules/keepaSensor/keepaVerifyChainPolicy"
import { shouldEnqueueOxylabsConfirm } from "../modules/oxylabsVerify/oxylabsProductDecision"
import { loadOxylabsVerifyConfig } from "../modules/oxylabsVerify/oxylabsVerifyConfig"
import { resolveOxylabsVerifyClaimKind } from "../modules/oxylabsVerify/oxylabsVerifyKinds"

const commercial = {
  amazonCents: 1999,
  newCents: 2100,
  buyBoxCents: 1999,
  primeExclusiveCents: null as number | null,
  availability: "IN_STOCK",
  buyBoxIsPrimeExclusive: true as boolean | null,
  newFbaCount: 2,
  newFbmCount: 1,
}

// 1. No prev, panel matches New → baseline, job 0
{
  const p = planKeepaCollectorObservation({
    prev: null,
    registryStatus: "ACTIVE",
    panelSourcePrice: 21.0,
    commercial,
  })
  assert.equal(p.trigger, "baseline")
  assert.equal(p.evaluationCode, BASELINE_PRICE_CONSISTENT)
  assert.equal(p.createCandidate, false)
  assert.equal(p.enqueuePrimary, false)
}

// 2. Panel matches Amazon ±1 cent → job 0
{
  const p = planKeepaCollectorObservation({
    prev: null,
    registryStatus: "ACTIVE",
    panelSourcePrice: 20.0,
    commercial,
  })
  assert.equal(p.evaluationCode, BASELINE_PRICE_CONSISTENT)
  assert.equal(p.enqueuePrimary, false)
  const d = evaluateKeepaBaselinePanelPrice({ panelSourcePrice: 19.98, keepaPrices: commercial })
  assert.equal(d.code, BASELINE_PRICE_CONSISTENT)
}

// 3. Panel in no positive Keepa price → one PRIMARY
{
  const p = planKeepaCollectorObservation({
    prev: null,
    registryStatus: "ACTIVE",
    panelSourcePrice: 67.99,
    commercial,
  })
  assert.equal(p.evaluationCode, BASELINE_PRICE_MISMATCH)
  assert.equal(p.createCandidate, true)
  assert.equal(p.enqueuePrimary, true)
  assert.ok(p.candidateFingerprint)
  assert.equal(shouldEnqueueKeepaVerifyPrimary(p.evaluationCode), true)
}

// 4. A repeated unresolved confirmed mismatch has a stable fingerprint; database
// uniqueness prevents a second candidate/job.
{
  const a = planKeepaCollectorObservation({
    prev: null,
    registryStatus: "ACTIVE",
    panelSourcePrice: 67.99,
    commercial,
  })
  const b = planKeepaCollectorObservation({
    prev: null,
    registryStatus: "ACTIVE",
    panelSourcePrice: 67.99,
    commercial,
  })
  assert.equal(a.candidateFingerprint, b.candidateFingerprint)
  assert.equal(
    keepaBaselineMismatchFingerprint({ panelCents: 6799, keepaPrices: commercial }),
    a.candidateFingerprint
  )
  const replayAfterStore = planKeepaCollectorObservation({
    prev: commercial,
    registryStatus: "ACTIVE",
    panelSourcePrice: 67.99,
    commercial,
  })
  assert.equal(replayAfterStore.trigger, "unchanged")
  assert.equal(replayAfterStore.evaluationCode, CONFIRMED_PRICE_MISMATCH)
  assert.equal(replayAfterStore.candidateFingerprint, confirmedPriceMismatchFingerprint({ panelCents: [6799], keepaPrices: commercial }))
}

// 5. Panel price missing → job 0
{
  const p = planKeepaCollectorObservation({
    prev: null,
    registryStatus: "ACTIVE",
    panelSourcePrice: null,
    commercial,
  })
  assert.equal(p.evaluationCode, BASELINE_PANEL_PRICE_MISSING)
  assert.equal(p.enqueuePrimary, false)
  assert.equal(shouldEnqueueKeepaVerifyPrimary(p.evaluationCode), false)
}

// 6. Keepa prices only null/0/-1/-2, panel valid → one PRIMARY
{
  const empty = {
    ...commercial,
    amazonCents: null,
    newCents: 0,
    buyBoxCents: -1,
    primeExclusiveCents: -2,
  }
  const p = planKeepaCollectorObservation({
    prev: null,
    registryStatus: "ACTIVE",
    panelSourcePrice: 12.5,
    commercial: empty,
  })
  assert.equal(p.evaluationCode, BASELINE_PRICE_MISMATCH)
  assert.equal(p.enqueuePrimary, true)
}

// 7. B0F5PSJSTT: collector stable at $7.59 but confirmed source is $3.79.
// It must request verification, without treating Keepa as an authoritative write.
{
  const p = planKeepaCollectorObservation({
    prev: { ...commercial, amazonCents: null, newCents: 759 },
    registryStatus: "ACTIVE",
    panelSourcePrice: 3.79,
    panelSourcePrices: [3.79],
    commercial: { ...commercial, amazonCents: null, newCents: 759 },
  })
  assert.equal(p.trigger, "unchanged")
  assert.equal(p.evaluationCode, CONFIRMED_PRICE_MISMATCH)
  assert.equal(p.createCandidate, true)
  assert.equal(p.enqueuePrimary, true)
  assert.equal(shouldEnqueueKeepaVerifyPrimary(p.evaluationCode), true)
}

// 8. Same collector and same confirmed source stay quiet; ±1 cent is tolerated.
{
  const stable = { ...commercial, amazonCents: null, newCents: 759 }
  for (const price of [7.59, 7.58, 7.6]) {
    const p = planKeepaCollectorObservation({
      prev: stable,
      registryStatus: "ACTIVE",
      panelSourcePrice: price,
      panelSourcePrices: [price],
      commercial: stable,
    })
    assert.equal(p.evaluationCode, "PRICE_CONSISTENT")
    assert.equal(p.createCandidate, false)
  }
}

// 9. A stale consumer cannot be masked by another matching consumer.
{
  const stable = { ...commercial, amazonCents: null, newCents: 759 }
  const p = planKeepaCollectorObservation({
    prev: stable,
    registryStatus: "ACTIVE",
    panelSourcePrice: 7.59,
    panelSourcePrices: [7.59, 3.79],
    commercial: stable,
  })
  assert.equal(p.evaluationCode, CONFIRMED_PRICE_MISMATCH)
  assert.equal(p.createCandidate, true)
}

// 10. Same unresolved mismatch is fingerprint-dedupable.
{
  const stable = { ...commercial, amazonCents: null, newCents: 759 }
  const a = planKeepaCollectorObservation({ prev: stable, registryStatus: "ACTIVE", panelSourcePrice: 3.79, panelSourcePrices: [3.79], commercial: stable })
  const b = planKeepaCollectorObservation({ prev: stable, registryStatus: "ACTIVE", panelSourcePrice: 3.79, panelSourcePrices: [3.79], commercial: stable })
  assert.equal(a.candidateFingerprint, b.candidateFingerprint)
}

// 11. Prev exists, snapshot changed → existing diff path
{
  const p = planKeepaCollectorObservation({
    prev: commercial,
    registryStatus: "ACTIVE",
    panelSourcePrice: 19.99,
    commercial: { ...commercial, amazonCents: 2500, buyBoxCents: 2500 },
  })
  assert.equal(p.trigger, "changed")
  assert.equal(p.evaluationCode, "KEEPA_SNAPSHOT_CHANGED")
  assert.equal(p.createCandidate, true)
  assert.equal(p.enqueuePrimary, true)
  assert.equal(shouldEnqueueKeepaVerifyPrimary("KEEPA_SNAPSHOT_CHANGED"), true)
}

// 9. CONFIRM 0
assert.equal(shouldEnqueueOxylabsConfirm(), false)
assert.equal(resolveOxylabsVerifyClaimKind("oxylabs-product-confirm-C"), null)

// 10. Mutations/eBay 0
process.env.OXYLABS_VERIFY_MUTATIONS_ENABLED = "false"
assert.equal(loadOxylabsVerifyConfig().mutationsEnabled, false)

const persistSrc = fs.readFileSync(path.join(__dirname, "../modules/keepaSensor/keepaObservationEvaluate.ts"), "utf8")
assert.doesNotMatch(persistSrc, /OXYLABS_PRODUCT_CONFIRM/)
assert.doesNotMatch(persistSrc, /amazon_pricing/)
assert.match(persistSrc, /observed_at <= EXCLUDED\.observed_at/)
const collectorSrc = fs.readFileSync(path.join(__dirname, "../modules/keepaSensor/keepaCollectorLoop.ts"), "utf8")
assert.match(collectorSrc, /updateKeepaTokenSampleParsed\(db, nowMs, parsed\)/)
const chainSrc = fs.readFileSync(path.join(__dirname, "../modules/oxylabsVerify/oxylabsVerifyChain.ts"), "utf8")
assert.match(chainSrc, /BASELINE_PRICE_MISMATCH/)
assert.doesNotMatch(chainSrc, /kind:\s*OXYLABS_PRODUCT_CONFIRM/)

console.log("PASS keepa baseline panel fixtures")
