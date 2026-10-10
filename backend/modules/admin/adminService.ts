// ─────────────────────────────────────────────────────────────
// adminService.ts
// ─────────────────────────────────────────────────────────────

import { query }               from "../../db/client"
import { getSchedulerSummary } from "../scheduler/schedulerService"
import { getLoopState }        from "../runtime/runtimeService"
import {
  buildPoolEligibilityWhere,
  splitEligiblePoolItems,
  toPoolIdSet,
  type PoolEligibilitySkipDetail,
} from "../pool/poolEligibilityService"
import type {
  AdminListingHistoryResult,
  AdminListingHistoryRow,
  AdminPoolArchiveItemResult,
  AdminPoolDeleteResponse,
  AdminPoolRestoreItemResult,
  AdminPoolRestoreResponse,
  AdminPoolResult,
  AdminPoolRow,
  AdminPoolDispatchResponse,
  AdminQueueSummary,
  AdminStoreRow,
  AdminStoresResult,
  DashboardSummary,
  PoolView,
} from "./adminTypes"

const POOL_VIEWS = new Set<PoolView>([
  "active", "ready", "processing", "assigned", "failed", "history", "archived", "all",
])

const POOL_NOT_ARCHIVED = `ap.archived_at IS NULL`

const POOL_PUBLISHED_CONDITION = `(
  ap.pipeline_stage = 'listed'
  OR ap.status = 'completed'
  OR ap.listing_status = 'success'
)`

function parsePoolView(raw: string | null | undefined): PoolView | null {
  if (!raw) return null
  const v = raw.trim().toLowerCase() as PoolView
  return POOL_VIEWS.has(v) ? v : null
}

function applyPoolViewFilter(
  view: PoolView,
  conditions: string[]
): void {
  switch (view) {
    case "active":
      conditions.push(POOL_NOT_ARCHIVED)
      conditions.push(`NOT ${POOL_PUBLISHED_CONDITION}`)
      break
    case "ready":
      conditions.push(POOL_NOT_ARCHIVED)
      conditions.push(`NOT ${POOL_PUBLISHED_CONDITION}`)
      conditions.push(`ap.status = 'ready'`)
      break
    case "processing":
      conditions.push(POOL_NOT_ARCHIVED)
      conditions.push(`NOT ${POOL_PUBLISHED_CONDITION}`)
      conditions.push(`(
        ap.status = 'processing'
        OR ap.pipeline_stage IN ('imported', 'validated', 'scraped', 'ai_generated', 'scheduled', 'listing')
      )`)
      break
    case "assigned":
      conditions.push(POOL_NOT_ARCHIVED)
      conditions.push(`NOT ${POOL_PUBLISHED_CONDITION}`)
      conditions.push(`ap.assigned_store_id IS NOT NULL`)
      break
    case "failed":
      conditions.push(POOL_NOT_ARCHIVED)
      conditions.push(`(
        ap.status = 'skipped'
        OR ap.listing_status = 'failed'
        OR ap.scrape_status = 'failed'
        OR ap.ai_status = 'failed'
      )`)
      break
    case "history":
      conditions.push(POOL_NOT_ARCHIVED)
      conditions.push(POOL_PUBLISHED_CONDITION)
      break
    case "archived":
      conditions.push(`ap.archived_at IS NOT NULL`)
      break
    case "all":
      break
  }
}

// ─── DASHBOARD ────────────────────────────────────────────────

