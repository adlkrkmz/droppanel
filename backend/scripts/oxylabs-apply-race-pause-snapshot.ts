import "dotenv/config"
import { query } from "../db/client"
import { loadOxylabsVerifyConfig } from "../modules/oxylabsVerify/oxylabsVerifyConfig"

async function main(): Promise<void> {
  const cfg = loadOxylabsVerifyConfig()
  const jobs = await query(
    `SELECT status, COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND id > 6940
     GROUP BY status ORDER BY n DESC`
  )
  const outbox = await query(
    `SELECT o.status, COUNT(*)::int AS n
     FROM amazon_scan_apply_outbox o
     JOIN amazon_scan_jobs j ON j.id = o.job_id
     WHERE j.kind = 'OXYLABS_PRODUCT_PRIMARY'
     GROUP BY o.status ORDER BY n DESC`
  )
  const locked = await query(
    `SELECT COUNT(*)::int AS n
     FROM amazon_scan_apply_outbox o
     JOIN amazon_scan_jobs j ON j.id = o.job_id
     WHERE j.kind = 'OXYLABS_PRODUCT_PRIMARY'
       AND o.locked_until IS NOT NULL AND o.locked_until > NOW()`
  )
  const claimed = await query(
    `SELECT COUNT(*)::int AS n, MAX(id)::text AS max_id
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY'
       AND status IN ('CLAIMED','RUNNING')`
  )
  const recentCompleted = await query(
    `SELECT COUNT(*)::int AS n, MAX(id)::text AS max_id, MAX(completed_at)::text AS last_completed
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND status = 'COMPLETED' AND id > 6940`
  )
  const reservations = await query(`SELECT COUNT(*)::int AS n FROM oxylabs_verify_call_reservations`)
  const canary = await query(`SELECT success_result_count FROM oxylabs_verify_canary_state WHERE id = 1`)
  console.log(
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        cfg,
        jobs: jobs.rows,
        outbox: outbox.rows,
        lockedOutbox: locked.rows,
        inFlightClaims: claimed.rows,
        recentCompleted: recentCompleted.rows,
        reservations: reservations.rows,
        canary: canary.rows,
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
