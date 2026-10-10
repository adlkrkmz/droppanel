// ----------------------------------------------------------------
// appTypes.ts — user-scoped /app/* API types (Phase 2)
// ----------------------------------------------------------------

export type AppStoreConnectionHint = "connected" | "reconnect_suggested" | "inactive"

export type AppStoreSummary = {
  storeId:               number
  storeCode:             string
  name:                  string
  status:                string
  connected:             boolean
  connectionHint:        AppStoreConnectionHint
  ebayExpiresAt:         string | null
  listingCount:          number
  stockAlertsCount:      number
  asinLinkedCount:       number
  needsAsinCount:        number
  asinCompletionPercent: number
  hasMarketingScope?:    boolean
  marketingAccess?: {
    granted: boolean
    code: "MARKETING_SCOPE_REQUIRED" | null
  }
}

export type AppStoresResponse = {
  ok:     true
  stores: AppStoreSummary[]
}

export type AppDashboardSummary = {
  storeCount:            number
  connectedStoreCount:   number
  listingCount:          number
  activeListingCount:    number
  pendingStockAlerts:    number
  lastImportAt:          string | null
  asinLinkedCount:       number
  needsAsinCount:        number
  asinCompletionPercent: number
}

export type AppOnboardingStatus = {
  needsEbayConnect: boolean
  needsImport:      boolean
  needsSettings:    boolean
}

export type AppDashboardResponse = {
  ok:         true
  summary:    AppDashboardSummary
  onboarding: AppOnboardingStatus
}

export type AppListingItem = {
  catalogStateId:         number
  ebayItemId:             string | null
  title:                  string | null
  imageUrl:               string | null
  internalSku:            string | null
  sourceUrl:              string | null
  asin:                   string | null
  ebayPrice:              number | null
  sourcePrice:            number | null
  sourcePriceSource:      string | null
  sourceStatus:           string | null
  sourceStatusReason:     string | null
  ebayQuantity:           number | null
  listedAt:               string | null
  totalSold:              number | null
  clicks30d:              number | null
  clicks30dCheckedAt:     string | null
  status:                 string | null
  autoPriceProtectedAt:   string | null
  autoPriceOldEbayPrice:  number | null
  autoPriceNewEbayPrice:  number | null
  stockGuardEnabled:      boolean
  lastCheckedAt:          string | null
  updatedAt:              string | null
  promotion?: {
    requested: boolean
    requestedRate: number | null
    status: "OFF" | "PENDING" | "ACTIVE" | "FAILED" | "UNKNOWN"
    effectiveRate: number | null
    campaignId: string | null
    adId: string | null
    code: string | null
    message: string
    retryable: boolean
  }
}

export type AppListingsFilter =
  | "all"
  | "needs-asin"
  | "asin-linked"
  | "source-tracked"
  | "source-missing"
  | "guard-on"
  | "guard-off"
  | "qty0"
  | "bot_zeroed"
  | "unavailable"
  | "no_price"
  | "check_failed"

export type AppListingsSort = "title" | "asin" | "ebayPrice" | "sourcePrice" | "quantity" | "status" | "stockGuard" | "profitProtection" | "updated" | "listedAt" | "totalSold" | "clicks30d"

export type AppListingsResponse = {
  ok:        true
  storeCode: string
  storeId?:  number
  page:      number
  limit:     number
  filter:    AppListingsFilter
  total:     number
  items:     AppListingItem[]
  hasMarketingScope?: boolean
  marketingAccess?: {
    granted: boolean
    code: "MARKETING_SCOPE_REQUIRED" | null
  }
}

export type AppImportStatusResponse = {
  ok:                 true
  storeId?:           number
  storeCode:          string
  syncStatus:         string | null
  lastCatalogSyncAt:  string | null
  syncStartedAt:      string | null
  syncError:          string | null
  listingCount:       number
  activeListingCount: number
  pendingAlerts:      number
  updatedAt:          string | null
}

export type AppImportMatchRowInput = {
  ebayItemId: string
  asin:       string
}

export type AppImportMatchRowResult = {
  ebayItemId: string
  asin:       string
  status:     string
  message:    string
}

export type AppImportMatchSummary = {
  total:         number
  matched:       number
  updated:       number
  alreadyExists: number
  invalidAsin:   number
  ebayNotFound:  number
  storeConflict: number
  duplicate:     number
  failed:        number
}

export type AppImportMatchResponse = {
  ok:        true
  storeCode: string
  total:     number
  matched:   number
  skipped:   number
  failed:    number
  summary:   AppImportMatchSummary
  results:   AppImportMatchRowResult[]
}

export type AppRecommendedPriceResponse = {
  ok:                   true
  catalogStateId:       number
  amazonPrice:          number
  currentEbayPrice:     number
  storeMarkupPercent:   number
  recommendedEbayPrice: number
  pricingSource:        string
  promotionAdRatePercent?: number | null
  promotionFeeImpactPercent?: number | null
  unpromotedRecommendedEbayPrice?: number | null
  promotedRecommendedEbayPrice?: number | null
}