export async function getDashboardSummary(
  workspaceId: string
): Promise<DashboardSummary> {
  const result = await query<{
    asin_registry_total: string
    asin_pool_total:     string
    pool_ready:          string
    pool_completed:      string
    stage_validated:     string
    stage_scraped:       string
    stage_ai_generated:  string
    stage_listed:        string
    stores_total:        string
    stores_active:       string
  }>(
    `SELECT
       (SELECT COUNT(*) FROM asin_registry WHERE workspace_id = $1) AS asin_registry_total,
       (SELECT COUNT(*) FROM asin_pool     WHERE workspace_id = $1) AS asin_pool_total,
       COUNT(*) FILTER (WHERE ap.status         = 'ready')         AS pool_ready,
       COUNT(*) FILTER (WHERE ap.status         = 'completed')     AS pool_completed,
       COUNT(*) FILTER (WHERE ap.pipeline_stage = 'validated')     AS stage_validated,
       COUNT(*) FILTER (WHERE ap.pipeline_stage = 'scraped')       AS stage_scraped,
       COUNT(*) FILTER (WHERE ap.pipeline_stage = 'ai_generated')  AS stage_ai_generated,
       COUNT(*) FILTER (WHERE ap.pipeline_stage = 'listed')        AS stage_listed,
       (SELECT COUNT(*) FROM stores WHERE workspace_id = $1)       AS stores_total,
       (SELECT COUNT(*) FROM stores WHERE workspace_id = $1 AND status = 'active') AS stores_active
     FROM asin_pool ap WHERE ap.workspace_id = $1`,
    [workspaceId]
  )
  const row   = result.rows[0]
  const parse = (v: string | undefined): number => parseInt(v ?? "0", 10)
  return {
    asinRegistryTotal: parse(row?.asin_registry_total),
    asinPoolTotal:     parse(row?.asin_pool_total),
    poolReady:         parse(row?.pool_ready),
    poolCompleted:     parse(row?.pool_completed),
    pipelineStages: {
      validated:    parse(row?.stage_validated),
      scraped:      parse(row?.stage_scraped),
      ai_generated: parse(row?.stage_ai_generated),
      listed:       parse(row?.stage_listed),
    },
    storesTotal:  parse(row?.stores_total),
    storesActive: parse(row?.stores_active),
    generatedAt:  new Date().toISOString(),
  }
}

// ─── QUEUE ────────────────────────────────────────────────────

export async function getAdminQueueSummary(
  workspaceId: string
): Promise<AdminQueueSummary> {
  const summary = await getSchedulerSummary(workspaceId)
  return {
    scrapeQueueCount:  summary.counts.scrapeQueueCount,
    aiQueueCount:      summary.counts.aiQueueCount,
    publishQueueCount: summary.counts.publishQueueCount,
    total:             summary.counts.total,
    generatedAt:       new Date().toISOString(),
  }
}

// ─── HISTORY ──────────────────────────────────────────────────

export async function getRecentListingHistory(
  workspaceId: string,
  limit = 50
): Promise<AdminListingHistoryResult> {
  const result = await query<{
    id:           number
    asin:         string
    internal_sku: string | null
    ebay_item_id: string | null
    store_name:   string | null
    status:       string
    listed_at:    string | null
    created_at:   string
  }>(
    `SELECT lh.id, ar.asin, lh.internal_sku, lh.ebay_item_id,
            s.name AS store_name, lh.status,
            lh.listed_at::text, lh.created_at::text
     FROM listing_history lh
     INNER JOIN asin_registry ar ON ar.id = lh.asin_registry_id
     LEFT  JOIN stores s          ON s.id  = lh.store_id
     WHERE lh.workspace_id = $1
     ORDER BY lh.created_at DESC LIMIT $2`,
    [workspaceId, limit]
  )
  const rows: AdminListingHistoryRow[] = result.rows.map(r => ({
    id:          r.id,
    asin:        r.asin,
    internalSku: r.internal_sku,
    ebayItemId:  r.ebay_item_id,
    storeName:   r.store_name,
    status:      r.status,
    listedAt:    r.listed_at,
    createdAt:   r.created_at,
  }))
  return { rows, total: rows.length, generatedAt: new Date().toISOString() }
}

// ─── STORES ───────────────────────────────────────────────────

export async function getAdminStores(
  workspaceId: string
): Promise<AdminStoresResult> {
  const result = await query<{
    id:         number
    name:       string
    store_code: string
    status:     string
    created_at: string
  }>(
    `SELECT s.id, s.name, s.store_code, s.status, s.created_at::text
     FROM stores s
     INNER JOIN ebay_accounts ea       ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id
     WHERE s.workspace_id = $1
       AND s.status = 'active'
     ORDER BY s.created_at ASC`,
    [workspaceId]
  )
  const rows: AdminStoreRow[] = result.rows.map(r => ({
    id: r.id,
    storeId: r.id,
    name: r.name,
    storeCode: r.store_code,
    status: r.status,
    createdAt: r.created_at,
  }))
  return { rows, total: rows.length, generatedAt: new Date().toISOString() }
}

// ─── POOL ─────────────────────────────────────────────────────

