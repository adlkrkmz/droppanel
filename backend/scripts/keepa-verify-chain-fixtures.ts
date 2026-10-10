import assert from "assert"
import "dotenv/config"
import {
  evaluateScanApplyMutationGate,
  resolveScanClaimKind,
  scanJobClaimableByWorker,
} from "../modules/amazonScan/amazonScanApplyPolicy"
import {
  amazonKeepaVerifyConfirmWorkerId,
  amazonKeepaVerifyPrimaryWorkerId,
  amazonScanConfirmWorkerId,
  amazonScanWorkerIdForRole,
  publicWorkerClaimId,
} from "../modules/amazonPublicWorker/amazonPublicWorkerPool"
import { evaluateKeepaTrustedEvidence, type NormalizedKeepaEvidence } from "../modules/keepaSensor/keepaEvidencePolicy"
import {
  decideKeepaVerifyFollowUp,
  keepaVerifyCandidatePurpose,
  keepaVerifyConfirmPersistMode,
  keepaVerifyPrimaryEnqueueSkip,
  keepaVerifyPrimaryEnqueueSlots,
  KEEPA_TRUSTED_BASELINE_PURPOSE,
  shouldEnqueueKeepaVerifyPrimary,
} from "../modules/keepaSensor/keepaVerifyChainPolicy"
import { classifyConfirmationSource, evaluateKeepaDirectMutationGate } from "../modules/keepaSensor/keepaDirectMutationGate"
import { classifySourceApplyGuard } from "../modules/globalKeepa/sourceAsinLifecycle"
import * as ebayPrice from "../modules/listings/listingsEbayPriceService"
import * as ebayZero from "../modules/stockAlerts/stockAlertsEbayZeroService"

let ebayPriceInvocations = 0
let ebayZeroInvocations = 0
const origPrice = ebayPrice.updateListingPriceOnEbay
const origZero = ebayZero.zeroListingQuantityOnEbay
;(ebayPrice as { updateListingPriceOnEbay: typeof origPrice }).updateListingPriceOnEbay = (async () => {
  ebayPriceInvocations += 1
  throw new Error("ebay price mock must not be reached")
}) as typeof origPrice
;(ebayZero as { zeroListingQuantityOnEbay: typeof origZero }).zeroListingQuantityOnEbay = (async () => {
  ebayZeroInvocations += 1
  throw new Error("ebay zero mock must not be reached")
}) as typeof origZero

function ebayTotal(): number {
  return ebayPriceInvocations + ebayZeroInvocations
}

const evidence = (over: Partial<NormalizedKeepaEvidence> = {}): NormalizedKeepaEvidence => ({
  requestedAsin: "B0TESTASIN",
  returnedAsin: "B0TESTASIN",
  amazonCents: 1000,
  newCents: 1000,
  buyBoxCents: 1000,
  primeExclusiveCents: null,
  availability: "IN_STOCK",
  buyBoxIsPrimeExclusive: true,
  newFbaCount: 2,
  newFbmCount: 1,
  ...over,
})

const trusted = {
  asin: "B0TESTASIN",
  priceCents: 1000,
  inStock: true,
  primeOrFba: true,
  verifiedAt: "2026-09-22T00:00:00.000Z",
  fingerprint: "trusted-fp",
}

assert.equal(shouldEnqueueKeepaVerifyPrimary("PRICE_EVIDENCE_MISMATCH"), true)
assert.equal(shouldEnqueueKeepaVerifyPrimary("STOCK_RISK"), true)
assert.equal(shouldEnqueueKeepaVerifyPrimary("PRIME_RISK"), true)
assert.equal(shouldEnqueueKeepaVerifyPrimary("ASIN_IDENTITY_MISMATCH"), true)
assert.equal(shouldEnqueueKeepaVerifyPrimary("NO_TRUSTED_REFERENCE"), true)
assert.equal(shouldEnqueueKeepaVerifyPrimary("PRICE_CONSISTENT"), false)
assert.equal(shouldEnqueueKeepaVerifyPrimary("UNKNOWN"), false)
assert.equal(shouldEnqueueKeepaVerifyPrimary(null), false)
assert.equal(shouldEnqueueKeepaVerifyPrimary(""), false)

