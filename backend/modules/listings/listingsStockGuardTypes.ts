export const SOURCE_STATUS_VALUES = [
  "AMAZON_OK",
  "UNAVAILABLE",
  "NO_PRICE",
  "REMOVED",
  "CHECK_FAILED",
  "NO_ASIN",
  "BOT_ZEROED",
] as const

export type SourceStatusValue = (typeof SOURCE_STATUS_VALUES)[number]

export type ListingItemRef = {
  ebayItemId?:     string
  catalogStateId?: number
}

export type StockGuardRequest = {
  storeCode: string
  items:     ListingItemRef[]
  enabled:   boolean
}

export type ListingActionResult = {
  ebayItemId?:     string
  catalogStateId?: number
  status:          "UPDATED" | "NOT_FOUND"
  message?:        string
}

export type StockGuardResponse = {
  ok:       true
  updated:  number
  notFound: number
  results:  ListingActionResult[]
}

export type RemoveFromListRequest = {
  storeCode: string
  items:     ListingItemRef[]
}

export type RemoveFromListResponse = StockGuardResponse

export type RestoreToListRequest = {
  storeCode: string
  items:     ListingItemRef[]
}

export type RestoreToListResponse = StockGuardResponse

export type SourceStatusRequest = {
  storeCode:          string
  items:              ListingItemRef[]
  sourceStatus:       SourceStatusValue
  sourceStatusReason?: string | null
}

export type SourceStatusResponse = StockGuardResponse

export function isSourceStatusValue(v: string): v is SourceStatusValue {
  return (SOURCE_STATUS_VALUES as readonly string[]).includes(v)
}
