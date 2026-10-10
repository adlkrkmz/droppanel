import { query } from "../../db/client"

export async function detachConsumersForListings(input: {
  workspaceId: string
  catalogStateIds?: number[]
  ebayItemIds?: string[]
}): Promise<number> {
  const catalogIds = (input.catalogStateIds ?? []).filter(id => Number.isFinite(id) && id > 0)
  const ebayIds = (input.ebayItemIds ?? []).map(id => String(id).trim()).filter(Boolean)
  if (catalogIds.length === 0 && ebayIds.length === 0) return 0
  const res = await query(
    `DELETE FROM global_asin_consumers c
     USING store_catalog_state scs
     WHERE scs.id = c.catalog_state_id
       AND scs.workspace_id = $1::uuid
       AND (
         (cardinality($2::bigint[]) > 0 AND scs.id = ANY($2::bigint[]))
         OR (cardinality($3::text[]) > 0 AND trim(scs.ebay_item_id) = ANY($3::text[]))
       )`,
    [input.workspaceId, catalogIds, ebayIds]
  )
  try {
    const { emitKeepaAsinSyncForCatalog } = await import("../keepaSensor/keepaAsinSyncOutbox")
    for (const id of catalogIds) {
      await emitKeepaAsinSyncForCatalog({ workspaceId: input.workspaceId, storeId: 0, catalogStateId: id })
    }
  } catch (e) {
    console.warn("[keepa-asin-sync] detach emit failed:", e instanceof Error ? e.message : e)
  }
  return res.rowCount ?? 0
}
