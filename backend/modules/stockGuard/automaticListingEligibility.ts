import { query } from "../../db/client"

/** Final guard immediately before an automatic eBay mutation. */
export async function isEligibleForAutomaticMutation(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
}): Promise<boolean> {
  const res = await query<{
    stock_guard_enabled: boolean | null
    current_status: string | null
    ebay_item_id: string | null
    ebay_quantity: number | null
    store_status: string | null
  }>(
    `SELECT scs.stock_guard_enabled,
            scs.current_status::text AS current_status,
            scs.ebay_item_id,
            scs.ebay_quantity,
            st.status AS store_status
     FROM store_catalog_state scs
     JOIN stores st
       ON st.id = scs.store_id AND st.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND scs.store_id = $2::bigint
       AND scs.id = $3::bigint
     LIMIT 1`,
    [input.workspaceId, input.storeId, input.catalogStateId]
  )
  const row = res.rows[0]
  if (!row) return false
  if (row.stock_guard_enabled === false) return false
  if (String(row.store_status ?? "").trim().toLowerCase() !== "active") return false
  if (String(row.current_status ?? "live").trim().toLowerCase() !== "live") return false
  if (!row.ebay_item_id?.trim()) return false
  return Number(row.ebay_quantity ?? 0) > 0
}
