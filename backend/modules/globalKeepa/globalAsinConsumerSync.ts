import type { PoolClient, QueryResult, QueryResultRow } from "pg"
import { query } from "../../db/client"
import { listingPriorityRank } from "./globalKeepaPriority"
import { loadGlobalKeepaFoundationConfig } from "./globalKeepaConfig"
import {
  UPSERT_GLOBAL_AMAZON_ASIN_SQL,
  UPSERT_GLOBAL_ASIN_CONSUMER_SQL,
} from "./globalAsinBackfillCore"

async function execQuery<T extends QueryResultRow>(
  client: PoolClient | undefined,
  text: string,
  params: unknown[]
): Promise<QueryResult<T>> {
  if (client) return client.query<T>(text, params)
  return query<T>(text, params)
}

/**
 * After a catalog row's Amazon ASIN changes, move the unique consumer
 * to the new (keepa_domain, asin) identity. Writes only global foundation tables.
 * Unique (catalog_state_id) means A is detached and B attached in one upsert.
 */
export async function syncGlobalAsinConsumerForCatalog(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
  asin: string
  totalSold?: number | null
  sold30d?: number | null
  clicks30d?: number | null
  client?: PoolClient
}): Promise<number | null> {
  const asin = input.asin.trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    await execQuery(input.client, `DELETE FROM global_asin_consumers WHERE catalog_state_id = $1::bigint`, [
      input.catalogStateId,
    ])
    return null
  }
  const domain = loadGlobalKeepaFoundationConfig().keepaDomain
  const priority = listingPriorityRank({
    totalSold: input.totalSold ?? null,
    sold30d: input.sold30d ?? null,
    clicks30d: input.clicks30d ?? null,
  })
  const asinRes = await execQuery<{ id: number }>(input.client, UPSERT_GLOBAL_AMAZON_ASIN_SQL, [
    domain,
    asin,
    priority,
  ])
  const globalAsinId = Number(asinRes.rows[0]?.id)
  if (!Number.isFinite(globalAsinId)) return null
  await execQuery(input.client, UPSERT_GLOBAL_ASIN_CONSUMER_SQL, [
    globalAsinId,
    input.workspaceId,
    input.storeId,
    input.catalogStateId,
    priority,
  ])
  return globalAsinId
}

/**
 * Resolve listing ASIN from catalog and upsert global consumer.
 * Additive only; never throws to callers (publish/sync stay intact).
 */
export async function trySyncGlobalAsinConsumerFromCatalog(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
}): Promise<void> {
  try {
    const res = await query<{
      workspace_id: string
      store_id: number
      catalog_state_id: number
      registry_asin: string | null
      source_url: string | null
      internal_sku: string | null
      total_sold: number | null
      sold_30d: number | null
      clicks_30d: number | null
      ebay_quantity: number | null
      current_status: string | null
      bot_zeroed_at: string | null
    }>(
      `SELECT scs.workspace_id::text AS workspace_id,
              scs.store_id,
              scs.id AS catalog_state_id,
              ar.asin AS registry_asin,
              scs.source_url,
              scs.internal_sku,
              scs.total_sold,
              scs.sold_30d,
              scs.clicks_30d,
              scs.ebay_quantity, scs.current_status::text, scs.bot_zeroed_at::text
       FROM store_catalog_state scs
       LEFT JOIN asin_registry ar
         ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
       WHERE scs.workspace_id = $1::uuid
         AND scs.store_id = $2::integer
         AND scs.id = $3::bigint
       LIMIT 1`,
      [input.workspaceId, input.storeId, input.catalogStateId]
    )
    const row = res.rows[0]
    if (!row) return
    const { resolveListingAsin } = await import("../monitor/listingAsinResolve")
    const asin = resolveListingAsin({
      registryAsin: row.registry_asin,
      sourceUrl: row.source_url,
      internalSku: row.internal_sku?.trim() ?? "",
    })
    const ended = ["ended", "ended_by_seller", "ended_by_ebay"].includes(String(row.current_status ?? "").toLowerCase())
    const monitorable = !ended && (Number(row.ebay_quantity ?? 0) > 0 || row.bot_zeroed_at != null)
    if (!asin || !monitorable) {
      const prev = await query<{ asin: string | null }>(
        `SELECT UPPER(TRIM(a.asin)) AS asin
         FROM global_asin_consumers c
         JOIN global_amazon_asins a ON a.id = c.global_asin_id
         WHERE c.catalog_state_id = $1::bigint
         LIMIT 1`,
        [Number(row.catalog_state_id)]
      )
      await query(`DELETE FROM global_asin_consumers WHERE catalog_state_id = $1::bigint`, [
        Number(row.catalog_state_id),
      ])
      const previousAsin = prev.rows[0]?.asin
      if (previousAsin) {
        const { emitKeepaAsinSyncForAsin } = await import("../keepaSensor/keepaAsinSyncOutbox")
        await emitKeepaAsinSyncForAsin(previousAsin)
      }
      return
    }
    await syncGlobalAsinConsumerForCatalog({
      workspaceId: row.workspace_id,
      storeId: Number(row.store_id),
      catalogStateId: Number(row.catalog_state_id),
      asin,
      totalSold: row.total_sold,
      sold30d: row.sold_30d,
      clicks30d: row.clicks_30d,
    })
    const { emitKeepaAsinSyncForCatalog } = await import("../keepaSensor/keepaAsinSyncOutbox")
    await emitKeepaAsinSyncForCatalog({
      workspaceId: row.workspace_id,
      storeId: Number(row.store_id),
      catalogStateId: Number(row.catalog_state_id),
    })
  } catch (e) {
    console.warn(
      "[GlobalKeepa] consumer sync skipped:",
      e instanceof Error ? e.message : e
    )
  }
}