export async function getPoolRows(
  workspaceId: string,
  filters: {
    view?:      PoolView | null
    stage?:     string | null
    status?:    string | null
    storeCode?: string | null
    asin?:      string | null
    limit?:     number
  }
): Promise<AdminPoolResult> {
  const { stage, status, storeCode, asin, limit, view: viewParam } = filters

  const conditions: string[] = ["ap.workspace_id = $1"]
  const params: unknown[]    = [workspaceId]
  let   idx = 2

  const hasLegacyStageStatus = !!(stage || status)
  const effectiveView: PoolView =
    viewParam ??
    (hasLegacyStageStatus ? "all" : "active")
  applyPoolViewFilter(effectiveView, conditions)

  if (stage)     { conditions.push(`ap.pipeline_stage = $${idx++}`); params.push(stage)     }
  if (status)    { conditions.push(`ap.status = $${idx++}::pool_status`);         params.push(status)    }
  if (storeCode) { conditions.push(`s.store_code = $${idx++}`);      params.push(storeCode) }
  if (asin)      { conditions.push(`ar.asin = $${idx++}`);           params.push(asin)      }

  const limitClause = limit != null ? `LIMIT $${idx++}` : ''
  if (limit != null) params.push(limit)

  console.log('[getPoolRows] params:', JSON.stringify(params))
  console.log('[getPoolRows] conditions:', conditions)

  const result = await query<{
    pool_id:             number
    asin:                string
    title:               string | null
    brand:               string | null
    amazon_cost:         string | null
    pipeline_stage:      string
    status:              string
    scrape_status:       string
    ai_status:           string
    listing_status:      string
    assigned_store_id:   number | null
    assigned_store_code: string | null
    assigned_store_name: string | null
    created_at:          string
    updated_at:          string
    archived_at:         string | null
    archived_by:         string | null
    archive_reason:      string | null
  }>(
    `SELECT
       ap.id                  AS pool_id,
       ar.asin,
       COALESCE(aic.title, apc.title, ar.title) AS title,
       COALESCE(apc.brand, ar.brand)             AS brand,
       apc.price::text                           AS amazon_cost,
       ap.pipeline_stage,
       ap.status,
       ap.scrape_status,
       ap.ai_status,
       ap.listing_status,
       ap.assigned_store_id,
       s.store_code                              AS assigned_store_code,
       s.name                                    AS assigned_store_name,
       ap.created_at::text,
       ap.updated_at::text,
       ap.archived_at::text,
       ap.archived_by,
       ap.archive_reason
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     LEFT  JOIN stores s
       ON s.id = ap.assigned_store_id
     LEFT  JOIN amazon_product_cache apc
       ON apc.asin_registry_id = ap.asin_registry_id
     LEFT  JOIN ai_listing_cache aic
       ON aic.workspace_id = ap.workspace_id
      AND aic.asin_registry_id = ap.asin_registry_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ap.updated_at DESC
     ${limitClause}`,
    params
  )

  console.log('[getPoolRows] sql params:', params)
  console.log('[getPoolRows] result count:', result.rows.length)

  const rows: AdminPoolRow[] = result.rows.map(r => ({
    poolId:            typeof r.pool_id === "string" ? parseInt(r.pool_id, 10) : r.pool_id,
    asin:              r.asin,
    title:             r.title,
    brand:             r.brand,
    amazonCost:        r.amazon_cost !== null ? parseFloat(r.amazon_cost) : null,
    pipelineStage:     r.pipeline_stage,
    status:            r.status,
    scrapeStatus:      r.scrape_status,
    aiStatus:          r.ai_status,
    listingStatus:     r.listing_status,
    assignedStoreId:   r.assigned_store_id,
    assignedStoreCode: r.assigned_store_code,
    assignedStoreName: r.assigned_store_name,
    createdAt:         r.created_at,
    updatedAt:         r.updated_at,
    archivedAt:        r.archived_at,
    archivedBy:        r.archived_by,
    archiveReason:     r.archive_reason,
  }))

  return {
    rows,
    total: rows.length,
    filters: {
      view:      effectiveView,
      stage:     stage ?? null,
      status:    status ?? null,
      storeCode: storeCode ?? null,
    },
    generatedAt: new Date().toISOString(),
  }
}

export { parsePoolView }

// ─── POOL ARCHIVE (soft delete) ───────────────────────────────

