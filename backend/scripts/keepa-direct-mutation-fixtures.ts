import assert from "assert"
import "dotenv/config"
import { applyAcceptedSourcePrice } from "../modules/stockGuard/acceptedSourcePricePipeline"
import { applyConfirmedNoValidSource } from "../modules/stockGuard/confirmedNoValidSourcePipeline"
import {
  dispatchKeepaRadarVerification,
  enqueueVerificationForKeepaSignal,
} from "../modules/amazonVerification/amazonVerificationKeepaBridge"
import {
  classifyConfirmationSource,
  evaluateKeepaDirectMutationGate,
  keepaDirectMutationsEnabled,
} from "../modules/keepaSensor/keepaDirectMutationGate"
import { evaluateKeepaDualBrowserGate } from "../modules/keepaSensor/keepaVerifyPolicy"
import { evaluateScanApplyMutationGate } from "../modules/amazonScan/amazonScanApplyPolicy"
import type { VerifiedSourceDecision } from "../modules/amazonVerification/verifiedSourceDecision"
import * as ebayPrice from "../modules/listings/listingsEbayPriceService"
import * as ebayZero from "../modules/stockAlerts/stockAlertsEbayZeroService"

const dummyDecision = (asin: string): VerifiedSourceDecision => ({
  outcome: "VALID_SOURCE",
  code: "TEST",
  acceptedPrice: 10,
  requestedAsin: asin,
  finalAsin: asin,
  redirected: false,
  validPrimeOrFba: true,
  mutationAllowed: true,
})

const payload = (price: number | null, extra: Record<string, unknown> = {}) => ({
  displayedPrice: price,
  isPrime: true,
  isFba: true,
  stockStatus: "IN_STOCK",
  captcha: false,
  timeout: false,
  ...extra,
  metadata: { offerPageHealthy: extra.offerPageHealthy !== false, publicStatus: extra.publicStatus ?? "AMAZON_CHECKED" },
})

const dummyIds = {
  workspaceId: "00000000-0000-0000-0000-000000000000",
  userId: "00000000-0000-0000-0000-000000000000",
  catalogStateId: 1,
  asin: "B0KSSEN001",
}

let ebayPriceInvocations = 0
let ebayZeroInvocations = 0
const origPrice = ebayPrice.updateListingPriceOnEbay
const origZero = ebayZero.zeroListingQuantityOnEbay
;(ebayPrice as { updateListingPriceOnEbay: typeof origPrice }).updateListingPriceOnEbay = (async (...args) => {
  ebayPriceInvocations += 1
  throw new Error("ebay price mock must not be reached")
}) as typeof origPrice
;(ebayZero as { zeroListingQuantityOnEbay: typeof origZero }).zeroListingQuantityOnEbay = (async (...args) => {
  ebayZeroInvocations += 1
  throw new Error("ebay zero mock must not be reached")
}) as typeof origZero

function ebayCounts(): { price: number; zero: number; total: number } {
  return { price: ebayPriceInvocations, zero: ebayZeroInvocations, total: ebayPriceInvocations + ebayZeroInvocations }
}

