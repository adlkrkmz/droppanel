import "dotenv/config"
import { Pool } from "pg"

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error("DATABASE_URL is not defined")
  const pool = new Pool({ connectionString: dbUrl })

  const q = async (label: string, sql: string, params: unknown[] = []) => {
    const r = await pool.query(sql, params)
    console.log(`\n=== ${label} ===`)
    console.log(JSON.stringify(r.rows, null, 2))
    return r.rows
  }

  await q(
    "status_breakdown",
    `SELECT status, COUNT(*)::text AS n FROM keepa_asin_sync_outbox GROUP BY status ORDER BY n DESC`
  )
  await q(
    "event_type_breakdown",
    `SELECT event_type, COUNT(*)::text AS n FROM keepa_asin_sync_outbox GROUP BY event_type ORDER BY n DESC`
  )
  await q(
    "windows",
    `SELECT
       COUNT(*) FILTER (WHERE o.created_at >= NOW() - INTERVAL '5 minutes')::text AS last_5m,
       COUNT(*) FILTER (WHERE o.created_at >= NOW() - INTERVAL '15 minutes')::text AS last_15m,
       COUNT(*) FILTER (WHERE o.created_at >= NOW() - INTERVAL '1 hour')::text AS last_1h,
       COUNT(*) FILTER (WHERE o.created_at >= NOW() - INTERVAL '6 hours')::text AS last_6h,
       COUNT(*) FILTER (WHERE o.created_at >= NOW() - INTERVAL '24 hours')::text AS last_24h,
       COUNT(*)::text AS total,
       MIN(o.created_at) AS first_at,
       MAX(o.created_at) AS last_at
     FROM keepa_asin_sync_outbox o`
  )
  await q(
    "per_minute_last_2h",
    `SELECT date_trunc('minute', created_at) AS minute, COUNT(*)::text AS n
     FROM keepa_asin_sync_outbox
     WHERE created_at >= NOW() - INTERVAL '2 hours'
     GROUP BY 1
     ORDER BY 1`
  )
  await q(
    "per_hour",
    `SELECT date_trunc('hour', created_at) AS hour, COUNT(*)::text AS n
     FROM keepa_asin_sync_outbox
     GROUP BY 1
     ORDER BY 1`
  )
  await q(
    "asin_stats",
    `SELECT
       COUNT(DISTINCT asin)::text AS distinct_asins,
       ROUND(AVG(c)::numeric, 2)::text AS avg_events_per_asin,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY c)::text AS p95,
       MAX(c)::text AS max_events
     FROM (SELECT asin, COUNT(*)::int AS c FROM keepa_asin_sync_outbox GROUP BY asin) s`
  )
  await q(
    "events_per_asin_histogram",
    `SELECT c::text AS events_per_asin, COUNT(*)::text AS asin_count
     FROM (SELECT asin, COUNT(*)::int AS c FROM keepa_asin_sync_outbox GROUP BY asin) s
     GROUP BY c
     ORDER BY c`
  )
  await q(
    "asin_event_type_repeats",
    `SELECT
       COUNT(*) FILTER (WHERE n = 1)::text AS unique_pairs,
       COUNT(*) FILTER (WHERE n > 1)::text AS repeated_pairs,
       COALESCE(MAX(n),0)::text AS max_repeat
     FROM (
       SELECT asin, event_type, COUNT(*)::int AS n
       FROM keepa_asin_sync_outbox
       GROUP BY asin, event_type
     ) s`
  )
  await q(
    "fingerprint_repeats",
    `SELECT
       COUNT(*) FILTER (WHERE n = 1)::text AS unique_fp,
       COUNT(*) FILTER (WHERE n > 1)::text AS repeated_fp,
       COALESCE(MAX(n),0)::text AS max_fp_repeat
     FROM (
       SELECT asin, event_type, payload_fingerprint, COUNT(*)::int AS n
       FROM keepa_asin_sync_outbox
       GROUP BY 1,2,3
     ) s`
  )
  await q(
    "version_stats",
    `SELECT
       MIN(source_version)::text AS min_v,
       MAX(source_version)::text AS max_v,
       COUNT(*) FILTER (WHERE source_version = 1)::text AS v1_events,
       COUNT(*) FILTER (WHERE source_version > 1)::text AS vgt1_events
     FROM keepa_asin_sync_outbox`
  )
  await q(
    "state_vs_outbox",
    `SELECT
       (SELECT COUNT(*)::text FROM keepa_asin_sync_state) AS sync_state_rows,
       (SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::text FROM keepa_asin_sync_state) AS state_active,
       (SELECT COUNT(*) FILTER (WHERE status = 'PAUSED_QTY_ZERO')::text FROM keepa_asin_sync_state) AS state_paused,
       (SELECT COUNT(*) FILTER (WHERE status = 'REMOVED')::text FROM keepa_asin_sync_state) AS state_removed,
       (SELECT COUNT(DISTINCT asin)::text FROM keepa_asin_sync_outbox) AS outbox_distinct_asins`
  )
  await q(
    "state_version_vs_commercial_fingerprint",
    `SELECT
       COUNT(*)::text AS state_rows,
       COUNT(*) FILTER (WHERE source_version = 1)::text AS version_1,
       COUNT(*) FILTER (WHERE source_version > 1)::text AS version_gt1,
       MAX(source_version)::text AS max_state_version
     FROM keepa_asin_sync_state`
  )
  await q(
    "noop_version_heuristic",
    `-- ASINs whose successive outbox payloads share status/priority/cadence/count
     -- while source_version increases. Compare payload fields only (no identifiers printed).
     SELECT COUNT(*)::text AS successive_same_commercial
     FROM (
       SELECT
         asin,
         source_version,
         payload->>'status' AS status,
         payload->>'priority' AS priority,
         payload->>'cadenceHours' AS cadence,
         payload->>'activeConsumerCount' AS cnt,
         LAG(payload->>'status') OVER w AS pstatus,
         LAG(payload->>'priority') OVER w AS ppriority,
         LAG(payload->>'cadenceHours') OVER w AS pcadence,
         LAG(payload->>'activeConsumerCount') OVER w AS pcnt,
         LAG(source_version) OVER w AS pver
       FROM keepa_asin_sync_outbox
       WINDOW w AS (PARTITION BY asin ORDER BY source_version, created_at)
     ) s
     WHERE pver IS NOT NULL
       AND source_version > pver
       AND status IS NOT DISTINCT FROM pstatus
       AND priority IS NOT DISTINCT FROM ppriority
       AND cadence IS NOT DISTINCT FROM pcadence
       AND cnt IS NOT DISTINCT FROM pcnt`
  )
  await q(
    "first_event_vs_later_by_hour",
    `WITH firsts AS (
       SELECT asin, MIN(created_at) AS first_at
       FROM keepa_asin_sync_outbox
       GROUP BY asin
     )
     SELECT date_trunc('hour', o.created_at) AS hour,
            COUNT(*) FILTER (WHERE o.created_at = f.first_at)::text AS first_seen_events,
            COUNT(*) FILTER (WHERE o.created_at > f.first_at)::text AS later_events
     FROM keepa_asin_sync_outbox o
     JOIN firsts f ON f.asin = o.asin
     GROUP BY 1
     ORDER BY 1`
  )
  await q(
    "projection_gap",
    `WITH catalog AS (
       SELECT DISTINCT UPPER(TRIM(COALESCE(
         CASE WHEN ar.asin ~ '^[A-Z0-9]{10}$' THEN ar.asin END,
         (regexp_match(COALESCE(scs.source_url, ''), 'amazon\\.com/(?:dp|gp/product)/([A-Z0-9]{10})', 'i'))[1],
         CASE WHEN UPPER(TRIM(COALESCE(scs.internal_sku,''))) ~ '^[A-Z0-9]{10}$' THEN UPPER(TRIM(scs.internal_sku)) END
       ))) AS asin
       FROM store_catalog_state scs
       LEFT JOIN asin_registry ar ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
       WHERE LOWER(COALESCE(scs.current_status::text,'')) NOT IN ('ended','ended_by_seller','ended_by_ebay')
    )
    SELECT
      COUNT(*) FILTER (WHERE c.asin IS NOT NULL)::text AS live_resolved_asins,
      (SELECT COUNT(*)::text FROM keepa_asin_sync_state WHERE status IN ('ACTIVE','PAUSED_QTY_ZERO')) AS projected_active_paused,
      COUNT(*) FILTER (
        WHERE c.asin IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM keepa_asin_sync_state st WHERE st.asin = c.asin
        )
      )::text AS live_asins_without_state
     FROM catalog c`
  )
  await q(
    "recent_vs_state_age",
    `SELECT
       COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL '15 minutes')::text AS state_updated_15m,
       COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL '1 hour')::text AS state_updated_1h,
       MIN(updated_at) AS state_first_update,
       MAX(updated_at) AS state_last_update
     FROM keepa_asin_sync_state`
  )

  await pool.end()
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})
