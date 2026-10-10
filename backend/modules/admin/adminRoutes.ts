import {
  getDashboardSummary, getAdminQueueSummary, getRecentListingHistory,
  getAdminStores, getRuntimeStatus, getPoolRows, dispatchSelectedPool,
  resolvePoolIdsFromAsins,
  parsePoolView, archivePoolItems, restorePoolItems,
} from "./adminService"
import {
  deleteSelectedPoolItems,
  type PoolDeleteSelectedResponse,
} from "../pool/poolDeleteSelectedService"
import { runDispatch }             from "../dispatch/dispatchService"
import { importAsins }             from "../asinImport/asinImportService"
import { getMonitorListings }      from "../monitor/monitorService"
import { importMatchListings }     from "../listings/listingsImportService"
import type { ImportMatchRequest, ImportMatchResponse } from "../listings/listingsImportTypes"
import {
  removeFromList,
  restoreToList,
  setSourceStatus,
  setStockGuard,
} from "../listings/listingsStockGuardService"
import { syncListingMetrics } from "../listings/listingsMetricsService"
import { sync30dClicksForStore } from "../listings/listingsSync30dClicksService"
import type { Sync30dClicksResponse } from "../listings/listingsSync30dClicksTypes"
import { syncListingsForStore } from "../listings/listingsSyncService"
import type { SyncListingsResponse } from "../listings/listingsSyncTypes"
import {
  processStoreSyncQueue,
  recordClicks30dSyncFromResult,
  scheduleCatalogSyncImmediate,
} from "../storeSync/storeSyncScheduleService"
import { getStoreListingsDebug } from "../listings/listingsStoreDebugService"
import type { StoreListingsDebug } from "../listings/listingsStoreDebugTypes"
import { endListings } from "../listings/listingsEndService"
import { updateListingSourceAsin } from "../listings/listingsUpdateSourceAsinService"
import {
  getRecommendedPriceForListing,
  updateEbayListingPrice,
} from "../listings/listingsEbayPriceService"
import type { UpdateSourceAsinResponse } from "../listings/listingsUpdateSourceAsinTypes"
import type {
  RemoveFromListRequest,
  RemoveFromListResponse,
  RestoreToListRequest,
  RestoreToListResponse,
  SourceStatusRequest,
  SourceStatusResponse,
  StockGuardRequest,
  StockGuardResponse,
} from "../listings/listingsStockGuardTypes"
import type {
  SyncMetricsRequest,
  SyncMetricsResponse,
} from "../listings/listingsMetricsTypes"
import type {
  EndListingRequest,
  EndListingResponse,
} from "../listings/listingsEndTypes"
import {
  updatePrice, updateStock, blindListing,
  updateSourceUrl,
}                                    from "../monitorActions/monitorActionsService"
import type {
  UpdatePriceRequest, UpdatePriceResponse,
  UpdateStockRequest, UpdateStockResponse,
  BlindRequest, BlindResponse,
}                                    from "../monitorActions/monitorActionsTypes"
import {
  buildAuthUrl,
  buildReconnectAuthUrl,
  handleCallback,
  getAccountStatus,
  refreshAccessToken, getAllAccounts, getValidAccessToken,
  findNextAutoStoreCode,
}                                    from "../ebayOAuth/ebayOAuthService"
import type {
  EbayAccountStatus,
  EbayCallbackResult,
  EbayConnectUrlResponse,
  EbayOAuthReconnectResponse,
}                                    from "../ebayOAuth/ebayOAuthTypes"
import type { MonitorListingsResult } from "../monitor/monitorTypes"
import { runTimedPublishForStore } from "../publishQueue/publishQueueService"
import { splitEligiblePoolItems } from "../pool/poolEligibilityService"
import type { PoolEligibilitySkipDetail } from "./adminTypes"
import { parseTitleMode } from "../titleBot/titleBotService"
import { generateTraceId } from "../logger/logger"

type UploadTraceFields = {
  step:            string
  route:           string
  asin?:           string | null
  poolId?:         number | null
  poolIds?:        number[] | null
  sku?:            string | null
  sourceUrl?:      string | null
  titleMode?:      string | null
  hasTitle?:       boolean
  titlePreview?:   string | null
  status?:         string | null
  reason?:         string | null
  skipDetails?:    unknown
}

function reqTraceId(req: AdminRequest): string {
  return req.traceId ?? generateTraceId()
}

function uploadTrace(traceId: string, fields: UploadTraceFields): void {
  console.log("[UPLOAD_TRACE]", { traceId, ...fields })
}

function uploadError(
  traceId: string,
  fields: UploadTraceFields & {
    message?:       string | null
    code?:          string | null
    stack?:         string | null
    responsePreview?: string | null
  }
): void {
  console.error("[UPLOAD_ERROR]", { traceId, ...fields })
}
import { fetchPublishQueueForStore } from "../publishQueue/publishQueueRepository"
import {
  handlePostSchedulePublish,
  handleGetScheduleCommands,
  handleGetScheduleCommandById,
  handleGetScheduleCommandJobs,
  handlePostScheduleCommandCancel,
  handlePostScheduleCommandPause,
  handlePostScheduleCommandResume,
  handlePostScheduleRunnerRunDue,
  handleGetScheduleRunnerStatus,
  handlePostScheduleRunnerRunLiveOne,
} from "../scheduledPublish/scheduledPublishRoutes"
import {
  handleGetPoolCategoryPreferences,
  handlePutPoolCategoryPreferences,
} from "../pool/poolCategoryPreferencesRoutes"
import type { AsinImportRequest, AsinImportResponse } from "../asinImport/asinImportTypes"
import type {
  AdminDispatchRequest, AdminDispatchResponse, AdminErrorBody,
  AdminListingRunRequest, AdminListingRunResponse,
  AdminPoolDispatchRequest, AdminPoolDispatchResponse, AdminPoolResult,
  AdminPoolDeleteRequest, AdminPoolDeleteResponse,
  AdminPoolRestoreRequest, AdminPoolRestoreResponse,
  AdminPublishRequest, AdminPublishResponse,
  AdminQueueSummary, AdminListingHistoryResult,
  AdminRequest, AdminResponse, AdminStoresResult, DashboardSummary,
  AdminCreateStoreRequest, AdminCreateStoreResponse,
} from "./adminTypes"
import { extractAndSaveProduct } from "../productExtractor/productExtractorService"
import type { ProductExtractorRequest, ProductExtractorResponse } from "../productExtractor/productExtractorTypes"
import { generateAndCacheAiListing } from "../aiListing/aiListingService"
import type { AiListingInput, AiListingOutput } from "../aiListing/aiListingTypes"
import {
  createRunWithJobs,
  claimNext,
  reportProgress,
  getRunStatus,
  getActiveRuns,
} from "../dispatchJobs/dispatchJobsService"
import type {
  DispatchJob,
  DispatchRun,
  ClaimNextJobResult,
  ReportJobRequest,
  RunStatusResult,
} from "../dispatchJobs/dispatchJobsTypes"
import {
  getSettingsForStore,
  saveAddress,
  syncWarehouseMerchantLocationToEbay,
  fetchEbayPolicies,
  savePolicies,
  saveMarkup,
  savePricing,
  saveWarehouseBanner,
} from "../settings/settingsService"
import { isPricingMode, normalizeTieredProfitOverrides } from "../pricing/pricingService"
import type {
  SettingsForStoreResponse,
  EbayPoliciesResponse,
} from "../settings/settingsService"
import type { StoreAddress } from "../storeSettings/storeSettingsTypes"
import { query } from "../../db/client"
import {
  getNotifications as fetchPersistedNotifications,
  markAsRead as markNotificationsAsRead,
  markAllAsRead as markAllNotificationsAsRead,
} from "../notifications/notificationService"
import {
  listStockAlerts,
  ignoreStockAlerts,
  approveZeroStockAlerts,
} from "../stockAlerts/stockAlertsService"
import type {
  StockAlertsListResponse,
  StockAlertsIgnoreRequest,
  StockAlertsIgnoreResponse,
  StockAlertsApproveZeroRequest,
  StockAlertsApproveZeroResponse,
  StockReviewStatus,
} from "../stockAlerts/stockAlertsTypes"
import { StockAlertsHttpError } from "../stockAlerts/stockAlertsTypes"
import { parseAdminStockReviewStatus } from "../stockAlerts/stockAlertListQuery"
import {
  getStoreByCode as getOrderStoreByCode,
  getOrderDetail,
  listOrdersFromDb,
  updateManualFields,
} from "../orders/ordersRepository"
import {
  syncOrdersForAllStores,
  syncOrdersForStore,
} from "../orders/ordersSyncService"
import { refreshOrderEarnings } from "../orders/ordersEarningsService"
import { buildAssistPacket, setManualAsin } from "../orders/ordersRepository"
import { isOperationStatus, OrdersHttpError } from "../orders/ordersTypes"
import type {
  AssistedOrderPacket,
  OrderDetail,
  OrderManualUpdateInput,
  OrdersListResponse,
} from "../orders/ordersTypes"

function getWorkspaceId(): string {
  const id = process.env.WORKSPACE_ID
  if (!id) throw new Error("WORKSPACE_ID is not defined in environment")
  return id
}
function err(message: string, status = 500): AdminResponse<never> {
  const body: AdminErrorBody = { error: "AdminError", message }
  return { status, body }
}
function bad(message: string): AdminResponse<never> { return err(message, 400) }

export type SummaryResponseBody = {
  dashboard: DashboardSummary
  runtime: { loopStatus: string; turn: number; startedAt: string | null; lastTurnAt: string | null; recentTurns: number }
}

