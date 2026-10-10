import { query } from "../../db/client"

/** After 30D clicks sync, align Stock Guard priority without resetting the whole catalog. */
export async function refreshStockGuardPriorityAfterClicksSync(
  workspaceId: string,
  storeId: number
): Promise<void> {
  try {
    await query(
      `UPDATE store_catalog_state scs
       SET source_check_priority = CASE
             WHEN COALESCE(scs.total_sold, 0) > 0 OR COALESCE(scs.sold_30d, 0) > 0 THEN 'sold'
             WHEN COALESCE(scs.clicks_30d, 0) > 0 THEN 'clicked'
             ELSE 'normal'
           END,
           source_next_check_at = CASE
             WHEN COALESCE(scs.total_sold, 0) > 0 OR COALESCE(scs.sold_30d, 0) > 0
               THEN scs.source_next_check_at
             WHEN COALESCE(scs.clicks_30d, 0) > 0
               AND COALESCE(scs.source_check_priority, 'normal') = 'normal'
               AND (scs.source_next_check_at IS NULL OR scs.source_next_check_at > NOW())
               THEN NOW()
             ELSE scs.source_next_check_at
           END,
           updated_at = NOW()
       WHERE scs.workspace_id = $1::uuid
         AND scs.store_id = $2::bigint
         AND scs.panel_hidden_at IS NULL
         AND scs.current_status = 'live'
         AND COALESCE(scs.stock_guard_enabled, true) = true
         AND COALESCE(scs.ebay_quantity, 0) > 0`,
      [workspaceId, storeId]
    )
  } catch (e) {
    console.warn(
      "[Clicks30dSync] stock guard priority refresh skipped:",
      e instanceof Error ? e.message : e
    )
  }
}
