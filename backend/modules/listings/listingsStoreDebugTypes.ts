export type StoreListingsDebug = {
  storeCode:      string
  storeId:        number
  storeName:      string
  hasEbayAccount: boolean
  ebayUserId:     string | null
  tokenExpiresAt: string | null
  catalogTotal:   number
  visibleCount:   number
  hiddenCount:    number
  endedCount:     number
  withEbayItemId: number
  withAsin:       number
  lastSyncAt:     string | null
}
