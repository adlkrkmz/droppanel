import type { KeepaApiProduct } from "./keepaTypes"
import { KEEPA_CSV_INDEX } from "./keepaPriceTypes"
import type {
  KeepaPriceCandidatesUsd,
  KeepaSelectedPriceSource,
  KeepaTrustedCurrentPriceSource,
} from "./keepaPriceTypes"

export type KeepaPriceSelectionWarning =
  | "AMAZON_CURRENT_IGNORED_BY_POLICY"
  | "HISTORICAL_PRIME_EXCLUSIVE_IGNORED"

/** Fixed priority — first valid current wins (not lowest price). */
const TRUSTED_CURRENT_PRIORITY: KeepaTrustedCurrentPriceSource[] = [
  "PRIME_EXCLUSIVE_CURRENT",
  "BUY_BOX_CURRENT",
  "NEW_CURRENT",
  "NEW_FBA_CURRENT",
]

function readKeepaCents(cur: number[], index: number): number | null {
  const v = cur[index]
  if (typeof v !== "number" || !Number.isFinite(v)) return null
  if (v <= 0) return null
  return v
}

/** Keepa prices are integer cents; -1 means no offer. */
export function keepaCentsToUsd(cents: number | null | undefined): number | null {
  if (cents == null) return null
  if (!Number.isFinite(cents)) return null
  if (cents <= 0) return null
  const usd = cents / 100
  return Number.isFinite(usd) ? Math.round(usd * 100) / 100 : null
}

/** Debug-only candidates from stats.current — never used for selection except the 4 trusted currents. */
export function extractKeepaPriceCandidates(product: KeepaApiProduct): KeepaPriceCandidatesUsd {
  const cur = product.stats?.current ?? []
  const stats = product.stats as { buyBoxPrice?: number; buyBoxIsPrimeExclusive?: boolean } | undefined

  const buyBoxFromCurrent = readKeepaCents(cur, KEEPA_CSV_INDEX.BUY_BOX_SHIPPING)
  const buyBoxFromStats =
    typeof stats?.buyBoxPrice === "number" ? stats.buyBoxPrice : null
  const buyBoxCents = buyBoxFromCurrent ?? buyBoxFromStats

  return {
    primeExclusiveCurrent: keepaCentsToUsd(readKeepaCents(cur, KEEPA_CSV_INDEX.PRIME_EXCL)),
    buyBoxCurrent: keepaCentsToUsd(buyBoxCents),
    amazonCurrent: keepaCentsToUsd(readKeepaCents(cur, KEEPA_CSV_INDEX.AMAZON)),
    newCurrent: keepaCentsToUsd(readKeepaCents(cur, KEEPA_CSV_INDEX.NEW)),
    newFbaCurrent: keepaCentsToUsd(readKeepaCents(cur, KEEPA_CSV_INDEX.NEW_FBA)),
    listPrice: keepaCentsToUsd(readKeepaCents(cur, KEEPA_CSV_INDEX.LISTPRICE)),
    offerCurrent: null,
  }
}

function priceForSource(
  candidates: KeepaPriceCandidatesUsd,
  source: KeepaTrustedCurrentPriceSource
): number | null {
  switch (source) {
    case "PRIME_EXCLUSIVE_CURRENT":
      return candidates.primeExclusiveCurrent
    case "BUY_BOX_CURRENT":
      return candidates.buyBoxCurrent
    case "NEW_CURRENT":
      return candidates.newCurrent
    case "NEW_FBA_CURRENT":
      return candidates.newFbaCurrent
    default:
      return null
  }
}

function collectWarnings(
  product: KeepaApiProduct,
  candidates: KeepaPriceCandidatesUsd
): KeepaPriceSelectionWarning[] {
  const warnings: KeepaPriceSelectionWarning[] = []
  if (candidates.amazonCurrent != null) {
    warnings.push("AMAZON_CURRENT_IGNORED_BY_POLICY")
  }
  const stats = product.stats as { buyBoxIsPrimeExclusive?: boolean } | undefined
  if (stats?.buyBoxIsPrimeExclusive === true && candidates.primeExclusiveCurrent == null) {
    warnings.push("HISTORICAL_PRIME_EXCLUSIVE_IGNORED")
  }
  return warnings
}

export type KeepaPriceSelection = {
  price: number | null
  selectedPriceSource: KeepaSelectedPriceSource
  priceCandidates: KeepaPriceCandidatesUsd
  priceSelectionWarnings: KeepaPriceSelectionWarning[]
}

/**
 * Trusted Amazon current for source_price — strict order, no Amazon Current / List / averages.
 */
export function selectKeepaActiveSourcePrice(product: KeepaApiProduct): KeepaPriceSelection {
  const priceCandidates = extractKeepaPriceCandidates(product)
  const warnings = collectWarnings(product, priceCandidates)

  for (const source of TRUSTED_CURRENT_PRIORITY) {
    const price = priceForSource(priceCandidates, source)
    if (price != null && price > 0) {
      return {
        price,
        selectedPriceSource: source,
        priceCandidates,
        priceSelectionWarnings: warnings,
      }
    }
  }

  return {
    price: null,
    selectedPriceSource: "PRICE_UNCERTAIN",
    priceCandidates,
    priceSelectionWarnings: warnings,
  }
}

export function formatPriceCandidatesLog(c: KeepaPriceCandidatesUsd): string {
  const fmt = (n: number | null) => (n == null ? "null" : n.toFixed(2))
  return (
    `{primeExclusive=${fmt(c.primeExclusiveCurrent)},buyBox=${fmt(c.buyBoxCurrent)},` +
    `amazon=${fmt(c.amazonCurrent)},new=${fmt(c.newCurrent)},newFba=${fmt(c.newFbaCurrent)},` +
    `listPrice=${fmt(c.listPrice)}}`
  )
}
