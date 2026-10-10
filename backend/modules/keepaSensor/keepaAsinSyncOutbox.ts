import { createHash, randomUUID } from "crypto"
import { query } from "../../db/client"
import {
  eventsFromProjectionTransition,
  projectKeepaAsin,
  type KeepaAsinProjection,
  type KeepaSyncEventType,
} from "./keepaAsinProjection"
import { resolveListingAsin } from "../monitor/listingAsinResolve"

function payloadFingerprint(eventType: KeepaSyncEventType, proj: KeepaAsinProjection): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        eventType,
        asin: proj.asin,
        activeConsumerCount: proj.activeConsumerCount,
        status: proj.status,
        priority: proj.priority,
        cadenceHours: proj.cadenceHours,
      })
    )
    .digest("hex")
}

export async function loadKeepaAsinProjection(asin: string): Promise<KeepaAsinProjection | null> {
  const a = asin.trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(a)) return null
  const res = await query<{
    ebay_quantity: string | null
    total_sold: string | null
    sold_30d: string | null
    current_status: string | null
    registry_asin: string | null
    source_url: string | null
    internal_sku: string | null
    bot_zeroed_at: string | null
  }>(
    `SELECT scs.ebay_quantity::text, scs.total_sold::text, scs.sold_30d::text, scs.current_status::text,
            ar.asin AS registry_asin, scs.source_url, scs.internal_sku, scs.bot_zeroed_at::text
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE (
       UPPER(TRIM(COALESCE(ar.asin,''))) = $1
       OR UPPER(TRIM(COALESCE(scs.internal_sku,''))) = $1
       OR scs.source_url ILIKE '%' || $1 || '%'
     )`,
    [a]
  )
  const listings = res.rows
    .map(row => {
      const resolved = resolveListingAsin({
        registryAsin: row.registry_asin,
        sourceUrl: row.source_url,
        internalSku: row.internal_sku?.trim() ?? "",
      })
      if (resolved !== a) return null
      const qty = Number(row.ebay_quantity ?? 0)
      const sold = Number(row.total_sold ?? 0) > 0 || Number(row.sold_30d ?? 0) > 0
      const live = !["ended", "ended_by_seller", "ended_by_ebay"].includes(String(row.current_status ?? "").toLowerCase())
      return { qty: Number.isFinite(qty) ? qty : 0, sold, live, recovery: row.bot_zeroed_at != null }
    })
    .filter((x): x is { qty: number; sold: boolean; live: boolean; recovery: boolean } => x != null)
  return projectKeepaAsin({ asin: a, listings })
}

async function previousProjection(asin: string): Promise<KeepaAsinProjection | null> {
  const res = await query<{
    status: string
    active_consumer_count: string
    priority: string
    cadence_hours: string
  }>(
    `SELECT status, active_consumer_count::text, priority, cadence_hours::text
     FROM keepa_asin_sync_state WHERE asin = $1`,
    [asin]
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    asin,
    activeConsumerCount: Number(row.active_consumer_count) || 0,
    listingCount: Number(row.active_consumer_count) || 0,
    status: row.status as KeepaAsinProjection["status"],
    priority: row.priority as KeepaAsinProjection["priority"],
    cadenceHours: Number(row.cadence_hours) || 24,
    soldPriority: row.priority === "SOLD",
    qtyPaused: row.status === "PAUSED_QTY_ZERO",
  }
}

export async function emitKeepaAsinSyncForAsins(asins: Array<string | null | undefined>): Promise<number> {
  const seen = new Set<string>()
  let inserted = 0
  for (const raw of asins) {
    const asin = String(raw ?? "").trim().toUpperCase()
    if (!/^[A-Z0-9]{10}$/.test(asin) || seen.has(asin)) continue
    seen.add(asin)
    inserted += await emitKeepaAsinSyncForAsin(asin)
  }
  return inserted
}

export async function emitKeepaAsinSyncForAsin(asin: string): Promise<number> {
  const next = await loadKeepaAsinProjection(asin)
  if (!next) return 0
  const prev = await previousProjection(next.asin)
  let types = eventsFromProjectionTransition(prev, next)
  if (types.length === 0 && next.status === "REMOVED" && prev == null) {
    types = ["ASIN_REMOVED"]
  }
  if (types.length === 0) return 0
  const stateFp = payloadFingerprint("ASIN_UPSERT", next)
  const versionRes = await query<{ source_version: string }>(
    `INSERT INTO keepa_asin_sync_state (
       asin, source_version, payload_fingerprint, status, active_consumer_count, priority, cadence_hours, updated_at
     ) VALUES ($1, 1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (asin) DO UPDATE SET
       source_version = keepa_asin_sync_state.source_version + 1,
       payload_fingerprint = EXCLUDED.payload_fingerprint,
       status = EXCLUDED.status,
       active_consumer_count = EXCLUDED.active_consumer_count,
       priority = EXCLUDED.priority,
       cadence_hours = EXCLUDED.cadence_hours,
       updated_at = NOW()
     RETURNING source_version::text`,
    [next.asin, stateFp, next.status, next.activeConsumerCount, next.priority, next.cadenceHours]
  )
  const sourceVersion = Number(versionRes.rows[0]?.source_version) || 1
  let inserted = 0
  for (const eventType of types) {
    const fp = payloadFingerprint(eventType, next)
    const ins = await query(
      `INSERT INTO keepa_asin_sync_outbox (
         event_id, asin, event_type, source_version, payload, payload_fingerprint, status
       ) VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, 'PENDING')
       ON CONFLICT (asin, event_type, payload_fingerprint) DO NOTHING`,
      [
        randomUUID(),
        next.asin,
        eventType,
        sourceVersion,
        JSON.stringify({ ...next, eventType, sourceVersion }),
        fp,
      ]
    )
    inserted += ins.rowCount ?? 0
  }
  return inserted
}

export async function emitKeepaAsinSyncForCatalog(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
  previousAsins?: Array<string | null | undefined>
}): Promise<void> {
  try {
    const res = await query<{
      registry_asin: string | null
      source_url: string | null
      internal_sku: string | null
    }>(
      `SELECT ar.asin AS registry_asin, scs.source_url, scs.internal_sku
       FROM store_catalog_state scs
       LEFT JOIN asin_registry ar
         ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
       WHERE scs.workspace_id = $1::uuid AND scs.id = $2::bigint
       LIMIT 1`,
      [input.workspaceId, input.catalogStateId]
    )
    const row = res.rows[0]
    const asin = row
      ? resolveListingAsin({
          registryAsin: row.registry_asin,
          sourceUrl: row.source_url,
          internalSku: row.internal_sku?.trim() ?? "",
        })
      : null
    await emitKeepaAsinSyncForAsins([...(input.previousAsins ?? []), asin])
  } catch (e) {
    console.warn("[keepa-asin-sync] emit failed:", e instanceof Error ? e.message : e)
  }
}

export async function keepaAsinReconcileHash(): Promise<{ count: number; hash: string }> {
  const res = await query<{ asin: string; source_version: string; payload_fingerprint: string }>(
    `SELECT asin, source_version::text, payload_fingerprint
     FROM keepa_asin_sync_state
     WHERE status <> 'REMOVED'
     ORDER BY asin`
  )
  const body = res.rows.map(r => `${r.asin}:${r.source_version}:${r.payload_fingerprint}`).join("|")
  return {
    count: res.rows.length,
    hash: createHash("sha256").update(body).digest("hex"),
  }
}
