import { query } from "../../db/client"

export type ListingPreparationRow = {
  pool_id: number
  asin_registry_id: number
  asin: string
  assigned_store_id: number
  store_code: string
  store_name: string
  status: string
  pipeline_stage: string
}

export type PreparedListingPayload = {
  poolId: number
  asinRegistryId: number
  asin: string
  assignedStoreId: number
  storeCode: string
  storeName: string
  internalSku: string
  listingStatus: "prepared"
}

function buildInternalSku(asin: string, storeCode: string): string {
  return `DP-${asin}-${storeCode}`
}

export async function getPreparedListingPayloads(
  workspaceId: string,
  limit = 100
): Promise<PreparedListingPayload[]> {
  const sql = `
    SELECT
      ap.id AS pool_id,
      ap.asin_registry_id,
      ar.asin,
      ap.assigned_store_id,
      s.store_code,
      s.name AS store_name,
      ap.status,
      ap.pipeline_stage
    FROM asin_pool ap
    INNER JOIN asin_registry ar
      ON ar.id = ap.asin_registry_id
    INNER JOIN stores s
      ON s.id = ap.assigned_store_id
    WHERE ap.workspace_id = $1
      AND ap.status = 'ready'
      AND ap.pipeline_stage = 'validated'
      AND ap.assigned_store_id IS NOT NULL
      AND s.status = 'active'
    ORDER BY ap.priority DESC, ap.id ASC
    LIMIT $2
  `

  const result = await query<ListingPreparationRow>(sql, [workspaceId, limit])

  return result.rows.map((row) => ({
    poolId: row.pool_id,
    asinRegistryId: row.asin_registry_id,
    asin: row.asin,
    assignedStoreId: row.assigned_store_id,
    storeCode: row.store_code,
    storeName: row.store_name,
    internalSku: buildInternalSku(row.asin, row.store_code),
    listingStatus: "prepared"
  }))
}