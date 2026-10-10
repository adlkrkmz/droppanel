import assert from "assert"
import {
  evaluateKeepaTrustedEvidence,
  observationPayloadHasForbiddenFields,
  snapshotToKeepaEvidence,
  trustedReferenceFingerprint,
  trustedFromBrowserVerificationRow,
  usdToPositiveCents,
  type NormalizedKeepaEvidence,
  type TrustedAmazonReference,
} from "../modules/keepaSensor/keepaEvidencePolicy"
import {
  applySyncEvent,
  localReconcileManifest,
  openKeepaLocalDb,
  pendingObservationCount,
  setWorkerState,
} from "../modules/keepaSensor/keepaLocalDb"
import { loadKeepaCollectorConfig, scanDueAsins } from "../modules/keepaSensor/keepaCollectorLoop"
import { KEEPA_COLLECTOR_VERSION } from "../modules/keepaSensor/keepaCollectorVersion"
import { KEEPA_CSV_INDEX } from "../modules/keepa/keepaPriceTypes"
import type { KeepaApiProduct } from "../modules/keepa/keepaTypes"
import type { KeepaMonitoredSnapshot } from "../modules/keepaSensor/keepaMonitoredSnapshot"
import { keepaDirectMutationsEnabled } from "../modules/keepaSensor/keepaDirectMutationGate"

const ASIN = "B0KEEPAS01"

function evidence(partial: Partial<NormalizedKeepaEvidence> & { requestedAsin?: string }): NormalizedKeepaEvidence {
  return {
    requestedAsin: partial.requestedAsin ?? ASIN,
    returnedAsin: partial.returnedAsin === undefined ? ASIN : partial.returnedAsin,
    amazonCents: partial.amazonCents ?? null,
    newCents: partial.newCents ?? null,
    buyBoxCents: partial.buyBoxCents ?? null,
    primeExclusiveCents: partial.primeExclusiveCents ?? null,
    availability: partial.availability ?? "IN_STOCK",
    buyBoxIsPrimeExclusive: partial.buyBoxIsPrimeExclusive ?? false,
    newFbaCount: partial.newFbaCount ?? 2,
    newFbmCount: partial.newFbmCount ?? 1,
  }
}

function trusted(partial: Partial<TrustedAmazonReference> = {}): TrustedAmazonReference {
  const asin = partial.asin ?? ASIN
  const priceCents = partial.priceCents === undefined ? 1000 : partial.priceCents
  const inStock = partial.inStock === undefined ? true : partial.inStock
  const primeOrFba = partial.primeOrFba === undefined ? true : partial.primeOrFba
  const verifiedAt = partial.verifiedAt ?? "2026-09-21T12:00:00.000Z"
  return {
    asin,
    priceCents,
    inStock,
    primeOrFba,
    verifiedAt,
    fingerprint:
      partial.fingerprint ??
      trustedReferenceFingerprint({
        asin,
        priceCents,
        inStock,
        primeOrFba,
        verifiedAt,
        sourceId: "task-1",
      }),
  }
}

function decide(
  ev: NormalizedKeepaEvidence,
  ref: TrustedAmazonReference | null,
  registryStatus: "ACTIVE" | "PAUSED_QTY_ZERO" | "REMOVED" | null = "ACTIVE"
) {
  return evaluateKeepaTrustedEvidence({ evidence: ev, trusted: ref, registryStatus })
}

