import { query, withTransaction } from "../../db/client"
import type { PoolClient } from "pg"
import { cadenceHoursForPriority, type KeepaAsinPriority, type KeepaAsinRegistryStatus } from "./keepaAsinProjection"

/** Catalog ASIN resolution matching resolveListingAsin (registry → URL → SKU). */
export const KEEPA_SNAPSHOT_RESOLVED_ASIN_SQL = `
COALESCE(
  CASE WHEN ar.asin ~ '^[A-Z0-9]{10}$' THEN UPPER(TRIM(ar.asin)) END,
  UPPER((regexp_match(COALESCE(scs.source_url, ''), 'amazon\\.com/(?:dp|gp/product)/([A-Z0-9]{10})', 'i'))[1]),
  CASE WHEN UPPER(TRIM(COALESCE(scs.internal_sku, ''))) ~ '^[A-Z0-9]{10}$'
    THEN UPPER(TRIM(scs.internal_sku)) END,
  UPPER((regexp_match(UPPER(TRIM(COALESCE(scs.internal_sku, ''))), '^DP-([A-Z0-9]{10})-[A-Z0-9]+$'))[1]),
  UPPER((regexp_match(UPPER(TRIM(COALESCE(scs.internal_sku, ''))), '^DP([A-Z0-9]{10})[A-Z0-9]{1,4}$'))[1])
)`

const GROUPED_SQL = `
SELECT
  ${KEEPA_SNAPSHOT_RESOLVED_ASIN_SQL} AS asin,
  COUNT(*) FILTER (
    WHERE LOWER(COALESCE(scs.current_status::text, '')) NOT IN ('ended', 'ended_by_seller', 'ended_by_ebay')
      AND COALESCE(scs.ebay_quantity, 0) > 0
  )::int AS active_consumer_count,
  COUNT(*) FILTER (
    WHERE LOWER(COALESCE(scs.current_status::text, '')) NOT IN ('ended', 'ended_by_seller', 'ended_by_ebay')
      AND COALESCE(scs.ebay_quantity, 0) <= 0 AND scs.bot_zeroed_at IS NOT NULL
  )::int AS recovery_consumer_count,
  COUNT(*) FILTER (
    WHERE LOWER(COALESCE(scs.current_status::text, '')) NOT IN ('ended', 'ended_by_seller', 'ended_by_ebay')
  )::int AS listing_count,
  BOOL_OR(
    LOWER(COALESCE(scs.current_status::text, '')) NOT IN ('ended', 'ended_by_seller', 'ended_by_ebay')
    AND (COALESCE(scs.total_sold, 0) > 0 OR COALESCE(scs.sold_30d, 0) > 0)
  ) AS sold,
  MAX(scs.updated_at) AS listing_updated_at
FROM store_catalog_state scs
LEFT JOIN asin_registry ar
  ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
GROUP BY 1
`

export type KeepaCollectorSnapshotRow = {
  asin: string
  activeConsumerCount: number
  status: KeepaAsinRegistryStatus
  priority: KeepaAsinPriority
  cadenceHours: 12 | 24 | 120
  sourceVersion: number
  updatedAt: string
  queueSeq: number
}

export type KeepaCollectorWatermark = {
  snapshotStartedAt: string
  lastEventCreatedAt: string | null
  lastEventId: string | null
  maxSourceVersion: number
}

export type KeepaCollectorSnapshotTotals = {
  uniqueAsins: number
  active: number
  pausedQtyZero: number
  sold: number
  standard: number
  excludedRemoved: number
  duplicateAsinRows: number
}

function projectStatus(listingCount: number, activeCount: number, recoveryCount = 0): KeepaAsinRegistryStatus {
  if (listingCount <= 0) return "REMOVED"
  if (activeCount + recoveryCount <= 0) return "PAUSED_QTY_ZERO"
  return "ACTIVE"
}

