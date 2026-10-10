import "dotenv/config"
import { query } from "../db/client"

async function main(): Promise<void> {
  const completed = await query<{
    id: string
    asin: string
    status: string
    completed_at: string | null
    failure_code: string | null
    http: string | null
    policy_code: string | null
    policy_class: string | null
    policy_evidence: string | null
    policy_audit: string | null
    mutations: string | null
  }>(
    `SELECT id::text, asin, status, completed_at::text, failure_code,
            result_payload->>'status_code' AS http,
            result_payload->'oxylabs_policy'->>'code' AS policy_code,
            result_payload->'oxylabs_policy'->>'productClass' AS policy_class,
            result_payload->'oxylabs_policy'->>'evidenceCode' AS policy_evidence,
            result_payload->'oxylabs_policy'->>'followReason' AS policy_audit,
            result_payload->'oxylabs_policy'->>'mutationsEnabled' AS mutations
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND id > 6940 AND status = 'COMPLETED'
     ORDER BY id ASC
     LIMIT 20`
  )
  const statusCounts = await query(
    `SELECT status, COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND id > 6940
     GROUP BY status ORDER BY n DESC`
  )
  const failCodes = await query(
    `SELECT COALESCE(failure_code, '(null)') AS code, COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND id > 6940 AND status <> 'PENDING'
     GROUP BY 1 ORDER BY n DESC`
  )
  const confirm = await query(
    `SELECT status, COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_CONFIRM'
     GROUP BY status`
  )
  const reservations = await query(`SELECT COUNT(*)::int AS n FROM oxylabs_verify_call_reservations`)
  const canary = await query(`SELECT success_result_count FROM oxylabs_verify_canary_state WHERE id = 1`)
  const zeros = await query(
    `SELECT catalog_state_id::text, asin, ebay_item_id, event_type, created_at::text
     FROM workspace_activity_events
     WHERE event_type IN ('STOCK_ZEROED','STOCK_ZERO_FAILED')
       AND created_at > NOW() - INTERVAL '2 hours'
     ORDER BY created_at DESC
     LIMIT 40`
  )
  const botZeroed = await query(
    `SELECT id::text, ebay_item_id, ebay_quantity::text, bot_zeroed_reason, last_verified_decision,
            source_price::text, ebay_price::text, bot_zeroed_at::text
     FROM store_catalog_state
     WHERE bot_zeroed_at > TIMESTAMPTZ '2026-09-24 09:54:00+00'
     ORDER BY bot_zeroed_at ASC
     LIMIT 40`
  )
  const policyDist = await query(
    `SELECT result_payload->'oxylabs_policy'->>'code' AS code,
            result_payload->'oxylabs_policy'->>'productClass' AS class,
            COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND id > 6940 AND status = 'COMPLETED'
     GROUP BY 1, 2
     ORDER BY n DESC`
  )
  const listingAfter = await query(
    `SELECT j.id::text AS job_id, j.asin, scs.id::text AS catalog_id, scs.ebay_item_id,
            scs.ebay_quantity::text, scs.ebay_price::text, scs.bot_zeroed_reason,
            scs.last_verified_decision
     FROM amazon_scan_jobs j
     JOIN global_asin_consumers c ON c.global_asin_id = j.global_asin_id
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     WHERE j.kind = 'OXYLABS_PRODUCT_PRIMARY' AND j.id > 6940 AND j.status = 'COMPLETED'
     ORDER BY j.id ASC
     LIMIT 40`
  )
  console.log(
    JSON.stringify(
      {
        completed20: completed.rows,
        statusCounts: statusCounts.rows,
        failCodes: failCodes.rows,
        confirm: confirm.rows,
        reservations: reservations.rows,
        canary: canary.rows,
        recentZeroEvents: zeros.rows,
        botZeroed: botZeroed.rows,
        policyDist: policyDist.rows,
        listingAfter: listingAfter.rows,
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
