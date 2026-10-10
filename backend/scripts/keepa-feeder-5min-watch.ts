import "dotenv/config"
import { query } from "../db/client"

const T0 = process.env.WATCH_T0 ?? new Date().toISOString()

async function snap(label: string) {
  const one = async (sql: string, params: unknown[] = []) =>
    (await query<{ c: string }>(sql, params)).rows[0]?.c ?? "0"
  const workers = await query<{ worker_id: string; status: string; uptime: unknown }>(
    `SELECT worker_id, status, host_telemetry->>'uptimeSec' AS uptime
     FROM amazon_scan_worker_heartbeat
     WHERE worker_id IN ('amazon-keepa-verify-primary-A','amazon-keepa-verify-confirm-C')`
  )
  const collector = await query<{ version: string | null; collected_at: Date }>(
    `SELECT payload->>'version' AS version, collected_at FROM keepa_collector_host_telemetry
     ORDER BY updated_at DESC LIMIT 1`
  )
  const dup = await one(
    `SELECT COUNT(*)::text AS c FROM (
       SELECT keepa_candidate_id, COUNT(*) AS n
       FROM amazon_scan_jobs
       WHERE kind = 'KEEPA_VERIFY_PRIMARY'
         AND status IN ('PENDING','CLAIMED','RUNNING','WAITING_FOR_WORKER','RETRYABLE')
         AND keepa_candidate_id IS NOT NULL
       GROUP BY keepa_candidate_id
       HAVING COUNT(*) > 1
     ) d`
  )
  const cross = await one(
    `SELECT COUNT(*)::text AS c FROM amazon_scan_jobs
     WHERE created_at >= $1::timestamptz
       AND (
         (kind = 'KEEPA_VERIFY_PRIMARY' AND worker_id LIKE 'amazon-keepa-verify-confirm-%')
         OR (kind = 'KEEPA_VERIFY_CONFIRM' AND worker_id LIKE 'amazon-keepa-verify-primary-%')
       )`,
    [T0]
  )
  const stale = await one(
    `SELECT COUNT(*)::text AS c
     FROM amazon_scan_apply_outbox o
     JOIN amazon_scan_jobs j ON j.id = o.job_id
     WHERE o.created_at >= $1::timestamptz AND o.last_error ILIKE '%STALE%'`,
    [T0]
  )
  return {
    label,
    at: new Date().toISOString(),
    orphanNoActive: await one(
      `SELECT COUNT(*)::text AS c FROM keepa_verify_candidates c
       WHERE c.status IN ('PENDING','RETRYABLE')
         AND NOT EXISTS (
           SELECT 1 FROM amazon_scan_jobs j
           WHERE j.keepa_candidate_id = c.id
             AND j.kind IN ('KEEPA_VERIFY_PRIMARY','KEEPA_VERIFY_CONFIRM')
             AND j.status IN ('PENDING','CLAIMED','RUNNING','WAITING_FOR_WORKER','RETRYABLE')
         )`
    ),
    activePrimary: await one(
      `SELECT COUNT(*)::text AS c FROM amazon_scan_jobs
       WHERE kind='KEEPA_VERIFY_PRIMARY'
         AND status IN ('PENDING','CLAIMED','RUNNING','WAITING_FOR_WORKER','RETRYABLE')`
    ),
    pendingPrimary: await one(
      `SELECT COUNT(*)::text AS c FROM amazon_scan_jobs WHERE kind='KEEPA_VERIFY_PRIMARY' AND status='PENDING'`
    ),
    primarySince: await query<{ bucket: string; c: string }>(
      `SELECT COALESCE(result_payload->'metadata'->>'publicStatus','NONE') AS bucket, COUNT(*)::text AS c
       FROM amazon_scan_jobs
       WHERE kind='KEEPA_VERIFY_PRIMARY' AND status='COMPLETED' AND completed_at >= $1::timestamptz
       GROUP BY 1`,
      [T0]
    ).then(r => r.rows),
    confirmSince: await query<{ bucket: string; c: string }>(
      `SELECT status AS bucket, COUNT(*)::text AS c FROM amazon_scan_jobs
       WHERE kind='KEEPA_VERIFY_CONFIRM' AND created_at >= $1::timestamptz
       GROUP BY 1`,
      [T0]
    ).then(r => r.rows),
    confirmCompleted: await query<{ public_status: string | null; c: string }>(
      `SELECT result_payload->'metadata'->>'publicStatus' AS public_status, COUNT(*)::text AS c
       FROM amazon_scan_jobs
       WHERE kind='KEEPA_VERIFY_CONFIRM' AND status='COMPLETED' AND completed_at >= $1::timestamptz
       GROUP BY 1`,
      [T0]
    ).then(r => r.rows),
    baselineMatched: await one(
      `SELECT COUNT(*)::text AS c FROM keepa_verify_candidates
       WHERE status='MATCHED' AND updated_at >= $1::timestamptz
         AND UPPER(COALESCE(snapshot->>'purpose','')) = 'TRUSTED_BASELINE'`,
      [T0]
    ),
    baselineRetry: await one(
      `SELECT COUNT(*)::text AS c FROM keepa_verify_candidates
       WHERE status='RETRYABLE' AND updated_at >= $1::timestamptz
         AND UPPER(COALESCE(snapshot->>'evaluationCode','')) = 'NO_TRUSTED_REFERENCE'`,
      [T0]
    ),
    trustedTasksSince: await one(
      `SELECT COUNT(*)::text AS c FROM amazon_price_verification_tasks
       WHERE completed_at >= $1::timestamptz AND status='COMPLETED'
         AND COALESCE(result_metadata->>'purpose','') IN ('TRUSTED_BASELINE','VERIFY')`,
      [T0]
    ),
    keepaDirectTasks: await one(
      `SELECT COUNT(*)::text AS c FROM amazon_price_verification_tasks
       WHERE completed_at >= $1::timestamptz AND COALESCE(result_metadata->>'confirmationSource','') = 'KEEPA'`,
      [T0]
    ),
    workers: workers.rows,
    collector: collector.rows[0] ?? null,
    duplicateActivePrimary: dup,
    crossKind: cross,
    stale: stale,
  }
}

async function main() {
  const t0 = await snap("t0")
  console.log(JSON.stringify(t0, null, 2))
  await new Promise(r => setTimeout(r, 5 * 60 * 1000))
  const t1 = await snap("t1")
  console.log(JSON.stringify(t1, null, 2))
}

main().then(() => process.exit(0)).catch(e => {
  console.error(e)
  process.exit(1)
})