export async function archivePoolItems(
  workspaceId: string,
  poolIds:     number[],
  reason:      string = "manual_archive"
): Promise<AdminPoolDeleteResponse> {
  if (poolIds.length === 0) {
    return { ok: true, archived: 0, failed: 0, deleted: 0, results: [] }
  }

  const existing = await query<{ id: number; archived_at: string | null }>(
    `SELECT id, archived_at::text
     FROM asin_pool
     WHERE workspace_id = $1 AND id = ANY($2::int[])`,
    [workspaceId, poolIds]
  )

  const foundMap = new Map(existing.rows.map(r => [r.id, r.archived_at]))
  const results: AdminPoolArchiveItemResult[] = []
  const toArchive: number[] = []

  for (const poolId of poolIds) {
    if (!foundMap.has(poolId)) {
      results.push({ poolId, ok: false, message: "Not found." })
      continue
    }
    if (foundMap.get(poolId)) {
      results.push({ poolId, ok: true, message: "Already archived." })
      continue
    }
    toArchive.push(poolId)
  }

  if (toArchive.length > 0) {
    await query(
      `UPDATE asin_pool
       SET archived_at    = NOW(),
           archived_by    = 'admin',
           archive_reason = $3,
           updated_at     = NOW()
       WHERE workspace_id = $1
         AND id = ANY($2::int[])
         AND archived_at IS NULL`,
      [workspaceId, toArchive, reason]
    )
    for (const poolId of toArchive) {
      results.push({ poolId, ok: true, message: "Archived." })
    }
  }

  const failed = results.filter(r => !r.ok).length

  return {
    ok:       failed === 0,
    archived: toArchive.length,
    failed,
    deleted:  toArchive.length,
    results,
  }
}

// ─── POOL RESTORE ─────────────────────────────────────────────

export async function restorePoolItems(
  workspaceId: string,
  poolIds:     number[],
  _reason:     string = "manual_restore"
): Promise<AdminPoolRestoreResponse> {
  if (poolIds.length === 0) {
    return { ok: true, restored: 0, failed: 0, results: [] }
  }

  const existing = await query<{ id: number; archived_at: string | null }>(
    `SELECT id, archived_at::text
     FROM asin_pool
     WHERE workspace_id = $1 AND id = ANY($2::int[])`,
    [workspaceId, poolIds]
  )

  const foundMap = new Map(existing.rows.map(r => [r.id, r.archived_at]))
  const results: AdminPoolRestoreItemResult[] = []
  const toRestore: number[] = []

  for (const poolId of poolIds) {
    if (!foundMap.has(poolId)) {
      results.push({ poolId, ok: false, message: "Not found." })
      continue
    }
    if (!foundMap.get(poolId)) {
      results.push({ poolId, ok: true, message: "Already active." })
      continue
    }
    toRestore.push(poolId)
  }

  if (toRestore.length > 0) {
    await query(
      `UPDATE asin_pool
       SET archived_at    = NULL,
           archived_by    = NULL,
           archive_reason = NULL,
           updated_at     = NOW()
       WHERE workspace_id = $1
         AND id = ANY($2::int[])
         AND archived_at IS NOT NULL`,
      [workspaceId, toRestore]
    )
    for (const poolId of toRestore) {
      results.push({ poolId, ok: true, message: "Restored." })
    }
  }

  const failed = results.filter(r => !r.ok).length

  return {
    ok:       failed === 0,
    restored: toRestore.length,
    failed,
    results,
  }
}

// ─── POOL DISPATCH SELECTED ───────────────────────────────────

export async function resolvePoolIdsFromAsins(
  workspaceId: string,
  asins:       string[]
): Promise<{ poolIds: number[]; skipDetails: PoolEligibilitySkipDetail[] }> {
  const normalized = [...new Set(
    asins.map(a => a.trim().toUpperCase()).filter(a => a.length > 0)
  )]
  const skipDetails: PoolEligibilitySkipDetail[] = []
  const poolIds: number[] = []

  if (normalized.length === 0) {
    return { poolIds, skipDetails }
  }

  const result = await query<{ pool_id: number; asin: string }>(
    `SELECT ap.id AS pool_id, ar.asin
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     WHERE ap.workspace_id = $1
       AND ar.asin = ANY($2::text[])`,
    [workspaceId, normalized]
  )

  const asinToPoolId = new Map(
    result.rows.map(r => [
      r.asin.toUpperCase(),
      typeof r.pool_id === "string" ? parseInt(r.pool_id, 10) : r.pool_id,
    ])
  )

  for (const asin of normalized) {
    const poolId = asinToPoolId.get(asin)
    if (!poolId) {
      skipDetails.push({ poolId: 0, asin, reason: "POOL_ITEM_NOT_FOUND" })
    } else {
      poolIds.push(poolId)
    }
  }

  return { poolIds, skipDetails }
}