export async function loadKeepaCollectorWatermark(): Promise<KeepaCollectorWatermark> {
  const started = await query<{ ts: Date }>(`SELECT CLOCK_TIMESTAMP() AS ts`)
  const ev = await query<{ event_id: string; created_at: Date; source_version: string }>(
    `SELECT event_id::text, created_at, source_version::text
     FROM keepa_asin_sync_outbox
     ORDER BY created_at DESC, event_id DESC
     LIMIT 1`
  )
  const ver = await query<{ m: string | null }>(
    `SELECT MAX(source_version)::text AS m FROM keepa_asin_sync_state`
  )
  const row = ev.rows[0]
  return {
    snapshotStartedAt: new Date(started.rows[0].ts).toISOString(),
    lastEventCreatedAt: row ? new Date(row.created_at).toISOString() : null,
    lastEventId: row?.event_id ?? null,
    maxSourceVersion: Number(ver.rows[0]?.m ?? 0) || 0,
  }
}

export async function loadKeepaCollectorSnapshotTotals(): Promise<KeepaCollectorSnapshotTotals> {
  const r = await query<{
    unique_asins: string
    active: string
    paused: string
    sold: string
    standard: string
    removed: string
    null_asin: string
  }>(
    `WITH g AS (${GROUPED_SQL})
     SELECT
       COUNT(*) FILTER (WHERE asin IS NOT NULL)::text AS unique_asins,
       COUNT(*) FILTER (
         WHERE asin IS NOT NULL AND listing_count > 0 AND active_consumer_count > 0
       )::text AS active,
       COUNT(*) FILTER (
         WHERE asin IS NOT NULL AND listing_count > 0 AND active_consumer_count = 0
       )::text AS paused,
       COUNT(*) FILTER (
         WHERE asin IS NOT NULL AND listing_count > 0 AND active_consumer_count > 0 AND sold
       )::text AS sold,
       COUNT(*) FILTER (
         WHERE asin IS NOT NULL AND listing_count > 0 AND active_consumer_count > 0 AND NOT sold
       )::text AS standard,
       COUNT(*) FILTER (WHERE asin IS NOT NULL AND listing_count = 0)::text AS removed,
       COUNT(*) FILTER (WHERE asin IS NULL)::text AS null_asin
     FROM g`
  )
  const row = r.rows[0]
  return {
    uniqueAsins: Number(row?.unique_asins ?? 0),
    active: Number(row?.active ?? 0),
    pausedQtyZero: Number(row?.paused ?? 0),
    sold: Number(row?.sold ?? 0),
    standard: Number(row?.standard ?? 0),
    excludedRemoved: Number(row?.removed ?? 0) + Number(row?.null_asin ?? 0),
    duplicateAsinRows: 0,
  }
}

export async function loadKeepaCollectorSnapshotPage(input: {
  cursorAsin?: string
  limit?: number
  offsetSeq?: number
}): Promise<{ items: KeepaCollectorSnapshotRow[]; nextCursor: string | null }> {
  const limit = Math.min(200, Math.max(1, input.limit ?? 100))
  const cursor = String(input.cursorAsin ?? "").trim().toUpperCase()
  const offsetSeq = Math.max(0, input.offsetSeq ?? 0)
  const rows = await query<{
    asin: string
    active_consumer_count: string
    recovery_consumer_count: string
    listing_count: string
    sold: boolean
    listing_updated_at: Date
    source_version: string | null
    state_updated_at: Date | null
  }>(
    `WITH g AS (${GROUPED_SQL})
     SELECT g.asin,
            g.active_consumer_count::text,
            g.recovery_consumer_count::text,
            g.listing_count::text,
            g.sold,
            g.listing_updated_at,
            st.source_version::text,
            st.updated_at AS state_updated_at
     FROM g
     LEFT JOIN keepa_asin_sync_state st ON st.asin = g.asin
     WHERE g.asin IS NOT NULL
       AND g.listing_count > 0
       AND ($1::text = '' OR g.asin > $1::text)
     ORDER BY g.asin ASC
     LIMIT $2::int`,
    [cursor, limit]
  )
  const items: KeepaCollectorSnapshotRow[] = rows.rows.map((row, i) => {
    const listingCount = Number(row.listing_count) || 0
    const activeCount = Number(row.active_consumer_count) || 0
    const recoveryCount = Number(row.recovery_consumer_count) || 0
    const status = projectStatus(listingCount, activeCount, recoveryCount)
    const priority: KeepaAsinPriority = status === "ACTIVE" && row.sold ? "SOLD" : "STANDARD"
    const cadenceHours = (status === "ACTIVE" && activeCount === 0 ? 120 : cadenceHoursForPriority(priority)) as 12 | 24 | 120
    const updated = row.state_updated_at ?? row.listing_updated_at
    return {
      asin: row.asin,
      activeConsumerCount: activeCount + recoveryCount,
      status,
      priority,
      cadenceHours,
      sourceVersion: Number(row.source_version ?? 0) || 0,
      updatedAt: new Date(updated).toISOString(),
      queueSeq: offsetSeq + i + 1,
    }
  })
  const nextCursor = items.length === limit ? items[items.length - 1].asin : null
  return { items, nextCursor }
}

