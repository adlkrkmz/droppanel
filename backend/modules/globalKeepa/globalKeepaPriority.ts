import type { CatalogPriorityInput, ListingPriorityRank } from "./globalKeepaTypes"
import {
  LISTING_PRIORITY_CLICKED,
  LISTING_PRIORITY_NORMAL,
  LISTING_PRIORITY_SOLD,
} from "./globalKeepaTypes"

/** Same listing decision tree as Stock Guard (total_sold / sold_30d / clicks_30d). */
export function listingPriorityRank(input: CatalogPriorityInput): ListingPriorityRank {
  const sold = (input.totalSold ?? 0) > 0 || (input.sold30d ?? 0) > 0
  if (sold) return LISTING_PRIORITY_SOLD
  if (input.clicks30d != null && input.clicks30d > 0) return LISTING_PRIORITY_CLICKED
  return LISTING_PRIORITY_NORMAL
}

/** Global ASIN priority = highest consumer listing priority (lowest rank number). */
export function globalAsinPriorityRank(listingRanks: ListingPriorityRank[]): ListingPriorityRank {
  if (listingRanks.length === 0) return LISTING_PRIORITY_NORMAL
  return listingRanks.reduce(
    (min, r) => (r < min ? r : min),
    LISTING_PRIORITY_NORMAL
  )
}
