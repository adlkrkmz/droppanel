export type GlobalKeepaRadarStatus =
  | "KEEPA_OK"
  | "FBA_PRESENT"
  | "FBA_MISSING"
  | "PRICE_CHANGED"
  | "PRICE_UNCHANGED"
  | "PRICE_AMBIGUOUS"
  | "CHECK_FAILED"
  | "STALE_DATA"
  | "PRODUCT_NOT_RETURNED"

export type GlobalKeepaPriceConfidence =
  | "CONFIRMED_FBA"
  | "AMBIGUOUS"
  | "NONE"
  | "FAILED"

export type ListingPriorityRank = 0 | 1 | 2

export const LISTING_PRIORITY_SOLD: ListingPriorityRank = 0
export const LISTING_PRIORITY_CLICKED: ListingPriorityRank = 1
export const LISTING_PRIORITY_NORMAL: ListingPriorityRank = 2

export type KeepaTokenFields = {
  tokensLeft: number | null
  refillRate: number | null
  refillIn: number | null
  tokensConsumed: number | null
  processingTimeInMs: number | null
}

export type KeepaRadarProductFields = {
  asin: string
  amazonPriceUsd: number | null
  newPriceUsd: number | null
  newFbaCount: number | null
  newFbmCount: number | null
  lastUpdateMinutes: number | null
  lastPriceChangeMinutes: number | null
  lastUpdateAt: Date | null
  lastPriceChangeAt: Date | null
}

export type KeepaRadarClassification = {
  status: GlobalKeepaRadarStatus
  priceConfidence: GlobalKeepaPriceConfidence
  fields: KeepaRadarProductFields | null
}

export type CatalogPriorityInput = {
  totalSold: number | null
  sold30d: number | null
  clicks30d: number | null
}

export type GlobalAsinConsumerRow = {
  catalogStateId: number
  workspaceId: string
  storeId: number
  registryAsin: string | null
  sourceUrl: string | null
  internalSku: string
  totalSold: number | null
  sold30d: number | null
  clicks30d: number | null
  ebayItemId: string | null
  asinRegistryId: number | null
  currentStatus: string | null
  panelHiddenAt: string | null
}
