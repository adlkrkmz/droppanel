import { query } from "../../db/client"
import { addNotification } from "../notifications/notificationService"
import {
  newApproveZeroJobId,
  startApproveZeroBackgroundJob,
  type ApproveZeroJobItem,
} from "./stockAlertsApproveZeroWorker"
import { normReviewItemId } from "./stockAlertsId"
import {
  cleanupResolvedPriceIncreaseAlerts,
  cleanupZeroQtyPendingStockAlerts,
} from "../stockGuard/stockGuardCleanupService"
import { reconcileVerificationWaitingReviews } from "./stockAlertReviewLifecycle"
import { STOCK_GUARD_SCAN_ELIGIBLE_QTY } from "../stockGuard/stockGuardScanEligibility"
import { getStoreByCode, upsertPendingReviewItem } from "./stockAlertsRepository"
import {
  buildAdminListStatusClause,
  STOCK_ALERTS_VISIBLE_SQL,
} from "./stockAlertListQuery"
import type { ReviewUpsertInput } from "./stockAlertsRepository"
import type {
  StockAlertRow,
  StockAlertsApproveZeroResponse,
  StockAlertsIgnoreResponse,
  StockAlertsListResponse,
  StockReviewStatus,
} from "./stockAlertsTypes"
import { StockAlertsHttpError } from "./stockAlertsTypes"
import { calculateRecommendedEbayPrice } from "../pricing/pricingCalculatorService"
import { loadPromotionPricingContext } from "../pricing/promotionPricingContext"

export async function createReviewFromCurrentSourceStatus(
  workspaceId: string,
  storeCode:   string
): Promise<{ ok: true; created: number; updated: number; pending: number }> {
  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error("Active store not found")

  const rows = await query<{
    id: number
    internal_sku: string
    ebay_item_id: string | null
    ebay_title: string | null
    image_url: string | null
    ebay_quantity: number | null
    ebay_price: string | null
    asin: string | null
    source_status: string | null
    source_status_reason: string | null
    source_price: string | null
  }>(
    `SELECT scs.id,
            scs.internal_sku,
            scs.ebay_item_id,
            scs.ebay_title,
            scs.image_url,
            scs.ebay_quantity,
            scs.ebay_price::text AS ebay_price,
            ar.asin,
            scs.source_status,
            scs.source_status_reason,
            scs.source_price::text AS source_price
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1
       AND scs.store_id = $2
       AND scs.panel_hidden_at IS NULL
       AND scs.current_status = 'live'
       AND COALESCE(scs.stock_guard_enabled, true) = true
       AND ar.asin IS NOT NULL
       AND ${STOCK_GUARD_SCAN_ELIGIBLE_QTY}
       AND scs.source_status IN ('NO_PRICE','UNAVAILABLE','REMOVED')`,
    [workspaceId, store.id]
  )

  let created = 0
  let updated = 0
  for (const r of rows.rows) {
    const action = await upsertPendingReviewItem({
      workspaceId,
      storeId: store.id,
      catalogStateId: r.id,
      ebayItemId: r.ebay_item_id?.trim() || null,
      internalSku: r.internal_sku?.trim() || null,
      asin: r.asin!.trim(),
      ebayTitle: r.ebay_title?.trim() || null,
      imageUrl: r.image_url?.trim() || null,
      ebayQuantity: r.ebay_quantity ?? null,
      ebayPrice: r.ebay_price != null && r.ebay_price.trim() !== "" ? parseFloat(r.ebay_price) : null,
      sourceStatus: String(r.source_status),
      sourceStatusReason: r.source_status_reason?.trim() || null,
      sourcePrice: r.source_price != null && r.source_price.trim() !== "" ? parseFloat(r.source_price) : null,
    })
    if (!action) continue
    if (action === "created") created++
    else updated++
  }

  const pending = created + updated
  if (pending > 0) {
    const title = `${pending} products need stock review`
    const message =
      `Store: ${store.name?.trim() || storeCode}\n` +
      `Open: /listings/stock-alerts?storeCode=${storeCode}&status=pending`
    void addNotification(workspaceId, "warning", title, message)
  }

  return { ok: true, created, updated, pending }
}

