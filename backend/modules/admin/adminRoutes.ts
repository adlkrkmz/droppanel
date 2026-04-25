import {
  getDashboardSummary, getAdminQueueSummary, getRecentListingHistory,
  getAdminStores, getRuntimeStatus, getPoolRows, dispatchSelectedPool,
} from "./adminService"
import { runDispatch }             from "../dispatch/dispatchService"
import { importAsins }             from "../asinImport/asinImportService"
import { getMonitorListings }      from "../monitor/monitorService"
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
  buildAuthUrl, handleCallback, getAccountStatus,
  refreshAccessToken, getAllAccounts, getValidAccessToken,
  findNextAutoStoreCode,
}                                    from "../ebayOAuth/ebayOAuthService"
import type {
  EbayAccountStatus, EbayCallbackResult, EbayConnectUrlResponse,
}                                    from "../ebayOAuth/ebayOAuthTypes"
import type { MonitorListingsResult } from "../monitor/monitorTypes"
import { runTimedPublishForStore } from "../publishQueue/publishQueueService"
import type { AsinImportRequest, AsinImportResponse } from "../asinImport/asinImportTypes"
import type {
  AdminDispatchRequest, AdminDispatchResponse, AdminErrorBody,
  AdminListingRunRequest, AdminListingRunResponse,
  AdminPoolDispatchRequest, AdminPoolDispatchResponse, AdminPoolResult,
  AdminPoolDeleteRequest, AdminPoolDeleteResponse,
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
} from "../settings/settingsService"
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
    const { stage, status, storeCode, limit, asin } = req.query
    return {
      status: 200,
      body: await getPoolRows(getWorkspaceId(), {
        stage: stage || null,
        status: status || null,
        storeCode: storeCode || null,
        asin: asin || null,
        limit: limit ? parseInt(limit, 10) : undefined,
      }),
    }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handlePostPoolDispatch(req: AdminRequest): Promise<AdminResponse<AdminPoolDispatchResponse>> {
  try {
    const body = req.body as Partial<AdminPoolDispatchRequest>
    if (!body.storeCode) return bad("storeCode is required")
    if (!body.poolIds || body.poolIds.length === 0) return bad("poolIds must be non-empty")
    return { status: 200, body: await dispatchSelectedPool(getWorkspaceId(), body.poolIds, body.storeCode) }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
}

export async function handleDeletePoolItems(req: AdminRequest): Promise<AdminResponse<AdminPoolDeleteResponse>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = req.body as Partial<AdminPoolDeleteRequest>

    const poolIdsRaw = body.poolIds
    if (!poolIdsRaw || !Array.isArray(poolIdsRaw) || poolIdsRaw.length === 0) return bad("poolIds must be a non-empty array")

    const poolIds = poolIdsRaw.map(id => Number(id)).filter(id => Number.isInteger(id) && id >= 1)
    if (poolIds.length === 0) return bad("poolIds must be a non-empty array of integers")

    const result = await query(
      `DELETE FROM asin_pool
       WHERE workspace_id = $2
         AND id = ANY($1::int[])`,
      [poolIds, workspaceId]
    )

    return { status: 200, body: { deleted: result.rowCount ?? 0 } }
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
  try {
    const input = req.body as Partial<ProductExtractorRequest>
    if (!input.asin) return bad("asin is required")
    const workspaceId = getWorkspaceId()
    const source = (input.source as string | undefined) || "amazon"
    const external_id = (input.external_id as string | null | undefined) ?? null
    const result = await extractAndSaveProduct(workspaceId, { ...input, source, external_id } as ProductExtractorRequest)
    return { status: 200, body: result }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
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
      ? body.poolIds as number[]
      : undefined

    let dispatchResult: { selectedCount: number; skippedCount: number; assignedPoolIds: number[]; assignedAsins: string[] } | null = null
    let targetPoolIds: number[] | undefined

    if (directPoolIds) {
      targetPoolIds = directPoolIds
      console.log(`[ListingRun] Direct poolIds mode: ${targetPoolIds.length} item(s)`)
    } else {
      dispatchResult = await runDispatch({
        workspaceId,
        storeCode:     body.storeCode,
        count:         body.count,
        selectionMode: body.selectionMode ?? "random",
        delaySeconds,
      })
      targetPoolIds = dispatchResult.assignedPoolIds
      console.log(`[ListingRun] Dispatch: selected=${dispatchResult.selectedCount} skipped=${dispatchResult.skippedCount}`)
    }

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
  try {
    const body = req.body as Partial<AdminPublishRequest>
    if (!body.storeCode) return bad("storeCode is required")
    const targetPoolIds = Array.isArray(body.poolIds) && body.poolIds.length > 0
      ? body.poolIds as number[]
      : undefined
    return {
      status: 200,
      body: await runTimedPublishForStore({
        workspaceId:    getWorkspaceId(),
        storeCode:      body.storeCode,
        delaySeconds:   body.delaySeconds   ?? 5,
        limit:          targetPoolIds ? targetPoolIds.length * 3 : (body.limit ?? 10),
        dryRun:         body.dryRun         ?? true,
        quantity:       body.quantity        ?? 1,
        simulationMode: body.simulationMode ?? true,
        ebayOauthToken: process.env.EBAY_OAUTH_TOKEN ?? "SIM_TOKEN",
        ebaySandbox:    (process.env.EBAY_SANDBOX ?? "true") !== "false",
        targetPoolIds,
      }) as AdminPublishResponse,
    }
  } catch (e) { console.error("[ADMIN]", e); return err(e instanceof Error ? e.message : String(e)) }
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
    }>

    if (!body.storeCode) return bad("storeCode is required")
    if (!Array.isArray(body.poolIds) || body.poolIds.length === 0) return bad("poolIds must be non-empty array")

    const poolIds = body.poolIds
      .map(id => Number(id))
      .filter(id => Number.isInteger(id) && id >= 1)

    if (poolIds.length === 0) return bad("poolIds must be non-empty integers")

    const quantity = body.quantity ?? 1
    if (!Number.isInteger(quantity) || quantity < 1) return bad("quantity must be an integer >= 1")

    const delaySeconds = body.delaySeconds ?? 0
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0) return bad("delaySeconds must be an integer >= 0")

    const run = await createRunWithJobs(
      getWorkspaceId(),
      String(body.storeCode).trim(),
      poolIds,
      quantity,
      delaySeconds
    )

    return { status: 200, body: run }
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
    const result = await getMonitorListings(workspaceId, storeCode, offset, limit)
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

