// ─────────────────────────────────────────────────────────────
// monitorTypes.ts
// ─────────────────────────────────────────────────────────────

export type MonitorItem = {
  catalogStateId: number | null
  sku:         string
  title:       string
  ebayItemId:  string | null
  ebayPrice:   number
  quantity:    number
  cost:        number | null
  isTracked:   boolean
  lastSyncAt:  string | null
  margin:      number | null
  asin:        string | null
  image:       string | null
  sourceUrl:   string | null
  listedAt:    string | null
  currentStatus: string | null
  stockGuardEnabled:  boolean
  panelHiddenAt:      string | null
  sourceStatus:       string | null
  sourceStatusReason: string | null
  sourcePrice:        number | null
  sourceCheckedAt:    string | null
  botZeroedAt:        string | null
  botZeroedReason:    string | null
  botZeroedBy:        string | null
  totalSold:          number | null
  sold30d:            number | null
  clicks30d:          number | null
  clicks30dCheckedAt: string | null
  views30d:           number | null
  impressions30d:     number | null
  watchCount:         number | null
  metricsSyncedAt:    string | null
  metricsSource:      string | null
  metricsError:       string | null
  autoPriceProtectedAt: string | null
}

export type GetMonitorListingsOptions = {
  includeHidden?: boolean
  search?:     string
  status?:      string
  sortBy?:       string
  sortDir?:      string
}

export type MonitorListingsResult = {
  store:              string
  /** Filtered result count (pagination total) */
  total:              number
  ebayInventoryTotal: number
  tracked:            number
  untracked:          number
  simulationMode:     boolean
  items:              MonitorItem[]
  generatedAt:        string
  currentPage:        number
  totalPages:         number
  pageSize:           number
  appliedSortBy?:      string | null
  appliedSortDir?:     string | null
  storeSync?: {
    lastCatalogSyncAt: string | null
    lastMetricsSyncAt: string | null
    syncStatus:        string | null
    syncError:         string | null
  }
}

// eBay Inventory API response shapes (simplified)
export type EbayInventoryItemSummary = {
  sku:       string
  title?:    string
  imageUrls?: string[]
  quantity?: number
}

export type EbayOfferSummary = {
  sku:       string
  offerId:   string
  price?: {
    value: string
    currency: string
  }
  availableQuantity?: number
  listingId?: string
  status?: string
}

export type EbayGetInventoryItemsResponse = {
  inventoryItems?: {
    sku:     string
    product?: {
      title?:     string
      imageUrls?: string[]
    }
    availability?: {
      shipToLocationAvailability?: {
        quantity?: number
      }
    }
  }[]
  total?: number
  href?:  string
  next?:  string
  limit?: number
  offset?: number
}

export type EbayGetOffersResponse = {
  offers?: {
    sku:     string
    offerId: string
    pricingSummary?: {
      price?: {
        value:    string
        currency: string
      }
    }
    availableQuantity?: number
    listing?: {
      listingId: string
    }
    status?: string
  }[]
  total?: number
  next?:  string
  limit?: number
  offset?: number
}
