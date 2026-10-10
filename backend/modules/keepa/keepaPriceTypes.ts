/**
 * Keepa product.stats.current indices — Product.CsvType (keepacom/api_backend).
 * @see https://github.com/keepacom/api_backend/blob/master/src/main/java/com/keepa/api/backend/structs/Product.java
 */
export const KEEPA_CSV_INDEX = {
  AMAZON: 0,
  NEW: 1,
  LISTPRICE: 4,
  NEW_FBA: 10,
  BUY_BOX_SHIPPING: 18,
  /** "New, Prime exclusive - Current" in Keepa UI */
  PRIME_EXCL: 33,
  /** Official Product.CsvType — New FBA offer count (includes Amazon). Additive; unused by Stock Guard selector. */
  COUNT_NEW_FBA: 34,
  /** Official Product.CsvType — New FBM offer count. Additive; unused by Stock Guard selector. */
  COUNT_NEW_FBM: 35,
} as const

/** Only these four may be written to source_price / source_price_source */
export type KeepaTrustedCurrentPriceSource =
  | "PRIME_EXCLUSIVE_CURRENT"
  | "BUY_BOX_CURRENT"
  | "NEW_CURRENT"
  | "NEW_FBA_CURRENT"

export type KeepaSelectedPriceSource =
  | KeepaTrustedCurrentPriceSource
  | "PRICE_UNCERTAIN"
  | "NONE"

export type KeepaPriceCandidatesUsd = {
  primeExclusiveCurrent: number | null
  buyBoxCurrent: number | null
  amazonCurrent: number | null
  newCurrent: number | null
  newFbaCurrent: number | null
  listPrice: number | null
  offerCurrent: number | null
}

export const TRUSTED_CURRENT_KEEPA_PRICE_SOURCES: ReadonlySet<KeepaTrustedCurrentPriceSource> =
  new Set([
    "PRIME_EXCLUSIVE_CURRENT",
    "BUY_BOX_CURRENT",
    "NEW_CURRENT",
    "NEW_FBA_CURRENT",
  ])

export function isTrustedCurrentKeepaPriceSource(
  source: KeepaSelectedPriceSource | string | null | undefined
): boolean {
  if (!source) return false
  return TRUSTED_CURRENT_KEEPA_PRICE_SOURCES.has(source as KeepaTrustedCurrentPriceSource)
}

/** @deprecated Use isTrustedCurrentKeepaPriceSource */
export function isTrustedBuyableKeepaPriceSource(
  source: KeepaSelectedPriceSource | string | null | undefined
): boolean {
  return isTrustedCurrentKeepaPriceSource(source)
}

/** @deprecated Use isTrustedCurrentKeepaPriceSource */
export function isTrustedKeepaPriceSource(
  source: KeepaSelectedPriceSource | string | null | undefined
): boolean {
  return isTrustedCurrentKeepaPriceSource(source)
}