export async function handlePostEbayRefresh(req: AdminRequest): Promise<AdminResponse<{ accessToken: string; expiresAt: string }>> {
  try {
    const workspaceId = getWorkspaceId()
    const body        = req.body as { storeCode?: string }
    const storeCode   = body.storeCode ?? "S1"
    const simulation  = (process.env.EBAY_SIMULATION ?? "true") !== "false"
    const result      = await refreshAccessToken(workspaceId, storeCode, simulation)
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
  { method: "DELETE", path: "/admin/pool",                handler: handleDeletePoolItems  },
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
  { method: "POST", path: "/admin/ebay/refresh",             handler: handlePostEbayRefresh       },
  { method: "POST", path: "/admin/ebay/disconnect",          handler: handlePostEbayDisconnect  },
  { method: "POST", path: "/admin/monitor/update-price",      handler: handlePostMonitorUpdatePrice },
  { method: "POST", path: "/admin/monitor/update-stock",      handler: handlePostMonitorUpdateStock },
  { method: "POST", path: "/admin/monitor/update-source-url", handler: handlePostMonitorUpdateSourceUrl },
  { method: "POST", path: "/admin/monitor/blind",             handler: handlePostMonitorBlind       },
  { method: "GET",  path: "/admin/monitor/listings",      handler: handleGetMonitorListings },
  { method: "POST", path: "/admin/asins/import",           handler: handlePostAsinImport    },
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
] as const