function product(asin: string, current: number[]): KeepaApiProduct {
  return { asin, stats: { current, buyBoxIsPrimeExclusive: false } }
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

function seedComplete(db: ReturnType<typeof openKeepaLocalDb>, asin: string, nowMs: number) {
  applySyncEvent(
    db,
    {
      eventId: "00000000-0000-4000-8000-000000000001",
      asin,
      eventType: "ASIN_UPSERT",
      sourceVersion: 1,
      payload: { status: "ACTIVE", activeConsumerCount: 1, priority: "STANDARD", cadenceHours: 24 },
      nowMs,
    },
    { remoteAckStatus: "ACKED_REMOTE" }
  )
  setWorkerState(db, "bootstrap_status", "COMPLETE")
  setWorkerState(db, "bootstrap_phase", "COMPLETE")
  setWorkerState(db, "central_reconcile_hash", localReconcileManifest(db).hash)
  setWorkerState(db, "central_reconcile_count", String(localReconcileManifest(db).uniqueAsins))
}

async function main(): Promise<void> {
  assert.equal(KEEPA_COLLECTOR_VERSION, "1.0.8")
  assert.equal(usdToPositiveCents(-1), null)
  assert.equal(usdToPositiveCents(-2), null)
  assert.equal(usdToPositiveCents(0), null)
  assert.equal(usdToPositiveCents(10), 1000)

  const inNew = decide(evidence({ amazonCents: 1100, newCents: 1000, buyBoxCents: 1200 }), trusted())
  assert.equal(inNew.code, "PRICE_CONSISTENT")
  assert.equal(inNew.createCandidate, false)
  console.log("PASS trusted price in Keepa New → candidate 0")

  const inAmazon = decide(evidence({ amazonCents: 1000, newCents: 1400 }), trusted())
  assert.equal(inAmazon.code, "PRICE_CONSISTENT")
  assert.equal(inAmazon.createCandidate, false)
  console.log("PASS trusted price in Keepa Amazon → candidate 0")

  const otherField = decide(
    evidence({ amazonCents: 1100, newCents: 1000, buyBoxCents: 1555, newFbmCount: 9, newFbaCount: 4 }),
    trusted()
  )
  assert.equal(otherField.code, "PRICE_CONSISTENT")
  assert.equal(otherField.createCandidate, false)
  console.log("PASS other Keepa price field changed, trusted still present → candidate 0")

  const mismatch = decide(evidence({ amazonCents: 1100, newCents: 1200, buyBoxCents: 1300 }), trusted({ priceCents: 1000 }))
  assert.equal(mismatch.code, "PRICE_EVIDENCE_MISMATCH")
  assert.equal(mismatch.createCandidate, true)
  console.log("PASS trusted price absent → PRICE_EVIDENCE_MISMATCH")

  const replay = decide(evidence({ amazonCents: 1100, newCents: 1200, buyBoxCents: 1300 }), trusted({ priceCents: 1000 }))
  assert.equal(replay.candidateFingerprint, mismatch.candidateFingerprint)
  assert.equal(replay.createCandidate, true)
  console.log("PASS same observation replay same candidate fingerprint")

  const fbaCountOnly = decide(evidence({ amazonCents: 1000, newFbaCount: 7, newFbmCount: 3 }), trusted())
  assert.equal(fbaCountOnly.createCandidate, false)
  assert.equal(fbaCountOnly.code, "PRICE_CONSISTENT")
  console.log("PASS FBA/FBM count change → candidate 0")

  const unknown = decide(
    evidence({
      amazonCents: null,
      newCents: null,
      buyBoxCents: null,
      primeExclusiveCents: null,
      availability: "UNKNOWN",
      newFbaCount: null,
      buyBoxIsPrimeExclusive: null,
    }),
    trusted()
  )
  assert.equal(unknown.createCandidate, false)
  assert.notEqual(unknown.code, "STOCK_RISK")
  assert.notEqual(unknown.code, "PRIME_RISK")
  console.log("PASS UNKNOWN/null Keepa → candidate 0")

  const stock = decide(
    evidence({
      amazonCents: null,
      newCents: null,
      buyBoxCents: null,
      primeExclusiveCents: null,
      availability: "NO_FBA",
      newFbaCount: 0,
    }),
    trusted({ inStock: true })
  )
  assert.equal(stock.code, "STOCK_RISK")
  assert.equal(stock.createCandidate, true)
  console.log("PASS definite stock loss → STOCK_RISK")

  const prime = decide(
    evidence({
      amazonCents: null,
      newCents: 9999,
      primeExclusiveCents: null,
      newFbaCount: 0,
      buyBoxIsPrimeExclusive: false,
    }),
    trusted({ primeOrFba: true, priceCents: 9999 })
  )
  assert.equal(prime.code, "PRIME_RISK")
  assert.equal(prime.createCandidate, true)
  console.log("PASS definite Prime/FBA loss → PRIME_RISK")

  const identity = decide(evidence({ requestedAsin: ASIN, returnedAsin: "B0KEEPAS02", amazonCents: 1000 }), trusted())
  assert.equal(identity.code, "ASIN_IDENTITY_MISMATCH")
  assert.equal(identity.createCandidate, true)
  console.log("PASS requested/returned ASIN mismatch → ASIN_IDENTITY_MISMATCH")

  const noTrusted = decide(evidence({ amazonCents: 1100 }), null)
  assert.equal(noTrusted.code, "NO_TRUSTED_REFERENCE")
  assert.equal(noTrusted.createCandidate, false)
  console.log("PASS no trusted reference → baseline, candidate 0")

  const qty0 = decide(evidence({ amazonCents: 1100, returnedAsin: "B0KEEPAS02" }), trusted(), "PAUSED_QTY_ZERO")
  assert.equal(qty0.code, "SKIP_DETACHED_OR_QTY_ZERO")
  assert.equal(qty0.createCandidate, false)
  const detached = decide(evidence({ amazonCents: 1100 }), trusted(), "REMOVED")
  assert.equal(detached.createCandidate, false)
  console.log("PASS qty=0/detached → candidate 0")

  assert.equal(inNew.ebayMutationCalls, 0)
  assert.equal(mismatch.ebayMutationCalls, 0)
  assert.equal(mismatch.mutation, false)
  console.log("PASS Keepa observation evaluation ebay mutation calls 0")

  const snap: KeepaMonitoredSnapshot = {
    asin: ASIN,
    buyBoxPriceUsd: 12.34,
    newPriceUsd: 10,
    amazonPriceUsd: 11,
    newFbaCount: 2,
    newFbmCount: 1,
    primeExclusivePriceUsd: null,
    buyBoxIsPrimeExclusive: false,
    buyBoxSellerId: "SELLER",
    availability: "IN_STOCK",
  }
  const fromSnap = snapshotToKeepaEvidence(ASIN, snap)
  assert.equal(fromSnap.newCents, 1000)
  assert.equal(fromSnap.amazonCents, 1100)
  assert.equal(fromSnap.buyBoxCents, 1234)

  const keepaConfirmedNotTrusted = trustedFromBrowserVerificationRow({
    id: "1",
    asin: ASIN,
    resultPrice: "10.00",
    resultIsPrime: true,
    resultIsFba: true,
    resultShipsFromAmazon: true,
    resultPurchasable: "TRUE",
    completedAt: "2026-09-21T12:00:00.000Z",
    lastVerifiedAsin: ASIN,
    lastVerifiedDecision: "UNKNOWN",
  })
  assert.equal(keepaConfirmedNotTrusted, null)
  const incomplete = trustedFromBrowserVerificationRow({
    id: "1",
    asin: ASIN,
    resultPrice: "10.00",
    resultIsPrime: true,
    resultIsFba: true,
    resultShipsFromAmazon: true,
    resultPurchasable: "UNKNOWN",
    completedAt: "2026-09-21T12:00:00.000Z",
    lastVerifiedAsin: ASIN,
    lastVerifiedDecision: "VALID_SOURCE",
  })
  assert.equal(incomplete, null)
  const movedAsin = trustedFromBrowserVerificationRow({
    id: "1",
    asin: ASIN,
    resultPrice: "10.00",
    resultIsPrime: true,
    resultIsFba: true,
    resultShipsFromAmazon: true,
    resultPurchasable: "TRUE",
    completedAt: "2026-09-21T12:00:00.000Z",
    lastVerifiedAsin: "B0KEEPAS02",
    lastVerifiedDecision: "VALID_SOURCE",
  })
  assert.equal(movedAsin, null)
  console.log("PASS Keepa/UNKNOWN/moved ASIN not trusted")

  assert.equal(observationPayloadHasForbiddenFields({ requestedAsin: ASIN }), false)
  assert.equal(observationPayloadHasForbiddenFields({ asin: ASIN }), true)
  assert.equal(observationPayloadHasForbiddenFields({ apiKey: "x" }), true)

  const cfg = loadKeepaCollectorConfig({
    KEEPA_COLLECTOR_ENABLED: "true",
    KEEPA_ENABLED: "true",
    KEEPA_COLLECTOR_RUN_MODE: "once",
    LISTJETGO_API_BASE: "http://local",
    KEEPA_COLLECTOR_WORKER_TOKEN: "t".repeat(32),
    KEEPA_API_KEY: "k",
  })
  const db = openKeepaLocalDb(":memory:")
  seedComplete(db, ASIN, 1)
  const okBody = {
    ok: true as const,
    status: 200,
    durationMs: 5,
    body: {
      tokensLeft: 100,
      refillRate: 20,
      refillIn: 1,
      tokensConsumed: 1,
      tokenFlowReduction: 0,
      processingTimeInMs: 5,
      products: [product(ASIN, csv({ amazon: 1000, buyBox: 1000, fba: 2 }))],
    },
  }
  let keepaCalls = 0
  const first = await scanDueAsins(cfg, db, {
    nowMs: 2,
    jitterMs: 0,
    keepaFetch: async () => {
      keepaCalls++
      return okBody
    },
    http: {
      getJson: async () => ({ status: 500, json: {} }),
      postJson: async () => ({ status: 503, json: { ok: false } }),
    },
  })
  assert.equal(first.keepaCalls, 1)
  assert.equal(keepaCalls, 1)
  assert.equal(pendingObservationCount(db), 1)
  db.prepare("UPDATE asin_registry SET last_scanned_at = ?, next_scan_at = ? WHERE asin = ?").run(2, 9_000_000_000, ASIN)
  keepaCalls = 0
  const retry = await scanDueAsins(cfg, db, {
    nowMs: 3,
    jitterMs: 0,
    keepaFetch: async () => {
      keepaCalls++
      throw new Error("must-not-call-keepa")
    },
    http: {
      getJson: async () => ({ status: 500, json: {} }),
      postJson: async (_path, body) => {
        assert.equal(observationPayloadHasForbiddenFields(body ?? {}), false)
        assert.equal(Object.prototype.hasOwnProperty.call(body ?? {}, "asin"), false)
        return { status: 200, json: { ok: true } }
      },
    },
  })
  assert.equal(keepaCalls, 0)
  assert.equal(retry.keepaCalls, 0)
  assert.equal(pendingObservationCount(db), 0)
  console.log("PASS network retry delivers observation without Keepa")

  assert.equal(keepaDirectMutationsEnabled("false"), false)
  assert.equal(keepaDirectMutationsEnabled(""), false)
  assert.equal(keepaDirectMutationsEnabled(undefined), false)
  console.log("PASS KEEPA_DIRECT_MUTATIONS_ENABLED fail-closed")

  console.log("PASS keepa-collector 1.0.8 fixtures")
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})
