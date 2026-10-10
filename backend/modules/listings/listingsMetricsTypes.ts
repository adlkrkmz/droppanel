export type SyncMetricsRequest = {
  storeCode:    string
  mode?:        "all"
  ebayItemIds?: string[]
}

export type SyncMetricsItemResult = {
  ebayItemId: string
  status:     "UPDATED" | "NOT_FOUND" | "SKIPPED"
  message?:   string
}

export type SyncMetricsResponse = {
  ok:                 true
  storeCode:            string
  processed:            number
  updated:              number
  notFound:             number
  analyticsAvailable:   boolean
  analyticsError:       string | null
  /** Human-readable hint when sync yields no updates (token, empty catalog, etc.). */
  syncHint:             string | null
  results:              SyncMetricsItemResult[]
}

export type ListingMetricsSnapshot = {
  listingId:        string
  totalSold:        number | null
  watchCount:       number | null
  listedAt:         string | null
  clicks30d:        number | null
  views30d:         number | null
  impressions30d:   number | null
  metricsSource:    string
  metricsError:     string | null
}
