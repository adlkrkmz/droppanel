import { getBackendApiBase } from "./api"
import type {
  AppDashboardResponse,
  AppEbayConnectResponse,
  AppEbayStatusResponse,
  AppListingsFilter,
  AppListingsSort,
  AppListingsResponse,
  AppListingItem,
  AppListingsSyncResponse,
  AppRecommendedPriceResponse,
  AppUpdateListingPriceResponse,
  AppListingStockGuardUpdateResponse,
  AppBulkListingStockGuardResponse,
  AppBulkHideListingsResponse,
  AppBulkEndListingsResponse,
  AppUpdateSourceAsinResponse,
  AppEndListingResponse,
  AppSetListingQuantityResponse,
  AppBulkSetListingQuantityResponse,
  AppImportStatusResponse,
  AppImportMatchRow,
  AppImportMatchResult,
  AppImportMatchResponse,
  AppSettingsResponse,
  AppSettingsAddressPayload,
  AppSettingsAddressResponse,
  AppSettingsMarkupResponse,
  AppSettingsPoliciesPayload,
  AppSettingsPoliciesResponse,
  AppSettingsPricingPayload,
  AppSettingsWarehouseBannerResponse,
  AppPoliciesResponse,
  AppStockAlertsResponse,
  AppStockAlertIgnoreResponse,
  AppBulkIgnoreStockAlertsResponse,
  AppBulkApproveZeroStockAlertsResponse,
  AppStockAlertApproveZeroResponse,
  AppStockGuardSettings,
  AppStockGuardSettingsPayload,
  AppStockGuardSettingsResponse,
  AppStockGuardSettingsUpdateResponse,
  AppStockGuardStatus,
  AppStockGuardStatusResponse,
  AppStockAlertRisk,
  AppStockAlertStatus,
  AppStoresResponse,
  AppActivityResponse,
  AppActivityItem,
  AppActivityActionFilter,
  AppOrdersResponse,
} from "./userAppTypes"

export type { AppListingsSort } from "./userAppTypes"

export type {
  AppDashboardResponse,
  AppEbayStatusResponse,
  AppEbayConnectResponse,
  AppEbayStoreStatus,
  AppListingItem,
  AppListingsFilter,
  AppListingsResponse,
  AppListingsSyncResponse,
  AppRecommendedPriceResponse,
  AppUpdateListingPriceResponse,
  AppListingStockGuardUpdateResponse,
  AppBulkListingStockGuardResponse,
  AppBulkHideListingsResponse,
  AppBulkEndListingsResponse,
  AppUpdateSourceAsinResponse,
  AppEndListingResponse,
  AppSetListingQuantityResponse,
  AppBulkSetListingQuantityResponse,
  AppImportStatusResponse,
  AppImportMatchRow,
  AppImportMatchResult,
  AppImportMatchResponse,
  AppSettingsResponse,
  AppSettingsAddressPayload,
  AppSettingsAddressResponse,
  AppSettingsMarkupResponse,
  AppSettingsPoliciesPayload,
  AppSettingsPoliciesResponse,
  AppSettingsWarehouseBannerResponse,
  AppStockAlertItem,
  AppStockAlertsResponse,
  AppStockAlertIgnoreResponse,
  AppBulkIgnoreStockAlertsResponse,
  AppBulkApproveZeroStockAlertsResponse,
  AppStockAlertApproveZeroResponse,
  AppStockGuardSettings,
  AppStockGuardSettingsPayload,
  AppStockGuardSettingsResponse,
  AppStockGuardSettingsUpdateResponse,
  AppStockGuardStatus,
  AppStockGuardStatusResponse,
  AppStockAlertRisk,
  AppStockAlertStatus,
  AppStoreSettings,
  AppStoreAddress,
  AppStoresResponse,
  AppStoreSummary,
  AppActivityResponse,
  AppActivityItem,
  AppActivityActionFilter,
  AppOrderItem,
  AppOrderStatus,
  AppOrdersStoreError,
  AppOrdersResponse,
} from "./userAppTypes"

