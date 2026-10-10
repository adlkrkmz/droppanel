/**
 * Map public AmazonWorker observation → production VerificationResultPayload.
 * Does NOT invent Stock Guard rules — only fills the same fields login extract submits.
 * Ships-from uses amazonVerificationNormalize.shipsFromAmazon (never exact-string FBA checks).
 */
import type { AmazonObservation } from './parsing'
import {
  deriveIsFba,
  derivePurchasable,
  shipsFromAmazon,
  soldByAmazon,
} from '../amazonVerification/amazonVerificationNormalize'
import { evaluateOfferPrimeFbaSignals } from '../amazonBrowserWorker/amazonOfferPrimeFbaGate'
import type { AmazonExtractOk } from '../amazonBrowserWorker/amazonPageExtract'

type VerificationResultPayload = {
  asin?: string
  requestedAsin?: string
  finalAsin?: string
  displayedPrice?: unknown
  currency?: unknown
  condition?: unknown
  shipsFrom?: unknown
  soldBy?: unknown
  isPrime?: unknown
  isFba?: unknown
  purchasable?: unknown
  hasAddToCart?: unknown
  hasBuyNow?: unknown
  availabilityText?: unknown
  stockStatus?: unknown
  pageUrl?: unknown
  captcha?: unknown
  loginRequired?: unknown
  pageUnavailable?: unknown
  redirected?: unknown
  primeExclusive?: unknown
  metadata?: Record<string, unknown>
}

/**
 * Public parser sometimes emits noisy blobs like "Amazon Amazon Ships from Amazon".
 * Reduce to a token the existing shipsFromAmazon() helper already accepts — no new FBA rules.
 */
export function normalizePublicShipsFromBlob(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
  if (shipsFromAmazon(trimmed) === true) return trimmed
  const n = trimmed.toLowerCase().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ')
  // "Amazon.com … Shipper" / repeated Amazon tokens with shipper language
  if (
    /\bamazon(\.com)?\b/.test(n) &&
    /(ships\s*from|shipper)/.test(n) &&
    !/\b(marketplace|walmart|target|ebay)\b/.test(n)
  ) {
    return /\bamazon\.com\b/.test(n) ? 'Amazon.com' : 'Amazon'
  }
  return trimmed
}

const EXPLICIT_OOS_RE =
  /out of stock|currently unavailable|temporarily out of stock|don.?t know when/i

/** OOS stockStatus only with explicit availability text — never from bare inStock=false. */
function mapStockStatus(obs: AmazonObservation): string | null {
  const text = `${obs.availability ?? ''}`
  if (EXPLICIT_OOS_RE.test(text)) return 'OUT_OF_STOCK'
  if (obs.inStock === true) {
    if (/only\s+\d+\s+left/i.test(obs.availability ?? '')) return 'LIMITED_STOCK'
    return 'IN_STOCK'
  }
  if (/\bin stock\b/i.test(text)) return 'IN_STOCK'
  return null
}

function mapCondition(obs: AmazonObservation): string | null {
  switch (obs.offerCondition) {
    case 'NEW':
      return 'NEW'
    case 'USED':
    case 'LIKE_NEW':
    case 'RENEWED':
      return 'USED'
    case 'RESALE':
      return 'USED'
    default:
      return obs.offerLabel || obs.offerCondition || null
  }
}

export type PublicMappedResult = {
  payload: VerificationResultPayload
  mappedCodeHint: string
  shipsFromNormalized: string | null
  shipsFromAmazon: boolean | null
  isPrime: boolean | null
  isFba: boolean | null
}

/**
 * Build login-compatible extract data then reuse evaluateOfferPrimeFbaSignals.
 */