const priceMismatch = evaluateKeepaTrustedEvidence({
  evidence: evidence({ amazonCents: 777, newCents: 777, buyBoxCents: 777 }),
  trusted,
  registryStatus: "ACTIVE",
})
assert.equal(priceMismatch.code, "PRICE_EVIDENCE_MISMATCH")
assert.equal(priceMismatch.createCandidate, true)
assert.equal(
  keepaVerifyPrimaryEnqueueSkip({
    enqueueEnabled: true,
    evaluationCode: priceMismatch.code,
    candidateStatus: "PENDING",
    existingPrimary: false,
    activeJob: false,
  }),
  null
)
assert.equal(
  keepaVerifyPrimaryEnqueueSkip({
    enqueueEnabled: true,
    evaluationCode: priceMismatch.code,
    candidateStatus: "PENDING",
    existingPrimary: true,
    activeJob: false,
  }),
  "PRIMARY_EXISTS"
)
console.log("PASS PRICE mismatch → tek PRIMARY / replay duplicate yok")

const consistent = evaluateKeepaTrustedEvidence({
  evidence: evidence(),
  trusted,
  registryStatus: "ACTIVE",
})
assert.equal(consistent.code, "PRICE_CONSISTENT")
assert.equal(consistent.createCandidate, false)
assert.equal(
  keepaVerifyPrimaryEnqueueSkip({
    enqueueEnabled: true,
    evaluationCode: consistent.code,
    candidateStatus: "PENDING",
    existingPrimary: false,
    activeJob: false,
  }),
  "CODE_NOT_PRIMARY"
)

const noTrusted = evaluateKeepaTrustedEvidence({
  evidence: evidence(),
  trusted: null,
  registryStatus: "ACTIVE",
})
assert.equal(noTrusted.code, "NO_TRUSTED_REFERENCE")
assert.equal(noTrusted.createCandidate, true)
assert.equal(shouldEnqueueKeepaVerifyPrimary(noTrusted.code), true)
assert.equal(keepaVerifyCandidatePurpose(noTrusted.code), KEEPA_TRUSTED_BASELINE_PURPOSE)
assert.equal(keepaVerifyCandidatePurpose("PRICE_EVIDENCE_MISMATCH"), "VERIFY")
assert.equal(keepaVerifyPrimaryEnqueueSlots(0), 50)
assert.equal(keepaVerifyPrimaryEnqueueSlots(50), 0)
assert.equal(keepaVerifyPrimaryEnqueueSlots(37), 13)
assert.equal(
  keepaVerifyConfirmPersistMode({
    purpose: KEEPA_TRUSTED_BASELINE_PURPOSE,
    gateSkip: null,
    allowEbayMutation: true,
    persistObservationOnly: false,
  }),
  "trusted_baseline"
)
assert.equal(
  keepaVerifyConfirmPersistMode({
    purpose: "VERIFY",
    gateSkip: null,
    allowEbayMutation: true,
    persistObservationOnly: false,
  }),
  "ebay_apply"
)
assert.equal(
  keepaVerifyConfirmPersistMode({
    purpose: KEEPA_TRUSTED_BASELINE_PURPOSE,
    gateSkip: "CONFIRM_CONFLICT",
    allowEbayMutation: true,
    persistObservationOnly: false,
  }),
  "none"
)
assert.equal(
  keepaVerifyConfirmPersistMode({
    purpose: KEEPA_TRUSTED_BASELINE_PURPOSE,
    gateSkip: "INCOMPLETE_NO_MUTATION",
    allowEbayMutation: false,
    persistObservationOnly: false,
  }),
  "none"
)
assert.equal(
  keepaVerifyPrimaryEnqueueSkip({
    enqueueEnabled: true,
    evaluationCode: "NO_TRUSTED_REFERENCE",
    candidateStatus: "PENDING",
    existingPrimary: false,
    activeJob: false,
    trustedBaselineAlreadyExists: true,
  }),
  "TRUSTED_BASELINE_EXISTS"
)
assert.equal(
  keepaVerifyPrimaryEnqueueSkip({
    enqueueEnabled: true,
    evaluationCode: "PRICE_EVIDENCE_MISMATCH",
    candidateStatus: "PENDING",
    existingPrimary: false,
    activeJob: false,
    duplicateAsinActive: true,
  }),
  "DUPLICATE_ASIN"
)
console.log("PASS NO_TRUSTED → TRUSTED_BASELINE candidate / cap 50 / mutation 0")