export async function listStockAlerts(input: {
  workspaceId: string
  storeCode:   string
  status:      StockReviewStatus
  risk?:       string
  search?:     string
  offset:      number
  limit:       number
}): Promise<StockAlertsListResponse> {
  const store = await getStoreByCode(input.workspaceId, input.storeCode)
  if (!store) throw new Error("Active store not found")

  await cleanupZeroQtyPendingStockAlerts(input.workspaceId)
  await cleanupResolvedPriceIncreaseAlerts(input.workspaceId)
  await reconcileVerificationWaitingReviews(input.workspaceId).catch(e =>
    console.warn("[stock-alerts] verification review reconcile skipped:", e instanceof Error ? e.message : e)
  )

  const safeLimit = Math.max(1, Math.min(200, input.limit))
  const safeOffset = Math.max(0, input.offset)
  const statusClause = buildAdminListStatusClause(input.status)

  const params: unknown[] = [input.workspaceId, store.id]
  let nextIdx = 3
  let whereSql = statusClause
  if (input.status !== "pending") {
    params.push(input.status)
    nextIdx = 4
  }

  const risk = input.risk?.trim().toUpperCase()
  if (risk && ["NO_PRICE", "UNAVAILABLE", "REMOVED", "PRICE_INCREASE"].includes(risk)) {
    whereSql += ` AND sri.source_status = $${nextIdx}`
    params.push(risk)
    nextIdx++
  }

  const search = input.search?.trim()
  if (search) {
    whereSql += ` AND (
          sri.asin ILIKE $${nextIdx}
          OR COALESCE(sri.ebay_title,'') ILIKE $${nextIdx}
          OR COALESCE(sri.ebay_item_id,'') ILIKE $${nextIdx}
        )`
    params.push(`%${search}%`)
    nextIdx++
  }

  const stats = await query<{ total: string }>(
    `SELECT COUNT(*)::text AS total
     FROM stock_review_items sri
     WHERE sri.workspace_id = $1::uuid
       AND sri.store_id = $2::bigint
       ${whereSql}`,
    params
  )
  const total = parseInt(stats.rows[0]?.total ?? "0", 10) || 0

  const listParams = [...params, safeLimit, safeOffset]
  const list = await query<{
    id: number
    store_id: number
    catalog_state_id: number
    asin: string
    ebay_item_id: string | null
    internal_sku: string | null
    ebay_title: string | null
    image_url: string | null
    ebay_quantity: number | null
    ebay_price: string | null
    source_status: string
    source_status_reason: string | null
    verification_source: string | null
    source_price: string | null
    old_source_price: string | null
    new_source_price: string | null
    price_change_percent: string | null
    detected_at: string
    checked_at: string | null
    review_status: string
    actioned_at: string | null
    action_error: string | null
    processing_started_at: string | null
  }>(
    `SELECT
       sri.id,
       sri.store_id,
       sri.catalog_state_id,
       sri.asin,
       sri.ebay_item_id,
       sri.internal_sku,
       sri.ebay_title,
       sri.image_url,
       sri.ebay_quantity,
       sri.ebay_price::text AS ebay_price,
       sri.source_status,
       sri.source_status_reason,
       COALESCE(
         NULLIF(BTRIM(sri.verification_source), ''),
         (
           SELECT NULLIF(BTRIM(e.after_data->>'source'), '')
           FROM workspace_activity_events e
           WHERE e.workspace_id = sri.workspace_id
             AND e.catalog_state_id = sri.catalog_state_id
             AND e.event_type IN ('PRICE_PROTECTION_APPLIED', 'ACTION_FAILED', 'STOCK_ZEROED', 'STOCK_ZERO_FAILED')
           ORDER BY e.created_at DESC, e.id DESC
           LIMIT 1
         ),
         (
           SELECT CASE UPPER(BTRIM(t.claimed_by_source))
             WHEN 'DESKTOP_AGENT' THEN 'DESKTOP_AGENT'
             WHEN 'SERVER_BROWSER_AUTH' THEN 'SERVER_BROWSER_AUTH'
             WHEN 'SERVER_BROWSER_PUBLIC' THEN 'SERVER_BROWSER_PUBLIC'
             WHEN 'SERVER' THEN 'SERVER_BROWSER'
             ELSE NULL
           END
           FROM amazon_price_verification_tasks t
           WHERE t.workspace_id = sri.workspace_id
             AND t.catalog_state_id = sri.catalog_state_id
             AND t.status = 'COMPLETED'
           ORDER BY t.completed_at DESC NULLS LAST, t.id DESC
           LIMIT 1
         )
       ) AS verification_source,
       sri.source_price::text AS source_price,
       sri.old_source_price::text AS old_source_price,
       sri.new_source_price::text AS new_source_price,
       sri.price_change_percent::text AS price_change_percent,
       sri.detected_at::text AS detected_at,
       COALESCE(sri.checked_at, scs.source_checked_at)::text AS checked_at,
       sri.review_status,
       sri.actioned_at::text AS actioned_at,
       sri.action_error,
       sri.processing_started_at::text AS processing_started_at
     FROM stock_review_items sri
     LEFT JOIN store_catalog_state scs
       ON scs.id = sri.catalog_state_id
      AND scs.workspace_id = sri.workspace_id
      AND scs.store_id = sri.store_id
     WHERE sri.workspace_id = $1::uuid
       AND sri.store_id = $2::bigint
       ${whereSql}
     ORDER BY sri.detected_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    listParams
  )

  const rows: StockAlertRow[] = list.rows.map(r => ({
    id: r.id,
    storeId: r.store_id,
    catalogStateId: r.catalog_state_id,
    asin: r.asin,
    ebayItemId: r.ebay_item_id?.trim() || null,
    internalSku: r.internal_sku?.trim() || null,
    ebayTitle: r.ebay_title?.trim() || null,
    imageUrl: r.image_url?.trim() || null,
    ebayQuantity: r.ebay_quantity ?? null,
    ebayPrice: r.ebay_price != null && r.ebay_price.trim() !== "" ? parseFloat(r.ebay_price) : null,
    sourceStatus: r.source_status,
    sourceStatusReason: r.source_status_reason?.trim() || null,
    verificationSource: r.verification_source?.trim() || null,
    sourcePrice: r.source_price != null && r.source_price.trim() !== "" ? parseFloat(r.source_price) : null,
    oldSourcePrice:
      r.old_source_price != null && r.old_source_price.trim() !== ""
        ? parseFloat(r.old_source_price)
        : null,
    newSourcePrice:
      r.new_source_price != null && r.new_source_price.trim() !== ""
        ? parseFloat(r.new_source_price)
        : null,
    priceChangePercent:
      r.price_change_percent != null && r.price_change_percent.trim() !== ""
        ? parseFloat(r.price_change_percent)
        : null,
    detectedAt: r.detected_at,
    checkedAt: r.checked_at,
    reviewStatus: r.review_status as StockReviewStatus,
    actionedAt: r.actioned_at,
    actionError: r.action_error?.trim() || null,
    processingStartedAt: r.processing_started_at,
  }))

  for (const row of rows) {
    const isPrice =
      row.sourceStatus === "PRICE_INCREASE" ||
      row.oldSourcePrice != null ||
      row.newSourcePrice != null
    if (!isPrice) continue
    const amazon =
      row.newSourcePrice != null && Number.isFinite(row.newSourcePrice) && row.newSourcePrice > 0
        ? row.newSourcePrice
        : row.sourcePrice
    if (amazon == null || !Number.isFinite(amazon) || amazon <= 0) continue
    try {
      const promotion = await loadPromotionPricingContext({
        workspaceId: input.workspaceId,
        storeId: store.id,
        catalogStateId: row.catalogStateId,
      })
      const calc = await calculateRecommendedEbayPrice({
        workspaceId: input.workspaceId,
        storeId: store.id,
        amazonPrice: amazon,
        promotion,
      })
      if (calc.recommendedEbayPrice > 0) {
        row.storeMarkupPercent = calc.storeMarkupPercent
        row.recommendedEbayPrice = calc.recommendedEbayPrice
      }
    } catch {
      /* pricing unavailable — modal can still load recommended */
    }
  }

  const summaryRes = await query<{
    pending: string
    processing: string
    noprice: string
    unavailable: string
    removed: string
    priceincrease: string
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE sri.review_status = 'pending' AND ${STOCK_GUARD_SCAN_ELIGIBLE_QTY})::text AS pending,
       COUNT(*) FILTER (WHERE sri.review_status = 'processing')::text AS processing,
       COUNT(*) FILTER (WHERE sri.review_status = 'pending' AND ${STOCK_GUARD_SCAN_ELIGIBLE_QTY} AND sri.source_status = 'NO_PRICE')::text AS noprice,
       COUNT(*) FILTER (WHERE sri.review_status = 'pending' AND ${STOCK_GUARD_SCAN_ELIGIBLE_QTY} AND sri.source_status = 'UNAVAILABLE')::text AS unavailable,
       COUNT(*) FILTER (WHERE sri.review_status = 'pending' AND ${STOCK_GUARD_SCAN_ELIGIBLE_QTY} AND sri.source_status = 'REMOVED')::text AS removed,
       COUNT(*) FILTER (WHERE sri.review_status = 'pending' AND ${STOCK_GUARD_SCAN_ELIGIBLE_QTY} AND sri.source_status = 'PRICE_INCREASE')::text AS priceincrease
     FROM stock_review_items sri
     INNER JOIN store_catalog_state scs
       ON scs.id = sri.catalog_state_id
      AND scs.workspace_id = sri.workspace_id
      AND scs.store_id = sri.store_id
     WHERE sri.workspace_id = $1::uuid
       AND sri.store_id = $2::bigint
       AND ${STOCK_ALERTS_VISIBLE_SQL}`,
    [input.workspaceId, store.id]
  )
  const s = summaryRes.rows[0]

  return {
    ok: true,
    rows,
    total,
    summary: {
      pending: parseInt(s?.pending ?? "0", 10) || 0,
      processing: parseInt(s?.processing ?? "0", 10) || 0,
      noPrice: parseInt(s?.noprice ?? "0", 10) || 0,
      unavailable: parseInt(s?.unavailable ?? "0", 10) || 0,
      removed: parseInt(s?.removed ?? "0", 10) || 0,
      priceIncrease: parseInt(s?.priceincrease ?? "0", 10) || 0,
    },
  }
}