function restoreEnv(prev: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

const prev: Record<string, string | undefined> = {
  KEEPA_DIRECT_MUTATIONS_ENABLED: process.env.KEEPA_DIRECT_MUTATIONS_ENABLED,
  KEEPA_ENABLED: process.env.KEEPA_ENABLED,
  GLOBAL_KEEPA_MONITOR_ENABLED: process.env.GLOBAL_KEEPA_MONITOR_ENABLED,
  GLOBAL_KEEPA_PLANNER_ENABLED: process.env.GLOBAL_KEEPA_PLANNER_ENABLED,
  GLOBAL_KEEPA_ACTIONS_ENABLED: process.env.GLOBAL_KEEPA_ACTIONS_ENABLED,
  GLOBAL_KEEPA_TO_EXTENSION_DISPATCH_ENABLED: process.env.GLOBAL_KEEPA_TO_EXTENSION_DISPATCH_ENABLED,
  AMAZON_KEEPA_ROUTINE_ACTIONS_DISABLED: process.env.AMAZON_KEEPA_ROUTINE_ACTIONS_DISABLED,
}

process.env.KEEPA_DIRECT_MUTATIONS_ENABLED = "false"
process.env.KEEPA_ENABLED = "true"
process.env.GLOBAL_KEEPA_MONITOR_ENABLED = "true"
process.env.GLOBAL_KEEPA_PLANNER_ENABLED = "true"
process.env.GLOBAL_KEEPA_ACTIONS_ENABLED = "true"
process.env.GLOBAL_KEEPA_TO_EXTENSION_DISPATCH_ENABLED = "true"
process.env.AMAZON_KEEPA_ROUTINE_ACTIONS_DISABLED = "false"

async function main(): Promise<void> {
  try {
    assert.equal(keepaDirectMutationsEnabled(), false)
    assert.equal(classifyConfirmationSource("KEEPA_CONFIRMED"), "keepa_direct")
    assert.equal(classifyConfirmationSource("KEEPA_RADAR"), "keepa_direct")
    assert.equal(classifyConfirmationSource("GLOBAL_KEEPA"), "keepa_direct")
    assert.equal(classifyConfirmationSource("SERVER_BROWSER_PUBLIC"), "browser_confirmed")
    assert.equal(classifyConfirmationSource(undefined), "unknown")
    assert.equal(classifyConfirmationSource("NOT_A_SOURCE"), "unknown")
    assert.equal(evaluateKeepaDirectMutationGate("KEEPA_CONFIRMED").skip, "KEEPA_DIRECT_MUTATION_DISABLED")
    assert.equal(evaluateKeepaDirectMutationGate("SERVER_BROWSER_PUBLIC").allowed, true)
    assert.equal(evaluateKeepaDirectMutationGate(undefined).allowed, false)
    assert.equal(evaluateKeepaDirectMutationGate("mystery").allowed, false)

    const beforeLegacy = ebayCounts().total
    const price = await applyAcceptedSourcePrice({
      ...dummyIds,
      confirmationSource: "KEEPA_CONFIRMED",
      logicalOperationId: "keepa:legacy-price",
      decision: dummyDecision(dummyIds.asin),
      permitEbayMutation: true,
    })
    assert.equal(price.ebayMutated, false)
    assert.equal(price.planAction, "KEEPA_DIRECT_MUTATION_DISABLED")
    assert.equal(ebayCounts().total, beforeLegacy, "legacy Keepa price eBay invocations")
    console.log("PASS legacy Keepa price → mutation 0 ebayInvocations=" + ebayCounts().total)

    const zero = await applyConfirmedNoValidSource({
      ...dummyIds,
      confirmationSource: "KEEPA_CONFIRMED",
      logicalOperationId: "keepa-zero:legacy",
      decision: { ...dummyDecision(dummyIds.asin), outcome: "CONFIRMED_NO_VALID_SOURCE", mutationAllowed: true },
    })
    assert.equal(zero.ebayMutated, false)
    assert.equal(zero.planAction, "KEEPA_DIRECT_MUTATION_DISABLED")
    assert.equal(ebayCounts().total, beforeLegacy, "legacy Keepa stock eBay invocations")
    console.log("PASS legacy Keepa stock zero → mutation 0 ebayInvocations=" + ebayCounts().total)

    const radarFields = {
      asin: dummyIds.asin,
      amazonPriceUsd: 10,
      newPriceUsd: 10,
      newFbaCount: 1,
      newFbmCount: 0,
      lastUpdateMinutes: null,
      lastPriceChangeMinutes: null,
      lastUpdateAt: null,
      lastPriceChangeAt: null,
    }
    const radarPrice = await dispatchKeepaRadarVerification({
      globalAsinId: 1,
      asin: dummyIds.asin,
      fields: radarFields,
      previousFbaCount: 1,
      productReturned: true,
    })
    assert.equal(radarPrice.created, 0)
    assert.equal(radarPrice.skipped, "KEEPA_DIRECT_MUTATION_DISABLED")
    const radarApply = await applyAcceptedSourcePrice({
      ...dummyIds,
      confirmationSource: "KEEPA_CONFIRMED",
      logicalOperationId: "keepa:radar-price",
      decision: dummyDecision(dummyIds.asin),
      permitEbayMutation: true,
    })
    assert.equal(radarApply.planAction, "KEEPA_DIRECT_MUTATION_DISABLED")
    assert.equal(ebayCounts().total, beforeLegacy, "radar Keepa price eBay invocations")
    console.log("PASS radar Keepa price → mutation 0 ebayInvocations=" + ebayCounts().total)

    const radarStock = await applyConfirmedNoValidSource({
      ...dummyIds,
      confirmationSource: "KEEPA_CONFIRMED",
      logicalOperationId: "keepa-zero:radar",
      decision: { ...dummyDecision(dummyIds.asin), outcome: "CONFIRMED_NO_VALID_SOURCE", mutationAllowed: true },
    })
    assert.equal(radarStock.planAction, "KEEPA_DIRECT_MUTATION_DISABLED")
    const enq = await enqueueVerificationForKeepaSignal({
      signal: "PRICE_AMBIGUOUS",
      keepaFailureCount: 0,
      globalAsinId: 1,
      asin: dummyIds.asin,
    })
    assert.equal(enq.created, 0)
    assert.equal(enq.skipped, "KEEPA_DIRECT_MUTATION_DISABLED")
    assert.equal(ebayCounts().total, beforeLegacy, "radar Keepa stock eBay invocations")
    console.log("PASS radar Keepa stock → mutation 0 ebayInvocations=" + ebayCounts().total)

    const candidateOnly = evaluateKeepaDualBrowserGate({
      primaryPayload: payload(9.7),
      confirmPayload: null,
      primaryObservedAtMs: Date.now() - 45_000,
      confirmObservedAtMs: null,
      nowMs: Date.now(),
    })
    assert.equal(candidateOnly.allowEbayMutation, false)
    assert.equal(ebayCounts().total, beforeLegacy)
    console.log("PASS Keepa candidate only → mutation 0 ebayInvocations=" + ebayCounts().total)

    const now = Date.now()
    const primaryOnly = evaluateScanApplyMutationGate({
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
    })
    assert.equal(primaryOnly.allowEbayMutation, false)
    assert.equal(ebayCounts().total, beforeLegacy)
    console.log("PASS KEEPA_VERIFY_PRIMARY → mutation 0 ebayInvocations=" + ebayCounts().total)

    const matched = evaluateKeepaDualBrowserGate({
      primaryPayload: payload(9.7),
      confirmPayload: payload(9.7),
      primaryObservedAtMs: now - 45_000,
      confirmObservedAtMs: now - 5_000,
      nowMs: now,
      keepaBuyBoxUsd: 10,
    })
    assert.equal(matched.decision, "MATCHED")
    assert.equal(matched.allowEbayMutation, true)
    const browserEnter = await applyAcceptedSourcePrice({
      ...dummyIds,
      confirmationSource: "SERVER_BROWSER_PUBLIC",
      logicalOperationId: "browser:matched",
      decision: dummyDecision(dummyIds.asin),
      permitEbayMutation: true,
    })
    assert.notEqual(browserEnter.planAction, "KEEPA_DIRECT_MUTATION_DISABLED")
    assert.equal(browserEnter.ebayMutated, false)
    assert.equal(ebayCounts().total, beforeLegacy, "MATCHED dummy listing must not call eBay")
    console.log("PASS KEEPA_VERIFY_CONFIRM MATCHED + fresh → pipeline allowed ebayInvocations=" + ebayCounts().total)

    for (const [label, gate] of [
      [
        "conflict",
        evaluateKeepaDualBrowserGate({
          primaryPayload: payload(9.7),
          confirmPayload: payload(10),
          primaryObservedAtMs: now - 45_000,
          confirmObservedAtMs: now - 5_000,
          nowMs: now,
        }),
      ],
      [
        "incomplete",
        evaluateKeepaDualBrowserGate({
          primaryPayload: payload(null, { offerPageHealthy: false, publicStatus: "AMAZON_INCOMPLETE" }),
          confirmPayload: payload(10),
          primaryObservedAtMs: now - 45_000,
          confirmObservedAtMs: now - 5_000,
          nowMs: now,
        }),
      ],
      [
        "stale",
        evaluateKeepaDualBrowserGate({
          primaryPayload: payload(9.7),
          confirmPayload: payload(9.7),
          primaryObservedAtMs: now - 800_000,
          confirmObservedAtMs: now - 700_000,
          nowMs: now,
        }),
      ],
      [
        "unknown",
        evaluateKeepaDualBrowserGate({
          primaryPayload: payload(9.7),
          confirmPayload: payload(9.7),
          primaryObservedAtMs: null,
          confirmObservedAtMs: now - 5_000,
          nowMs: now,
        }),
      ],
    ] as const) {
      assert.equal(gate.allowEbayMutation, false, label)
    }
    assert.equal(ebayCounts().total, beforeLegacy)
    console.log("PASS CONFIRM stale/conflict/UNKNOWN/INCOMPLETE → mutation 0 ebayInvocations=" + ebayCounts().total)

    const unknownApply = await applyAcceptedSourcePrice({
      ...dummyIds,
      confirmationSource: "NOT_A_REAL_SOURCE" as "KEEPA_CONFIRMED",
      logicalOperationId: "keepa:unknown",
      decision: dummyDecision(dummyIds.asin),
      permitEbayMutation: true,
    })
    assert.equal(unknownApply.planAction, "KEEPA_DIRECT_MUTATION_DISABLED")
    const missingApply = await applyAcceptedSourcePrice({
      ...dummyIds,
      confirmationSource: undefined as unknown as "KEEPA_CONFIRMED",
      logicalOperationId: "keepa:missing",
      decision: dummyDecision(dummyIds.asin),
      permitEbayMutation: true,
    })
    assert.equal(missingApply.planAction, "KEEPA_DIRECT_MUTATION_DISABLED")
    assert.equal(ebayCounts().total, beforeLegacy)
    console.log("PASS source undefined/unknown → mutation 0 ebayInvocations=" + ebayCounts().total)

    const aliasApply = await applyAcceptedSourcePrice({
      ...dummyIds,
      confirmationSource: "KEEPA_RADAR" as "KEEPA_CONFIRMED",
      logicalOperationId: "keepa:alias",
      decision: dummyDecision(dummyIds.asin),
      permitEbayMutation: true,
    })
    assert.equal(aliasApply.planAction, "KEEPA_DIRECT_MUTATION_DISABLED")
    const sourceAsinStyle = await applyAcceptedSourcePrice({
      ...dummyIds,
      confirmationSource: "KEEPA_CONFIRMED",
      logicalOperationId: `source-asin-update:${dummyIds.catalogStateId}:${dummyIds.asin}:1000`,
      decision: dummyDecision(dummyIds.asin),
      permitEbayMutation: true,
    })
    assert.equal(sourceAsinStyle.planAction, "KEEPA_DIRECT_MUTATION_DISABLED")
    assert.equal(ebayCounts().total, beforeLegacy)
    console.log(
      "PASS master false + all legacy Keepa flags true → mutation 0 ebayPrice=" +
        ebayCounts().price +
        " ebayZero=" +
        ebayCounts().zero
    )

    process.env.KEEPA_DIRECT_MUTATIONS_ENABLED = "true"
    assert.equal(keepaDirectMutationsEnabled(), true)
    assert.equal(evaluateKeepaDirectMutationGate("KEEPA_CONFIRMED").allowed, true)
    const allowedEnter = await applyAcceptedSourcePrice({
      ...dummyIds,
      confirmationSource: "KEEPA_CONFIRMED",
      logicalOperationId: "keepa:compat",
      decision: dummyDecision(dummyIds.asin),
      permitEbayMutation: true,
    })
    assert.notEqual(allowedEnter.planAction, "KEEPA_DIRECT_MUTATION_DISABLED")
    assert.equal(allowedEnter.ebayMutated, false)
    restoreEnv(prev)
    assert.notEqual(String(process.env.KEEPA_DIRECT_MUTATIONS_ENABLED ?? "").toLowerCase(), "true")
    assert.equal(ebayCounts().total, 0)
    console.log("PASS gate true is fixture-only; ebay mock total=" + ebayCounts().total)
    console.log("PASS keepa-direct-mutation fixtures ebayPrice=" + ebayCounts().price + " ebayZero=" + ebayCounts().zero)
  } finally {
    restoreEnv(prev)
    ;(ebayPrice as { updateListingPriceOnEbay: typeof origPrice }).updateListingPriceOnEbay = origPrice
    ;(ebayZero as { zeroListingQuantityOnEbay: typeof origZero }).zeroListingQuantityOnEbay = origZero
  }
}

void main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .then(() => process.exit(0))
