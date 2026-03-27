// ─────────────────────────────────────────────────────────────
// publishQueueRepository.ts
// ─────────────────────────────────────────────────────────────

import { query } from "../../db/client"
import type { PublishQueueEntry } from "./publishQueueTypes"

// ─── PUBLISH SIRADAKİ KAYITLAR ────────────────────────────────
// status='ready', pipeline_stage='ai_generated',
// ai_status='success', assigned_store_id = storeId

export async function fetchPublishQueueForStore(
  workspaceId: string,
  storeId:     number,
  limit:       number
): Promise<PublishQueueEntry[]> {
  const result = await query<{
    pool_id:          number
    asin_registry_id: number
    asin:             string
    assigned_store_id: number
    store_code:       string
    store_name:       string
    priority:         number
  }>(
    `SELECT
       ap.id               AS pool_id,
       ap.asin_registry_id,
       ar.asin,
       ap.assigned_store_id,
       s.store_code,
       s.name              AS store_name,
       ap.priority
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     INNER JOIN stores s          ON s.id  = ap.assigned_store_id
     WHERE ap.workspace_id      = $1
       AND ap.assigned_store_id = $2
       AND ap.status            = 'ready'
       AND ap.pipeline_stage    = 'ai_generated'
       AND ap.ai_status         = 'success'
     ORDER BY ap.priority DESC, ap.id ASC
     LIMIT $3`,
    [workspaceId, storeId, limit]
  )

  return result.rows.map(r => ({
    poolId:          r.pool_id,
    asinRegistryId:  r.asin_registry_id,
    asin:            r.asin,
    assignedStoreId: r.assigned_store_id,
    storeCode:       r.store_code,
    storeName:       r.store_name,
    priority:        r.priority
  }))
}

// ─── STORE ID'Yİ KODLA BUL ────────────────────────────────────

export async function findStoreIdByCode(
  workspaceId: string,
  storeCode:   string
): Promise<{ id: number; name: string; storeCode: string; status: string } | null> {
  const result = await query<{
    id:         number
    name:       string
    store_code: string
    status:     string
  }>(
    `SELECT id, name, store_code, status
     FROM stores
     WHERE workspace_id = $1
       AND store_code   = $2
     LIMIT 1`,
    [workspaceId, storeCode]
  )

  const row = result.rows[0]
  if (!row) return null
  return {
    id:        row.id,
    name:      row.name,
    storeCode: row.store_code,
    status:    row.status
  }
}

// ─── PUBLISH SONRASI İŞARETLE ─────────────────────────────────
// persistence service zaten asin_pool'u güncelliyor (completed/listed)
// Bu fonksiyon dryRun durumunda veya manuel rollback için kullanılır

export async function markPoolAsPublished(poolId: number): Promise<void> {
  await query(
    `UPDATE asin_pool
     SET status         = 'completed',
         listing_status = 'success',
         pipeline_stage = 'listed',
         updated_at     = NOW()
     WHERE id = $1`,
    [poolId]
  )
}

export async function markPoolAsPublishFailed(poolId: number): Promise<void> {
  await query(
    `UPDATE asin_pool
     SET listing_status = 'failed',
         updated_at     = NOW()
     WHERE id = $1`,
    [poolId]
  )
}
