/**
 * READ-ONLY acceptance for B07921PHCF alternate Amazon-fulfilled NEW offer.
 * Opens Amazon via isolated public profile (amazon-C). Does NOT claim queue,
 * submitVerificationResult, or mutate eBay/DB business state.
 */
import {
  AmazonPublicWorker,
  PUBLIC_AMAZON_PROFILE_ROOT,
} from '../modules/amazonPublicWorker/amazonPublicWorker'
import type { AppConfig } from '../modules/amazonPublicWorker/types'
import { mapPublicObservationToVerificationPayload } from '../modules/amazonPublicWorker/mapPublicObservationToVerificationPayload'
import { classifyVerifiedAmazonSource } from '../modules/amazonVerification/verifiedSourceDecision'
import { shipsFromAmazon } from '../modules/amazonVerification/amazonVerificationNormalize'
import { setPublicWorkerPersistenceSink } from '../modules/amazonPublicWorker/persistence'

const ASIN = (process.argv[2] || 'B07921PHCF').toUpperCase()

async function main(): Promise<void> {
  process.env.AMAZON_PUBLIC_US_ZIP = process.env.AMAZON_PUBLIC_US_ZIP || '10001'
  setPublicWorkerPersistenceSink({
    logEvent: (e, a, _w, d) => console.log(`[accept] ${e} ${a ?? ''} ${d ?? ''}`),
    updateItem: () => undefined,
  })

  const config: AppConfig = {
    localPort: 0,
    keepaConcurrency: 1,
    amazonMode: 'FAILOVER',
    amazonWorkers: ['C'],
    amazonActiveConcurrency: 1,
    amazonHeadless: true,
    navigationTimeout: 90000,
    keepaHeadless: true,
    keepaDelayMs: 1500,
    amazonDelayMs: 2500,
    technicalRetryMax: 1,
  }

  // amazon-C — isolated from live public worker profile amazon-A
  const acceptWorker = new AmazonPublicWorker('C', config)

  console.log(`PUBLIC_PROFILE_ROOT=${PUBLIC_AMAZON_PROFILE_ROOT}`)
  console.log(`ACCEPTANCE_ASIN=${ASIN}`)
  console.log('MODE=READ_ONLY (no queue claim / no submitVerificationResult / no eBay)')

  try {
    const result = await acceptWorker.observe(ASIN)
    if (result.kind !== 'done' || !result.observation || !result.selection) {
      console.log(
        JSON.stringify(
          {
            B07921PHCF_ACCEPTANCE: 'FAIL',
            kind: result.kind,
            reason: result.reason,
            FINAL_SELECTED_SOURCE: 'NONE',
            FINAL_PRODUCTION_DECISION: 'OTHER',
          },
          null,
          2
        )
      )
      process.exitCode = 2
      return
    }

    const sel = result.selection
    const mapped = mapPublicObservationToVerificationPayload({
      requestedAsin: ASIN,
      observation: result.observation,
      publicStatus: result.status || 'AMAZON_CHECKED',
    })
    const decision = classifyVerifiedAmazonSource({
      requestedAsin: ASIN,
      finalAsin: mapped.payload.finalAsin,
      displayedPrice: typeof mapped.payload.displayedPrice === 'number' ? mapped.payload.displayedPrice : null,
      condition: typeof mapped.payload.condition === 'string' ? mapped.payload.condition : null,
      isPrime: typeof mapped.payload.isPrime === 'boolean' ? mapped.payload.isPrime : null,
      isFba: typeof mapped.payload.isFba === 'boolean' ? mapped.payload.isFba : null,
      shipsFromAmazon: shipsFromAmazon(mapped.shipsFromNormalized),
      purchasable:
        mapped.payload.metadata && typeof mapped.payload.metadata.purchasable === 'string'
          ? (mapped.payload.metadata.purchasable as 'TRUE' | 'FALSE' | 'UNKNOWN')
          : null,
      stockStatus: typeof mapped.payload.stockStatus === 'string' ? mapped.payload.stockStatus : null,
      availabilityText: typeof mapped.payload.availabilityText === 'string' ? mapped.payload.availabilityText : null,
      pageUnavailable: mapped.payload.pageUnavailable === true,
      redirected: mapped.payload.redirected === true,
      offerPageHealthy: mapped.payload.metadata?.offerPageHealthy === true,
    })

    const finalDecision =
      decision.outcome === 'VALID_SOURCE' ? 'VALID' : decision.code === 'NOT_FBA' ? 'NOT_FBA' : decision.code

    const selectedPrice = result.observation.mainPrice
    const selectedShips = result.observation.shipsFrom || ''
    const selectedSold = result.observation.soldBy || ''
    const priceOk = selectedPrice != null && Math.abs(selectedPrice - 15.51) < 0.05
    const shipsOk = shipsFromAmazon(selectedShips) === true || /amazon\.com/i.test(selectedShips)
    const soldOk = /amazon(\.com)?/i.test(selectedSold)
    const pass =
      sel.alternateFound === true &&
      sel.finalSelectedSource === 'ALTERNATE' &&
      priceOk &&
      shipsOk &&
      soldOk &&
      finalDecision === 'VALID'

    const report = {
      B07921PHCF_ACCEPTANCE: pass ? 'PASS' : 'FAIL',
      PRIMARY: {
        price: sel.primary.price,
        condition: sel.primary.condition,
        shipsFrom: sel.primary.shipsFrom,
        soldBy: sel.primary.soldBy,
      },
      ALTERNATE_FOUND: sel.alternateFound ? 'YES' : 'NO',
      ALTERNATE: sel.alternate
        ? {
            price: sel.alternate.price,
            condition: sel.alternate.condition,
            prime: sel.alternate.prime,
            shipsFrom: sel.alternate.shipsFrom,
            soldBy: sel.alternate.soldBy,
            availability: sel.alternate.availability,
          }
        : null,
      FINAL_SELECTED_SOURCE: sel.finalSelectedSource,
      FINAL_OBSERVATION: {
        price: result.observation.mainPrice,
        condition: result.observation.offerCondition,
        prime: result.observation.primeVisible,
        shipsFrom: result.observation.shipsFrom,
        soldBy: result.observation.soldBy,
        availability: result.observation.availability,
        publicStatus: result.status,
      },
      MAPPED: {
        displayedPrice: mapped.payload.displayedPrice,
        condition: mapped.payload.condition,
        isPrime: mapped.payload.isPrime,
        isFba: mapped.payload.isFba,
        shipsFrom: mapped.shipsFromNormalized,
        shipsFromAmazon: mapped.shipsFromAmazon,
      },
      FINAL_PRODUCTION_DECISION: finalDecision,
      DECISION_DETAIL: { outcome: decision.outcome, code: decision.code },
      qty0: finalDecision === 'VALID' ? 'NO' : 'WOULD_APPLY_IF_SUBMITTED',
      PRODUCTION_MUTATION: 'NO',
    }
    console.log(JSON.stringify(report, null, 2))
    if (!pass) process.exitCode = 2
  } finally {
    await acceptWorker.close()
    setPublicWorkerPersistenceSink(null)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