export function mapPublicObservationToVerificationPayload(input: {
  requestedAsin: string
  observation: AmazonObservation
  publicStatus: string
}): PublicMappedResult {
  const requested = input.requestedAsin.trim().toUpperCase()
  const actual = input.observation.actualAsin?.trim().toUpperCase() || null
  const pageUnavailable =
    input.publicStatus === 'PRODUCT_NOT_FOUND_OBSERVED' || input.observation.pageExists === false
  const redirected =
    input.publicStatus === 'ASIN_MISMATCH_OBSERVED' ||
    (Boolean(actual) && Boolean(requested) && actual !== requested)

  const shipsFromNormalized = normalizePublicShipsFromBlob(input.observation.shipsFrom)
  const stockStatus = mapStockStatus(input.observation)
  const availabilityText = input.observation.availability
  const condition = mapCondition(input.observation)
  const displayedPrice = input.observation.mainPrice
  const isPrime = input.observation.primeVisible

  // Client OUT_OF_STOCK_OBSERVED without explicit availability evidence → incomplete (non-destructive)
  const oosClaimWithoutEvidence =
    input.publicStatus === 'OUT_OF_STOCK_OBSERVED' && stockStatus !== 'OUT_OF_STOCK'

  // AMAZON_INCOMPLETE / false-OOS claim → leave purchase chrome unset so classifier stays UNKNOWN
  const incomplete = input.publicStatus === 'AMAZON_INCOMPLETE' || oosClaimWithoutEvidence

  // Never trust client OUT_OF_STOCK_OBSERVED alone for purchasable=FALSE
  const purchasableHint =
    stockStatus === 'OUT_OF_STOCK'
      ? false
      : stockStatus === 'IN_STOCK' || stockStatus === 'LIMITED_STOCK'
        ? true
        : null

  const extractLike: AmazonExtractOk['data'] = {
    asin: actual ?? null,
    requestedAsin: requested,
    finalAsin: actual,
    displayedPrice: incomplete ? null : displayedPrice,
    currency: 'USD',
    condition: condition ?? 'NEW',
    shipsFrom: shipsFromNormalized ?? '',
    soldBy: input.observation.soldBy ?? '',
    isPrime: incomplete ? null : isPrime,
    hasAddToCart: incomplete ? false : purchasableHint === true,
    hasBuyNow: false,
    availabilityText: availabilityText ?? '',
    stockStatus: stockStatus ?? 'UNKNOWN',
    pageUrl: input.observation.finalUrl,
    captcha: false,
    pageUnavailable,
    redirected,
  }

  const signals = evaluateOfferPrimeFbaSignals(extractLike)
  const ships = shipsFromAmazon(shipsFromNormalized)
  const sold = soldByAmazon(input.observation.soldBy)
  // Do not coerce null ships → isFba false (false NOT_FBA)
  const isFba = deriveIsFba({ shipsFromAmazon: ships, soldByAmazon: sold, isFba: signals.isFba })

  const purchasable = derivePurchasable({
    hasAddToCart: extractLike.hasAddToCart,
    hasBuyNow: extractLike.hasBuyNow,
    availabilityText,
    stockStatus,
  })

  let mappedCodeHint = input.publicStatus
  if (pageUnavailable) mappedCodeHint = 'PRODUCT_NOT_FOUND'
  else if (redirected) mappedCodeHint = 'SOURCE_ASIN_MISMATCH'
  else if (oosClaimWithoutEvidence) mappedCodeHint = 'INCOMPLETE'
  else if (stockStatus === 'OUT_OF_STOCK') mappedCodeHint = 'OUT_OF_STOCK'
  else if (incomplete) mappedCodeHint = 'INCOMPLETE'
  else if (input.publicStatus === 'NEW_OFFER_UNAVAILABLE') mappedCodeHint = 'NEW_OFFER_UNAVAILABLE'
  else if (input.publicStatus === 'AMAZON_CHECKED') mappedCodeHint = 'MAPPED_FOR_PRODUCTION_CLASSIFIER'

  const obsAny = input.observation as AmazonObservation & {
    deliveryZip?: string | null
    deliveryLocation?: string | null
  }

  const payload: VerificationResultPayload = {
    asin: actual ?? undefined,
    requestedAsin: requested,
    finalAsin: actual ?? undefined,
    displayedPrice: incomplete ? null : displayedPrice,
    currency: 'USD',
    condition,
    shipsFrom: shipsFromNormalized,
    soldBy: input.observation.soldBy,
    isPrime: incomplete ? null : signals.isPrime,
    isFba,
    hasAddToCart: extractLike.hasAddToCart,
    hasBuyNow: extractLike.hasBuyNow,
    availabilityText,
    stockStatus,
    pageUrl: input.observation.finalUrl,
    captcha: false,
    pageUnavailable,
    redirected,
    metadata: {
      verificationSource: 'SERVER_BROWSER_PUBLIC',
      taskType: 'VERIFY_SOURCE',
      verifiedAt: new Date().toISOString(),
      decisionOrder: 'PAGE>ASIN>STOCK>PRIME>SHIPS_FROM_AMAZON>CONDITION>IN_STOCK',
      shipsFromAmazon: ships,
      soldByAmazon: sold,
      purchasable,
      offerPageHealthy: incomplete ? false : signals.offerPageHealthy,
      publicStatus: input.publicStatus,
      publicOfferCondition: input.observation.offerCondition,
      publicNewOfferAvailable: input.observation.newOfferAvailable,
      publicOfferLabel: input.observation.offerLabel,
      availabilityText: availabilityText ?? null,
      deliveryZip: obsAny.deliveryZip ?? null,
      deliveryLocation: obsAny.deliveryLocation ?? null,
      domReadPass: 1,
      pageReady: 'public',
    },
  }

  return {
    payload,
    mappedCodeHint,
    shipsFromNormalized,
    shipsFromAmazon: ships,
    isPrime: payload.isPrime as boolean | null,
    isFba,
  }
}
