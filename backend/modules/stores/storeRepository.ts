import { query } from "../../db/client"

export type CreateStoreInput = {
  workspaceId: string
  name: string
  storeCode: string
  marketplace?: string
  status?: string
  maxActiveListings?: number
  targetActiveListings?: number
  dailyListingLimit?: number
}

export async function createStore(input: CreateStoreInput) {
  const sql = `
    INSERT INTO stores (
      workspace_id,
      name,
      store_code,
      marketplace,
      status,
      max_active_listings,
      target_active_listings,
      daily_listing_limit
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `

  const result = await query(sql, [
    input.workspaceId,
    input.name,
    input.storeCode,
    input.marketplace ?? "ebay",
    input.status ?? "active",
    input.maxActiveListings ?? 10000,
    input.targetActiveListings ?? 5000,
    input.dailyListingLimit ?? 250
  ])

  return result.rows[0] ?? null
}

export async function getStoreById(id: number) {
  const sql = `
    SELECT *
    FROM stores
    WHERE id = $1
    LIMIT 1
  `

  const result = await query(sql, [id])
  return result.rows[0] ?? null
}

export async function getStoreByCode(workspaceId: string, storeCode: string) {
  const sql = `
    SELECT *
    FROM stores
    WHERE workspace_id = $1
      AND store_code = $2
    LIMIT 1
  `

  const result = await query(sql, [workspaceId, storeCode])
  return result.rows[0] ?? null
}

export async function listStoresByWorkspace(workspaceId: string) {
  const sql = `
    SELECT *
    FROM stores
    WHERE workspace_id = $1
    ORDER BY id ASC
  `

  const result = await query(sql, [workspaceId])
  return result.rows
}

export async function updateStoreStatus(id: number, status: string) {
  const sql = `
    UPDATE stores
    SET status = $2,
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `

  const result = await query(sql, [id, status])
  return result.rows[0] ?? null
}

export async function updateStoreSyncState(
  id: number,
  updates: {
    syncHealth?: string
    healthStatus?: string
    lastSyncAt?: string | Date | null
    errorCount?: number
    lastError?: string | null
  }
) {
  const sql = `
    UPDATE stores
    SET sync_health = COALESCE($2, sync_health),
        health_status = COALESCE($3, health_status),
        last_sync_at = COALESCE($4, last_sync_at),
        error_count = COALESCE($5, error_count),
        last_error = COALESCE($6, last_error),
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `

  const result = await query(sql, [
    id,
    updates.syncHealth ?? null,
    updates.healthStatus ?? null,
    updates.lastSyncAt ?? null,
    updates.errorCount ?? null,
    updates.lastError ?? null
  ])

  return result.rows[0] ?? null
}

export async function deleteStore(id: number) {
  const sql = `
    DELETE FROM stores
    WHERE id = $1
    RETURNING id
  `

  const result = await query(sql, [id])
  return result.rows[0] ?? null
}

export async function getStoreCapacity(storeId: number) {
  const sql = `
    SELECT
      s.id,
      s.name,
      s.store_code,
      s.status,
      s.max_active_listings,
      s.target_active_listings,
      s.daily_listing_limit,
      COUNT(CASE WHEN scs.current_status = 'live' THEN 1 END)::int AS current_live_count,
      GREATEST(
        s.max_active_listings - COUNT(CASE WHEN scs.current_status = 'live' THEN 1 END)::int,
        0
      )::int AS remaining_capacity
    FROM stores s
    LEFT JOIN store_catalog_state scs
      ON scs.store_id = s.id
    WHERE s.id = $1
    GROUP BY
      s.id,
      s.name,
      s.store_code,
      s.status,
      s.max_active_listings,
      s.target_active_listings,
      s.daily_listing_limit
  `

  const result = await query(sql, [storeId])
  return result.rows[0] ?? null
}
