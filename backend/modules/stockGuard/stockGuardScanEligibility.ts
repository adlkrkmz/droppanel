import { query } from "../../db/client"

/** Live listing base filters (store-scoped queries add workspace_id + store_id). */
export const STOCK_GUARD_SCAN_ELIGIBLE_QTY = `COALESCE(scs.ebay_quantity, 0) > 0`

/** Max unique ASINs per scheduler job / scan batch (token-safe). */
export const STOCK_GUARD_MAX_DUE_ASINS_PER_JOB = 50

/** Catalog due-listing ORDER BY (sold → clicked → normal, oldest check first). */
export const STOCK_GUARD_DUE_ORDER_BY = `
  CASE
    WHEN COALESCE(scs.total_sold, 0) > 0 OR COALESCE(scs.sold_30d, 0) > 0 THEN 0
    WHEN COALESCE(scs.clicks_30d, 0) > 0 THEN 1
    ELSE 2
  END,
  scs.source_next_check_at ASC NULLS FIRST`

export async function countSkippedZeroQty(
  workspaceId: string,
  storeId: number
): Promise<number> {
  try {
    const res = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM store_catalog_state scs
       WHERE scs.workspace_id = $1::uuid
         AND scs.store_id = $2::bigint
         AND scs.panel_hidden_at IS NULL
         AND scs.current_status = 'live'
         AND COALESCE(scs.stock_guard_enabled, true) = true
         AND NOT (${STOCK_GUARD_SCAN_ELIGIBLE_QTY})`,
      [workspaceId, storeId]
    )
    return parseInt(res.rows[0]?.c ?? "0", 10) || 0
  } catch {
    return 0
  }
}

/** Skip review/alert for listings not open for sale on eBay. */
export function isEligibleForStockGuardScan(ebayQuantity: number | null | undefined): boolean {
  return ebayQuantity != null && Number.isFinite(ebayQuantity) && ebayQuantity > 0
}
