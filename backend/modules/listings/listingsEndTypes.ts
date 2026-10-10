export type EndListingItemRef = {
  ebayItemId?:     string
  catalogStateId?: number
}

export type EndListingRequest = {
  storeCode: string
  items:     EndListingItemRef[]
}

export type EndListingResultStatus =
  | "ENDED_BY_OFFER"
  | "ENDED_BY_ITEM_ID"
  | "ENDED_LOCALLY"
  | "NOT_FOUND"
  | "FAILED"
  | "SIMULATION"

export type EndListingItemResult = {
  ebayItemId?:     string
  catalogStateId?: number
  status:          EndListingResultStatus
  message?:        string
}

export type EndListingResponse = {
  ok:       true
  ended:    number
  notFound: number
  failed:   number
  results:  EndListingItemResult[]
}