export type KeepaCollectorReconcileCheckpoint = {
  rows: import("./keepaCollectorReconcile").KeepaReconcileRow[]
  eventHighWatermarkCreatedAt: string | null
  eventHighWatermarkId: string | null
  generatedAt: string
}

export async function loadKeepaCollectorReconcileCheckpoint(): Promise<KeepaCollectorReconcileCheckpoint> {
  return withTransaction(async (client: PoolClient) => {
    const rows = await client.query<{
      asin: string
      active_consumer_count: string
      recovery_consumer_count: string
      listing_count: string
      sold: boolean
      source_version: string | null
    }>(
      `WITH g AS (${GROUPED_SQL})
       SELECT g.asin,
              g.active_consumer_count::text,
              g.recovery_consumer_count::text,
              g.listing_count::text,
              g.sold,
              st.source_version::text
       FROM g
       LEFT JOIN keepa_asin_sync_state st ON st.asin = g.asin
       WHERE g.asin IS NOT NULL AND g.listing_count > 0
       ORDER BY g.asin ASC`
    )
    const wm = await client.query<{ event_id: string; created_at: Date }>(
      `SELECT event_id::text, created_at
       FROM keepa_asin_sync_outbox
       ORDER BY created_at DESC, event_id DESC
       LIMIT 1`
    )
    const now = await client.query<{ ts: Date }>(`SELECT CLOCK_TIMESTAMP() AS ts`)
    const mapped = rows.rows
      .map(row => {
        const listingCount = Number(row.listing_count) || 0
        const activeCount = Number(row.active_consumer_count) || 0
        const recoveryCount = Number(row.recovery_consumer_count) || 0
        const status = projectStatus(listingCount, activeCount, recoveryCount)
        if (status === "REMOVED") return null
        const priority: KeepaAsinPriority = status === "ACTIVE" && row.sold ? "SOLD" : "STANDARD"
        return {
          asin: row.asin,
          status,
          priority,
          cadenceHours: status === "ACTIVE" && activeCount === 0 ? 120 : cadenceHoursForPriority(priority),
          activeConsumerCount: activeCount + recoveryCount,
          sourceVersion: Number(row.source_version ?? 0) || 0,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
    const top = wm.rows[0]
    return {
      rows: mapped,
      eventHighWatermarkCreatedAt: top ? new Date(top.created_at).toISOString() : null,
      eventHighWatermarkId: top?.event_id ?? null,
      generatedAt: new Date(now.rows[0].ts).toISOString(),
    }
  })
}

export async function loadKeepaCollectorReconcileRows(): Promise<import("./keepaCollectorReconcile").KeepaReconcileRow[]> {
  const checkpoint = await loadKeepaCollectorReconcileCheckpoint()
  return checkpoint.rows
}