const countOnly = evaluateKeepaTrustedEvidence({
  evidence: evidence({ newFbaCount: 9, newFbmCount: 8 }),
  trusted,
  registryStatus: "ACTIVE",
})
assert.equal(countOnly.createCandidate, false)
assert.equal(shouldEnqueueKeepaVerifyPrimary(countOnly.code), false)
assert.equal(
  keepaVerifyPrimaryEnqueueSkip({
    enqueueEnabled: true,
    evaluationCode: "UNKNOWN",
    candidateStatus: "PENDING",
    existingPrimary: false,
    activeJob: false,
  }),
  "CODE_NOT_PRIMARY"
)
assert.equal(
  keepaVerifyPrimaryEnqueueSkip({
    enqueueEnabled: false,
    evaluationCode: "PRICE_EVIDENCE_MISMATCH",
    candidateStatus: "PENDING",
    existingPrimary: false,
    activeJob: false,
  }),
  "KEEPA_VERIFY_ENQUEUE_DISABLED"
)
console.log("PASS consistent/no-trusted/UNKNOWN/count-only → job 0")

const slotA = amazonScanWorkerIdForRole("KEEPA_VERIFY_PRIMARY", "A")
const slotC = amazonScanWorkerIdForRole("KEEPA_VERIFY_CONFIRM", "C")
assert.equal(slotA, amazonKeepaVerifyPrimaryWorkerId("A"))
assert.equal(slotC, amazonKeepaVerifyConfirmWorkerId("C"))
assert.equal(resolveScanClaimKind(slotA), "KEEPA_VERIFY_PRIMARY")
assert.equal(resolveScanClaimKind(slotC), "KEEPA_VERIFY_CONFIRM")
assert.equal(scanJobClaimableByWorker(slotA, "KEEPA_VERIFY_PRIMARY"), true)
assert.equal(scanJobClaimableByWorker(slotA, "KEEPA_VERIFY_CONFIRM"), false)
assert.equal(scanJobClaimableByWorker(slotA, "ROUTINE"), false)
assert.equal(scanJobClaimableByWorker(slotC, "KEEPA_VERIFY_CONFIRM"), true)
assert.equal(scanJobClaimableByWorker(slotC, "KEEPA_VERIFY_PRIMARY"), false)
assert.equal(scanJobClaimableByWorker(slotC, "ROUTINE"), false)
assert.equal(scanJobClaimableByWorker(publicWorkerClaimId("A"), "KEEPA_VERIFY_PRIMARY"), false)
assert.equal(scanJobClaimableByWorker(publicWorkerClaimId("A"), "KEEPA_VERIFY_CONFIRM"), false)
assert.equal(scanJobClaimableByWorker(amazonScanConfirmWorkerId("C"), "KEEPA_VERIFY_PRIMARY"), false)
assert.equal(scanJobClaimableByWorker("unknown-worker", "KEEPA_VERIFY_PRIMARY"), false)
assert.equal(resolveScanClaimKind("unknown-worker"), null)
console.log("PASS A yalnız PRIMARY / C yalnız CONFIRM / cross-kind claim 0")

const primaryValid = decideKeepaVerifyFollowUp({
  kind: "KEEPA_VERIFY_PRIMARY",
  incomplete: false,
  decisionOutcome: "VALID_SOURCE",
  fingerprintMatch: false,
  freshnessSkip: null,
})
assert.equal(primaryValid.enqueueConfirm, true)
assert.equal(primaryValid.applyBrowser, false)
const primaryIncomplete = decideKeepaVerifyFollowUp({
  kind: "KEEPA_VERIFY_PRIMARY",
  incomplete: true,
  decisionOutcome: "VALID_SOURCE",
  fingerprintMatch: false,
  freshnessSkip: null,
})
assert.equal(primaryIncomplete.enqueueConfirm, false)
assert.equal(primaryIncomplete.applyBrowser, false)
const now = Date.now()
assert.equal(
  evaluateScanApplyMutationGate({
    kind: "KEEPA_VERIFY_PRIMARY",
    incomplete: false,
    decisionOutcome: "VALID_SOURCE",
    fingerprintMatch: true,
    hasParent: false,
    parentObservedAtMs: null,
    resultObservedAtMs: now,
    nowMs: now,
    maxAgeMs: 600_000,
    mutationCandidate: true,
  }).allowEbayMutation,
  false
)
console.log("PASS PRIMARY VALID → tek CONFIRM / INCOMPLETE → CONFIRM/mutation 0")

