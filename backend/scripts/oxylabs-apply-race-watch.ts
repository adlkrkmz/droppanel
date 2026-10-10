import "dotenv/config"
import { query } from "../db/client"

async function main(): Promise<void> {
  const since = "2026-09-24 10:22:19+00"
  const jobs = await query(
    `SELECT status, COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND completed_at >= $1::timestamptz
     GROUP BY status`,
    [since]
  )
  const completed = await query(
    `SELECT COUNT(*)::int AS n, MIN(id)::text AS min_id, MAX(id)::text AS max_id
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND status = 'COMPLETED' AND completed_at >= $1::timestamptz`,
    [since]
  )
  const claimed = await query(
    `SELECT COUNT(*)::int AS n FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND status IN ('CLAIMED','RUNNING')`
  )
  const ops = await query(
    `SELECT status, COUNT(*)::int AS n,
            SUM(ebay_mutate_count)::int AS mutates,
            SUM(ebay_readback_count)::int AS reads
     FROM oxylabs_apply_operations
     WHERE created_at >= $1::timestamptz
     GROUP BY status`,
    [since]
  )
  const dupMutate = await query(
    `SELECT COUNT(*)::int AS n
     FROM oxylabs_apply_operations
     WHERE created_at >= $1::timestamptz AND ebay_mutate_count > 1`,
    [since]
  )
  const opsDetail = await query(
    `SELECT operation_key, job_id::text, catalog_state_id::text, action, status,
            ebay_mutate_count, ebay_readback_count, last_error
     FROM oxylabs_apply_operations
     WHERE created_at >= $1::timestamptz
     ORDER BY created_at
     LIMIT 40`,
    [since]
  )
  const policy = await query(
    `SELECT result_payload->'oxylabs_policy'->>'code' AS code, COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND status = 'COMPLETED' AND completed_at >= $1::timestamptz
     GROUP BY 1 ORDER BY n DESC`,
    [since]
  )
  const fails = await query(
    `SELECT COUNT(*)::int AS n FROM workspace_activity_events
     WHERE event_type = 'STOCK_ZERO_FAILED' AND created_at >= $1::timestamptz`,
    [since]
  )
  const zeros = await query(
    `SELECT COUNT(*)::int AS n FROM workspace_activity_events
     WHERE event_type = 'STOCK_ZEROED' AND created_at >= $1::timestamptz`,
    [since]
  )
  const jobFails = await query(
    `SELECT COALESCE(failure_code,'(null)') AS code, COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND completed_at >= $1::timestamptz AND failure_code IS NOT NULL
     GROUP BY 1`,
    [since]
  )
  const pending = await query(
    `SELECT COUNT(*)::int AS n FROM amazon_scan_jobs WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND status = 'PENDING'`
  )
  console.log(
    JSON.stringify(
      {
        jobs: jobs.rows,
        completed: completed.rows,
        inFlight: claimed.rows,
        pending: pending.rows,
        ops: ops.rows,
        dupMutate: dupMutate.rows,
        opsDetail: opsDetail.rows,
        policy: policy.rows,
        stockZeroFailed: fails.rows,
        stockZeroed: zeros.rows,
        jobFails: jobFails.rows,
      },
      null,
      2
    )
  )
}

void main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