export async function handleGetSummary(_req: AdminRequest): Promise<AdminResponse<SummaryResponseBody>> {
  try {
    const wid = getWorkspaceId()
    const [dashboard, runtime] = await Promise.all([getDashboardSummary(wid), Promise.resolve(getRuntimeStatus())])
    return { status: 200, body: { dashboard, runtime } }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleGetQueue(_req: AdminRequest): Promise<AdminResponse<AdminQueueSummary>> {
  try { return { status: 200, body: await getAdminQueueSummary(getWorkspaceId()) } }
  catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleGetHistory(req: AdminRequest): Promise<AdminResponse<AdminListingHistoryResult>> {
  try {
    const limit = parseInt(req.query["limit"] ?? "50", 10)
    return { status: 200, body: await getRecentListingHistory(getWorkspaceId(), limit) }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleGetStores(_req: AdminRequest): Promise<AdminResponse<AdminStoresResult>> {
  try { return { status: 200, body: await getAdminStores(getWorkspaceId()) } }
  catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostCreateStore(req: AdminRequest): Promise<AdminResponse<AdminCreateStoreResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<AdminCreateStoreRequest>

    const name = String(body.name ?? "").trim()
    if (!name) return bad("name is required")

    const storeCode = String(body.storeCode ?? "").trim().toUpperCase()
    if (!storeCode) return bad("storeCode is required")
    if (storeCode.length > 10) return bad("storeCode must be max 10 characters")

    const existing = await query<{ id: number }>(
      `SELECT id
       FROM stores
       WHERE workspace_id = $1
         AND store_code = $2
       LIMIT 1`,
      [workspaceId, storeCode]
    )
    if (existing.rows.length > 0) return bad("This store code is already in use.")

    const result = await query<{
      id: number
      name: string
      store_code: string
      status: string
      created_at: string
    }>(
      `INSERT INTO stores (workspace_id, name, store_code, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id, name, store_code, status, created_at::text`,
      [workspaceId, name, storeCode]
    )

    const row = result.rows[0]
    if (!row) return bad("Failed to create store")

    return {
      status: 200,
      body: {
        id: row.id,
        storeId: row.id,
        name: row.name,
        storeCode: row.store_code,
        status: row.status,
        createdAt: row.created_at,
      },
    }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleGetPool(req: AdminRequest): Promise<AdminResponse<AdminPoolResult>> {
  try {
    const { stage, status, storeCode, limit, asin, view } = req.query
    return {
      status: 200,
      body: await getPoolRows(getWorkspaceId(), {
        view:      parsePoolView(view),
        stage:     stage || null,
        status:    status || null,
        storeCode: storeCode || null,
        asin:      asin || null,
        limit:     limit ? parseInt(limit, 10) : undefined,
      }),
    }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostPoolDispatch(req: AdminRequest): Promise<AdminResponse<AdminPoolDispatchResponse>> {
  const traceId = reqTraceId(req)
  const route = "POST /admin/pool/dispatch-selected"
  try {
    const body = req.body as Partial<AdminPoolDispatchRequest> & {
      titleMode?:  string
      useAiTitle?: boolean
    }
    const titleMode = parseTitleMode(body.titleMode, body.useAiTitle)
    const poolIdsFromBody = (body.poolIds ?? [])
      .map(id => Number(id))
      .filter(id => Number.isInteger(id) && id >= 1)
    const asins = Array.isArray(body.asins)
      ? body.asins.map(a => String(a).trim().toUpperCase()).filter(Boolean)
      : []

    uploadTrace(traceId, {
      step:      "dispatch_request",
      route,
      asin:      asins[0] ?? null,
      poolIds:   poolIdsFromBody.length > 0 ? poolIdsFromBody : null,
      titleMode,
      status:    "received",
    })

    if (!body.storeCode) return bad("storeCode is required")

    const workspaceId = getWorkspaceId()

    if (poolIdsFromBody.length === 0 && asins.length === 0) {
      return bad("poolIds or asins must be provided")
    }

    const asinResolve = asins.length > 0
      ? await resolvePoolIdsFromAsins(workspaceId, asins)
      : { poolIds: [] as number[], skipDetails: [] as PoolEligibilitySkipDetail[] }

    const poolIds = [...new Set([...poolIdsFromBody, ...asinResolve.poolIds])]

    uploadTrace(traceId, {
      step:        "dispatch_resolved_pool_ids",
      route,
      asin:        asins[0] ?? null,
      poolIds:     poolIds.length > 0 ? poolIds : null,
      poolId:      poolIds[0] ?? null,
      titleMode,
      skipDetails: asinResolve.skipDetails.length > 0 ? asinResolve.skipDetails : null,
      status:      poolIds.length > 0 ? "resolved" : "no_pool_ids",
    })

    if (poolIds.length === 0) {
      const emptyBody = {
        selectedCount:   0,
        skippedCount:    asinResolve.skipDetails.length,
        assignedPoolIds: [],
        skipDetails:     asinResolve.skipDetails,
        poolSkipped:     asinResolve.skipDetails.length,
        poolSkipDetails: asinResolve.skipDetails,
      }
      uploadTrace(traceId, {
        step:        "dispatch_complete",
        route,
        asin:        asins[0] ?? null,
        titleMode,
        status:      "skipped_all",
        reason:      "no_resolved_pool_ids",
        skipDetails: asinResolve.skipDetails,
      })
      return { status: 200, body: emptyBody }
    }

    const dispatchBody = await dispatchSelectedPool(
      workspaceId,
      poolIds,
      body.storeCode,
      asinResolve.skipDetails as import("../pool/poolEligibilityService").PoolEligibilitySkipDetail[]
    )

    uploadTrace(traceId, {
      step:        "dispatch_complete",
      route,
      asin:        asins[0] ?? null,
      poolIds,
      poolId:      dispatchBody.assignedPoolIds[0] ?? poolIds[0] ?? null,
      titleMode,
      status:      dispatchBody.selectedCount > 0 ? "assigned" : "skipped_all",
      reason:      dispatchBody.selectedCount > 0 ? null : "selected_count_zero",
      skipDetails: dispatchBody.skipDetails ?? dispatchBody.poolSkipDetails ?? null,
    })

    return { status: 200, body: dispatchBody }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    uploadError(traceId, {
      step:    "dispatch_failed",
      route,
      message: error.message,
      stack:   error.stack ?? null,
    })
    console.error("[ADMIN]", e)
    return err(error.message)
  }
}

export async function handlePostPoolDeleteSelected(
  req: AdminRequest
): Promise<AdminResponse<PoolDeleteSelectedResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<{ poolIds: number[] }>

    const poolIds = parsePoolIdList(body.poolIds)
    if (!poolIds) return bad("poolIds must be a non-empty array of integers")
    if (poolIds.length > POOL_BULK_MAX) return bad(`poolIds max ${POOL_BULK_MAX} items`)

    return {
      status: 200,
      body: await deleteSelectedPoolItems(workspaceId, poolIds),
    }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handleDeletePoolItems(req: AdminRequest): Promise<AdminResponse<AdminPoolDeleteResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<AdminPoolDeleteRequest>

    const poolIdsRaw = body.poolIds
    if (!poolIdsRaw || !Array.isArray(poolIdsRaw) || poolIdsRaw.length === 0) return bad("poolIds must be a non-empty array")

    const poolIds = poolIdsRaw.map(id => Number(id)).filter(id => Number.isInteger(id) && id >= 1)
    if (poolIds.length === 0) return bad("poolIds must be a non-empty array of integers")

    const reason = typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : "manual_archive"

    return {
      status: 200,
      body: await archivePoolItems(workspaceId, poolIds, reason),
    }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

const POOL_BULK_MAX = 100

function parsePoolIdList(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const ids = [...new Set(
    raw.map(id => Number(id)).filter(id => Number.isInteger(id) && id >= 1)
  )]
  if (ids.length === 0) return null
  return ids
}

export async function handlePostPoolRestore(req: AdminRequest): Promise<AdminResponse<AdminPoolRestoreResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<AdminPoolRestoreRequest>

    const poolIds = parsePoolIdList(body.poolIds)
    if (!poolIds) return bad("poolIds must be a non-empty array of integers")
    if (poolIds.length > POOL_BULK_MAX) return bad(`poolIds max ${POOL_BULK_MAX} items`)

    return {
      status: 200,
      body: await restorePoolItems(workspaceId, poolIds, body.reason?.trim() || "manual_restore"),
    }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostAsinImport(req: AdminRequest): Promise<AdminResponse<AsinImportResponse>> {
  try {
    const body = req.body as Partial<AsinImportRequest>
    if (!body.asins || !Array.isArray(body.asins) || body.asins.length === 0)
      return bad("asins must be a non-empty array")
    const result = await importAsins(getWorkspaceId(), { asins: body.asins })
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostProductExtract(req: AdminRequest): Promise<AdminResponse<ProductExtractorResponse>> {
  const traceId = reqTraceId(req)
  const route = "POST /admin/product/extract"
  try {
    const input = req.body as Partial<ProductExtractorRequest>
    const asin = input.asin ? String(input.asin).trim().toUpperCase() : null
    const title = typeof input.title === "string" ? input.title : null

    uploadTrace(traceId, {
      step:         "extract_request",
      route,
      asin,
      sourceUrl:    typeof input.external_id === "string" ? input.external_id : null,
      hasTitle:     Boolean(title),
      titlePreview: title ? title.slice(0, 80) : null,
      status:       "received",
    })

    if (!input.asin) return bad("asin is required")
    const workspaceId = getWorkspaceId()
    const source = (input.source as string | undefined) || "amazon"
    const external_id = (input.external_id as string | null | undefined) ?? null
    const result = await extractAndSaveProduct(workspaceId, { ...input, source, external_id } as ProductExtractorRequest)

    if (result.success) {
      uploadTrace(traceId, {
        step:         "extract_complete",
        route,
        asin:         result.asin,
        poolId:       result.poolId,
        hasTitle:     Boolean(title),
        titlePreview: title ? title.slice(0, 80) : null,
        status:       result.poolId != null ? "pool_created" : "pool_missing",
        reason:       result.poolId == null ? "fetchPoolId_returned_null" : null,
      })
    } else {
      uploadTrace(traceId, {
        step:   "extract_failed",
        route,
        asin,
        status: "error",
        reason: result.error,
      })
    }

    return { status: 200, body: result }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    uploadError(traceId, {
      step:    "extract_failed",
      route,
      message: error.message,
      stack:   error.stack ?? null,
    })
    console.error("[ADMIN]", e)
    return err(error.message)
  }
}

export async function handlePostAiListingGenerate(req: AdminRequest): Promise<AdminResponse<AiListingOutput>> {
  try {
    const body = req.body as { asin?: string; storeCode?: string }
    if (!body.asin) return bad("asin is required")
    const workspaceId = getWorkspaceId()
    const asin = String(body.asin).trim().toUpperCase()

    const row = await query<{
      asin_registry_id: number
      asin: string
      title: string | null
      brand: string | null
      price: number | null
      images: unknown
      attributes: unknown
    }>(
      `SELECT ar.id AS asin_registry_id, ar.asin,
              apc.title, apc.brand, apc.price, apc.images, apc.attributes
       FROM asin_registry ar
       INNER JOIN amazon_product_cache apc ON apc.asin_registry_id = ar.id
       WHERE ar.workspace_id = $1 AND ar.asin = $2
       LIMIT 1`,
      [workspaceId, asin]
    )

    const r = row.rows[0]
    if (!r) return err("Product not found in amazon_product_cache for this workspace and ASIN", 404)

    const att = (r.attributes as Record<string, unknown>) ?? {}
    const input: AiListingInput = {
      asin: r.asin,
      title: r.title ?? "",
      brand: r.brand ?? "",
      price: typeof r.price === "number" ? r.price : 0,
      currency: (att.currency as string) ?? "USD",
      images: Array.isArray(r.images) ? (r.images as string[]) : [],
      bullets: Array.isArray(att.bullets) ? (att.bullets as string[]) : [],
      description: (att.description as string) ?? "",
      specs: typeof att.specs === "object" && att.specs !== null && !Array.isArray(att.specs)
        ? (att.specs as Record<string, string>)
        : {},
      rating: typeof att.rating === "number" ? att.rating : 0,
      reviews: typeof att.reviews === "number" ? att.reviews : 0,
      bsr: typeof att.bsr === "number" ? att.bsr : null,
      category: (att.category as string) ?? "",
      isPrime: att.isPrime === true,
      isFreeShipping: att.isFreeShipping === true,
    }

    const result = await generateAndCacheAiListing(workspaceId, r.asin_registry_id, input)
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostListingRun(req: AdminRequest): Promise<AdminResponse<AdminListingRunResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body        = req.body as Partial<AdminListingRunRequest>
    if (!body.storeCode)               return bad("storeCode is required")
    if (!body.count || body.count < 1) return bad("count must be >= 1")
    const quantity = body.quantity ?? 1
    if (!Number.isInteger(quantity) || quantity < 1) return bad("quantity must be an integer >= 1")

    const dryRun         = body.dryRun         ?? true
    const simulationMode = body.simulationMode ?? true
    const delaySeconds   = body.delaySeconds   ?? 5
    const startedAt      = new Date().toISOString()
    const t0             = Date.now()

    // body.poolIds verilmişse iç dispatch atlanır — dispatch-selected dışarıda zaten yapıldı
    const directPoolIds = Array.isArray(body.poolIds) && body.poolIds.length > 0
      ? body.poolIds
          .map(id => Number(id))
          .filter(id => Number.isInteger(id) && id >= 1)
      : undefined

    console.log(`[ListingRun] poolIds in body: ${directPoolIds?.length ?? 0}`)

    let dispatchResult: { selectedCount: number; skippedCount: number; assignedPoolIds: number[]; assignedAsins: string[] } | null = null
    let targetPoolIds: number[] | undefined

    let poolSkipDetails: PoolEligibilitySkipDetail[] = []

    if (directPoolIds && directPoolIds.length > 0) {
      const split = await splitEligiblePoolItems(workspaceId, directPoolIds)
      poolSkipDetails = split.skipDetails
      targetPoolIds = split.eligibleIds
      console.log(`[ListingRun] Direct poolIds mode: eligible=${targetPoolIds.length} skipped=${split.skipDetails.length}`)
      if (targetPoolIds.length === 0) {
        return {
          status: 400,
          body: { error: "no_eligible_pool_items", message: "No eligible pool items to publish." },
        }
      }
    } else {
      const storeLookup = await import("../../db/client").then(m =>
        m.query<{ id: number }>(
          `SELECT id FROM stores WHERE workspace_id = $1 AND store_code = $2 AND status = 'active' LIMIT 1`,
          [workspaceId, body.storeCode]
        )
      )
      const storeId = storeLookup.rows[0]?.id
      if (storeId) {
        const queueEntries = await fetchPublishQueueForStore(workspaceId, storeId, body.count)
        if (queueEntries.length > 0) {
          targetPoolIds = queueEntries.map(e => e.poolId)
          console.log(`[ListingRun] Publish queue mode: ${targetPoolIds.length} item(s)`)
        }
      }

      if (!targetPoolIds || targetPoolIds.length === 0) {
        dispatchResult = await runDispatch({
          workspaceId,
          storeCode:     body.storeCode,
          count:         body.count,
          selectionMode: body.selectionMode ?? "random",
          delaySeconds,
        })
        targetPoolIds = dispatchResult.assignedPoolIds.length > 0
          ? dispatchResult.assignedPoolIds
          : undefined
        console.log(`[ListingRun] Dispatch: selected=${dispatchResult.selectedCount} skipped=${dispatchResult.skippedCount}`)
      }
    }

    const titleMode = parseTitleMode(body.titleMode, body.useAiTitle)

    const publishResult = await runTimedPublishForStore({
      workspaceId,
      storeCode:      body.storeCode,
      delaySeconds,
      limit:          body.count,
      dryRun,
      simulationMode,
      quantity,
      ebayOauthToken: process.env.EBAY_OAUTH_TOKEN ?? "SIM_TOKEN",
      ebaySandbox:    (process.env.EBAY_SANDBOX ?? "true") !== "false",
      targetPoolIds,
      titleMode,
    })
    console.log(`[ListingRun] Publish: attempted=${publishResult.attempted} succeeded=${publishResult.succeeded} blocked=${publishResult.blocked}`)

    const completedAt = new Date().toISOString()
    const storeResult = await import("../../db/client").then(m =>
      m.query<{ name: string; id: number }>(
        `SELECT id, name FROM stores WHERE workspace_id = $1 AND store_code = $2 LIMIT 1`,
        [workspaceId, body.storeCode]
      )
    )
    const store = storeResult.rows[0]

    return {
      status: 200,
      body: {
        storeId:        store?.id ?? 0,
        storeCode:      body.storeCode,
        storeName:      store?.name ?? body.storeCode,
        dryRun,
        simulationMode,
        dispatch: {
          selectedCount:   dispatchResult?.selectedCount   ?? targetPoolIds?.length ?? 0,
          skippedCount:    dispatchResult?.skippedCount    ?? 0,
          assignedPoolIds: dispatchResult?.assignedPoolIds ?? targetPoolIds ?? [],
          assignedAsins:   dispatchResult?.assignedAsins   ?? [],
        },
        publish: {
          attempted:  publishResult.attempted,
          succeeded:  publishResult.succeeded,
          failed:     publishResult.failed,
          blocked:    publishResult.blocked,
          skipped:    publishResult.skipped,
          items:      publishResult.items,
          totalMs:    publishResult.totalMs,
        },
        poolSkipped:   poolSkipDetails.length > 0 ? poolSkipDetails.length : undefined,
        poolSkipDetails: poolSkipDetails.length > 0 ? poolSkipDetails : undefined,
        startedAt,
        completedAt,
        totalMs: Date.now() - t0,
      },
    }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostDispatch(req: AdminRequest): Promise<AdminResponse<AdminDispatchResponse>> {
  try {
    const body = req.body as Partial<AdminDispatchRequest>
    if (!body.storeCode)               return bad("storeCode is required")
    if (!body.count || body.count < 1) return bad("count must be >= 1")
    return {
      status: 200,
      body: await runDispatch({
        workspaceId:   getWorkspaceId(),
        storeCode:     body.storeCode,
        count:         body.count,
        selectionMode: body.selectionMode ?? "random",
        delaySeconds:  body.delaySeconds  ?? 120,
      }),
    }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostPublishRun(req: AdminRequest): Promise<AdminResponse<AdminPublishResponse>> {
  const traceId = reqTraceId(req)
  const route = "POST /admin/publish/run"
  try {
    const body = req.body as Partial<AdminPublishRequest>
    const titleMode = parseTitleMode(body.titleMode, body.useAiTitle)
    const rawPoolIds = Array.isArray(body.poolIds)
      ? body.poolIds.map(id => Number(id)).filter(id => Number.isInteger(id) && id >= 1)
      : []

    uploadTrace(traceId, {
      step:      "publish_request",
      route,
      poolIds:   rawPoolIds.length > 0 ? rawPoolIds : null,
      poolId:    rawPoolIds[0] ?? null,
      titleMode,
      status:    "received",
    })

    if (!body.storeCode) return bad("storeCode is required")
    const workspaceId = getWorkspaceId()

    let targetPoolIds: number[] | undefined
    let poolSkipDetails: PoolEligibilitySkipDetail[] | undefined

    if (rawPoolIds.length > 0) {
      const split = await splitEligiblePoolItems(workspaceId, rawPoolIds)
      poolSkipDetails = split.skipDetails.length > 0 ? split.skipDetails : undefined

      uploadTrace(traceId, {
        step:        "publish_eligibility_split",
        route,
        poolIds:     rawPoolIds,
        poolId:      split.eligibleIds[0] ?? rawPoolIds[0] ?? null,
        titleMode,
        status:      split.eligibleIds.length > 0 ? "eligible" : "none_eligible",
        skipDetails: split.skipDetails.length > 0 ? split.skipDetails : null,
      })

      if (split.eligibleIds.length === 0) {
        uploadTrace(traceId, {
          step:        "publish_aborted",
          route,
          poolIds:     rawPoolIds,
          titleMode,
          status:      "rejected",
          reason:      "no_eligible_pool_items",
          skipDetails: split.skipDetails,
        })
        return {
          status: 400,
          body: { error: "no_eligible_pool_items", message: "No eligible pool items to publish." },
        }
      }
      targetPoolIds = split.eligibleIds
    }

    const publishResult = await runTimedPublishForStore({
      workspaceId,
      storeCode:      body.storeCode,
      delaySeconds:   body.delaySeconds   ?? 5,
      limit:          targetPoolIds ? targetPoolIds.length * 3 : (body.limit ?? 10),
      dryRun:         body.dryRun         ?? true,
      quantity:       body.quantity        ?? 1,
      simulationMode: body.simulationMode ?? true,
      ebayOauthToken: process.env.EBAY_OAUTH_TOKEN ?? "SIM_TOKEN",
      ebaySandbox:    (process.env.EBAY_SANDBOX ?? "true") !== "false",
      targetPoolIds,
      titleMode,
    })

    uploadTrace(traceId, {
      step:      "publish_complete",
      route,
      poolIds:   targetPoolIds ?? null,
      poolId:    targetPoolIds?.[0] ?? rawPoolIds[0] ?? null,
      titleMode,
      status:    publishResult.succeeded > 0 ? "succeeded" : publishResult.attempted > 0 ? "failed" : "no_payloads",
      reason:    publishResult.succeeded > 0
        ? null
        : `attempted=${publishResult.attempted} failed=${publishResult.failed} skipped=${publishResult.skipped} blocked=${publishResult.blocked}`,
      skipDetails: poolSkipDetails ?? null,
    })

    return {
      status: 200,
      body: {
        ...publishResult,
        poolSkipped:     poolSkipDetails?.length,
        poolSkipDetails,
      } as AdminPublishResponse,
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    uploadError(traceId, {
      step:    "publish_failed",
      route,
      message: error.message,
      stack:   error.stack ?? null,
    })
    console.error("[ADMIN]", e)
    return err(error.message)
  }
}

export async function handlePostDispatchRunCreate(
  req: AdminRequest
): Promise<AdminResponse<DispatchRun>> {
  try {
    const body = req.body as Partial<{
      storeCode: string
      poolIds: number[]
      quantity: number
      delaySeconds: number
      titleMode?: string
      useAiTitle?: boolean
    }>

    if (!body.storeCode) return bad("storeCode is required")
    if (!Array.isArray(body.poolIds) || body.poolIds.length === 0) return bad("poolIds must be non-empty array")

    const poolIds = body.poolIds
      .map(id => Number(id))
      .filter(id => Number.isInteger(id) && id >= 1)

    if (poolIds.length === 0) return bad("poolIds must be non-empty integers")

    const workspaceId = getWorkspaceId()
    const split = await splitEligiblePoolItems(workspaceId, poolIds)
    if (split.eligibleIds.length === 0) {
      return {
        status: 400,
        body: { error: "no_eligible_pool_items", message: "No eligible pool items to dispatch." },
      }
    }

    const quantity = body.quantity ?? 1
    if (!Number.isInteger(quantity) || quantity < 1) return bad("quantity must be an integer >= 1")

    const delaySeconds = body.delaySeconds ?? 0
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0) return bad("delaySeconds must be an integer >= 0")

    const titleMode = parseTitleMode(body.titleMode, body.useAiTitle)

    const run = await createRunWithJobs(
      workspaceId,
      String(body.storeCode).trim(),
      split.eligibleIds,
      quantity,
      delaySeconds,
      titleMode
    )

    return {
      status: 200,
      body: {
        ...run,
        poolSkipped:     split.skipDetails.length > 0 ? split.skipDetails.length : undefined,
        poolSkipDetails: split.skipDetails.length > 0 ? split.skipDetails : undefined,
      },
    }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostDispatchJobClaimNext(
  req: AdminRequest
): Promise<AdminResponse<ClaimNextJobResult>> {
  try {
    console.log("[ClaimNext] handler entered")
    const body = req.body as Partial<{ workerId: string; storeCode: string | null }>
    console.log('[ClaimNext] request:', req.body)
    if (!body.workerId || String(body.workerId).trim() === "") return bad("workerId is required")

    const result = await claimNext(
      getWorkspaceId(),
      body.storeCode ? String(body.storeCode).trim() : null,
      String(body.workerId).trim()
    )
    console.log('[ClaimNext] result:', JSON.stringify(result))
    return { status: 200, body: { job: result.job } }
  } catch (e) {
    console.error("[ClaimNext] ERROR:", e instanceof Error ? e.stack : JSON.stringify(e))
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostDispatchJobReport(
  req: AdminRequest
): Promise<AdminResponse<{ ok: true }>> {
  try {
    const body = req.body as Partial<ReportJobRequest> & {
      jobId?: number
      workerId?: string
      status?: string
    }
    const jobId = body.jobId
    if (!Number.isInteger(jobId) || (jobId as number) < 1) return bad("jobId must be an integer >= 1")
    if (!body.workerId || String(body.workerId).trim() === "") return bad("workerId is required")
    if (!body.status || String(body.status).trim() === "") return bad("status is required")

    await reportProgress(
      jobId as number,
      String(body.workerId).trim(),
      body.status as ReportJobRequest["status"],
      body.error !== undefined ? String(body.error) : undefined,
      body.failedStage as ReportJobRequest["failedStage"],
      body.failureKind
    )

    return { status: 200, body: { ok: true } }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostDispatchJobsCleanupStale(
  req: AdminRequest
): Promise<AdminResponse<{ cleaned: number }>> {
  try {
    const body = req.body as Partial<{ workerId: string }>
    if (!body.workerId || String(body.workerId).trim() === "") return bad("workerId is required")

    const workerId = String(body.workerId).trim()
    const result = await query(
      `UPDATE dispatch_jobs
       SET status = 'pending',
           claimed_at = NULL,
           worker_id = NULL,
           updated_at = NOW()
       WHERE worker_id = $1
         AND status IN ('claimed','extract_running','ai_running','listing_running')
         AND claimed_at < NOW() - interval '3 minutes'`,
      [workerId]
    )

    return { status: 200, body: { cleaned: result.rowCount ?? 0 } }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handleGetDispatchRunStatus(
  req: AdminRequest
): Promise<AdminResponse<RunStatusResult>> {
  try {
    const workspaceId = getWorkspaceId()
    const runIdRaw = req.query["runId"]
    const runId = runIdRaw ? parseInt(runIdRaw, 10) : NaN
    if (!Number.isInteger(runId) || runId < 1) return bad("runId must be an integer >= 1")

    const result = await getRunStatus(workspaceId, runId)
    return { status: 200, body: result }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handleGetDispatchActiveRuns(
  req: AdminRequest
): Promise<AdminResponse<DispatchRun[]>> {
  try {
    const result = await getActiveRuns(getWorkspaceId())
    return { status: 200, body: result }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handleGetMonitorListings(req: AdminRequest): Promise<AdminResponse<MonitorListingsResult>> {
  try {
    const workspaceId = getWorkspaceId()
    const storeCode   = req.query["storeCode"] ?? "S1"
    const limitParam  = req.query["limit"]
    const offsetParam = req.query["offset"]
    const limit       = limitParam !== undefined ? Math.max(1, Math.min(200, parseInt(String(limitParam), 10) || 50)) : 50
    const offset      = offsetParam !== undefined ? Math.max(0, parseInt(String(offsetParam), 10) || 0) : 0
    const includeHidden = req.query["includeHidden"] === "true" || req.query["includeHidden"] === "1"
    const result = await getMonitorListings(workspaceId, storeCode, offset, limit, {
      includeHidden,
      search:   req.query["search"]?.trim(),
      status:   req.query["status"]?.trim(),
      sortBy:   req.query["sortBy"]?.trim(),
      sortDir:  req.query["sortDir"]?.trim(),
    })
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleGetEbayConnectUrl(req: AdminRequest): Promise<AdminResponse<EbayConnectUrlResponse>> {
  try {
    const workspaceId  = getWorkspaceId()
    const storeCode    = req.query["storeCode"] ?? "S1"
    const simulation   = (process.env.EBAY_SIMULATION ?? "true") !== "false"
    return { status: 200, body: await buildAuthUrl(workspaceId, storeCode, simulation) }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

/** storeCode=AUTO → sıradaki S1,S2,… kodu ile OAuth URL (mağaza callback’te oluşur). */
export async function handlePostEbayAuthUrl(req: AdminRequest): Promise<AdminResponse<EbayConnectUrlResponse>> {
  try {
    const workspaceId   = getWorkspaceId()
    const storeCodeRaw  = String(req.query["storeCode"] ?? "").trim().toUpperCase()
    const simulation    = (process.env.EBAY_SIMULATION ?? "true") !== "false"
    if (storeCodeRaw !== "AUTO") return bad("storeCode must be AUTO")
    const nextCode = await findNextAutoStoreCode(workspaceId)
    return { status: 200, body: await buildAuthUrl(workspaceId, nextCode, simulation, true) }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

/** Settings “+ Add Store”: sıradaki S kodu + OAuth URL (query gerekmez). */
export async function handlePostEbayConnect(_req: AdminRequest): Promise<AdminResponse<EbayConnectUrlResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const simulation  = (process.env.EBAY_SIMULATION ?? "true") !== "false"
    const nextCode    = await findNextAutoStoreCode(workspaceId)
    return { status: 200, body: await buildAuthUrl(workspaceId, nextCode, simulation, true) }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleGetEbayCallback(req: AdminRequest): Promise<AdminResponse<EbayCallbackResult>> {
  try {
    const workspaceId  = getWorkspaceId()
    const code         = req.query["code"]  ?? ""
    const state        = req.query["state"] ?? ""
    const simulation   = (process.env.EBAY_SIMULATION ?? "true") !== "false"
    if (!code)  return bad("code is required")
    if (!state) return bad("state is required")
    const result = await handleCallback(workspaceId, code, state, simulation)
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleGetEbayAccountStatus(req: AdminRequest): Promise<AdminResponse<EbayAccountStatus>> {
  try {
    const workspaceId = getWorkspaceId()
    const storeCode   = req.query["storeCode"] ?? "S1"
    return { status: 200, body: await getAccountStatus(workspaceId, storeCode) }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleGetEbayAccounts(_req: AdminRequest): Promise<AdminResponse<{ accounts: unknown[] }>> {
  try {
    const accounts = await getAllAccounts(getWorkspaceId())
    return { status: 200, body: { accounts } }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostEbayOAuthReconnect(
  req: AdminRequest
): Promise<AdminResponse<EbayOAuthReconnectResponse | { ok: false; error: string }>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as { storeCode?: string; force?: boolean }
    const storeCode = String(body.storeCode ?? "").trim()
    if (!storeCode) return bad("storeCode is required")

    const result = await buildReconnectAuthUrl(workspaceId, storeCode)
    return {
      status: 200,
      body: {
        ok: true,
        storeCode: result.storeCode,
        authUrl: result.authUrl,
      },
    }
  } catch (e) {
    console.error("[ADMIN][ebay/oauth/reconnect]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostEbayRefresh(req: AdminRequest): Promise<AdminResponse<{ accessToken: string; expiresAt: string }>> {
  try {
    const workspaceId = getWorkspaceId()
    const body        = req.body as { storeCode?: string }
    const storeCode   = body.storeCode ?? "S1"
    const simulation  = (process.env.EBAY_SIMULATION ?? "true") !== "false"
    const result      = await refreshAccessToken(workspaceId, storeCode, simulation)
    void scheduleCatalogSyncImmediate(workspaceId, storeCode).catch(console.warn)
    return { status: 200, body: { accessToken: result.accessToken, expiresAt: result.expiresAt } }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostEbayDisconnect(
  req: AdminRequest,
): Promise<AdminResponse<{ ok: true }>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as { storeCode?: string }
    if (!body.storeCode) return bad("storeCode is required")
    const storeCode = String(body.storeCode).trim()
    if (!storeCode) return bad("storeCode is required")

    // 1) store_id'yi stores tablosundan bul
    const storeRes = await query<{ id: number }>(
      `SELECT id
       FROM stores
       WHERE workspace_id = $1
         AND store_code = $2
       LIMIT 1`,
      [workspaceId, storeCode]
    )
       const storeId = storeRes.rows[0]?.id
    if (!storeId) return bad("Store not found")

    await query(
      `DELETE FROM ebay_accounts
       WHERE workspace_id = $1 AND store_id = $2`,
      [workspaceId, storeId]
    )
    await query(
      `DELETE FROM stores
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, storeId]
    )

    return { status: 200, body: { ok: true } }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostMonitorUpdatePrice(req: AdminRequest): Promise<AdminResponse<UpdatePriceResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body        = req.body as Partial<UpdatePriceRequest>
    if (!body.storeCode)                    return bad("storeCode is required")
    if (!body.sku)                          return bad("sku is required")
    if (!body.newPrice || body.newPrice <= 0) return bad("newPrice must be > 0")
    const simulation = (process.env.EBAY_SIMULATION ?? "true") !== "false"
    const sandbox    = (process.env.EBAY_SANDBOX    ?? "true") !== "false"
    return { status: 200, body: await updatePrice(workspaceId, body as UpdatePriceRequest, simulation, sandbox) }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostMonitorUpdateStock(req: AdminRequest): Promise<AdminResponse<UpdateStockResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body        = req.body as Partial<UpdateStockRequest>
    if (!body.storeCode)             return bad("storeCode is required")
    if (!body.sku)                   return bad("sku is required")
    if (body.quantity === undefined) return bad("quantity is required")
    const simulation = (process.env.EBAY_SIMULATION ?? "true") !== "false"
    const sandbox    = (process.env.EBAY_SANDBOX    ?? "true") !== "false"
    return { status: 200, body: await updateStock(workspaceId, body as UpdateStockRequest, simulation, sandbox) }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostMonitorUpdateSourceUrl(req: AdminRequest): Promise<AdminResponse<{ ok: boolean }>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as { storeCode?: string; sku?: string; sourceUrl?: string }
    if (!body.storeCode) return bad("storeCode is required")
    if (!body.sku)       return bad("sku is required")
    if (!body.sourceUrl) return bad("sourceUrl is required")
    await updateSourceUrl(workspaceId, body.sku, body.sourceUrl)
    return { status: 200, body: { ok: true } }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostMonitorBlind(req: AdminRequest): Promise<AdminResponse<BlindResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body        = req.body as Partial<BlindRequest>
    if (!body.storeCode) return bad("storeCode is required")
    if (!body.sku)       return bad("sku is required")
    const simulation = (process.env.EBAY_SIMULATION ?? "true") !== "false"
    const sandbox    = (process.env.EBAY_SANDBOX    ?? "true") !== "false"
    return { status: 200, body: await blindListing(workspaceId, body as BlindRequest, simulation, sandbox) }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostListingsImportMatch(
  req: AdminRequest
): Promise<AdminResponse<ImportMatchResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<ImportMatchRequest>
    if (!body.storeCode?.trim()) return bad("storeCode is required")
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      return bad("rows must be a non-empty array")
    }
    const result = await importMatchListings(workspaceId, {
      storeCode: String(body.storeCode).trim(),
      rows: body.rows.map(r => ({
        ebayItemId: String(r?.ebayItemId ?? "").trim(),
        asin:       String(r?.asin ?? "").trim(),
      })),
    })
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostListingsStockGuard(
  req: AdminRequest
): Promise<AdminResponse<StockGuardResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<StockGuardRequest>
    if (!body.storeCode?.trim()) return bad("storeCode is required")
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return bad("items must be a non-empty array")
    }
    if (typeof body.enabled !== "boolean") return bad("enabled must be a boolean")
    const result = await setStockGuard(workspaceId, {
      storeCode: String(body.storeCode).trim(),
      enabled:   body.enabled,
      items: body.items.map(i => ({
        ebayItemId: String(i?.ebayItemId ?? "").trim(),
      })),
    })
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostListingsRemoveFromList(
  req: AdminRequest
): Promise<AdminResponse<RemoveFromListResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<RemoveFromListRequest>
    if (!body.storeCode?.trim()) return bad("storeCode is required")
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return bad("items must be a non-empty array")
    }
    const result = await removeFromList(
      workspaceId,
      String(body.storeCode).trim(),
      body.items.map(i => ({ ebayItemId: String(i?.ebayItemId ?? "").trim() }))
    )
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostListingsRestoreToList(
  req: AdminRequest
): Promise<AdminResponse<RestoreToListResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<RestoreToListRequest>
    if (!body.storeCode?.trim()) return bad("storeCode is required")
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return bad("items must be a non-empty array")
    }
    const result = await restoreToList(
      workspaceId,
      String(body.storeCode).trim(),
      body.items.map(i => ({ ebayItemId: String(i?.ebayItemId ?? "").trim() }))
    )
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleGetListingsRecommendedPrice(
  req: AdminRequest
): Promise<AdminResponse<unknown>> {
  try {
    const workspaceId = getWorkspaceId()
    const storeCode = String(req.query?.storeCode ?? "").trim()
    const catalogStateId = Number(req.query?.catalogStateId)
    if (!storeCode) return bad("storeCode is required")
    if (!Number.isFinite(catalogStateId)) return bad("catalogStateId is required")
    const body = await getRecommendedPriceForListing(workspaceId, storeCode, catalogStateId)
    return { status: 200, body }
  } catch (e) {
    console.error("[ADMIN][recommended-price]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostListingsUpdateEbayPrice(
  req: AdminRequest
): Promise<AdminResponse<{ ok: true; oldPrice: number; newPrice: number }>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as {
      storeCode?: string
      catalogStateId?: number
      newPrice?: number
    }
    if (!body.storeCode?.trim()) return bad("storeCode is required")
    const catalogStateId = Number(body.catalogStateId)
    if (!Number.isFinite(catalogStateId)) return bad("catalogStateId is required")
    const newPrice = Number(body.newPrice)
    if (!Number.isFinite(newPrice) || newPrice <= 0) return bad("newPrice must be > 0")

    const result = await updateEbayListingPrice({
      workspaceId,
      storeCode: String(body.storeCode).trim(),
      catalogStateId,
      newPrice,
    })
    return { status: 200, body: result }
  } catch (e) {
    console.error("[ADMIN][update-ebay-price]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostListingsUpdateSourceAsin(
  req: AdminRequest
): Promise<AdminResponse<UpdateSourceAsinResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as {
      storeCode?: string
      catalogStateId?: number
      newAsin?: string
    }
    if (!body.storeCode?.trim()) return bad("storeCode is required")
    const catalogStateId = Number(body.catalogStateId)
    if (!Number.isFinite(catalogStateId)) return bad("catalogStateId is required")
    if (!String(body.newAsin ?? "").trim()) return bad("newAsin is required")

    const result = await updateListingSourceAsin({
      workspaceId,
      storeCode: String(body.storeCode).trim(),
      catalogStateId,
      newAsinRaw: String(body.newAsin),
    })
    return { status: 200, body: result }
  } catch (e) {
    console.error("[ADMIN][update-source-asin]", e)
    const msg = e instanceof Error ? e.message : String(e)
    const clientErrors = [
      "ASIN is required",
      "ASIN must be 10 characters",
      "storeCode is required",
      "catalogStateId is required",
      "newAsin is required",
      "New ASIN must be different",
      "New ASIN is not confirmed active",
      "Active store not found",
      "Listing not found",
    ]
    if (clientErrors.some(prefix => msg.startsWith(prefix) || msg === prefix)) {
      return bad(msg)
    }
    return err(msg)
  }
}

export async function handlePostListingsSourceStatus(
  req: AdminRequest
): Promise<AdminResponse<SourceStatusResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<SourceStatusRequest>
    if (!body.storeCode?.trim()) return bad("storeCode is required")
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return bad("items must be a non-empty array")
    }
    if (!body.sourceStatus?.trim()) return bad("sourceStatus is required")
    const result = await setSourceStatus(workspaceId, {
      storeCode:          String(body.storeCode).trim(),
      sourceStatus:       String(body.sourceStatus).trim().toUpperCase() as SourceStatusRequest["sourceStatus"],
      sourceStatusReason: body.sourceStatusReason ?? null,
      items: body.items.map(i => ({
        ebayItemId: String(i?.ebayItemId ?? "").trim(),
      })),
    })
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostListingsEnd(
  req: AdminRequest
): Promise<AdminResponse<EndListingResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<EndListingRequest>
    if (!body.storeCode?.trim()) return bad("storeCode is required")
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return bad("items must be a non-empty array")
    }
    const result = await endListings(workspaceId, {
      storeCode: String(body.storeCode).trim(),
      items: body.items.map(i => ({
        ebayItemId:
          i?.ebayItemId != null && String(i.ebayItemId).trim()
            ? String(i.ebayItemId).trim()
            : undefined,
        catalogStateId:
          typeof i?.catalogStateId === "number" && i.catalogStateId > 0
            ? i.catalogStateId
            : undefined,
      })),
    })
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostListingsSyncListings(
  req: AdminRequest
): Promise<AdminResponse<SyncListingsResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as { storeCode?: string }
    const storeCode = body.storeCode?.trim()
    if (!storeCode) return bad("storeCode is required")

    const result = await syncListingsForStore(workspaceId, storeCode)
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

/** Debug: run one store sync queue job (catalog / metrics / 30D clicks). */
export async function handlePostStoreSyncQueueTick(
  _req: AdminRequest
): Promise<AdminResponse<{ ok: true; message: string }>> {
  await processStoreSyncQueue()
  return { status: 200, body: { ok: true, message: "Store sync queue tick completed" } }
}

export async function handlePostListingsSync30dClicks(
  req: AdminRequest
): Promise<AdminResponse<Sync30dClicksResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as { storeCode?: string }
    if (!body.storeCode?.trim()) return bad("storeCode is required")
    const storeCode = String(body.storeCode).trim()
    const result = await sync30dClicksForStore(workspaceId, storeCode)
    await recordClicks30dSyncFromResult(workspaceId, storeCode, result)
    return { status: 200, body: result }
  } catch (e) {
    console.error("[ADMIN][sync-30d-clicks]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostListingsSyncMetrics(
  req: AdminRequest
): Promise<AdminResponse<SyncMetricsResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<SyncMetricsRequest>
    if (!body.storeCode?.trim()) return bad("storeCode is required")

    const ebayItemIds = Array.isArray(body.ebayItemIds)
      ? body.ebayItemIds.map(id => String(id ?? "").trim()).filter(Boolean)
      : undefined

    const result = await syncListingMetrics(workspaceId, {
      storeCode: String(body.storeCode).trim(),
      ebayItemIds,
    })
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleGetListingsStoreDebug(
  req: AdminRequest
): Promise<AdminResponse<StoreListingsDebug>> {
  try {
    const workspaceId = getWorkspaceId()
    const storeCode   = req.query["storeCode"]?.trim()
    if (!storeCode) return bad("storeCode is required")
    const result = await getStoreListingsDebug(workspaceId, storeCode)
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleGetSettings(req: AdminRequest): Promise<AdminResponse<SettingsForStoreResponse | null>> {
  try {
    const workspaceId = getWorkspaceId()
    const storeCode   = req.query["storeCode"] ?? "S1"
    const result      = await getSettingsForStore(workspaceId, storeCode)
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostSettingsAddress(req: AdminRequest): Promise<AdminResponse<SettingsForStoreResponse | null>> {
  try {
    const workspaceId = getWorkspaceId()
    const body        = req.body as Partial<
      StoreAddress & { storeCode: string; registrationCountry?: string | null }
    >
    if (!body.storeCode) return bad("storeCode is required")
    const storeCode = String(body.storeCode).trim()

    if (!String(body.firstName ?? "").trim()) return bad("firstName is required")
    if (!String(body.lastName ?? "").trim())  return bad("lastName is required")
    if (!String(body.address1 ?? "").trim()) return bad("address1 is required")
    if (!String(body.city ?? "").trim())      return bad("city is required")
    if (!String(body.state ?? "").trim())     return bad("state is required")
    if (!String(body.zip ?? "").trim())       return bad("zip (postcode) is required")
    if (!String(body.country ?? "").trim())  return bad("country is required")

    const address: StoreAddress = {
      firstName: String(body.firstName).trim(),
      lastName:  String(body.lastName).trim(),
      company:   body.company ? String(body.company).trim() : null,
      address1:  String(body.address1).trim(),
      address2:  body.address2 ? String(body.address2).trim() : null,
      city:      String(body.city).trim(),
      state:     String(body.state).trim(),
      zip:       String(body.zip).trim(),
      country:   String(body.country).trim().toUpperCase().slice(0, 2),
    }

    const result = await saveAddress(workspaceId, storeCode, address, {
      registrationCountry: body.registrationCountry?.trim() || null,
    })
    if (!result) return bad("Store not found")

    await syncWarehouseMerchantLocationToEbay(workspaceId, storeCode, address)

    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleGetSettingsPolicies(req: AdminRequest): Promise<AdminResponse<EbayPoliciesResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const storeCode   = req.query["storeCode"] ?? "S1"
    const result      = await fetchEbayPolicies(workspaceId, storeCode)
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostSettingsPolicies(req: AdminRequest): Promise<AdminResponse<SettingsForStoreResponse | null>> {
  try {
    const workspaceId = getWorkspaceId()
    const body        = req.body as {
      storeCode?: string
      fulfillmentPolicyId?: string | null
      paymentPolicyId?:     string | null
      returnPolicyId?:      string | null
      countryOrRegion?:     string | null
      cityState?:           string | null
    }
    if (!body.storeCode) return bad("storeCode is required")
    const result = await savePolicies(workspaceId, body.storeCode, {
      fulfillmentPolicyId: body.fulfillmentPolicyId ?? null,
      paymentPolicyId:     body.paymentPolicyId     ?? null,
      returnPolicyId:      body.returnPolicyId      ?? null,
      countryOrRegion:     body.countryOrRegion !== undefined ? String(body.countryOrRegion).trim() || null : undefined,
      cityState:           body.cityState !== undefined ? String(body.cityState).trim() || null : undefined,
    })
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleGetNotifications(req: AdminRequest): Promise<AdminResponse<{ rows: unknown[] }>> {
  try {
    const limit = req.query["limit"] ? parseInt(req.query["limit"]!, 10) : 50
    const rows = await fetchPersistedNotifications(getWorkspaceId(), Number.isFinite(limit) && limit > 0 ? limit : 50)
    return { status: 200, body: { rows } }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostNotificationsRead(req: AdminRequest): Promise<AdminResponse<{ updated: number }>> {
  try {
    const body = req.body as { ids?: unknown }
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is number => typeof x === "number" && x > 0) : []
    if (ids.length === 0) return bad("ids must be a non-empty array of numbers")
    const updated = await markNotificationsAsRead(getWorkspaceId(), ids)
    return { status: 200, body: { updated } }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostNotificationsReadAll(req: AdminRequest): Promise<AdminResponse<{ updated: number }>> {
  try {
    const updated = await markAllNotificationsAsRead(getWorkspaceId())
    return { status: 200, body: { updated } }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

// GET /admin/orders — list orders from DB (no live eBay call).
export async function handleGetOrders(req: AdminRequest): Promise<AdminResponse<OrdersListResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const allStores = String(req.query["allStores"] ?? "").trim() === "true"

    if (allStores) {
      const orders = await listOrdersFromDb(workspaceId, { allStores: true })
      return { status: 200, body: { ok: true, allStores: true, storeCode: null, orders, errors: [] } }
    }

    const storeCode = String(req.query["storeCode"] ?? "").trim()
    if (!storeCode) return bad("storeCode is required")

    const store = await getOrderStoreByCode(workspaceId, storeCode)
    if (!store) return bad("Store not found")

    const orders = await listOrdersFromDb(workspaceId, { storeId: store.id, allStores: false })
    return { status: 200, body: { ok: true, allStores: false, storeCode, orders, errors: [] } }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

// POST /admin/orders/sync — fetch from eBay, upsert to DB, then return DB list.
export async function handlePostOrdersSync(req: AdminRequest): Promise<AdminResponse<OrdersListResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = (req.body ?? {}) as { storeCode?: string; allStores?: boolean }
    const allStores = body.allStores === true || String(req.query["allStores"] ?? "").trim() === "true"

    if (allStores) {
      const { errors } = await syncOrdersForAllStores(workspaceId)
      const orders = await listOrdersFromDb(workspaceId, { allStores: true })
      return { status: 200, body: { ok: true, allStores: true, storeCode: null, orders, errors } }
    }

    const storeCode = String(body.storeCode ?? req.query["storeCode"] ?? "").trim()
    if (!storeCode) return bad("storeCode is required")

    const store = await getOrderStoreByCode(workspaceId, storeCode)
    if (!store) return bad("Store not found")

    const outcome = await syncOrdersForStore(workspaceId, store)
    const errors = outcome.error ? [outcome.error] : []
    const orders = await listOrdersFromDb(workspaceId, { storeId: store.id, allStores: false })
    return { status: 200, body: { ok: true, allStores: false, storeCode, orders, errors } }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

function parseOrderId(req: AdminRequest): number | null {
  const raw = req.params["orderId"]
  if (!raw) return null
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 1 ? n : null
}

// GET /admin/orders/:orderId — single order detail from DB.
export async function handleGetOrderDetail(
  req: AdminRequest
): Promise<AdminResponse<OrderDetail>> {
  try {
    const orderId = parseOrderId(req)
    if (!orderId) return bad("Invalid order id")

    const detail = await getOrderDetail(getWorkspaceId(), orderId)
    if (!detail) return err("Sipariş bulunamadı", 404)
    return { status: 200, body: detail }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

// POST /admin/orders/:orderId/earnings — refresh eBay Order earnings for this order only.
export async function handlePostOrderEarnings(
  req: AdminRequest
): Promise<AdminResponse<OrderDetail>> {
  try {
    const orderId = parseOrderId(req)
    if (!orderId) return bad("Invalid order id")

    const detail = await refreshOrderEarnings(getWorkspaceId(), orderId)
    if (!detail) return err("Sipariş bulunamadı", 404)
    return { status: 200, body: detail }
  } catch (e) {
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

// PATCH /admin/orders/:orderId — save local manual operation fields only.
export async function handlePatchOrder(
  req: AdminRequest
): Promise<AdminResponse<OrderDetail>> {
  try {
    const orderId = parseOrderId(req)
    if (!orderId) return bad("Invalid order id")

    const body = (req.body ?? {}) as Record<string, unknown>
    const input: OrderManualUpdateInput = {}

    const normStr = (v: unknown): string | null => {
      if (v === null) return null
      if (typeof v !== "string") return null
      const t = v.trim()
      return t.length > 0 ? t : null
    }

    if ("notes" in body) input.notes = normStr(body["notes"])
    if ("amazonOrderNumber" in body) input.amazonOrderNumber = normStr(body["amazonOrderNumber"])
    if ("amazonOrderUrl" in body) input.amazonOrderUrl = normStr(body["amazonOrderUrl"])
    if ("amazonPurchasePrice" in body) {
      const raw = body["amazonPurchasePrice"]
      if (raw === null || raw === "") {
        input.amazonPurchasePrice = null
      } else {
        const n = typeof raw === "number" ? raw : parseFloat(String(raw))
        input.amazonPurchasePrice = Number.isFinite(n) ? n : null
      }
    }
    if ("operationStatus" in body) {
      const raw = body["operationStatus"]
      if (!isOperationStatus(raw)) return bad("Geçersiz operasyon durumu")
      input.operationStatus = raw
    }

    const detail = await updateManualFields(getWorkspaceId(), orderId, input)
    if (!detail) return err("Sipariş bulunamadı", 404)
    return { status: 200, body: detail }
  } catch (e) {
    if (e instanceof OrdersHttpError) return err(e.message, e.status)
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

// GET /admin/orders/:orderId/assist — assisted Amazon order packet (read-only).
export async function handleGetOrderAssist(
  req: AdminRequest
): Promise<AdminResponse<AssistedOrderPacket>> {
  try {
    const orderId = parseOrderId(req)
    if (!orderId) return bad("Invalid order id")

    const autoRun = String(req.query?.autoRun ?? "") === "1"
    const packet = await buildAssistPacket(getWorkspaceId(), orderId, autoRun)
    return { status: 200, body: packet }
  } catch (e) {
    if (e instanceof OrdersHttpError) return err(e.message, e.status)
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

// PATCH /admin/orders/:orderId/assist-asin — manual ASIN on primary item only.
export async function handlePatchOrderAsin(
  req: AdminRequest
): Promise<AdminResponse<{ asin: string }>> {
  try {
    const orderId = parseOrderId(req)
    if (!orderId) return bad("Invalid order id")

    const body = req.body as Partial<{ asin: string }>
    const asin = typeof body.asin === "string" ? body.asin : ""
    if (!asin.trim()) return bad("ASIN gerekli")

    const result = await setManualAsin(getWorkspaceId(), orderId, asin)
    return { status: 200, body: result }
  } catch (e) {
    if (e instanceof OrdersHttpError) return err(e.message, e.status)
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handleGetStockAlerts(req: AdminRequest): Promise<AdminResponse<StockAlertsListResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const storeCode   = req.query["storeCode"] ?? ""
    const status      = (req.query["status"] ?? "pending").trim() as StockReviewStatus
    const risk        = req.query["risk"]?.trim()
    const search      = req.query["search"]?.trim()
    const limitParam  = req.query["limit"]
    const offsetParam = req.query["offset"]
    const limit       = limitParam !== undefined ? Math.max(1, Math.min(200, parseInt(String(limitParam), 10) || 50)) : 50
    const offset      = offsetParam !== undefined ? Math.max(0, parseInt(String(offsetParam), 10) || 0) : 0

    const safeStatus: StockReviewStatus = parseAdminStockReviewStatus(status)

    const result = await listStockAlerts({
      workspaceId,
      storeCode: storeCode.trim(),
      status: safeStatus,
      risk,
      search,
      offset,
      limit,
    })
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostStockAlertsIgnore(
  req: AdminRequest
): Promise<AdminResponse<StockAlertsIgnoreResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<StockAlertsIgnoreRequest>
    const storeCode = String(body.storeCode ?? "").trim()
    const ids = Array.isArray(body.ids) ? body.ids.map(id => Number(id)).filter(n => Number.isFinite(n)) : []
    if (!storeCode) return bad("storeCode is required")
    const result = await ignoreStockAlerts(workspaceId, storeCode, ids)
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostStockAlertsApproveZero(
  req: AdminRequest
): Promise<AdminResponse<StockAlertsApproveZeroResponse | { ok: false; error: string }>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<StockAlertsApproveZeroRequest>
    const storeCode = String(body.storeCode ?? "").trim()
    const ids = Array.isArray(body.ids) ? body.ids.map(id => Number(id)).filter(n => Number.isFinite(n)) : []
    if (!storeCode) return bad("storeCode is required")
    const result = await approveZeroStockAlerts(workspaceId, storeCode, ids)
    return { status: 200, body: result }
  } catch (e) {
    if (e instanceof StockAlertsHttpError) {
      return { status: e.httpStatus, body: { ok: false, error: e.message } }
    }
    console.error("[ADMIN]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostSettingsMarkup(
  req: AdminRequest
): Promise<AdminResponse<{ ok: true; markupPercent: number }>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as { storeCode?: string; markupPercent?: number }
    if (!body.storeCode) return bad("storeCode is required")
    if (typeof body.markupPercent !== "number" || !Number.isFinite(body.markupPercent)) {
      return bad("markupPercent must be a number")
    }
    const markupPercent = Number(body.markupPercent)
    if (markupPercent < 1 || markupPercent > 1000) {
      return bad("markupPercent must be between 1 and 1000")
    }
    await saveMarkup(workspaceId, String(body.storeCode).trim(), markupPercent)
    return { status: 200, body: { ok: true, markupPercent } }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostSettingsPricing(
  req: AdminRequest
): Promise<AdminResponse<SettingsForStoreResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as {
      storeCode?: string
      pricingMode?: unknown
      percentageNetProfitPercent?: unknown
      tieredProfitOverrides?: unknown
    }
    const storeCode = String(body.storeCode ?? "").trim()
    if (!storeCode) return bad("storeCode is required")
    if (!isPricingMode(body.pricingMode)) return bad("Invalid pricingMode")
    const percentage = Number(body.percentageNetProfitPercent)
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 1000) {
      return bad("percentageNetProfitPercent must be between 0 and 1000")
    }
    const overrides = normalizeTieredProfitOverrides(body.tieredProfitOverrides)
    const saved = await savePricing(workspaceId, storeCode, {
      pricingMode: body.pricingMode,
      percentageNetProfitPercent: percentage,
      tieredProfitOverrides: overrides,
    })
    return { status: 200, body: saved }
  } catch (e) {
    console.error("[ADMIN]", e)
    const msg = e instanceof Error ? e.message : String(e)
    return bad(msg)
  }
}

export async function handlePostSettingsWarehouseBanner(
  req: AdminRequest
): Promise<AdminResponse<{ ok: true; storeCode: string; warehouseShippingBannerEnabled: boolean }>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as { storeCode?: string; warehouseShippingBannerEnabled?: boolean }
    if (!body.storeCode) return bad("storeCode is required")
    if (typeof body.warehouseShippingBannerEnabled !== "boolean") {
      return bad("warehouseShippingBannerEnabled must be a boolean")
    }
    const storeCode = String(body.storeCode).trim()
    const enabled = body.warehouseShippingBannerEnabled
    await saveWarehouseBanner(workspaceId, storeCode, enabled)
    return { status: 200, body: { ok: true, storeCode, warehouseShippingBannerEnabled: enabled } }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export {
  handlePostSchedulePublish,
  handleGetScheduleCommands,
  handleGetScheduleCommandById,
  handleGetScheduleCommandJobs,
  handlePostScheduleCommandCancel,
  handlePostScheduleCommandPause,
  handlePostScheduleCommandResume,
  handlePostScheduleRunnerRunDue,
  handleGetScheduleRunnerStatus,
  handlePostScheduleRunnerRunLiveOne,
}

import {
  handlePostExtensionCaptureJobs,
  handleGetExtensionCaptureJob,
  handleGetActiveExtensionCaptureJobs,
  handlePostExtensionCaptureClaimNext,
  handlePostExtensionCaptureItemStart,
  handlePostExtensionCaptureItemSubmit,
  handlePostExtensionCaptureItemFail,
  handlePostExtensionCaptureJobCancel,
  handlePostExtensionCaptureItemPromotionRetry,
} from "../extensionCapture/extensionCaptureRoutes"

export {
  handlePostExtensionCaptureJobs,
  handleGetExtensionCaptureJob,
  handleGetActiveExtensionCaptureJobs,
  handlePostExtensionCaptureClaimNext,
  handlePostExtensionCaptureItemStart,
  handlePostExtensionCaptureItemSubmit,
  handlePostExtensionCaptureItemFail,
  handlePostExtensionCaptureJobCancel,
  handlePostExtensionCaptureItemPromotionRetry,
}

export const adminRouteMap = [
  { method: "GET",  path: "/admin/summary",                handler: handleGetSummary        },
  { method: "GET",  path: "/admin/queue",                  handler: handleGetQueue          },
  { method: "GET",  path: "/admin/history",                handler: handleGetHistory        },
  { method: "GET",  path: "/admin/stores",                 handler: handleGetStores         },
  { method: "GET",  path: "/admin/notifications",          handler: handleGetNotifications },
  { method: "POST", path: "/admin/notifications/read",     handler: handlePostNotificationsRead },
  { method: "POST", path: "/admin/notifications/read-all", handler: handlePostNotificationsReadAll },
  { method: "POST", path: "/admin/stores/create",        handler: handlePostCreateStore },
  { method: "GET",  path: "/admin/pool",                   handler: handleGetPool           },
  { method: "POST", path: "/admin/pool/dispatch-selected", handler: handlePostPoolDispatch  },
  { method: "POST", path: "/admin/pool/delete-selected",   handler: handlePostPoolDeleteSelected },
  { method: "DELETE", path: "/admin/pool",                handler: handleDeletePoolItems  },
  { method: "POST",   path: "/admin/pool/restore",        handler: handlePostPoolRestore  },
  { method: "POST",   path: "/admin/pool/schedule-publish", handler: handlePostSchedulePublish },
  { method: "GET",    path: "/admin/pool/schedule-commands", handler: handleGetScheduleCommands },
  { method: "GET",    path: "/admin/pool/schedule-commands/:id", handler: handleGetScheduleCommandById },
  { method: "GET",    path: "/admin/pool/schedule-commands/:id/jobs", handler: handleGetScheduleCommandJobs },
  { method: "POST",   path: "/admin/pool/schedule-commands/:id/cancel", handler: handlePostScheduleCommandCancel },
  { method: "POST",   path: "/admin/pool/schedule-commands/:id/pause", handler: handlePostScheduleCommandPause },
  { method: "POST",   path: "/admin/pool/schedule-commands/:id/resume", handler: handlePostScheduleCommandResume },
  { method: "POST",   path: "/admin/pool/schedule-runner/run-due", handler: handlePostScheduleRunnerRunDue },
  { method: "GET",    path: "/admin/pool/schedule-runner/status", handler: handleGetScheduleRunnerStatus },
  { method: "POST",   path: "/admin/pool/schedule-runner/run-live-one", handler: handlePostScheduleRunnerRunLiveOne },
  { method: "GET",    path: "/admin/pool/category-preferences", handler: handleGetPoolCategoryPreferences },
  { method: "PUT",    path: "/admin/pool/category-preferences", handler: handlePutPoolCategoryPreferences },
  { method: "POST", path: "/admin/dispatch-runs/create",       handler: handlePostDispatchRunCreate       },
  { method: "POST", path: "/admin/dispatch-jobs/cleanup-stale", handler: handlePostDispatchJobsCleanupStale },
  { method: "POST", path: "/admin/dispatch-jobs/claim-next", handler: handlePostDispatchJobClaimNext },
  { method: "POST", path: "/admin/dispatch-jobs/report",    handler: handlePostDispatchJobReport },
  { method: "GET",  path: "/admin/dispatch-runs/status",  handler: handleGetDispatchRunStatus },
  { method: "GET",  path: "/admin/dispatch-runs/active",  handler: handleGetDispatchActiveRuns },
  { method: "GET",  path: "/admin/ebay/connect-url",       handler: handleGetEbayConnectUrl     },
  { method: "POST", path: "/admin/ebay/auth-url", handler: handlePostEbayAuthUrl       },
  { method: "POST", path: "/admin/ebay/connect", handler: handlePostEbayConnect       },
  { method: "GET",  path: "/admin/ebay/callback",            handler: handleGetEbayCallback       },
  { method: "GET",  path: "/admin/ebay/account-status",      handler: handleGetEbayAccountStatus  },
  { method: "GET",  path: "/admin/ebay/accounts",            handler: handleGetEbayAccounts       },
  { method: "POST", path: "/admin/ebay/oauth/reconnect",     handler: handlePostEbayOAuthReconnect },
  { method: "POST", path: "/admin/ebay/refresh",             handler: handlePostEbayRefresh       },
  { method: "POST", path: "/admin/ebay/disconnect",          handler: handlePostEbayDisconnect  },
  { method: "POST", path: "/admin/monitor/update-price",      handler: handlePostMonitorUpdatePrice },
  { method: "POST", path: "/admin/monitor/update-stock",      handler: handlePostMonitorUpdateStock },
  { method: "POST", path: "/admin/monitor/update-source-url", handler: handlePostMonitorUpdateSourceUrl },
  { method: "POST", path: "/admin/monitor/blind",             handler: handlePostMonitorBlind       },
  { method: "POST", path: "/admin/listings/import-match",     handler: handlePostListingsImportMatch },
  { method: "POST", path: "/admin/listings/stock-guard",        handler: handlePostListingsStockGuard },
  { method: "POST", path: "/admin/listings/remove-from-list",   handler: handlePostListingsRemoveFromList },
  { method: "POST", path: "/admin/listings/restore-to-list",    handler: handlePostListingsRestoreToList },
  { method: "GET",  path: "/admin/listings/recommended-price",  handler: handleGetListingsRecommendedPrice },
  { method: "POST", path: "/admin/listings/update-ebay-price",  handler: handlePostListingsUpdateEbayPrice },
  { method: "POST", path: "/admin/listings/update-source-asin", handler: handlePostListingsUpdateSourceAsin },
  { method: "POST", path: "/admin/listings/source-status",      handler: handlePostListingsSourceStatus },
  { method: "POST", path: "/admin/listings/end",                  handler: handlePostListingsEnd },
  { method: "POST", path: "/admin/listings/sync-listings",        handler: handlePostListingsSyncListings },
  { method: "POST", path: "/admin/store-sync/queue-tick",         handler: handlePostStoreSyncQueueTick },
  { method: "POST", path: "/admin/listings/sync-30d-clicks",      handler: handlePostListingsSync30dClicks },
  { method: "POST", path: "/admin/listings/sync-metrics",         handler: handlePostListingsSyncMetrics },
  { method: "GET",  path: "/admin/listings/store-debug",          handler: handleGetListingsStoreDebug },
  { method: "GET",  path: "/admin/monitor/listings",      handler: handleGetMonitorListings },
  { method: "POST", path: "/admin/asins/import",           handler: handlePostAsinImport    },
  { method: "POST", path: "/admin/extension-capture-jobs", handler: handlePostExtensionCaptureJobs },
  { method: "POST", path: "/admin/extension-capture-jobs/claim-next", handler: handlePostExtensionCaptureClaimNext },
  { method: "GET",  path: "/admin/extension-capture-jobs/active", handler: handleGetActiveExtensionCaptureJobs },
  { method: "GET",  path: "/admin/extension-capture-jobs/:commandId", handler: handleGetExtensionCaptureJob },
  { method: "POST", path: "/admin/extension-capture-jobs/:commandId/cancel", handler: handlePostExtensionCaptureJobCancel },
  { method: "POST", path: "/admin/extension-capture-jobs/:commandId/items/:itemId/start-capture", handler: handlePostExtensionCaptureItemStart },
  { method: "POST", path: "/admin/extension-capture-jobs/:commandId/items/:itemId/capture", handler: handlePostExtensionCaptureItemSubmit },
  { method: "POST", path: "/admin/extension-capture-jobs/:commandId/items/:itemId/fail", handler: handlePostExtensionCaptureItemFail },
  { method: "POST", path: "/admin/extension-capture-jobs/:commandId/items/:itemId/promotion/retry", handler: handlePostExtensionCaptureItemPromotionRetry },
  { method: "POST", path: "/admin/product/extract",        handler: handlePostProductExtract },
  { method: "POST", path: "/admin/ai-listing/generate",    handler: handlePostAiListingGenerate },
  { method: "POST", path: "/admin/listing/run",            handler: handlePostListingRun    },
  { method: "POST", path: "/admin/dispatch",               handler: handlePostDispatch      },
  { method: "POST", path: "/admin/publish/run",            handler: handlePostPublishRun    },
  { method: "GET",  path: "/admin/settings",               handler: handleGetSettings      },
  { method: "POST", path: "/admin/settings/address",       handler: handlePostSettingsAddress },
  { method: "GET",  path: "/admin/settings/policies",      handler: handleGetSettingsPolicies },
  { method: "POST", path: "/admin/settings/policies",      handler: handlePostSettingsPolicies },
  { method: "POST", path: "/admin/settings/markup",        handler: handlePostSettingsMarkup },
  { method: "POST", path: "/admin/settings/pricing",       handler: handlePostSettingsPricing },
  { method: "POST", path: "/admin/settings/warehouse-banner", handler: handlePostSettingsWarehouseBanner },
] as const
