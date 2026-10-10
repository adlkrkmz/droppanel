import { query } from "../../db/client"
import { resolveListingAsin } from "../monitor/monitorService"
import {
  STOCK_GUARD_DUE_ORDER_BY,
  STOCK_GUARD_MAX_DUE_ASINS_PER_JOB,
  STOCK_GUARD_SCAN_ELIGIBLE_QTY,
} from "./stockGuardScanEligibility"

/** Shared WHERE clause for due Stock Guard catalog rows (status + scheduler + scan). */
export const STOCK_GUARD_DUE_CATALOG_WHERE = `
  scs.panel_hidden_at IS NULL
  AND COALESCE(scs.stock_guard_enabled, true) = true
  AND ${STOCK_GUARD_SCAN_ELIGIBLE_QTY}
  AND scs.source_next_check_at IS NOT NULL
  AND scs.source_next_check_at <= NOW()
  AND (
    scs.current_status IS NULL
    OR scs.current_status = 'live'
  )
  AND scs.ebay_item_id IS NOT NULL
  AND BTRIM(scs.ebay_item_id) <> ''`

export type DueCatalogRow = {
  id: number
  internal_sku: string | null
  source_url: string | null
  registry_asin: string | null
  total_sold: number | null
  sold_30d: number | null
  clicks_30d: number | null
  source_next_check_at: string | null
}

export type DueStockGuardSummary = {
  dueListings: number
  eligibleAsins: number
  noAsinListings: number
  soldDue: number
  clickedDue: number
  normalDue: number
  priority: number
  earliestDueAt: string | null
}

export function summarizeDueCatalogRows(rows: DueCatalogRow[]): DueStockGuardSummary {
  const asinTiers = new Map<string, number>()
  let noAsinListings = 0
  let earliestMs = Number.POSITIVE_INFINITY

  for (const r of rows) {
    if (r.source_next_check_at) {
      const ms = new Date(r.source_next_check_at).getTime()
      if (Number.isFinite(ms) && ms < earliestMs) earliestMs = ms
    }

    const asin = resolveListingAsin({
      registryAsin: r.registry_asin,
      sourceUrl: r.source_url,
      internalSku: r.internal_sku?.trim() ?? "",
    })
    if (!asin) {
      noAsinListings++
      continue
    }

    const sold = (r.total_sold ?? 0) > 0 || (r.sold_30d ?? 0) > 0
    const clicked = !sold && (r.clicks_30d ?? 0) > 0
    const tier = sold ? 0 : clicked ? 1 : 2
    const prev = asinTiers.get(asin)
    if (prev === undefined || tier < prev) asinTiers.set(asin, tier)
  }

  let soldDue = 0
  let clickedDue = 0
  let normalDue = 0
  let minTier = 2
  for (const tier of asinTiers.values()) {
    if (tier === 0) soldDue++
    else if (tier === 1) clickedDue++
    else normalDue++
    if (tier < minTier) minTier = tier
  }

  return {
    dueListings: rows.length,
    eligibleAsins: asinTiers.size,
    noAsinListings,
    soldDue,
    clickedDue,
    normalDue,
    priority: asinTiers.size > 0 ? minTier : 2,
    earliestDueAt:
      Number.isFinite(earliestMs) && earliestMs !== Number.POSITIVE_INFINITY
        ? new Date(earliestMs).toISOString()
        : null,
  }
}

export async function loadDueCatalogRowsForStore(input: {
  workspaceId: string
  storeId: number
  limit?: number
}): Promise<DueCatalogRow[]> {
  const limit = input.limit ?? STOCK_GUARD_MAX_DUE_ASINS_PER_JOB
  const res = await query<DueCatalogRow>(
    `SELECT scs.id,
            scs.internal_sku,
            scs.source_url,
            ar.asin AS registry_asin,
            scs.total_sold,
            scs.sold_30d,
            scs.clicks_30d,
            scs.source_next_check_at::text AS source_next_check_at
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND scs.store_id = $2::bigint
       AND ${STOCK_GUARD_DUE_CATALOG_WHERE}
     ORDER BY ${STOCK_GUARD_DUE_ORDER_BY}
     LIMIT $3::int`,
    [input.workspaceId, input.storeId, limit]
  )
  return res.rows
}

export async function findDueStockGuardForStore(input: {
  workspaceId: string
  storeId: number
  limit?: number
}): Promise<{ rows: DueCatalogRow[]; summary: DueStockGuardSummary }> {
  const rows = await loadDueCatalogRowsForStore(input)
  return { rows, summary: summarizeDueCatalogRows(rows) }
}

export async function countWaitingCatalogRows(
  workspaceId: string,
  storeId: number
): Promise<{ waitingCount: number; earliestWaitingAt: string | null }> {
  try {
    const res = await query<{ waiting: string; earliest_waiting: string | null }>(
      `SELECT
         COUNT(*)::text AS waiting,
         MIN(scs.source_next_check_at)::text AS earliest_waiting
       FROM store_catalog_state scs
       WHERE scs.workspace_id = $1::uuid
         AND scs.store_id = $2::bigint
         AND scs.panel_hidden_at IS NULL
         AND COALESCE(scs.stock_guard_enabled, true) = true
         AND ${STOCK_GUARD_SCAN_ELIGIBLE_QTY}
         AND scs.source_next_check_at IS NOT NULL
         AND scs.source_next_check_at > NOW()
         AND (
           scs.current_status IS NULL
           OR scs.current_status = 'live'
         )
         AND scs.ebay_item_id IS NOT NULL
         AND BTRIM(scs.ebay_item_id) <> ''`,
      [workspaceId, storeId]
    )
    const row = res.rows[0]
    return {
      waitingCount: parseInt(row?.waiting ?? "0", 10) || 0,
      earliestWaitingAt: row?.earliest_waiting ?? null,
    }
  } catch {
    return { waitingCount: 0, earliestWaitingAt: null }
  }
}
