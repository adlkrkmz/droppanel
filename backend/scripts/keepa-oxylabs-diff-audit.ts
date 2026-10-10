import "dotenv/config"
import { query } from "../db/client"

async function main(): Promise<void> {
  const now = await query(`SELECT NOW() AS n, NOW() AT TIME ZONE 'utc' AS utc`)
  const repair = await query(
    `SELECT request_id, created_at::text, updated::text, final_count::text, final_hash
     FROM keepa_collector_repair_receipts
     ORDER BY created_at DESC NULLS LAST
     LIMIT 3`
  )
  const obsCols = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'keepa_asin_last_observations' ORDER BY ordinal_position`
  )
  const dist = await query(
    `SELECT evaluation_code, COUNT(*)::int AS c
     FROM keepa_asin_last_observations
     GROUP BY evaluation_code
     ORDER BY c DESC`
  )
  const recent = await query(
    `SELECT evaluation_code, COUNT(*)::int AS c
     FROM (
       SELECT evaluation_code
       FROM keepa_asin_last_observations
       ORDER BY updated_at DESC
       LIMIT 1000
     ) t
     GROUP BY evaluation_code
     ORDER BY c DESC`
  )
  const recentObs = await query(
    `SELECT evaluation_code, COUNT(*)::int AS c
     FROM (
       SELECT evaluation_code
       FROM keepa_asin_last_observations
       ORDER BY observed_at DESC
       LIMIT 1000
     ) t
     GROUP BY evaluation_code
     ORDER BY c DESC`
  )
  const windows = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE updated_at > NOW() - interval '6 hours')::int AS upd_6h,
       COUNT(*) FILTER (WHERE observed_at > NOW() - interval '6 hours')::int AS obs_6h,
       COUNT(*) FILTER (WHERE updated_at > NOW() - interval '24 hours')::int AS upd_24h,
       MIN(updated_at)::text AS min_upd,
       MAX(updated_at)::text AS max_upd,
       MIN(observed_at)::text AS min_obs,
       MAX(observed_at)::text AS max_obs
     FROM keepa_asin_last_observations`
  )
  const last1000meta = await query(
    `SELECT MIN(updated_at)::text AS min_upd, MAX(updated_at)::text AS max_upd,
            MIN(observed_at)::text AS min_obs, MAX(observed_at)::text AS max_obs
     FROM (
       SELECT updated_at, observed_at FROM keepa_asin_last_observations ORDER BY updated_at DESC LIMIT 1000
     ) t`
  )
  const cand = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE created_at > NOW() - interval '12 hours')::int AS created_12h,
       COUNT(*) FILTER (WHERE snapshot->>'evaluationCode' = 'KEEPA_SNAPSHOT_CHANGED')::int AS snapshot_changed,
       COUNT(*) FILTER (WHERE snapshot->>'evaluationCode' = 'KEEPA_SNAPSHOT_CHANGED' AND created_at > NOW() - interval '12 hours')::int AS snapshot_changed_12h,
       COUNT(*) FILTER (WHERE created_at > NOW() - interval '12 hours' AND status = 'PENDING')::int AS pending_12h
     FROM keepa_verify_candidates`
  )
  const candCodes = await query(
    `SELECT COALESCE(snapshot->>'evaluationCode','') AS code, COUNT(*)::int AS c
     FROM keepa_verify_candidates
     WHERE created_at > NOW() - interval '24 hours'
     GROUP BY 1 ORDER BY c DESC`
  )
  const jobs = await query(
    `SELECT kind, status, COUNT(*)::int AS c
     FROM amazon_scan_jobs
     WHERE kind LIKE 'OXYLABS%'
     GROUP BY kind, status
     ORDER BY kind, status`
  )
  const jobsRecent = await query(
    `SELECT id::text, kind, status, created_at::text, keepa_candidate_id::text
     FROM amazon_scan_jobs
     WHERE kind LIKE 'OXYLABS%' AND created_at > NOW() - interval '24 hours'
     ORDER BY id DESC
     LIMIT 20`
  )
  const tel = await query(
    `SELECT collected_at::text, payload
     FROM keepa_collector_host_telemetry
     ORDER BY collected_at DESC
     LIMIT 3`
  )
  console.log(
    JSON.stringify(
      {
        now: now.rows[0],
        repair: repair.rows,
        obsCols: obsCols.rows.map(r => r.column_name),
        evalAll: dist.rows,
        evalLast1000Updated: recent.rows,
        evalLast1000Observed: recentObs.rows,
        windows: windows.rows[0],
        last1000meta: last1000meta.rows[0],
        candidates: cand.rows[0],
        candCodes24h: candCodes.rows,
        oxylabsJobs: jobs.rows,
        oxylabsRecent: jobsRecent.rows,
        telemetryKeys: tel.rows.map(r => ({
          collected_at: r.collected_at,
          keys: r.payload && typeof r.payload === "object" ? Object.keys(r.payload as object) : [],
          pending: (r.payload as Record<string, unknown>)?.observationOutboxPending,
          delivered: (r.payload as Record<string, unknown>)?.observationOutboxDelivered,
          version: (r.payload as Record<string, unknown>)?.collectorVersion,
        })),
      },
      null,
      2
    )
  )
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
