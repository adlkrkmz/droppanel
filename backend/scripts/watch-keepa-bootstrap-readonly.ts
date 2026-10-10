import "dotenv/config"
import { Pool } from "pg"
import { computeKeepaReconcileManifest } from "../modules/keepaSensor/keepaCollectorReconcile"

const GROUPED_SQL = `
SELECT
  COALESCE(
    CASE WHEN ar.asin ~ '^[A-Z0-9]{10}$' THEN UPPER(TRIM(ar.asin)) END,
    UPPER((regexp_match(COALESCE(scs.source_url, ''), 'amazon\\.com/(?:dp|gp/product)/([A-Z0-9]{10})', 'i'))[1]),
    CASE WHEN UPPER(TRIM(COALESCE(scs.internal_sku, ''))) ~ '^[A-Z0-9]{10}$'
      THEN UPPER(TRIM(scs.internal_sku)) END
  ) AS asin,
  COUNT(*) FILTER (
    WHERE LOWER(COALESCE(scs.current_status::text, '')) NOT IN ('ended', 'ended_by_seller', 'ended_by_ebay')
      AND COALESCE(scs.ebay_quantity, 0) > 0
  )::int AS active_consumer_count,
  COUNT(*) FILTER (
    WHERE LOWER(COALESCE(scs.current_status::text, '')) NOT IN ('ended', 'ended_by_seller', 'ended_by_ebay')
  )::int AS listing_count,
  BOOL_OR(
    LOWER(COALESCE(scs.current_status::text, '')) NOT IN ('ended', 'ended_by_seller', 'ended_by_ebay')
    AND (COALESCE(scs.total_sold, 0) > 0 OR COALESCE(scs.sold_30d, 0) > 0)
  ) AS sold
FROM store_catalog_state scs
LEFT JOIN asin_registry ar
  ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
GROUP BY 1
`

async function snapshot(pool: Pool) {
  const outboxStatus = await pool.query(`SELECT status, COUNT(*)::text AS n FROM keepa_asin_sync_outbox GROUP BY status ORDER BY status`)
  const outboxType = await pool.query(`SELECT event_type, COUNT(*)::text AS n FROM keepa_asin_sync_outbox GROUP BY event_type ORDER BY event_type`)
  const outboxTot = await pool.query(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE status='PENDING')::text AS pending,
            COUNT(*) FILTER (WHERE status='DELIVERED')::text AS delivered,
            COUNT(*) FILTER (WHERE status='COVERED_BY_SNAPSHOT')::text AS covered,
            COUNT(*) FILTER (WHERE status='FAILED')::text AS failed,
            MIN(created_at) AS first_at,
            MAX(created_at) AS last_at
     FROM keepa_asin_sync_outbox`
  )
  const receipts = await pool.query(
    `SELECT COUNT(*)::text AS n,
            MAX(created_at) AS last_at
     FROM keepa_collector_bootstrap_receipts`
  )
  const receiptRows = await pool.query(
    `SELECT request_id IS NOT NULL AS has_request_id,
            length(request_id) AS request_id_len,
            local_count,
            length(local_hash) AS hash_len,
            left(local_hash, 12) AS hash_prefix,
            snapshot_started_at,
            covered,
            created_at
     FROM keepa_collector_bootstrap_receipts
     ORDER BY created_at DESC
     LIMIT 5`
  )
  const cand = await pool.query(`SELECT COUNT(*)::text AS n FROM keepa_verify_candidates`)
  const jobs = await pool.query(
    `SELECT kind, status, COUNT(*)::text AS n FROM amazon_scan_jobs GROUP BY kind, status ORDER BY kind, status`
  )
  const jobsTot = await pool.query(`SELECT COUNT(*)::text AS n, MAX(created_at) AS last_created, MAX(completed_at) AS last_completed FROM amazon_scan_jobs`)
  const apply = await pool.query(`SELECT status, COUNT(*)::text AS n FROM amazon_scan_apply_outbox GROUP BY status ORDER BY status`)
  const applyTot = await pool.query(`SELECT COUNT(*)::text AS n, MAX(created_at) AS last_created, MAX(updated_at) AS last_updated FROM amazon_scan_apply_outbox`)
  const rows = await pool.query<{
    asin: string | null
    active_consumer_count: string
    listing_count: string
    sold: boolean
    source_version: string | null
  }>(
    `WITH g AS (${GROUPED_SQL})
     SELECT g.asin, g.active_consumer_count::text, g.listing_count::text, g.sold, st.source_version::text
     FROM g
     LEFT JOIN keepa_asin_sync_state st ON st.asin = g.asin
     WHERE g.asin IS NOT NULL AND g.listing_count > 0
     ORDER BY g.asin`
  )
  const mapped = rows.rows.map(row => {
    const listingCount = Number(row.listing_count) || 0
    const activeCount = Number(row.active_consumer_count) || 0
    const status = listingCount <= 0 ? "REMOVED" : activeCount <= 0 ? "PAUSED_QTY_ZERO" : "ACTIVE"
    const priority = status === "ACTIVE" && row.sold ? "SOLD" : "STANDARD"
    return {
      asin: String(row.asin),
      status,
      priority,
      cadenceHours: priority === "SOLD" ? 12 : 24,
      activeConsumerCount: activeCount,
      sourceVersion: Number(row.source_version ?? 0) || 0,
    }
  })
  const manifest = computeKeepaReconcileManifest(mapped)
  const wm = await pool.query(
    `SELECT created_at, event_id::text IS NOT NULL AS has_id
     FROM keepa_asin_sync_outbox
     ORDER BY created_at DESC, event_id DESC
     LIMIT 1`
  )
  return {
    at: new Date().toISOString(),
    outbox: {
      ...outboxTot.rows[0],
      byStatus: Object.fromEntries(outboxStatus.rows.map(r => [r.status, r.n])),
      byType: Object.fromEntries(outboxType.rows.map(r => [r.event_type, r.n])),
    },
    receipts: { count: receipts.rows[0]?.n, lastAt: receipts.rows[0]?.last_at, rows: receiptRows.rows },
    candidates: cand.rows[0]?.n,
    scanJobs: { ...jobsTot.rows[0], byKindStatus: jobs.rows },
    applyOutbox: { ...applyTot.rows[0], byStatus: Object.fromEntries(apply.rows.map(r => [r.status, r.n])) },
    projection: {
      hash: manifest.hash,
      uniqueAsins: manifest.uniqueAsins,
      active: manifest.active,
      pausedQtyZero: manifest.pausedQtyZero,
      sold: manifest.sold,
      standard: manifest.standard,
      duplicates: manifest.duplicates,
      sourceVersionRegressions: manifest.sourceVersionRegressions,
      eventHighWatermarkCreatedAt: wm.rows[0]?.created_at ?? null,
    },
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const data = await snapshot(pool)
  console.log(JSON.stringify(data, null, 2))
  await pool.end()
}

void main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
