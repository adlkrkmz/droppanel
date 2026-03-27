// ─────────────────────────────────────────────────────────────
// monitorTypes.ts
// ─────────────────────────────────────────────────────────────

export type MonitorItemStatus = "TRACKED" | "UNTRACKED"

export type MonitorItem = {
  sku:          string
  title:        string
  image:        string | null
  ebayPrice:    number
  quantity:     number
  cost:         number | null
  margin:       number | null
  asin:         string | null
  ebayItemId:   string | null
  listedAt:     string | null
  status:       MonitorItemStatus
  poolId:       number | null
  stage:        string | null
}

export type MonitorListingsResult = {
  store:              string
  /** Sıralanmış tüm monitor satırları (sayfalama öncesi) */
  total:              number
  /** getInventoryItems.total — eBay envanter kayıt sayısı (Total kartı) */
  ebayInventoryTotal: number
  tracked:            number
  untracked:          number
  simulationMode:     boolean
  items:              MonitorItem[]
  generatedAt:        string
  currentPage:        number
  totalPages:         number
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