export type AppUpdateListingPriceRequest = {
  storeCode:      string
  catalogStateId: number
  /** Explicit seller-confirmed USD listing price. */
  price?:         number
  confirm:        true
}

export type AppUpdateListingPriceResponse = {
  ok:            true
  storeCode:     string
  catalogStateId: number
  ebayItemId:    string | null
  oldEbayPrice:  number
  newEbayPrice:  number
  pricingSource: string
  message:       string
}

export type AppListingStockGuardUpdateResponse = {
  ok:                true
  storeCode:         string
  catalogStateId:    number
  stockGuardEnabled: boolean
  message:           string
}

export type AppBulkListingStockGuardItemResult = {
  catalogStateId:   number
  ok:               boolean
  stockGuardEnabled?: boolean
  message?:         string
  error?:           string
}

export type AppBulkListingStockGuardResponse = {
  ok:                true
  storeCode:         string
  batchId:           string
  requested:         number
  succeeded:         number
  failed:            number
  stockGuardEnabled: boolean
  results:           AppBulkListingStockGuardItemResult[]
}

export type AppBulkHideListingItemResult = {
  catalogStateId: number
  ok:             boolean
  hidden?:        boolean
  message?:       string
  error?:         string
}

export type AppBulkHideListingsResponse = {
  ok:        true
  storeCode: string
  batchId:   string
  requested: number
  succeeded: number
  failed:    number
  results:   AppBulkHideListingItemResult[]
}

export type AppBulkEndListingItemResult = {
  catalogStateId: number
  ok:             boolean
  ebayItemId?:    string
  status?:        string
  message?:       string
  error?:         string
}

export type AppBulkEndListingsResponse = {
  ok:        true
  storeCode: string
  batchId:   string
  requested: number
  succeeded: number
  failed:    number
  results:   AppBulkEndListingItemResult[]
}

export type AppSetListingQuantityResponse = {
  ok:             true
  storeCode:      string
  catalogStateId: number
  ebayItemId?:    string
  oldQuantity:    number
  newQuantity:    number
  message:        string
}

export type AppBulkSetListingQuantityItemResult = {
  catalogStateId: number
  ok:             boolean
  outcome:        "succeeded" | "failed" | "uncertain"
  ebayItemId?:    string
  oldQuantity?:   number
  newQuantity?:   number
  message?:       string
  error?:         string
}

export type AppBulkSetListingQuantityResponse = {
  ok:        true
  storeCode: string
  batchId:   string
  quantity:  number
  requested: number
  succeeded: number
  failed:    number
  uncertain: number
  results:   AppBulkSetListingQuantityItemResult[]
}

export type AppUpdateSourceAsinResponse = {
  ok:             true
  storeCode:      string
  catalogStateId: number
  asin:           string
  previousAsin:   string | null
  message:        string
}

export type AppEndListingResponse = {
  ok:             true
  storeCode:      string
  catalogStateId: number
  ebayItemId?:    string
  status:         "removed" | "ended"
  message:        string
}

export type AppEbayStoreStatus = {
  storeCode:  string
  name:       string
  status:     string
  connected:  boolean
}

export type AppEbayStatusResponse = {
  ok:        true
  connected: boolean
  stores:    AppEbayStoreStatus[]
}

export type AppEbayConnectResponse = {
  ok:      true
  authUrl: string
}

export type AppStockAlertStatus =
  | "pending"
  | "processing"
  | "actioned"
  | "ignored"
  | "failed"
  | "all"

export type AppStockAlertRisk =
  | "all"
  | "needs-review"
  | "price-increase"
  | "source-unavailable"
  | "no-trusted-price"
  | "check-failed"

export type AppStockAlertItem = {
  alertId:            number
  catalogStateId:     number
  ebayItemId:         string | null
  asin:               string
  sourceStatus:       string
  sourceStatusReason: string | null
  verificationSource: string | null
  reviewStatus:       string
  ebayPrice:          number | null
  sourcePrice:        number | null
  oldSourcePrice:     number | null
  newSourcePrice:     number | null
  priceChangePercent: number | null
  actionError:        string | null
  createdAt:          string
  updatedAt:          string
  listingTitle:       string | null
  currentDbPrice:     number | null
  ebayQuantity:       number | null
  imageUrl?:          string | null
  storeId?:           number
}

export type AppStockAlertsResponse = {
  ok:        true
  storeCode: string
  storeId?:  number
  status:    AppStockAlertStatus
  risk:      AppStockAlertRisk
  q:         string | null
  page:      number
  limit:     number
  total:     number
  items:     AppStockAlertItem[]
}

export type AppStockAlertIgnoreResponse = {
  ok:           true
  storeCode:    string
  alertId:      number
  reviewStatus: "ignored"
  message:      string
}

export type AppBulkIgnoreStockAlertItemResult = {
  alertId:      number
  ok:           boolean
  reviewStatus?: string
  message?:     string
  error?:       string
}

