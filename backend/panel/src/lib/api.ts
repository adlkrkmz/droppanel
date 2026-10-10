function resolveApiBase(): string {
  if (typeof window !== "undefined") {
    const host = window.location.hostname
    if (host === "localhost" || host === "127.0.0.1") {
      return "http://localhost:4000"
    }
  }

  const fromEnv = process.env.NEXT_PUBLIC_API_BASE?.trim()
  if (fromEnv) return fromEnv.replace(/\/$/, "")

  if (process.env.NODE_ENV === "development") {
    return "http://localhost:4000"
  }

  return "https://api.listjetgo.com"
}

export function getBackendApiBase(): string {
  return resolveApiBase()
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${getBackendApiBase()}${path}`, {
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      ...init,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      throw new Error(`API bağlantı hatası (${path}): sunucuya ulaşılamadı.`)
    }
    throw e
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let detail = text.trim()
    if (detail) {
      try {
        const parsed = JSON.parse(detail) as { message?: string; error?: string }
        if (typeof parsed.message === "string" && parsed.message.trim()) {
          detail = parsed.message.trim()
        } else if (typeof parsed.error === "string" && parsed.error.trim()) {
          detail = parsed.error.trim()
        }
      } catch {
        /* keep raw text */
      }
    }
    throw new Error(detail || `API ${res.status} ${res.statusText}: ${path}`)
  }
  return res.json() as Promise<T>
}

export type DashboardSummary = {
  asinRegistryTotal: number; asinPoolTotal: number; poolReady: number; poolCompleted: number
  pipelineStages: { validated: number; scraped: number; ai_generated: number; listed: number }
  storesTotal: number; storesActive: number; generatedAt: string
}
export type QueueSummary = {
  scrapeQueueCount: number; aiQueueCount: number; publishQueueCount: number; total: number; generatedAt: string
}
export type ListingHistoryRow = {
  id: number; asin: string; internalSku: string | null; ebayItemId: string | null
  storeName: string | null; status: string; listedAt: string | null; createdAt: string
}
export type StoreRow = { id: number; name: string; storeCode: string; status: string; createdAt: string }

export type PoolRow = {
  poolId: number; asin: string; title: string | null; brand: string | null
  amazonCost: number | null; pipelineStage: string; status: string
  scrapeStatus: string; aiStatus: string; listingStatus: string
  assignedStoreId: number | null; assignedStoreCode: string | null
  assignedStoreName: string | null; createdAt: string; updatedAt: string
  archivedAt: string | null; archivedBy: string | null; archiveReason: string | null
}
export type PoolView =
  | "active"
  | "ready"
  | "processing"
  | "assigned"
  | "failed"
  | "history"
  | "archived"
  | "all"

export type PoolResult = {
  rows: PoolRow[]; total: number
  filters: {
    view:      PoolView | null
    stage:     string | null
    status:    string | null
    storeCode: string | null
  }
  generatedAt: string
}
export type PoolSkipDetail = {
  poolId?: number
  asin?:  string | null
  reason: string
}

export type PoolDispatchRequest  = {
  storeCode: string
  poolIds?:  number[]
  asins?:    string[]
  delaySeconds?: number
}
export type PoolDispatchResponse = {
  selectedCount:    number
  skippedCount:     number
  assignedPoolIds:  number[]
  skipDetails?:     PoolSkipDetail[]
  poolSkipped?:     number
  poolSkipDetails?: PoolSkipDetail[]
}

export type PoolPublishResponse = {
  succeeded?:       number
  failed?:          number
  attempted?:       number
  skipped?:         number
  blocked?:         number
  items?:           PublishItemResult[]
  poolSkipped?:     number
  poolSkipDetails?: PoolSkipDetail[]
}

export type PoolDispatchRunResponse = {
  id:               number
  total_jobs?:      number
  poolSkipped?:     number
  poolSkipDetails?: PoolSkipDetail[]
}

export type TitleMode = "titlebot" | "ai" | "original"

export type ListingRunRequest = {
  storeCode: string; count: number
  selectionMode: "random" | "priority" | "fifo"
  delaySeconds: number; quantity: number
  dryRun?: boolean; simulationMode?: boolean
  titleMode?: TitleMode
  useAiTitle?: boolean
}
export type ListingRunPublishItem = {
  poolId: number; asin: string; sku: string
  status: "success" | "failed" | "skipped" | "blocked"
  error: string | null; guardScore: number | null
  guardErrors: string[]; guardWarnings: string[]; durationMs: number
}
export type ListingRunResponse = {
  storeId: number; storeCode: string; storeName: string
  dryRun: boolean; simulationMode: boolean
  dispatch: { selectedCount: number; skippedCount: number; assignedPoolIds: number[]; assignedAsins: string[] }
  publish: {
    attempted: number; succeeded: number; failed: number; blocked: number; skipped: number
    items: ListingRunPublishItem[]; totalMs: number
  }
  poolSkipped?:     number
  poolSkipDetails?: PoolSkipDetail[]
  startedAt: string; completedAt: string; totalMs: number
}

export type PublishItemResult = {
  poolId: number; asin: string; sku: string
  status: "success" | "failed" | "skipped" | "blocked"
  error: string | null; guardScore: number | null
  guardErrors: string[]; guardWarnings: string[]; durationMs: number
}

// ─── GET ──────────────────────────────────────────────────────

export async function getSummary() {
  return apiFetch<{ dashboard: DashboardSummary; runtime: { loopStatus: string; turn: number; startedAt: string|null; lastTurnAt: string|null; recentTurns: number } }>("/admin/summary")
}
export async function getQueue()  { return apiFetch<QueueSummary>("/admin/queue") }
export async function getHistory(limit = 50) {
  return apiFetch<{ rows: ListingHistoryRow[]; total: number; generatedAt: string }>(`/admin/history?limit=${limit}`)
}
export async function getStores() { return apiFetch<{ rows: StoreRow[]; total: number; generatedAt: string }>("/admin/stores") }
export async function getPool(params?: {
  view?:      PoolView
  stage?:     string
  status?:    string
  storeCode?: string
  limit?:     number
}) {
  const q = new URLSearchParams()
  if (params?.view)      q.set("view",      params.view)
  if (params?.stage)     q.set("stage",     params.stage)
  if (params?.status)    q.set("status",    params.status)
  if (params?.storeCode) q.set("storeCode", params.storeCode)
  if (params?.limit)     q.set("limit",     String(params.limit))
  return apiFetch<PoolResult>(`/admin/pool${q.toString() ? "?" + q.toString() : ""}`)
}

export type MonitorItem = {
  catalogStateId: number | null
  sku: string
  title: string
  ebayItemId: string | null
  ebayPrice: number
  quantity: number
  cost: number | null
  isTracked: boolean
  lastSyncAt: string | null
  margin: number | null
  asin: string | null
  image: string | null
  sourceUrl: string | null
  listedAt: string | null
  currentStatus: string | null
  stockGuardEnabled: boolean
  panelHiddenAt: string | null
  sourceStatus: string | null
  sourceStatusReason: string | null
  verificationSource: string | null
  sourcePrice: number | null
  sourceCheckedAt: string | null
  botZeroedAt: string | null
  botZeroedReason: string | null
  botZeroedBy: string | null
  totalSold: number | null
  sold30d: number | null
  clicks30d: number | null
  clicks30dCheckedAt: string | null
  views30d: number | null
  impressions30d: number | null
  watchCount: number | null
  metricsSyncedAt: string | null
  metricsSource: string | null
  metricsError: string | null
  autoPriceProtectedAt?: string | null
}
export type MonitorResult = {
  /** Mağazanın görünen adı (store_code değil) */
  store: string
  total: number
  ebayInventoryTotal: number
  tracked: number
  untracked: number
  simulationMode: boolean
  items: MonitorItem[]
  generatedAt: string
  currentPage: number
  totalPages: number
  pageSize?: number
  appliedSortBy?: string | null
  appliedSortDir?: string | null
  storeSync?: {
    lastCatalogSyncAt: string | null
    lastMetricsSyncAt: string | null
    syncStatus: string | null
    syncError: string | null
  }
}

// ─── POST ─────────────────────────────────────────────────────

export async function postMonitorUpdatePrice(storeCode: string, sku: string, newPrice: number): Promise<{ success: boolean; simulation: boolean; newPrice: number; message: string }> {
  return apiFetch("/admin/monitor/update-price", { method: "POST", body: JSON.stringify({ storeCode, sku, newPrice }) })
}
export async function postMonitorUpdateStock(
  storeCode: string,
  sku: string,
  quantity: number
): Promise<{ success: boolean; simulation: boolean; quantity: number; message: string; updatedDb: boolean }> {
  return apiFetch("/admin/monitor/update-stock", { method: "POST", body: JSON.stringify({ storeCode, sku, quantity }) })
}
export async function postMonitorBlind(
  storeCode: string,
  sku: string
): Promise<{ success: boolean; simulation: boolean; message: string; updatedDb: boolean }> {
  return apiFetch("/admin/monitor/blind", { method: "POST", body: JSON.stringify({ storeCode, sku }) })
}
export async function postMonitorUpdateSourceUrl(storeCode: string, sku: string, sourceUrl: string): Promise<{ ok: boolean }> {
  return apiFetch("/admin/monitor/update-source-url", { method: "POST", body: JSON.stringify({ storeCode, sku, sourceUrl }) })
}

export type KeepaPriceCandidates = {
  primeExclusiveCurrent: number | null
  buyBoxCurrent: number | null
  amazonCurrent: number | null
  newCurrent: number | null
  newFbaCurrent: number | null
  listPrice: number | null
  offerCurrent?: number | null
}

export type KeepaCheckAsinResult = {
  ok: true
  asin: string
  sourceStatus: string
  reason: string
  price: number | null
  selectedPriceSource?: string
  priceCandidates?: KeepaPriceCandidates
  rawSignals?: {
    hasPrice: boolean
    hasNewPrice: boolean
    hasBuyBox: boolean
    hasOfferSignal: boolean
    hasPrimeExclusivePrice: boolean
  }
  priceSelectionWarnings?: string[]
}

export async function postKeepaCheckAsin(asin: string): Promise<KeepaCheckAsinResult> {
  return apiFetch<KeepaCheckAsinResult>("/admin/keepa/check-asin", {
    method: "POST",
    body: JSON.stringify({ asin }),
  })
}

export type UpdateSourceAsinResult = {
  ok: true
  catalogStateId: number
  newAsin: string
  previousAsin: string | null
  sourceStatus: string
  sourcePrice: number | null
  pendingAlertsIgnored: number
}

export async function postUpdateSourceAsin(input: {
  storeCode: string
  catalogStateId: number
  newAsin: string
}): Promise<UpdateSourceAsinResult> {
  return apiFetch<UpdateSourceAsinResult>("/admin/listings/update-source-asin", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export type RecommendedEbayPriceResult = {
  ok: true
  amazonPrice: number
  currentEbayPrice: number
  storeMarkupPercent: number
  recommendedEbayPrice: number
  pricingSource: string
  promotionAdRatePercent?: number | null
  promotionFeeImpactPercent?: number | null
  unpromotedRecommendedEbayPrice?: number | null
  promotedRecommendedEbayPrice?: number | null
}

export async function getRecommendedEbayPrice(
  storeCode: string,
  catalogStateId: number
): Promise<RecommendedEbayPriceResult> {
  const q = new URLSearchParams({
    storeCode,
    catalogStateId: String(catalogStateId),
  })
  return apiFetch<RecommendedEbayPriceResult>(`/admin/listings/recommended-price?${q}`)
}

export async function postUpdateEbayPrice(
  storeCode: string,
  catalogStateId: number,
  newPrice: number
): Promise<{ ok: true; oldPrice: number; newPrice: number }> {
  return apiFetch("/admin/listings/update-ebay-price", {
    method: "POST",
    body: JSON.stringify({ storeCode, catalogStateId, newPrice }),
  })
}
export async function getMonitorListings(
  storeCode = "S1",
  params?: {
    offset?: number
    limit?: number
    search?: string
    status?: string
    sortBy?: string
    sortDir?: "asc" | "desc"
  },
  signal?: AbortSignal
): Promise<MonitorResult> {
  const q = new URLSearchParams({ storeCode })
  if (params?.offset !== undefined) q.set("offset", String(params.offset))
  if (params?.limit !== undefined) q.set("limit", String(params.limit))
  if (params?.search?.trim()) q.set("search", params.search.trim())
  if (params?.status && params.status !== "all") q.set("status", params.status)
  if (params?.sortBy) q.set("sortBy", params.sortBy)
  if (params?.sortDir) q.set("sortDir", params.sortDir)
  return apiFetch<MonitorResult>(`/admin/monitor/listings?${q.toString()}`, { signal })
}

export type ListingActionResult = {
  ebayItemId?:     string
  catalogStateId?: number
  status:          "UPDATED" | "NOT_FOUND"
  message?:        string
}

export type ListingActionResponse = {
  ok: true
  updated: number
  notFound: number
  results: ListingActionResult[]
}

export async function postListingsStockGuard(
  storeCode: string,
  items: { ebayItemId?: string; catalogStateId?: number }[],
  enabled: boolean
): Promise<ListingActionResponse> {
  return apiFetch("/admin/listings/stock-guard", {
    method: "POST",
    body: JSON.stringify({ storeCode, items, enabled }),
  })
}

export async function postListingsRemoveFromList(
  storeCode: string,
  items: { ebayItemId: string }[]
): Promise<ListingActionResponse> {
  return apiFetch("/admin/listings/remove-from-list", {
    method: "POST",
    body: JSON.stringify({ storeCode, items }),
  })
}

export async function postListingsRestoreToList(
  storeCode: string,
  items: { ebayItemId: string }[]
): Promise<ListingActionResponse> {
  return apiFetch("/admin/listings/restore-to-list", {
    method: "POST",
    body: JSON.stringify({ storeCode, items }),
  })
}

export type EndListingItemRef = {
  ebayItemId?:     string
  catalogStateId?: number
}

export type EndListingResponse = {
  ok: true
  ended: number
  notFound: number
  failed: number
  results: {
    ebayItemId?:     string
    catalogStateId?: number
    status:
      | "ENDED_BY_OFFER"
      | "ENDED_BY_ITEM_ID"
      | "ENDED_LOCALLY"
      | "NOT_FOUND"
      | "FAILED"
      | "SIMULATION"
    message?: string
  }[]
}

export async function postListingsEnd(
  storeCode: string,
  items: EndListingItemRef[]
): Promise<EndListingResponse> {
  return apiFetch("/admin/listings/end", {
    method: "POST",
    body: JSON.stringify({ storeCode, items }),
  })
}

export type SyncListingsResponse = {
  ok: true
  storeCode: string
  storeId: number
  tradingRows: number
  inserted: number
  updated: number
  skipped: number
  errors: number
  reconciled: number
  syncHint: string | null
}

export async function postListingsSyncListings(storeCode: string): Promise<SyncListingsResponse> {
  return apiFetch("/admin/listings/sync-listings", {
    method: "POST",
    body: JSON.stringify({ storeCode }),
  })
}

export type SyncMetricsResponse = {
  ok: true
  storeCode: string
  processed: number
  updated: number
  notFound: number
  analyticsAvailable: boolean
  analyticsError: string | null
  syncHint: string | null
  results: { ebayItemId: string; status: string; message?: string }[]
}

export type StoreListingsDebug = {
  storeCode: string
  storeId: number
  storeName: string
  hasEbayAccount: boolean
  ebayUserId: string | null
  tokenExpiresAt: string | null
  catalogTotal: number
  visibleCount: number
  hiddenCount: number
  endedCount: number
  withEbayItemId: number
  withAsin: number
  lastSyncAt: string | null
}

export async function getListingsStoreDebug(storeCode: string): Promise<StoreListingsDebug> {
  const q = new URLSearchParams({ storeCode })
  return apiFetch<StoreListingsDebug>(`/admin/listings/store-debug?${q.toString()}`)
}

export type Sync30dClicksResponse = {
  ok: boolean
  storeCode: string
  checked: number
  updated: number
  missingAnalyticsPermission: boolean
  message: string
}

export async function postListingsSync30dClicks(storeCode: string): Promise<Sync30dClicksResponse> {
  return apiFetch("/admin/listings/sync-30d-clicks", {
    method: "POST",
    body: JSON.stringify({ storeCode }),
  })
}

export async function postListingsSyncMetrics(
  storeCode: string,
  options?: { mode?: "all"; ebayItemIds?: string[] }
): Promise<SyncMetricsResponse> {
  return apiFetch("/admin/listings/sync-metrics", {
    method: "POST",
    body: JSON.stringify(
      options?.ebayItemIds?.length
        ? { storeCode, ebayItemIds: options.ebayItemIds }
        : { storeCode, mode: "all" }
    ),
  })
}

export type ImportMatchRowInput = { ebayItemId: string; asin: string }

export type ImportMatchRowResult = {
  row: number
  ebayItemId: string
  asin: string
  status: string
  message: string
}

export type ImportMatchSummary = {
  total: number
  matched: number
  updated: number
  alreadyExists: number
  invalidAsin: number
  ebayNotFound: number
  storeConflict: number
  duplicate: number
  failed: number
}

export type ImportMatchResponse = {
  ok: true
  summary: ImportMatchSummary
  results: ImportMatchRowResult[]
}

export async function postListingsImportMatch(
  storeCode: string,
  rows: ImportMatchRowInput[]
): Promise<ImportMatchResponse> {
  return apiFetch<ImportMatchResponse>("/admin/listings/import-match", {
    method: "POST",
    body: JSON.stringify({ storeCode, rows }),
  })
}

export async function postPoolDispatch(req: PoolDispatchRequest): Promise<PoolDispatchResponse> {
  return apiFetch<PoolDispatchResponse>("/admin/pool/dispatch-selected", { method: "POST", body: JSON.stringify(req) })
}
export async function postListingRun(req: ListingRunRequest): Promise<ListingRunResponse> {
  return apiFetch<ListingRunResponse>("/admin/listing/run", { method: "POST", body: JSON.stringify(req) })
}

export type PoolArchiveResponse = {
  ok: boolean
  archived: number
  failed: number
  deleted: number
  results?: { poolId: number; ok: boolean; message?: string }[]
}

export async function deletePoolItems(poolIds: number[], reason?: string): Promise<PoolArchiveResponse> {
  return apiFetch<PoolArchiveResponse>("/admin/pool", {
    method: "DELETE",
    body: JSON.stringify({ poolIds, reason: reason ?? "manual_archive" }),
  })
}

export type PoolDeleteSelectedSkipped = {
  poolId: number
  asin:   string | null
  reason: string
}

export type PoolDeleteSelectedResponse = {
  ok:           boolean
  deletedCount: number
  skippedCount: number
  skipped:        PoolDeleteSelectedSkipped[]
}

export async function deleteSelectedPoolItems(poolIds: number[]): Promise<PoolDeleteSelectedResponse> {
  return apiFetch<PoolDeleteSelectedResponse>("/admin/pool/delete-selected", {
    method: "POST",
    body: JSON.stringify({ poolIds }),
  })
}

export type PoolRestoreResponse = {
  ok:       boolean
  restored: number
  failed:   number
  results?: { poolId: number; ok: boolean; message?: string }[]
}

export async function restorePoolItems(poolIds: number[], reason?: string): Promise<PoolRestoreResponse> {
  return apiFetch<PoolRestoreResponse>("/admin/pool/restore", {
    method: "POST",
    body: JSON.stringify({ poolIds, reason: reason ?? "manual_restore" }),
  })
}

// ─── Scheduled Publish Queue ────────────────────────────────────

export type ScheduleSelectionMode = "ready_next" | "selected"

export type ScheduleExecutionMode = "simulation" | "live"

export type ScheduleCommandStatus =
  | "scheduled" | "running" | "paused" | "completed" | "failed" | "cancelled"

export type ScheduleJobStatus =
  | "scheduled" | "running" | "simulated" | "published" | "failed" | "cancelled" | "skipped"

export type ScheduleSkipDetail = {
  poolId?: number
  asin?:   string | null
  reason:  string
}

export type ScheduleJobProgress = {
  scheduled:  number
  running:    number
  simulated:  number
  published:  number
  failed:     number
  cancelled:  number
  skipped:    number
  total:      number
}

export type ScheduledPublishCommand = {
  id:               number
  storeCode:        string
  title:            string | null
  status:           ScheduleCommandStatus
  selectionMode:    string
  requestedCount:   number
  eligibleCount:    number
  skippedCount:     number
  createdJobCount:  number
  startAt:          string
  intervalSeconds:  number
  quantity:         number
  titleMode:        string
  executionMode:    ScheduleExecutionMode
  createdAt:        string
  updatedAt:        string
  pausedAt:         string | null
  cancelledAt:      string | null
  completedAt:      string | null
  lastError:        string | null
  metadata?:        Record<string, unknown>
  progress?:        ScheduleJobProgress
}

export type ScheduledPublishJob = {
  id:            number
  commandId:     number
  poolId:        number
  asin:          string | null
  scheduledAt:   string
  status:        ScheduleJobStatus
  attemptCount:  number
  errorMessage:  string | null
  publishedAt:   string | null
  failedAt:      string | null
  cancelledAt:   string | null
}

export type QuickDispatchEvidenceGateSummary = {
  requestedCount:       number
  readyForPublishCount: number
  captureRequiredCount: number
  skippedCount:         number
  publishCommandId:     number | null
  captureCommandId:     number | null
  message:              string
}

export type SchedulePublishRequest = {
  storeCode:        string
  selectionMode:    ScheduleSelectionMode
  poolIds?:         number[]
  count:            number
  startAt:          string
  intervalSeconds:  number
  quantity?:        number
  titleMode?:       TitleMode
  title?:           string
  executionMode?:   ScheduleExecutionMode
  confirm?:         boolean
  confirmationText?: string
  evidenceGate?:    boolean
}

export type SchedulePublishResponse = {
  ok:           boolean
  command?:     ScheduledPublishCommand
  skipDetails?: ScheduleSkipDetail[]
  evidenceGate?: QuickDispatchEvidenceGateSummary
}

export type ScheduledCommandListResponse = {
  ok:       boolean
  page:     number
  limit:    number
  total:    number
  commands: ScheduledPublishCommand[]
}

export type ScheduledCommandDetailResponse = {
  ok:          boolean
  command:     ScheduledPublishCommand
  skipDetails?: ScheduleSkipDetail[]
  recentJobs?: ScheduledPublishJob[]
}

export type ScheduledJobListResponse = {
  ok:       boolean
  command:  ScheduledPublishCommand
  page:     number
  limit:    number
  total:    number
  jobs:     ScheduledPublishJob[]
}

export type ScheduleCommandActionResponse = {
  ok:      boolean
  command: ScheduledPublishCommand
}

export type ScheduledRunnerRunDueRequest = {
  limit?:     number
  storeCode?: string
}

export type ScheduledRunnerResult = {
  jobId:     number
  commandId: number
  poolId:    number
  asin?:     string | null
  ok:        boolean
  status:    string
  message?:  string
}

export type ScheduledRunnerRunDueResponse = {
  ok:              boolean
  mode:            "simulation"
  requestedLimit:  number
  processed:       number
  simulated:       number
  failed:          number
  skipped:         number
  results:         ScheduledRunnerResult[]
}

export type ScheduledSimulationAutoRunnerLastResult = {
  processed: number
  simulated: number
  skipped:   number
  failed:    number
}

export type ScheduledSimulationAutoRunnerStatus = {
  enabled:        boolean
  running:        boolean
  intervalMs:     number
  tickInProgress: boolean
  lastTickAt:     string | null
  lastResult:     ScheduledSimulationAutoRunnerLastResult | null
  lastError:      string | null
}

export type ScheduledRunnerStatusResponse = {
  ok:               boolean
  simulationRunner: ScheduledSimulationAutoRunnerStatus
}

export type ScheduledLiveRunnerRequest = {
  storeCode?:         string
  commandId?:         number
  confirm?:           boolean
  confirmationText?:  string
}

export type ScheduledLiveRunnerResult = {
  jobId?:      number
  commandId?:  number
  poolId?:     number
  asin?:       string | null
  status?:     string
  ebayItemId?: string | null
  message?:    string
  error?:      string
}

export type ScheduledLiveRunnerRunResponse = {
  ok:        boolean
  mode:      "live"
  processed: number
  published: number
  failed:    number
  skipped:   number
  message?:  string
  result?:   ScheduledLiveRunnerResult | null
}

export async function createScheduledPublishCommand(
  payload: SchedulePublishRequest
): Promise<SchedulePublishResponse> {
  return apiFetch<SchedulePublishResponse>("/admin/pool/schedule-publish", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function fetchScheduledPublishCommands(params?: {
  storeCode?: string
  status?:   string
  page?:     number
  limit?:    number
}): Promise<ScheduledCommandListResponse> {
  const q = new URLSearchParams()
  if (params?.storeCode) q.set("storeCode", params.storeCode)
  if (params?.status && params.status !== "all") q.set("status", params.status)
  if (params?.page)  q.set("page",  String(params.page))
  if (params?.limit) q.set("limit", String(params.limit))
  const qs = q.toString()
  return apiFetch<ScheduledCommandListResponse>(
    `/admin/pool/schedule-commands${qs ? `?${qs}` : ""}`
  )
}

export async function fetchScheduledPublishCommand(
  commandId: number
): Promise<ScheduledCommandDetailResponse> {
  return apiFetch<ScheduledCommandDetailResponse>(
    `/admin/pool/schedule-commands/${commandId}`
  )
}

export async function fetchScheduledPublishJobs(
  commandId: number,
  params?: { status?: string; page?: number; limit?: number }
): Promise<ScheduledJobListResponse> {
  const q = new URLSearchParams()
  if (params?.status && params.status !== "all") q.set("status", params.status)
  if (params?.page)  q.set("page",  String(params.page))
  if (params?.limit) q.set("limit", String(params.limit))
  const qs = q.toString()
  return apiFetch<ScheduledJobListResponse>(
    `/admin/pool/schedule-commands/${commandId}/jobs${qs ? `?${qs}` : ""}`
  )
}

export async function pauseScheduledPublishCommand(
  commandId: number
): Promise<ScheduleCommandActionResponse> {
  return apiFetch<ScheduleCommandActionResponse>(
    `/admin/pool/schedule-commands/${commandId}/pause`,
    { method: "POST", body: JSON.stringify({}) }
  )
}

export async function resumeScheduledPublishCommand(
  commandId: number
): Promise<ScheduleCommandActionResponse> {
  return apiFetch<ScheduleCommandActionResponse>(
    `/admin/pool/schedule-commands/${commandId}/resume`,
    { method: "POST", body: JSON.stringify({}) }
  )
}

export async function cancelScheduledPublishCommand(
  commandId: number
): Promise<ScheduleCommandActionResponse> {
  return apiFetch<ScheduleCommandActionResponse>(
    `/admin/pool/schedule-commands/${commandId}/cancel`,
    { method: "POST", body: JSON.stringify({}) }
  )
}

export async function runScheduledPublishSimulation(
  payload?: ScheduledRunnerRunDueRequest
): Promise<ScheduledRunnerRunDueResponse> {
  return apiFetch<ScheduledRunnerRunDueResponse>("/admin/pool/schedule-runner/run-due", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  })
}

export async function fetchScheduledPublishRunnerStatus(): Promise<ScheduledRunnerStatusResponse> {
  return apiFetch<ScheduledRunnerStatusResponse>("/admin/pool/schedule-runner/status")
}

export async function runScheduledPublishLiveOne(
  payload: ScheduledLiveRunnerRequest
): Promise<ScheduledLiveRunnerRunResponse> {
  return apiFetch<ScheduledLiveRunnerRunResponse>("/admin/pool/schedule-runner/run-live-one", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export type PoolCategoryPreferences = {
  categories: string[]
  note:       string
}

export async function fetchPoolCategoryPreferences(): Promise<PoolCategoryPreferences> {
  return apiFetch<PoolCategoryPreferences>("/admin/pool/category-preferences")
}

export async function savePoolCategoryPreferences(
  prefs: PoolCategoryPreferences
): Promise<PoolCategoryPreferences> {
  return apiFetch<PoolCategoryPreferences>("/admin/pool/category-preferences", {
    method: "PUT",
    body: JSON.stringify(prefs),
  })
}

export async function getActiveRuns(): Promise<any> {
  return apiFetch<any>("/admin/dispatch-runs/active")
}

export async function getRunStatus(runId: number): Promise<any> {
  return apiFetch<any>(`/admin/dispatch-runs/status?runId=${runId}`)
}

export type PersistedNotificationRow = {
  id: number
  type: string
  title: string
  message: string
  read: boolean
  createdAt: string
}

export async function getNotifications(limit = 50): Promise<{ rows: PersistedNotificationRow[] }> {
  return apiFetch<{ rows: PersistedNotificationRow[] }>(`/admin/notifications?limit=${limit}`)
}

export async function markNotificationsRead(ids: number[]): Promise<{ updated: number }> {
  return apiFetch<{ updated: number }>("/admin/notifications/read", {
    method: "POST",
    body: JSON.stringify({ ids }),
  })
}

export async function markAllNotificationsRead(): Promise<{ updated: number }> {
  return apiFetch<{ updated: number }>("/admin/notifications/read-all", {
    method: "POST",
    body: JSON.stringify({}),
  })
}

// ─── Stock Alerts (Keepa review queue) ─────────────────────────

export type StockReviewStatus = "pending" | "processing" | "actioned" | "ignored" | "failed" | "approved"

export type StockAlertRow = {
  id: number
  catalogStateId: number
  asin: string
  ebayItemId: string | null
  internalSku: string | null
  ebayTitle: string | null
  imageUrl: string | null
  ebayQuantity: number | null
  ebayPrice: number | null
  sourceStatus: string
  sourceStatusReason: string | null
  verificationSource: string | null
  sourcePrice: number | null
  oldSourcePrice?: number | null
  newSourcePrice?: number | null
  priceChangePercent?: number | null
  detectedAt: string
  checkedAt: string | null
  reviewStatus: StockReviewStatus
  actionedAt: string | null
  actionError: string | null
  processingStartedAt?: string | null
  storeMarkupPercent?: number | null
  recommendedEbayPrice?: number | null
}

export type StockAlertsListResponse = {
  ok: true
  rows: StockAlertRow[]
  total: number
  summary: {
    pending: number
    processing: number
    noPrice: number
    unavailable: number
    removed: number
    priceIncrease: number
  }
}

export async function getStockAlerts(params: {
  storeCode: string
  status: StockReviewStatus
  risk?: "NO_PRICE" | "UNAVAILABLE" | "REMOVED" | "PRICE_INCREASE" | "all"
  search?: string
  offset?: number
  limit?: number
}): Promise<StockAlertsListResponse> {
  const q = new URLSearchParams({ storeCode: params.storeCode, status: params.status })
  if (params.risk && params.risk !== "all") q.set("risk", params.risk)
  if (params.search?.trim()) q.set("search", params.search.trim())
  if (params.offset !== undefined) q.set("offset", String(params.offset))
  if (params.limit !== undefined) q.set("limit", String(params.limit))
  return apiFetch<StockAlertsListResponse>(`/admin/stock-alerts?${q.toString()}`)
}

export async function postStockAlertsIgnore(storeCode: string, ids: number[]): Promise<{ ok: true; ignored: number }> {
  return apiFetch<{ ok: true; ignored: number }>("/admin/stock-alerts/ignore", {
    method: "POST",
    body: JSON.stringify({ storeCode, ids }),
  })
}

export type StockAlertsApproveZeroResponse = {
  ok: true
  queued: true
  requested: number
  processing: number
  jobId: string
}

export async function getStockGuardSettings(storeCode: string): Promise<{
  storeCode: string
  storeName: string
  enabled: boolean
  mode: "manual" | "auto"
  priceAlertEnabled: boolean
  autoProfitProtectionEnabled?: boolean
}> {
  const res = await apiFetch<{
    ok: true
    settings: {
      storeCode: string
      storeName: string
      enabled: boolean
      mode: "manual" | "auto"
      priceAlertEnabled: boolean
      autoProfitProtectionEnabled?: boolean
    }
  }>(`/admin/stock-guard/settings?storeCode=${encodeURIComponent(storeCode)}`)
  return res.settings
}

export async function postStockGuardSettings(body: {
  storeCode: string
  enabled?: boolean
  mode?: "manual" | "auto"
  priceAlertEnabled?: boolean
  autoProfitProtectionEnabled?: boolean
}): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>("/admin/stock-guard/settings", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export async function postStockAlertsApproveZero(
  storeCode: string,
  ids: number[]
): Promise<StockAlertsApproveZeroResponse> {
  return apiFetch<StockAlertsApproveZeroResponse>("/admin/stock-alerts/approve-zero", {
    method: "POST",
    body: JSON.stringify({ storeCode, ids }),
  })
}

export type OrderStatus = "new" | "processing" | "updated" | "error"

export const OPERATION_STATUSES = [
  "NEW_ORDER",
  "AMAZON_PENDING",
  "AMAZON_ORDERED",
  "AQUALINE_PENDING",
  "TRACKING_PENDING",
  "TRACKING_RECEIVED",
  "EBAY_TRACKING_SUBMITTED",
  "IN_TRANSIT",
  "DELIVERED",
  "PROBLEM",
  "CANCELLED_REFUNDED",
] as const

export type OperationStatus = (typeof OPERATION_STATUSES)[number]

export const OPERATION_STATUS_LABELS: Record<OperationStatus, string> = {
  NEW_ORDER:               "Yeni Sipariş",
  AMAZON_PENDING:          "Amazon Bekliyor",
  AMAZON_ORDERED:          "Amazon Girildi",
  AQUALINE_PENDING:        "Aqualine Bekliyor",
  TRACKING_PENDING:        "Tracking Bekliyor",
  TRACKING_RECEIVED:       "Tracking Alındı",
  EBAY_TRACKING_SUBMITTED: "eBay'e Tracking Basıldı",
  IN_TRANSIT:              "Yolda",
  DELIVERED:               "Teslim Edildi",
  PROBLEM:                 "Sorunlu",
  CANCELLED_REFUNDED:      "İptal / Refund",
}

export type OrderItem = {
  id:            number
  orderId:       string
  storeCode:     string
  storeName:     string
  creationDate:  string | null
  buyerUsername: string | null
  buyerName:     string | null
  productTitle:  string
  imageUrl:      string | null
  quantity:      number
  total:         number
  currency:      string
  status:        OrderStatus
  operationStatus:      OperationStatus
  operationStatusLabel: string
}

export type OrdersStoreError = {
  storeCode: string
  storeName: string
  message:   string
}

export type OrdersResponse = {
  ok:        true
  allStores: boolean
  storeCode: string | null
  orders:    OrderItem[]
  errors:    OrdersStoreError[]
}

// GET /admin/orders — reads from DB (no live eBay call).
export async function getOrders(params: {
  storeCode?: string
  allStores?: boolean
}): Promise<OrdersResponse> {
  const q = new URLSearchParams()
  if (params.allStores) {
    q.set("allStores", "true")
  } else {
    const code = params.storeCode?.trim()
    if (!code) {
      throw new Error("storeCode is required")
    }
    q.set("storeCode", code)
  }
  return apiFetch<OrdersResponse>(`/admin/orders?${q.toString()}`)
}

// POST /admin/orders/sync — fetch from eBay + upsert to DB, returns refreshed list.
export async function syncOrders(params: {
  storeCode?: string
  allStores?: boolean
}): Promise<OrdersResponse> {
  const payload = params.allStores
    ? { allStores: true }
    : { storeCode: params.storeCode?.trim() }
  return apiFetch<OrdersResponse>(`/admin/orders/sync`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export type OrderAddress = {
  name:         string | null
  addressLine1: string | null
  addressLine2: string | null
  city:         string | null
  state:        string | null
  postalCode:   string | null
  country:      string | null
  phone:            string | null
  phoneRaw:         string | null
  phoneDisplay:     string | null
  phoneAmazonInput: string | null
}

export type OrderDetailItem = {
  title:      string
  imageUrl:   string | null
  ebayItemId: string | null
  asin:       string | null
  sku:        string | null
  quantity:   number
  itemPrice:  number | null
  currency:   string | null
}

export type OrderManualFields = {
  notes:               string | null
  amazonOrderNumber:   string | null
  amazonOrderUrl:      string | null
  amazonPurchasePrice: number | null
}

export type OrderFinanceSummary = {
  ebayOrderEarnings:          number | null
  ebayOrderEarningsCurrency:  string | null
  ebayOrderEarningsSource:    string | null
  ebayOrderEarningsCheckedAt: string | null
  ebayOrderEarningsError:     string | null
  status: "available" | "missing" | "not_ready" | "error"
  ebayGrossSales:             number | null
  amazonFinalCost:            number | null
  profit:                     number | null
  profitPercent:              number | null
}

export type OrderTrackingInfo = {
  ebayTrackingNumber: string | null
  ebayCarrier: string | null
  ebayShipmentStatus: string | null
  ebayShippedAt: string | null
  amazonTrackingUrl: string | null
  amazonShipmentId: string | null
  amazonPackageIndex: string | null
  amazonEstimatedDelivery: string | null
  amazonDeliveryStatus: string | null
  amazonDeliveryLocation: string | null
  amazonDeliveredAt: string | null
}

export type OrderEvent = {
  type:      string
  message:   string | null
  createdAt: string
}

export type OrderDetail = {
  id:                number
  ebayOrderId:       string
  legacyOrderId:     string | null
  storeCode:         string
  storeName:         string
  creationDate:      string | null
  lastSyncedAt:      string | null
  status:            OrderStatus
  fulfillmentStatus: string | null
  paymentStatus:     string | null
  operationStatus:          OperationStatus
  operationStatusLabel:     string
  operationStatusUpdatedAt: string | null
  buyerUsername:     string | null
  buyerName:         string | null
  total:             number
  currency:          string
  items:             OrderDetailItem[]
  address:           OrderAddress | null
  manual:            OrderManualFields
  finance:           OrderFinanceSummary
  tracking?:         OrderTrackingInfo
  events:            OrderEvent[]
}

export type OrderManualUpdateInput = {
  notes?:               string | null
  amazonOrderNumber?:   string | null
  amazonOrderUrl?:      string | null
  amazonPurchasePrice?: number | null
  operationStatus?:     OperationStatus
}

export type AssistedOrderPacket = {
  orderId:          number
  ebayOrderId:      string
  storeCode:        string
  title:            string
  imageUrl:         string | null
  asin:             string
  sku:              string | null
  ebayItemId:       string | null
  quantity:         number
  amazonProductUrl: string
  buyerUsername:    string | null
  buyerName:        string | null
  shippingAddress:  OrderAddress | null
  phone:            string | null
  phoneRaw:         string | null
  phoneNormalized:  string | null
  phoneDisplay:     string | null
  phoneAmazonInput: string | null
  paidAmount:       number
  currency:         string
  autoRun:          boolean
  // Panel → extension activation guard (set client-side at launch time).
  requestId?:       string
  source?:          string
  userInitiated?:   boolean
  startedAt?:       number
  expiresAt?:       number
}

// GET /admin/orders/:orderId — single order detail (DB id).
export async function getOrderDetail(orderId: number | string): Promise<OrderDetail> {
  return apiFetch<OrderDetail>(`/admin/orders/${encodeURIComponent(String(orderId))}`)
}

// GET /admin/orders/:orderId/assist — assisted Amazon order packet.
export async function getOrderAssist(
  orderId: number | string,
  autoRun = false
): Promise<AssistedOrderPacket> {
  const qs = autoRun ? "?autoRun=1" : ""
  return apiFetch<AssistedOrderPacket>(
    `/admin/orders/${encodeURIComponent(String(orderId))}/assist${qs}`
  )
}

// PATCH /admin/orders/:orderId/assist-asin — set manual ASIN on primary item.
export async function setOrderAssistAsin(
  orderId: number | string,
  asin: string
): Promise<{ asin: string }> {
  return apiFetch<{ asin: string }>(
    `/admin/orders/${encodeURIComponent(String(orderId))}/assist-asin`,
    { method: "PATCH", body: JSON.stringify({ asin }) }
  )
}

// PATCH /admin/orders/:orderId — save local manual operation fields.
export async function updateOrderManual(
  orderId: number | string,
  fields:  OrderManualUpdateInput
): Promise<OrderDetail> {
  return apiFetch<OrderDetail>(`/admin/orders/${encodeURIComponent(String(orderId))}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  })
}

// POST /admin/orders/:orderId/earnings — refresh eBay Order earnings (single order).
export async function refreshOrderEarnings(orderId: number | string): Promise<OrderDetail> {
  return apiFetch<OrderDetail>(`/admin/orders/${encodeURIComponent(String(orderId))}/earnings`, {
    method: "POST",
    body: JSON.stringify({}),
  })
}