export async function dispatchSelectedPool(
  workspaceId: string,
  poolIds:     number[],
  storeCode:   string,
  asinSkips:   PoolEligibilitySkipDetail[] = [],
  storeId?:    number | null
): Promise<AdminPoolDispatchResponse> {
  if (poolIds.length === 0) {
    return { selectedCount: 0, skippedCount: 0, assignedPoolIds: [], skipDetails: [] }
  }

  let store: { id: number; name: string } | undefined
  if (storeId != null && Number.isInteger(storeId) && storeId > 0) {
    const byId = await query<{ id: number; name: string }>(
      `SELECT id, name FROM stores
       WHERE workspace_id = $1 AND id = $2 AND status = 'active'
       LIMIT 1`,
      [workspaceId, storeId]
    )
    store = byId.rows[0]
  } else {
    const byCode = await query<{ id: number; name: string }>(
      `SELECT id, name FROM stores
       WHERE workspace_id = $1 AND store_code = $2 AND status = 'active'
       ORDER BY id ASC`,
      [workspaceId, storeCode]
    )
    if (byCode.rows.length > 1) {
      throw new Error("Ambiguous storeCode; use storeId")
    }
    store = byCode.rows[0]
  }
  if (!store) throw new Error("Active store not found")

  const { eligibleIds: publishEligible, skipDetails } = await splitEligiblePoolItems(workspaceId, poolIds)
  const rowMap = publishEligible.length > 0
    ? await import("../pool/poolEligibilityService").then(m => m.loadPoolItemsByIds(workspaceId, publishEligible))
    : new Map()

  const eligibilityWhere = buildPoolEligibilityWhere("ap")
  const dispatchResult = await query<{ id: number }>(
    `SELECT ap.id FROM asin_pool ap
     WHERE ap.workspace_id = $1
       AND ap.id = ANY($2::int[])
       AND ${eligibilityWhere}
       AND ap.status IN ('ready', 'skipped')
       AND ap.pipeline_stage IN ('validated', 'scraped', 'ai_generated')`,
    [workspaceId, publishEligible]
  )
  const dispatchEligibleSet = toPoolIdSet(dispatchResult.rows.map(r => r.id))

  const assignedPoolIds: number[] = []
  const allSkipDetails: PoolEligibilitySkipDetail[] = [...asinSkips, ...skipDetails]

  for (const poolId of publishEligible) {
    if (dispatchEligibleSet.has(poolId)) {
      assignedPoolIds.push(poolId)
    } else {
      const row = rowMap.get(poolId)
      const detail = row
        ? `stage=${row.pipelineStage} status=${row.status} listing=${row.listingStatus}`
        : null
      console.log(
        `[dispatchSelectedPool] skip poolId=${poolId} asin=${row?.asin ?? "?"} reason=POOL_ITEM_NOT_ELIGIBLE ${detail ?? ""}`
      )
      allSkipDetails.push({
        poolId,
        asin:   row?.asin ?? null,
        reason: "POOL_ITEM_NOT_ELIGIBLE",
        detail,
      })
    }
  }

  const skippedCount = poolIds.length - assignedPoolIds.length

  console.log(
    `[dispatchSelectedPool] requested=${poolIds.length} assigned=${assignedPoolIds.length} skipped=${skippedCount}`
  )
  if (allSkipDetails.length > 0) {
    console.log(`[dispatchSelectedPool] skipDetails:`, JSON.stringify(allSkipDetails))
  }

  const poolSkipPayload = allSkipDetails.length > 0
    ? { poolSkipped: allSkipDetails.length, poolSkipDetails: allSkipDetails }
    : {}

  if (assignedPoolIds.length === 0) {
    return {
      selectedCount: 0,
      skippedCount,
      assignedPoolIds: [],
      skipDetails:     allSkipDetails.length > 0 ? allSkipDetails : undefined,
      ...poolSkipPayload,
    }
  }

  await query(
    `UPDATE asin_pool
     SET assigned_store_id = $1,
         status            = 'ready',
         listing_status    = 'pending',
         updated_at        = NOW()
     WHERE id = ANY($2::int[])`,
    [store.id, assignedPoolIds]
  )

  return {
    selectedCount:   assignedPoolIds.length,
    skippedCount,
    assignedPoolIds,
    skipDetails:     allSkipDetails.length > 0 ? allSkipDetails : undefined,
    ...poolSkipPayload,
  }
}

// ─── RUNTIME ──────────────────────────────────────────────────

export function getRuntimeStatus(): {
  loopStatus:  string
  turn:        number
  startedAt:   string | null
  lastTurnAt:  string | null
  recentTurns: number
} {
  const state = getLoopState()
  return {
    loopStatus:  state.status,
    turn:        state.turn,
    startedAt:   state.startedAt,
    lastTurnAt:  state.lastTurnAt,
    recentTurns: state.history.length,
  }
}
