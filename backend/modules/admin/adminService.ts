// ─────────────────────────────────────────────────────────────
// adminService.ts
// ─────────────────────────────────────────────────────────────

import { query }               from "../../db/client"
import { getSchedulerSummary } from "../scheduler/schedulerService"
import { getLoopState }        from "../runtime/runtimeService"
import type {
  AdminListingHistoryResult,
  AdminListingHistoryRow,
  AdminPoolResult,
  AdminPoolRow,
  AdminPoolDispatchResponse,
  AdminQueueSummary,
  AdminStoreRow,
  AdminStoresResult,
  DashboardSummary,
} from "./adminTypes"

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
    `SELECT id, name, store_code, status, created_at::text
     FROM stores WHERE workspace_id = $1 ORDER BY created_at ASC`,
    [workspaceId]
  )
  const rows: AdminStoreRow[] = result.rows.map(r => ({
    id: r.id, name: r.name, storeCode: r.store_code,
    status: r.status, createdAt: r.created_at,
  }))
  return { rows, total: rows.length, generatedAt: new Date().toISOString() }
}

// ─── POOL ─────────────────────────────────────────────────────

export async function getPoolRows(
  workspaceId: string,
  filters: {
    stage?:     string | null
    status?:    string | null
    storeCode?: string | null
    asin?:      string | null
    limit?:     number
  }
): Promise<AdminPoolResult> {
  const { stage, status, storeCode, asin, limit } = filters

  const conditions: string[] = ["ap.workspace_id = $1"]
  const params: unknown[]    = [workspaceId]
  let   idx = 2

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
    updated_at:          string
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
       ap.updated_at::text
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
    updatedAt:         r.updated_at,
  }))

  return {
    rows,
    total: rows.length,
    filters: { stage: stage ?? null, status: status ?? null, storeCode: storeCode ?? null },
    generatedAt: new Date().toISOString(),
  }
}

// ─── POOL DISPATCH SELECTED ───────────────────────────────────

export async function dispatchSelectedPool(
  workspaceId: string,
  poolIds:     number[],
  storeCode:   string
): Promise<AdminPoolDispatchResponse> {
  if (poolIds.length === 0) {
    return { selectedCount: 0, skippedCount: 0, assignedPoolIds: [] }
  }

  // Store bul
  const storeResult = await query<{ id: number }>(
    `SELECT id FROM stores WHERE workspace_id = $1 AND store_code = $2 AND status = 'active' LIMIT 1`,
    [workspaceId, storeCode]
  )
  const store = storeResult.rows[0]
  if (!store) throw new Error(`Active store not found: storeCode="${storeCode}"`)

  // ready veya skipped (önceki başarısız yükleme) itemları kabul et
  // skipped olanları ready'ye döndürüp yeniden ata
  const eligibleResult = await query<{ id: number }>(
    `SELECT id FROM asin_pool
     WHERE workspace_id = $1
       AND id = ANY($2::int[])
       AND status IN ('ready', 'skipped')
       AND pipeline_stage = 'ai_generated'`,
    [workspaceId, poolIds]
  )

  const eligibleIds = eligibleResult.rows.map(r => r.id)
  const skippedCount = poolIds.length - eligibleIds.length

  if (eligibleIds.length === 0) {
    return { selectedCount: 0, skippedCount, assignedPoolIds: [] }
  }

  // status'u ready'ye sıfırla, listing_status'u temizle, store ata
  await query(
    `UPDATE asin_pool
     SET assigned_store_id = $1,
         status            = 'ready',
         listing_status    = 'pending',
         updated_at        = NOW()
     WHERE id = ANY($2::int[])`,
    [store.id, eligibleIds]
  )

  return {
    selectedCount:   eligibleIds.length,
    skippedCount,
    assignedPoolIds: eligibleIds,
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