async function appFetch<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string; approvalStatus?: string }> {
  const res = await fetch(`${getBackendApiBase()}${path}`, {
    cache: "no-store",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  const data = await res.json().catch(() => ({}))

  if (res.status === 401) {
    return { ok: false, status: 401, error: "Unauthorized" }
  }

  if (res.status === 403) {
    return {
      ok:             false,
      status:         403,
      error:          data.message ?? data.error ?? "Forbidden",
      approvalStatus: data.approvalStatus,
    }
  }

  if (!res.ok) {
    return { ok: false, status: res.status, error: data.error ?? `HTTP ${res.status}` }
  }

  return { ok: true, data: data as T }
}

export async function fetchAppDashboard() {
  return appFetch<AppDashboardResponse>("/app/dashboard")
}

export type AppDashboardFinanceWindow = {
  orderCount: number
  ebayGrossSales: number
  ebayRemainingEarnings: number
  remainingOnKnownCost: number
  amazonCostKnownTotal: number
  profitOnKnownCost: number | null
  costKnownCount: number
  costTotalCount: number
  profitMarginPercent: number | null
}

export type AppDashboardOpsResponse = {
  ok: true
  scope: "store" | "all"
  storeId: number | null
  storeCode: string | null
  kpis: {
    activeListings: number
    ordersToday: number
    grossSalesToday: number
    netProfitToday: number | null
    needsAttention: number
    storesWithIssues: number | null
  }
  finance: {
    today: AppDashboardFinanceWindow
    week: AppDashboardFinanceWindow
    month: AppDashboardFinanceWindow
  }
  pipeline: {
    newOrders: number
    amazonOrdered: number
    shipped: number
    delayed: number
    delivered: number
    actionRequired: number
  }
  needsAttention: Array<{
    id: string
    title: string
    explanation: string
    count: number
    severity: "high" | "medium" | "low"
    href: string | null
  }>
  customerService: {
    sentToday: number
    failed: number
    thankYouToday: number
    shippedToday: number
    delayedToday: number
    deliveredToday: number
  }
  listingHealth: {
    activeListings: number
    outOfStock: number
    stockAlerts: number
    needsAsin: number
  }
  storeRows: Array<{
    storeId: number
    storeCode: string
    storeName: string
    ordersToday: number
    grossSalesToday: number
    knownSourceCostToday: number
    netProfitToday: number | null
    costKnownCount: number
    costTotalCount: number
    activeListings: number
    alerts: number
  }>
  recentActivity: Array<{
    id: string
    at: string
    title: string
    detail: string | null
    href: string | null
  }>
}

export async function fetchAppDashboardOps(params: { storeCode?: string; allStores?: boolean; period?: "today" | "week" | "month" }) {
  const q = new URLSearchParams()
  q.set("period", params.period ?? "today")
  if (params.allStores) q.set("allStores", "true")
  else if (params.storeCode?.trim()) q.set("storeCode", params.storeCode.trim())
  return appFetch<AppDashboardOpsResponse>(`/app/dashboard/ops?${q.toString()}`)
}

export async function fetchAppStores() {
  return appFetch<AppStoresResponse>("/app/stores")
}

export async function fetchAppActivity(params: {
  storeCode?: string
  action?:   AppActivityActionFilter
  q?:        string
  page?:     number
  limit?:    number
}) {
  const q = new URLSearchParams()
  if (params.storeCode?.trim()) q.set("storeCode", params.storeCode.trim())
  if (params.action && params.action !== "all") q.set("action", params.action)
  if (params.q?.trim()) q.set("q", params.q.trim())
  q.set("page", String(params.page ?? 1))
  q.set("limit", String(params.limit ?? 50))
  return appFetch<AppActivityResponse>(`/app/activity?${q.toString()}`)
}

export async function fetchAppOrders(params: {
  storeCode?: string
  allStores?: boolean
}) {
  const q = new URLSearchParams()
  if (params.allStores) {
    q.set("allStores", "true")
  } else if (params.storeCode?.trim()) {
    q.set("storeCode", params.storeCode.trim())
  }
  return appFetch<AppOrdersResponse>(`/app/orders?${q.toString()}`)
}

export async function syncAppOrders(params: {
  storeCode?: string
  allStores?: boolean
}) {
  return appFetch<AppOrdersResponse>("/app/orders/sync", {
    method: "POST",
    body:   JSON.stringify({
      storeCode: params.storeCode,
      allStores: params.allStores === true,
    }),
  })
}

export async function fetchAppOrderDetail(orderId: number | string) {
  return appFetch<import("./api").OrderDetail>(
    `/app/orders/${encodeURIComponent(String(orderId))}`
  )
}

export async function updateAppOrderManual(
  orderId: number | string,
  payload: import("./api").OrderManualUpdateInput
) {
  return appFetch<import("./api").OrderDetail>(
    `/app/orders/${encodeURIComponent(String(orderId))}`,
    { method: "PATCH", body: JSON.stringify(payload) }
  )
}

export async function refreshAppOrderEarnings(orderId: number | string) {
  return appFetch<import("./api").OrderDetail>(
    `/app/orders/${encodeURIComponent(String(orderId))}/earnings`,
    { method: "POST", body: "{}" }
  )
}

export type AppMailboxAccount = {
  id: number
  email: string
  status: string
  lastIngestedAt: string | null
  lastError: string | null
}

export async function fetchAppMailboxStatus() {
  return appFetch<{
    ok: true
    accounts: AppMailboxAccount[]
  }>("/app/mailbox/status")
}

export async function startAppMailboxConnect() {
  return appFetch<{ ok: true; authUrl: string }>("/app/mailbox/connect")
}

export async function syncAppMailbox(accountId: number) {
  try {
    return await appFetch<{
      ok: true
      fetched: number
      bodiesFetched: number
      parsed: number
      matched: number
      needsReview: number
      ignored: number
      duplicates: number
      inserted: number
      processed: number
      lastError: string | null
    }>("/app/mailbox/sync", {
      method: "POST",
      body: JSON.stringify({ accountId }),
    })
  } catch (e) {
    const error = e instanceof Error ? e.message : "Mailbox sync failed"
    return { ok: false as const, status: 0, error }
  }
}

export async function disconnectAppMailbox(accountId: number) {
  return appFetch<{ ok: true }>("/app/mailbox/disconnect", {
    method: "POST",
    body: JSON.stringify({ accountId }),
  })
}

export async function fetchAppFinanceSummary(storeCode: string) {
  const q = new URLSearchParams({ storeCode })
  return appFetch<{
    ok: true
    storeCode: string
    storeId: number
    today: {
      orderCount: number
      ebayGrossSales: number
      ebayRemainingEarnings: number
      amazonCostKnownTotal: number
      profitOnKnownCost: number | null
      costKnownCount: number
      costTotalCount: number
    }
    week: {
      orderCount: number
      ebayGrossSales: number
      ebayRemainingEarnings: number
      amazonCostKnownTotal: number
      profitOnKnownCost: number | null
      costKnownCount: number
      costTotalCount: number
    }
  }>(`/app/finance/summary?${q.toString()}`)
}

export async function fetchAppOrderAssist(orderId: number | string, autoRun = false) {
  const qs = autoRun ? "?autoRun=1" : ""
  return appFetch<import("./api").AssistedOrderPacket>(
    `/app/orders/${encodeURIComponent(String(orderId))}/assist${qs}`
  )
}

export async function setAppOrderAssistAsin(orderId: number | string, asin: string) {
  return appFetch<{ asin: string }>(
    `/app/orders/${encodeURIComponent(String(orderId))}/assist-asin`,
    { method: "PATCH", body: JSON.stringify({ asin }) }
  )
}

export async function fetchAppEbayStatus() {
  return appFetch<AppEbayStatusResponse>("/app/ebay/status")
}

export async function startAppEbayConnect() {
  return appFetch<AppEbayConnectResponse>("/app/ebay/connect")
}

export async function startAppEbayReconnect(storeId: number) {
  return appFetch<AppEbayConnectResponse>("/app/ebay/reconnect", {
    method: "POST",
    body:   JSON.stringify({ storeId }),
  })
}

export async function removeAppStore(storeId: number) {
  return appFetch<{ ok: true; storeId: number; storeCode: string; status: string }>(
    "/app/stores/remove",
    {
      method: "POST",
      body:   JSON.stringify({ storeId, confirm: true }),
    }
  )
}

export async function fetchAppListings(params: {
  storeCode: string
  storeId?:  number
  page?:     number
  limit?:    number
  filter?:   AppListingsFilter
  sort?:     AppListingsSort | null
  direction?: "asc" | "desc"
  q?:        string
  signal?:   AbortSignal
}) {
  const q = new URLSearchParams({
    storeCode: params.storeCode,
    page:      String(params.page ?? 1),
    limit:     String(params.limit ?? 50),
    filter:    params.filter ?? "all",
    ...(params.storeId ? { storeId: String(params.storeId) } : {}),
    ...(params.sort ? { sort: params.sort } : {}),
    ...(params.direction ? { direction: params.direction } : {}),
    ...(params.q ? { q: params.q } : {}),
  })
  return appFetch<AppListingsResponse>(`/app/listings?${q.toString()}`, {
    signal: params.signal,
  })
}

export async function fetchAppRecommendedPrice(storeCode: string, catalogStateId: number) {
  const q = new URLSearchParams({
    storeCode,
    catalogStateId: String(catalogStateId),
  })
  return appFetch<AppRecommendedPriceResponse>(`/app/listings/recommended-price?${q.toString()}`)
}

export async function updateAppListingPrice(payload: {
  storeCode:      string
  catalogStateId: number
  price?:         number
  confirm:        true
}) {
  return appFetch<AppUpdateListingPriceResponse>("/app/listings/update-price", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function updateAppListingStockGuard(payload: {
  storeCode:      string
  catalogStateId: number
  enabled:        boolean
  confirm:        true
}) {
  return appFetch<AppListingStockGuardUpdateResponse>("/app/listings/stock-guard", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function bulkUpdateAppListingStockGuard(payload: {
  storeCode:       string
  catalogStateIds: number[]
  enabled:         boolean
  confirm:         true
}) {
  return appFetch<AppBulkListingStockGuardResponse>("/app/listings/bulk-stock-guard", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function bulkHideAppListings(payload: {
  storeCode:       string
  catalogStateIds: number[]
  confirm:         true
}) {
  return appFetch<AppBulkHideListingsResponse>("/app/listings/bulk-hide", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function bulkEndAppListings(payload: {
  storeCode:       string
  catalogStateIds: number[]
  confirm:         true
}) {
  return appFetch<AppBulkEndListingsResponse>("/app/listings/bulk-end", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function updateAppListingSourceAsin(payload: {
  storeCode:      string
  catalogStateId: number
  asin:           string
  confirm:        true
}) {
  return appFetch<AppUpdateSourceAsinResponse>("/app/listings/update-source-asin", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function endAppListing(payload: {
  storeCode:      string
  catalogStateId: number
  confirm:        true
}) {
  return appFetch<AppEndListingResponse>("/app/listings/end", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function setAppListingQuantity(payload: {
  storeId?:       number
  storeCode?:     string
  catalogStateId: number
  quantity:       0 | 1
  confirm:        true
  signal?:        AbortSignal
}) {
  return appFetch<AppSetListingQuantityResponse>("/app/listings/set-quantity", {
    method: "POST",
    body:   JSON.stringify(payload),
    signal: payload.signal,
  })
}

export async function bulkSetAppListingQuantity(payload: {
  storeId?:       number
  storeCode?:     string
  catalogStateIds: number[]
  quantity:        0 | 1
  confirm:         true
  signal?:         AbortSignal
}) {
  return appFetch<AppBulkSetListingQuantityResponse>("/app/listings/bulk-set-quantity", {
    method: "POST",
    body:   JSON.stringify(payload),
    signal: payload.signal,
  })
}

export async function applyAppListingPromotion(payload: {
  storeCode: string
  storeId?: number
  catalogStateId: number
  promotedEnabled: boolean
  promotedAdRate?: number | null
}) {
  return appFetch<{
    ok: true
    storeCode: string
    catalogStateId: number
    listingId: string
    promotion: AppListingItem["promotion"]
  }>("/app/listings/promotion", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function verifyAppListingPromotion(payload: {
  storeCode: string
  storeId?: number
  catalogStateId: number
}) {
  return appFetch<{
    ok: true
    storeCode: string
    catalogStateId: number
    listingId: string
    promotion: AppListingItem["promotion"]
  }>("/app/listings/promotion/verify", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function retryAppListingPromotion(payload: {
  storeCode: string
  storeId?: number
  catalogStateId: number
}) {
  return appFetch<{
    ok: true
    storeCode: string
    catalogStateId: number
    listingId: string
    promotion: AppListingItem["promotion"]
  }>("/app/listings/promotion/retry", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function bulkApplyAppListingPromotion(payload: {
  storeCode: string
  storeId?: number
  catalogStateIds: number[]
  promotedEnabled: boolean
  promotedAdRate?: number | null
}) {
  return appFetch<{
    ok: true
    storeCode: string
    requested: number
    succeeded: number
    failed: number
    results: Array<{ catalogStateId: number; ok: boolean; error?: string }>
  }>("/app/listings/bulk-promotion", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function syncAppListings(storeId: number) {
  return appFetch<AppListingsSyncResponse>("/app/listings/sync", {
    method: "POST",
    body:   JSON.stringify({ storeId }),
  })
}

export async function fetchAppImportStatus(params: { storeId: number } | { storeCode: string }) {
  const q = new URLSearchParams()
  if ("storeId" in params) {
    q.set("storeId", String(params.storeId))
  } else {
    q.set("storeCode", params.storeCode)
  }
  return appFetch<AppImportStatusResponse>(`/app/import/status?${q.toString()}`)
}

export async function importMatchAppListings(payload: {
  storeCode: string
  rows:      AppImportMatchRow[]
}) {
  return appFetch<AppImportMatchResponse>("/app/listings/import-match", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function fetchAppSettings(storeCode: string) {
  const q = new URLSearchParams({ storeCode })
  return appFetch<AppSettingsResponse>(`/app/settings?${q.toString()}`)
}

export async function fetchAppSettingsPolicies(storeCode: string) {
  const q = new URLSearchParams({ storeCode })
  return appFetch<AppPoliciesResponse>(`/app/settings/policies?${q.toString()}`)
}

export async function fetchAppStockAlerts(params: {
  storeCode: string
  page?:     number
  limit?:    number
  status?:   AppStockAlertStatus
  risk?:     AppStockAlertRisk
  q?:        string
  signal?:   AbortSignal
}) {
  const q = new URLSearchParams({
    storeCode: params.storeCode,
    page:      String(params.page ?? 1),
    limit:     String(params.limit ?? 50),
    status:    params.status ?? "all",
    risk:      params.risk ?? "all",
  })
  const search = params.q?.trim()
  if (search) {
    q.set("q", search)
  }
  return appFetch<AppStockAlertsResponse>(`/app/stock-alerts?${q.toString()}`, {
    signal: params.signal,
  })
}

export async function ignoreAppStockAlert(payload: {
  storeCode: string
  alertId:   number
  confirm:   true
}) {
  return appFetch<AppStockAlertIgnoreResponse>("/app/stock-alerts/ignore", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function bulkIgnoreAppStockAlerts(payload: {
  storeCode: string
  alertIds:  number[]
  confirm:   true
}) {
  return appFetch<AppBulkIgnoreStockAlertsResponse>("/app/stock-alerts/bulk-ignore", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function bulkApproveZeroAppStockAlerts(payload: {
  storeCode:          string
  alertIds:           number[]
  confirm:            true
  confirmationText:   "ZERO"
}) {
  return appFetch<AppBulkApproveZeroStockAlertsResponse>("/app/stock-alerts/bulk-approve-zero", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function approveZeroAppStockAlert(payload: {
  storeCode:          string
  alertId:            number
  confirm:            true
  confirmationText:   "ZERO"
}) {
  return appFetch<AppStockAlertApproveZeroResponse>("/app/stock-alerts/approve-zero", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function fetchAppStockGuardSettings(storeCode: string) {
  const q = new URLSearchParams({ storeCode })
  return appFetch<AppStockGuardSettingsResponse>(`/app/stock-guard/settings?${q.toString()}`)
}

export async function fetchAppStockGuardStatus(storeCode: string) {
  const q = new URLSearchParams({ storeCode })
  return appFetch<AppStockGuardStatusResponse>(`/app/stock-guard/status?${q.toString()}`)
}

export async function saveAppStockGuardSettings(payload: AppStockGuardSettingsPayload) {
  return appFetch<AppStockGuardSettingsUpdateResponse>("/app/stock-guard/settings", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export type AppCustomerServiceResponse = {
  ok: true
  storeCode: string
  storeName: string
  masterEnabled: boolean
  automations: Array<{
    type: string
    label: string
    enabled: boolean
    template: string
    status: string
    comingSoon: boolean
    placeholders: string[]
    helpText?: string
    stats: { sentToday: number; failed: number; lastSentAt: string | null }
  }>
  stats: { sentToday: number; failed: number; lastSentAt: string | null }
  recent: Array<{
    id: number
    ebayOrderId: string
    automationType: string
    status: string
    lastError: string | null
    createdAt: string
    sentAt: string | null
    sourceEventType: string | null
  }>
  ebayMessage: {
    api: string
    fallbackApi: string
    connected: boolean
    messageScopeGranted: boolean
    reconnectRequired: boolean
    reconnectCode: string | null
  }
  placeholders: string[]
}

export async function fetchAppCustomerService(storeCode: string) {
  const q = new URLSearchParams({ storeCode })
  return appFetch<AppCustomerServiceResponse>(`/app/customer-service?${q.toString()}`)
}

export async function saveAppThankYouSettings(payload: {
  storeCode: string
  enabled?: boolean
  template?: string
}) {
  return appFetch<{
    ok: true
    storeCode: string
    thankYou: { enabled: boolean; template: string }
    ebayMessage: AppCustomerServiceResponse["ebayMessage"]
  }>("/app/customer-service/thank-you", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function saveAppCsMaster(payload: {
  storeCode: string
  enabled: boolean
}) {
  return appFetch<{
    ok: true
    storeCode: string
    masterEnabled: boolean
    ebayMessage: AppCustomerServiceResponse["ebayMessage"]
  }>("/app/customer-service/master", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function saveAppCsAutomation(payload: {
  storeCode: string
  type: "THANK_YOU" | "SHIPPED" | "DELAYED" | "DELIVERED"
  template?: string
}) {
  return appFetch<{
    ok: true
    storeCode: string
    automation: { type: string; enabled: boolean; template: string }
    ebayMessage: AppCustomerServiceResponse["ebayMessage"]
  }>("/app/customer-service/automations", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function fetchAppCustomerServiceConversations(storeCode: string, opts?: { limit?: number; offset?: number }) {
  const q = new URLSearchParams({ storeCode })
  if (opts?.limit != null) q.set("limit", String(opts.limit))
  if (opts?.offset != null) q.set("offset", String(opts.offset))
  return appFetch<{
    ok: true
    storeCode: string
    reconnectRequired: boolean
    reconnectCode: string | null
    conversations: Array<{
      conversationId: string
      conversationType: "FROM_MEMBERS" | "FROM_EBAY"
      conversationStatus: string | null
      subject: string | null
      counterpartyDisplay: string
      lastPreview: string | null
      lastMessageAt: string | null
      unreadCount: number
      listingItemId: string | null
      relatedEbayOrderId: string | null
      relatedOrderId: number | null
    }>
    limit: number
    offset: number
    total: number
  }>(`/app/customer-service/conversations?${q.toString()}`)
}

export async function fetchAppCustomerServiceConversation(
  storeCode: string,
  conversationId: string,
  conversationType: "FROM_MEMBERS" | "FROM_EBAY"
) {
  const q = new URLSearchParams({ storeCode, conversationType })
  return appFetch<{
    ok: true
    storeCode: string
    conversationId: string
    conversationType: "FROM_MEMBERS" | "FROM_EBAY"
    conversationStatus: string | null
    subject: string | null
    messages: Array<{
      messageId: string | null
      messageBody: string | null
      createdDate: string | null
      senderDisplay: string
      recipientDisplay: string
      readStatus: boolean | null
      subject: string | null
      media: Array<{ mediaName: string | null; mediaType: string | null; mediaUrl: string | null }>
    }>
    total: number
  }>(`/app/customer-service/conversations/${encodeURIComponent(conversationId)}?${q.toString()}`)
}

export async function fetchAppBuyerMessageNotifications(storeCode: string) {
  const q = new URLSearchParams({ storeCode })
  return appFetch<{
    ok: true
    storeCode: string
    messageScopeGranted: boolean
    notificationUserScopeGranted: boolean
    destination: { endpoint: string; destinationId: string | null; configured: boolean }
    topics: Array<{
      topicId: string
      status: string
      subscriptionId: string | null
      topicScope: string | null
      error: string | null
    }>
    inboxUnreadHint: number
    lastNotificationTopic: string | null
    lastNotificationAt: string | null
    reconnectRequired: boolean
    notes: string[]
    error?: string | null
  }>(`/app/customer-service/message-notifications?${q.toString()}`)
}

export async function ensureAppBuyerMessageNotifications(storeCode: string) {
  return appFetch<{
    ok: true
    storeCode: string
    messageScopeGranted: boolean
    notificationUserScopeGranted: boolean
    destination: { endpoint: string; destinationId: string | null; configured: boolean }
    topics: Array<{
      topicId: string
      status: string
      subscriptionId: string | null
      topicScope: string | null
      error: string | null
    }>
    inboxUnreadHint: number
    lastNotificationTopic: string | null
    lastNotificationAt: string | null
    reconnectRequired: boolean
    notes: string[]
    ensured: boolean
    error: string | null
  }>("/app/customer-service/message-notifications/ensure", {
    method: "POST",
    body: JSON.stringify({ storeCode }),
  })
}

export async function replyAppCustomerServiceConversation(payload: {
  storeCode: string
  conversationId: string
  messageText: string
}) {
  return appFetch<{
    ok: true
    storeCode: string
    conversationId: string
    messageId: string | null
  }>("/app/customer-service/conversations/reply", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function fetchAppActivityFeed(storeCode?: string) {
  const q = new URLSearchParams()
  if (storeCode) q.set("storeCode", storeCode)
  const suffix = q.toString() ? `?${q.toString()}` : ""
  return appFetch<{ ok: true; items: Array<{
    id: number
    event_type: string
    severity: string
    title: string
    message: string
    asin: string | null
    created_at: string
    read_at: string | null
  }>; windowHours: number }>(`/app/activity-feed${suffix}`)
}

export async function fetchAppActivityUnread() {
  return appFetch<{ ok: true; unread: number }>("/app/activity-feed/unread")
}

export async function markAppActivityRead(ids: number[] | "all") {
  return appFetch<{ ok: true; updated: number }>("/app/activity-feed/read", {
    method: "POST",
    body: JSON.stringify(ids === "all" ? { all: true } : { ids }),
  })
}

export async function saveAppSettingsMarkup(storeCode: string, markupPercent: number) {
  return appFetch<AppSettingsMarkupResponse>("/app/settings/markup", {
    method: "POST",
    body:   JSON.stringify({ storeCode, markupPercent }),
  })
}

export async function saveAppSettingsPricing(payload: AppSettingsPricingPayload) {
  return appFetch<{ ok: true; settings: AppSettingsResponse["settings"] }>("/app/settings/pricing", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function saveAppSettingsAddress(payload: AppSettingsAddressPayload) {
  return appFetch<AppSettingsAddressResponse>("/app/settings/address", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function saveAppSettingsPolicies(payload: AppSettingsPoliciesPayload) {
  return appFetch<AppSettingsPoliciesResponse>("/app/settings/policies", {
    method: "POST",
    body:   JSON.stringify(payload),
  })
}

export async function saveAppWarehouseBanner(storeCode: string, warehouseShippingBannerEnabled: boolean) {
  return appFetch<AppSettingsWarehouseBannerResponse>("/app/settings/warehouse-banner", {
    method: "POST",
    body:   JSON.stringify({ storeCode, warehouseShippingBannerEnabled }),
  })
}

export type DesktopAgentDevicePublic = {
  deviceId: string
  deviceName: string
  status: string
  online: boolean
  version: string | null
  lastHeartbeatAt: string | null
  lastObservationAt: string | null
  successfulObservationsToday: number
  technicalFailuresToday: number
  scannedCount: number
  createdAt: string
}

export async function createDesktopAgentPairing() {
  return appFetch<{
    ok: boolean
    pairingCode: string
    expiresAt: string
    expiresInSeconds: number
  }>("/api/desktop-agent/pairing/create", {
    method: "POST",
    body: JSON.stringify({}),
  })
}

export async function fetchDesktopAgentDevices() {
  return appFetch<{
    ok: boolean
    workspaceId: string
    devices: DesktopAgentDevicePublic[]
  }>("/api/desktop-agent/devices")
}

export async function disconnectDesktopAgentDevice(deviceId: string) {
  return appFetch<{ ok: boolean; deviceId: string; status: string }>(
    `/api/desktop-agent/devices/${encodeURIComponent(deviceId)}/disconnect`,
    {
      method: "POST",
      body: JSON.stringify({}),
    }
  )
}