export type AppBulkIgnoreStockAlertsResponse = {
  ok:        true
  storeCode: string
  batchId:   string
  requested: number
  succeeded: number
  failed:    number
  results:   AppBulkIgnoreStockAlertItemResult[]
}

export type AppStockAlertApproveZeroResponse = {
  ok:             true
  storeCode:      string
  alertId:        number
  catalogStateId: number
  ebayItemId:     string
  oldQuantity:    number
  newQuantity:    0
  reviewStatus:   "actioned"
  message:        string
}

export type AppBulkApproveZeroStockAlertItemResult = {
  alertId:         number
  ok:              boolean
  catalogStateId?: number
  ebayItemId?:     string
  oldQuantity?:    number | null
  newQuantity?:    number
  reviewStatus?:   string
  message?:        string
  error?:          string
}

export type AppBulkApproveZeroStockAlertsResponse = {
  ok:        true
  storeCode: string
  batchId:   string
  requested: number
  succeeded: number
  failed:    number
  results:   AppBulkApproveZeroStockAlertItemResult[]
}

export type AppStockGuardSettings = {
  enabled:                     boolean
  mode:                        "manual" | "auto"
  priceIncreaseAlertsEnabled:  boolean
  autoProfitProtectionEnabled: boolean
  lastScanAt:                  string | null
  lastRunStatus:               string | null
  updatedAt:                   string | null
}

export type AppStockGuardSettingsResponse = {
  ok:        true
  storeCode: string
  settings:  AppStockGuardSettings
}

export type AppStockGuardSettingsUpdateResponse = {
  ok:        true
  storeCode: string
  settings:  AppStockGuardSettings
  message:   string
}

export type AppStockGuardStatus = {
  enabled:                     boolean
  mode:                        "manual" | "auto"
  lastScanAt:                  string | null
  lastCompletedScanAt:         string | null
  lastRunStatus:               string | null
  lastError:                   string | null
  pendingAlertsCount:          number
  processingAlertsCount:       number
  failedAlertsCount:           number
  actionedAlertsCount:         number
  ignoredAlertsCount:          number
  protectedListingsCount:      number | null
  zeroQuantityListingsCount:   number | null
  keepaRadar?:                 "Running" | "Off"
  lastKeepaScanAt?:            string | null
  activeAsins?:                number | null
  dueAsins?:                   number | null
  pendingVerificationTasks?:   number
  waitingForWorkerTasks?:      number
  onlineExtensionWorkers?:     number
  lastVerifiedSourceAt?:       string | null
  lastProtectionActionAt?:     string | null
}

export type AppStockGuardStatusResponse = {
  ok:        true
  storeCode: string
  status:    AppStockGuardStatus
}

export type AppSettingsMarkupResponse = {
  ok:            true
  storeCode:     string
  markupPercent: number
}

export type AppSettingsAddressResponse = {
  ok:                     true
  storeCode:              string
  addressSaved:           boolean
  ebayLocationSynced:     boolean
  ebayLocationSyncError?: string
}

export type AppSettingsPoliciesResponse = {
  ok:                  true
  storeCode:           string
  fulfillmentPolicyId: string | null
  paymentPolicyId:     string | null
  returnPolicyId:      string | null
}

export type AppSettingsWarehouseBannerResponse = {
  ok:                           true
  storeCode:                    string
  warehouseShippingBannerEnabled: boolean
}

export type AppActivityActionFilter =
  | "all"
  | "bulk"
  | "listings"
  | "stock-alerts"
  | "stock-guard"
  | "settings"
  | "ebay"
  | "failed"

export type AppActivityResult = "success" | "partial" | "failed"

export type AppActivityItem = {
  id:              string
  action:          string
  label:           string
  targetType:      string | null
  targetId:        string | null
  storeCode:       string | null
  batchId:         string | null
  requested:       number | null
  succeeded:       number | null
  failed:          number | null
  summary:         string | null
  result:          AppActivityResult
  createdAt:       string
  metadataPreview: Record<string, unknown>
}

export type AppActivityResponse = {
  ok:    true
  page:  number
  limit: number
  total: number
  items: AppActivityItem[]
}

export type AppOrderStatus = "new" | "processing" | "updated" | "error"

export type AppOrderItem = {
  id:                   number
  orderId:              string
  storeCode:            string
  storeName:            string
  creationDate:         string | null
  buyerUsername:        string | null
  productTitle:         string
  imageUrl:             string | null
  quantity:             number
  total:                number
  currency:             string
  status:               AppOrderStatus
  operationStatus:      string
  operationStatusLabel: string
}

export type AppOrdersStoreError = {
  storeCode: string
  storeName: string
  message:   string
}

export type AppOrdersResponse = {
  ok:        true
  allStores: boolean
  storeCode: string | null
  orders:    AppOrderItem[]
  errors:    AppOrdersStoreError[]
}

export class AppHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "AppHttpError"
  }
}