const confirmMatch = evaluateScanApplyMutationGate({
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
assert.equal(confirmMatch.allowEbayMutation, true)
assert.equal(confirmMatch.skip, null)
assert.equal(classifyConfirmationSource("SERVER_BROWSER_PUBLIC"), "browser_confirmed")
const confirmFollow = decideKeepaVerifyFollowUp({
  kind: "KEEPA_VERIFY_CONFIRM",
  incomplete: false,
  decisionOutcome: "VALID_SOURCE",
  fingerprintMatch: true,
  freshnessSkip: null,
})
assert.equal(confirmFollow.applyBrowser, true)
const replay = decideKeepaVerifyFollowUp({
  kind: "KEEPA_VERIFY_CONFIRM",
  incomplete: false,
  decisionOutcome: "VALID_SOURCE",
  fingerprintMatch: true,
  freshnessSkip: null,
  alreadyApplied: true,
})
assert.equal(replay.applyBrowser, false)
assert.equal(replay.reason, "REPLAY_NO_SECOND_APPLY")
console.log("PASS CONFIRM match → browser apply yolu bir kez / replay ikinci apply 0")

for (const [label, gate] of [
  [
    "conflict",
    evaluateScanApplyMutationGate({
      kind: "KEEPA_VERIFY_CONFIRM",
      incomplete: false,
      decisionOutcome: "VALID_SOURCE",
      fingerprintMatch: false,
      hasParent: true,
      parentObservedAtMs: now - 10_000,
      resultObservedAtMs: now - 1_000,
      nowMs: now,
      maxAgeMs: 600_000,
      mutationCandidate: true,
    }),
  ],
  [
    "stale",
    evaluateScanApplyMutationGate({
      kind: "KEEPA_VERIFY_CONFIRM",
      incomplete: false,
      decisionOutcome: "VALID_SOURCE",
      fingerprintMatch: true,
      hasParent: true,
      parentObservedAtMs: now - 800_000,
      resultObservedAtMs: now - 1_000,
      nowMs: now,
      maxAgeMs: 600_000,
      mutationCandidate: true,
    }),
  ],
  [
    "incomplete",
    evaluateScanApplyMutationGate({
      kind: "KEEPA_VERIFY_CONFIRM",
      incomplete: true,
      decisionOutcome: "VALID_SOURCE",
      fingerprintMatch: true,
      hasParent: true,
      parentObservedAtMs: now - 10_000,
      resultObservedAtMs: now - 1_000,
      nowMs: now,
      maxAgeMs: 600_000,
      mutationCandidate: true,
    }),
  ],
] as const) {
  assert.equal(gate.allowEbayMutation, false, label)
}
assert.equal(evaluateKeepaDirectMutationGate("KEEPA_CONFIRMED").allowed, false)
assert.equal(evaluateKeepaDirectMutationGate("SERVER_BROWSER_PUBLIC").allowed, true)
console.log("PASS CONFIRM conflict/stale/incomplete mutation 0 / Keepa direct mutation 0")

assert.equal(
  classifySourceApplyGuard({
    taskAsin: "B0TESTASIN",
    currentSourceAsin: "B0OTHERASIN",
    consumerAsin: "B0TESTASIN",
    listingLive: true,
    stockGuardEnabled: true,
    monitorEligible: true,
    ebayQuantity: 2,
  }).ok,
  false
)
assert.equal(
  classifySourceApplyGuard({
    taskAsin: "B0TESTASIN",
    currentSourceAsin: "B0TESTASIN",
    consumerAsin: "B0TESTASIN",
    listingLive: false,
    stockGuardEnabled: true,
    monitorEligible: true,
    ebayQuantity: 2,
  }).ok,
  false
)
assert.equal(
  classifySourceApplyGuard({
    taskAsin: "B0TESTASIN",
    currentSourceAsin: "B0TESTASIN",
    consumerAsin: "B0TESTASIN",
    listingLive: true,
    stockGuardEnabled: true,
    monitorEligible: true,
    ebayQuantity: 0,
  }).ok,
  false
)
assert.equal(ebayTotal(), 0)
;(ebayPrice as { updateListingPriceOnEbay: typeof origPrice }).updateListingPriceOnEbay = origPrice
;(ebayZero as { zeroListingQuantityOnEbay: typeof origZero }).zeroListingQuantityOnEbay = origZero
console.log("PASS source ASIN/listing/qty değişmiş → mutation 0; eBay çağrısı 0")
console.log("PASS keepa-verify-chain fixtures")
