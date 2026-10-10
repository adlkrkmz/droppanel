import type { KeepaPriceCandidatesUsd, KeepaSelectedPriceSource } from "./keepaPriceTypes"



export type KeepaStatusResponse = {

  ok:       true

  enabled:  boolean

  domain:   number

  hasApiKey: boolean

  dryRun:   boolean

  offersEnabled: boolean

}



export type KeepaCheckAsinRequest = {

  asin: string

}



export type KeepaCheckAsinsRequest = {

  asins: string[]

}



export type KeepaScanStoreRequest = {

  storeCode: string

  mode: "all"

}



export type KeepaScanStoreResponse = {

  ok: true

  storeCode: string

  queued: boolean

  scanned: number

  updated: number

  skippedNoAsin: number

  skippedZeroQty: number

  reviewCreated: number

  reviewUpdated: number

  riskPending: number

  amazonOk: number

  noPrice: number

  unavailable: number

  removed: number

  checkFailed: number

  priceUncertain?: number

  primeExclusiveUsed?: number

  buyBoxUsed?: number

  newUsed?: number
  autoPriceProtected?: number
  autoPriceSkipped?: number
  autoPriceSafetyBlocked?: number
  autoPriceFailed?: number
}



export type KeepaSourceStatus =

  | "AMAZON_OK"

  | "NO_PRICE"

  | "UNAVAILABLE"

  | "REMOVED"

  | "CHECK_FAILED"

  | "PRICE_UNCERTAIN"



export type KeepaRawSignals = {

  hasPrice: boolean

  hasNewPrice: boolean

  hasBuyBox: boolean

  hasOfferSignal: boolean

  hasPrimeExclusivePrice: boolean

}



export type KeepaPriceSelectionWarning =
  | "AMAZON_CURRENT_IGNORED_BY_POLICY"
  | "HISTORICAL_PRIME_EXCLUSIVE_IGNORED"

export type KeepaCheckAsinResponse = {
  ok:              true
  asin:            string
  sourceStatus:    KeepaSourceStatus
  reason:          string
  price:           number | null
  primeOrFbaSignal: boolean
  rawSignals:      KeepaRawSignals
  selectedPriceSource: KeepaSelectedPriceSource
  priceCandidates: KeepaPriceCandidatesUsd
  priceSelectionWarnings: KeepaPriceSelectionWarning[]
}



export type KeepaCheckAsinsResponse = {

  ok:      true

  results: KeepaCheckAsinResponse[]

}



export type KeepaApiProductStats = {

  /** Keepa stats.current — Product.CsvType indexing */

  current?: number[]

  buyBoxIsPrimeExclusive?: boolean

  buyBoxPrice?: number

  buyBoxSellerId?: string

  buyBoxSeller?: string

}



export type KeepaApiProduct = {

  asin: string

  title?: string

  productTitle?: string

  parentAsin?: string

  variationCSV?: string[]

  availabilityAmazon?: number

  productType?: number

  stats?: KeepaApiProductStats

  offers?: unknown[]

  /** Keepa Time minutes. Optional; existing Stock Guard ignores this field. */
  lastUpdate?: number

  /** Keepa Time minutes. Optional; existing Stock Guard ignores this field. */
  lastPriceChange?: number

  domainId?: number

}



export type KeepaApiResponse = {

  tokensLeft?: number

  processingTimeInMs?: number

  error?: string

  products?: KeepaApiProduct[]

  /** Official Keepa token-bucket fields. Optional; existing Stock Guard only reads tokensLeft. */
  refillRate?: number

  refillIn?: number

  tokensConsumed?: number

  tokenFlowReduction?: number

}


