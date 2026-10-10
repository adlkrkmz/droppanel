import "dotenv/config"
import { query } from "../db/client"

async function main(): Promise<void> {
  const scs = await query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'store_catalog_state'
       AND column_name ILIKE '%price%'
     ORDER BY 1`
  )
  const obs = await query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'keepa_asin_last_observations'
     ORDER BY ordinal_position`
  )
  const uniq = await query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'keepa_verify_candidates'`
  )
  const start = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM keepa_asin_last_observations) AS last_obs,
       (SELECT COUNT(*)::int FROM keepa_asin_last_observations WHERE evaluation_code = 'SNAPSHOT_RECORDED') AS snapshot_recorded,
       (SELECT COUNT(*)::int FROM keepa_asin_last_observations WHERE evaluation_code LIKE 'BASELINE_%') AS already_baseline,
       (SELECT COUNT(*)::int FROM keepa_verify_candidates) AS candidates,
       (SELECT COUNT(*)::int FROM amazon_scan_jobs WHERE kind = 'OXYLABS_PRODUCT_PRIMARY') AS primary_jobs,
       (SELECT COUNT(*)::int FROM amazon_scan_jobs WHERE kind = 'OXYLABS_PRODUCT_CONFIRM') AS confirm_jobs,
       (SELECT COUNT(*)::int FROM oxylabs_verify_call_reservations) AS reservations,
       (SELECT COUNT(*)::int FROM amazon_scan_jobs WHERE kind = 'OXYLABS_PRODUCT_PRIMARY'
          AND status IN ('PENDING','CLAIMED','RUNNING','WAITING_FOR_WORKER','RETRYABLE')) AS primary_active`
  )
  const sample = await query(
    `SELECT pg_typeof(source_price)::text AS t, source_price::text AS v
     FROM store_catalog_state WHERE source_price IS NOT NULL LIMIT 3`
  )
  console.log(JSON.stringify({ scs: scs.rows, obs: obs.rows, uniq: uniq.rows, start: start.rows[0], sample: sample.rows }, null, 2))
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
