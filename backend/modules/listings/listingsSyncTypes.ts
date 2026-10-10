export type SyncListingsRequest = {
  storeCode: string
}

export type SyncListingsResponse = {
  ok:          true
  storeCode:     string
  storeId:       number
  tradingRows:   number
  inserted:      number
  updated:       number
  skipped:       number
  errors:        number
  reconciled:    number
  /** Set when sync yields no rows or constraint blocks inserts. */
  syncHint:      string | null
}
