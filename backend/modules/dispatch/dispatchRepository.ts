// ─────────────────────────────────────────────────────────────
// dispatchRepository.ts
// ─────────────────────────────────────────────────────────────

import { query } from "../../db/client"
import type { DispatchCandidate, StoreRow } from "./dispatchTypes"

// ─── STORE BULMAK ─────────────────────────────────────────────

export async function findStoreByCode(
  workspaceId: string,
  storeCode:   string
): Promise<StoreRow | null> {
  const result = await query<StoreRow>(
    `SELECT id, name, store_code AS "storeCode", status
     FROM stores
     WHERE workspace_id = $1
       AND store_code   = $2
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  return result.rows[0] ?? null
}

// ─── UYGUN ADAYLAR ────────────────────────────────────────────
// status='ready', assigned_store_id IS NULL,
// pipeline_stage IN (validated, scraped, ai_generated)

export async function fetchDispatchCandidates(
  workspaceId: string,
  limit:       number
): Promise<DispatchCandidate[]> {
  const result = await query<{
    pool_id:          number
    asin_registry_id: number
    asin:             string
    priority:         number
  }>(
    `SELECT
       ap.id              AS pool_id,
       ap.asin_registry_id,
       ar.asin,
       ap.priority
     FROM asin_pool ap
     INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
     INNER JOIN amazon_product_cache apc
       ON apc.asin_registry_id = ap.asin_registry_id
       AND apc.price > 0
     WHERE ap.workspace_id      = $1
       AND ap.status            = 'ready'
       AND ap.assigned_store_id IS NULL
       AND ap.pipeline_stage    IN ('validated', 'scraped', 'ai_generated')
     ORDER BY RANDOM()
     LIMIT $2`,
    [workspaceId, limit]
  )

  return result.rows.map(r => ({
    poolId:         r.pool_id,
    asinRegistryId: r.asin_registry_id,
    asin:           r.asin,
    priority:       r.priority
  }))
}

// ─── MAĞAZADA ZATEN VAR MI? ───────────────────────────────────
// store_catalog_state + listing_history üzerinden kontrol

export async function fetchAlreadyListedAsins(
  workspaceId: string,
  storeId:     number
): Promise<Set<string>> {
  // store_catalog_state
  const catalogResult = await query<{ asin: string }>(
    `SELECT ar.asin
     FROM store_catalog_state scs
     INNER JOIN asin_registry ar ON ar.id = scs.asin_registry_id
     WHERE scs.workspace_id = $1
       AND scs.store_id     = $2`,
    [workspaceId, storeId]
  )

  // listing_history
  const historyResult = await query<{ asin: string }>(
    `SELECT ar.asin
     FROM listing_history lh
     INNER JOIN asin_registry ar ON ar.id = lh.asin_registry_id
     WHERE lh.workspace_id = $1
       AND lh.store_id     = $2`,
    [workspaceId, storeId]
  )

  const asins = new Set<string>()
  for (const r of catalogResult.rows)  asins.add(r.asin)
  for (const r of historyResult.rows)  asins.add(r.asin)
  return asins
}

// ─── POOL KAYITLARINI MAĞAZAYA ATA ────────────────────────────

export async function assignPoolEntriesToStore(
  poolIds: number[],
  storeId: number
): Promise<number> {
  if (poolIds.length === 0) return 0

  const result = await query(
    `UPDATE asin_pool
     SET assigned_store_id = $1,
         updated_at        = NOW()
     WHERE id = ANY($2::int[])`,
    [storeId, poolIds]
  )

  return result.rowCount ?? 0
}