export async function ignoreStockAlerts(
  workspaceId: string,
  storeCode:   string,
  ids:         number[]
): Promise<StockAlertsIgnoreResponse> {
  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error("Active store not found")
  if (ids.length === 0) return { ok: true, ignored: 0 }

  const res = await query(
    `UPDATE stock_review_items
     SET review_status = 'ignored',
         ignored_at = NOW(),
         updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND store_id = $2::bigint
       AND review_status = 'pending'
       AND id = ANY($3::bigint[])`,
    [workspaceId, store.id, ids]
  )
  return { ok: true, ignored: res.rowCount ?? 0 }
}

export async function approveZeroStockAlerts(
  workspaceId: string,
  storeCode:   string,
  ids:         number[]
): Promise<StockAlertsApproveZeroResponse> {
  const simulationMode = (process.env.EBAY_SIMULATION ?? "true") !== "false"
  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
  const requested = ids.length

  console.log(
    `[StockAlerts][approve-zero] start storeCode=${storeCode} receivedIds=${JSON.stringify(ids)} idsCount=${requested} EBAY_SIMULATION=${simulationMode} EBAY_SANDBOX=${sandbox}`
  )

  if (requested === 0) {
    throw new StockAlertsHttpError(400, "No stock alert items selected")
  }

  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error("Active store not found")

  console.log(
    `[StockAlerts][approve-zero] resolved store_id=${store.id} workspace_id=${workspaceId}`
  )

  const rows = await query<{
    id: number
    catalog_state_id: number
    internal_sku: string | null
    ebay_item_id: string | null
    source_status: string
    source_status_reason: string | null
    catalog_internal_sku: string | null
    catalog_ebay_item_id: string | null
    catalog_ebay_offer_id: string | null
  }>(
    `SELECT
       sri.id,
       sri.catalog_state_id,
       sri.internal_sku,
       sri.ebay_item_id,
       sri.source_status,
       sri.source_status_reason,
       scs.internal_sku AS catalog_internal_sku,
       scs.ebay_item_id AS catalog_ebay_item_id,
       scs.ebay_offer_id AS catalog_ebay_offer_id
     FROM stock_review_items sri
     LEFT JOIN store_catalog_state scs
       ON scs.id = sri.catalog_state_id
      AND scs.workspace_id = sri.workspace_id
      AND scs.store_id = sri.store_id
     WHERE sri.workspace_id = $1::uuid
       AND sri.store_id = $2::bigint
       AND sri.review_status = 'pending'
       AND sri.id = ANY($3::bigint[])`,
    [workspaceId, store.id, ids]
  )

  const found = rows.rows.length
  console.log(`[StockAlerts][approve-zero] found pending items count=${found}`)

  for (const r of rows.rows) {
    const sku = (r.catalog_internal_sku ?? r.internal_sku)?.trim() || ""
    const itemId = (r.catalog_ebay_item_id ?? r.ebay_item_id)?.trim() || ""
    const offerId = r.catalog_ebay_offer_id?.trim() || ""
    console.log(
      `[StockAlerts][approve-zero] item id=${r.id} catalog_state_id=${r.catalog_state_id} ebay_item_id=${itemId || "(none)"} internal_sku=${sku || "(none)"} ebay_offer_id=${offerId || "(none)"}`
    )
  }

  if (found === 0) {
    throw new StockAlertsHttpError(404, "No pending stock alert items found")
  }

  const jobId = newApproveZeroJobId()
  const itemIds = rows.rows.map(r => normReviewItemId(r.id))

  await query(
    `UPDATE stock_review_items
     SET review_status = 'processing',
         processing_started_at = NOW(),
         processing_job_id = $4,
         action_error = NULL,
         updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND store_id = $2::bigint
       AND review_status = 'pending'
       AND id = ANY($3::bigint[])`,
    [workspaceId, store.id, itemIds, jobId]
  )

  const jobItems: ApproveZeroJobItem[] = rows.rows.map(r => ({
    id: normReviewItemId(r.id),
    catalogStateId: Number(r.catalog_state_id),
    internalSku: (r.catalog_internal_sku ?? r.internal_sku)?.trim() || null,
    ebayItemId: (r.catalog_ebay_item_id ?? r.ebay_item_id)?.trim() || null,
    ebayOfferId: r.catalog_ebay_offer_id?.trim() || null,
    sourceStatus: r.source_status,
    sourceStatusReason: r.source_status_reason,
  }))

  startApproveZeroBackgroundJob({
    workspaceId,
    storeId: store.id,
    storeCode,
    storeName: store.name?.trim() || storeCode,
    jobId,
    items: jobItems,
    sandbox,
    simulationMode,
  })

  console.log(
    `[StockAlerts][approve-zero] queued jobId=${jobId} requested=${requested} processing=${found}`
  )

  return {
    ok: true,
    queued: true,
    requested,
    processing: found,
    jobId,
  }
}
