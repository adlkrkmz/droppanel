// ─────────────────────────────────────────────────────────────
// ebayApiTypes.ts
// eBay Inventory API tip tanımları
// Kaynak: https://developer.ebay.com/api-docs/sell/inventory/overview.html
// ─────────────────────────────────────────────────────────────

// ─── INVENTORY ITEM ───────────────────────────────────────────

export type EbayCondition =
  | "NEW"
  | "LIKE_NEW"
  | "NEW_OTHER"
  | "NEW_WITH_DEFECTS"
  | "CERTIFIED_REFURBISHED"
  | "USED_EXCELLENT"
  | "USED_VERY_GOOD"
  | "USED_GOOD"
  | "USED_ACCEPTABLE"
  | "FOR_PARTS_OR_NOT_WORKING"

export type EbayAvailability = {
  shipToLocationAvailability: {
    quantity: number
  }
}

export type EbayProductAspects = Record<string, string[]>

/** brand tekil alan olarak gönderme — yalnızca aspects["Brand"] kullan (BrandMPN hatası önlenir) */
export type EbayProduct = {
  title:       string
  description: string
  brand?:      string
  aspects?:    EbayProductAspects
  imageUrls?:  string[]
}

// PUT /sell/inventory/v1/inventory_item/{sku}
export type EbayInventoryItemRequest = {
  availability: EbayAvailability
  condition: EbayCondition
  product: EbayProduct
}

export type EbayInventoryItemResponse = {
  sku: string
  statusCode: number          // 200 güncellendi, 201 oluşturuldu
  warnings?: EbayApiWarning[]
}

// ─── OFFER ────────────────────────────────────────────────────

export type EbayOfferPricingSummary = {
  price: {
    value: string             // "29.99"
    currency: string          // "USD"
  }
}

export type EbayListingPolicies = {
  fulfillmentPolicyId: string
  paymentPolicyId:     string
  returnPolicyId:      string
}

// POST /sell/inventory/v1/offer
export type EbayCreateOfferRequest = {
  sku:               string
  marketplaceId:     string   // "EBAY_US"
  format:            string   // "FIXED_PRICE"
  availableQuantity: number
  categoryId:        string
  listingDescription: string
  listingPolicies:   EbayListingPolicies
  pricingSummary:    EbayOfferPricingSummary
  merchantLocationKey?: string
}

export type EbayCreateOfferResponse = {
  offerId: string
  warnings?: EbayApiWarning[]
}

// PUT /sell/inventory/v1/offer/{offerId}
export type EbayUpdateOfferRequest = {
  categoryId:          string
  pricingSummary:      EbayOfferPricingSummary
  listingDescription:  string
  listingPolicies:     EbayListingPolicies
  merchantLocationKey: string
}

// POST /sell/inventory/v1/offer/{offerId}/publish
export type EbayPublishOfferResponse = {
  listingId: string
  warnings?: EbayApiWarning[]
}

// ─── SHARED ───────────────────────────────────────────────────

export type EbayApiWarning = {
  errorId:     number
  domain:      string
  category:    string
  message:     string
  parameters?: Array<{ name: string; value: string }>
}

export type EbayApiError = {
  errorId:  number
  domain:   string
  category: string
  message:  string
  longMessage?: string
}

export type EbayApiErrorResponse = {
  errors: EbayApiError[]
}

// ─── FLOW RESULT ──────────────────────────────────────────────
// Her ASIN için pipeline sonucu

export type InventoryFlowStatus = "ok" | "failed" | "simulated" | "FAILED"

export type InventoryFlowResult = {
  poolId:               number
  asin:                 string
  sku:                  string
  inventoryItemStatus:  InventoryFlowStatus
  offerStatus:          InventoryFlowStatus
  publishStatus:        InventoryFlowStatus
  ebayOfferId:          string | null
  ebayListingId:        string | null
  error:                string | null
  durationMs:           number
}

export type EbayListingPayload = {
  itemSpecifics?: Record<string, string>
}

// ─── CLIENT CONFIG ────────────────────────────────────────────

export type EbayClientConfig = {
  oauthToken:    string
  sandbox:       boolean           // true = sandbox, false = production
  simulationMode?: boolean         // true = hiç HTTP çağrısı yapma
}
