export type ImportMatchRowInput = {
  ebayItemId: string
  asin:       string
}

export type ImportMatchRequest = {
  storeCode: string
  rows:      ImportMatchRowInput[]
}

export type ImportMatchStatus =
  | "UPDATED"
  | "ALREADY_EXISTS"
  | "EBAY_NOT_FOUND"
  | "INVALID_ASIN"
  | "DUPLICATE_EBAY_ID"
  | "DUPLICATE_ASIN_WARNING"
  | "STORE_CONFLICT"
  | "FAILED"

export type ImportMatchRowResult = {
  row:        number
  ebayItemId: string
  asin:       string
  status:     ImportMatchStatus
  message:    string
}

export type ImportMatchSummary = {
  total:          number
  matched:        number
  updated:        number
  alreadyExists:  number
  invalidAsin:    number
  ebayNotFound:   number
  storeConflict:  number
  duplicate:      number
  failed:         number
}

export type ImportMatchResponse = {
  ok:      true
  summary: ImportMatchSummary
  results: ImportMatchRowResult[]
}
