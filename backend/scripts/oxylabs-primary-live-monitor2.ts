import "dotenv/config"
import { query } from "../db/client"

async function main(): Promise<void> {
  const listings = await query(
    `SELECT j.id::text AS job_id, j.asin,
            result_payload->'oxylabs_policy'->>'code' AS code,
            result_payload->'oxylabs_policy'->>'evidenceCode' AS evidence,
            scs.id::text AS catalog_id,
            scs.ebay_item_id,
            scs.ebay_quantity::text AS qty,
            scs.ebay_price::text,
            scs.bot_zeroed_reason,
            scs.last_verified_decision
     FROM amazon_scan_jobs j
     JOIN global_asin_consumers c ON c.global_asin_id = j.global_asin_id
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     WHERE j.id BETWEEN 6941 AND 6960
     ORDER BY j.id, scs.id`
  )
  const listingsAll = await query(
    `SELECT j.id::text AS job_id, j.asin,
            result_payload->'oxylabs_policy'->>'code' AS code,
            scs.id::text AS catalog_id,
            scs.ebay_item_id,
            scs.ebay_quantity::text AS qty,
            scs.bot_zeroed_reason
     FROM amazon_scan_jobs j
     LEFT JOIN global_asin_consumers c ON c.global_asin_id = j.global_asin_id
     LEFT JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     WHERE j.id BETWEEN 6941 AND 6960
     ORDER BY j.id`
  )
  const dist = await query(
    `SELECT result_payload->'oxylabs_policy'->>'code' AS code,
            result_payload->'oxylabs_policy'->>'evidenceCode' AS evidence,
            COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE id BETWEEN 6941 AND 6960
     GROUP BY 1, 2 ORDER BY n DESC`
  )
  const later = await query(
    `SELECT result_payload->'oxylabs_policy'->>'code' AS code, COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND id > 6940 AND status = 'COMPLETED'
     GROUP BY 1 ORDER BY n DESC`
  )
  const failed = await query(
    `SELECT event_type, COUNT(*)::int AS n
     FROM workspace_activity_events
     WHERE created_at > TIMESTAMPTZ '2026-09-24 09:54:00+00'
       AND event_type IN ('STOCK_ZEROED','STOCK_ZERO_FAILED')
     GROUP BY 1`
  )
  const failDetail = await query(
    `SELECT catalog_state_id::text, asin, ebay_item_id, event_type, message, created_at::text
     FROM workspace_activity_events
     WHERE event_type = 'STOCK_ZERO_FAILED'
       AND created_at > TIMESTAMPTZ '2026-09-24 09:54:00+00'
     ORDER BY created_at`
  )
  const priceChange = await query(
    `SELECT COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND id > 6940 AND status = 'COMPLETED'
       AND result_payload->'oxylabs_policy'->>'code' IN ('PRICE_CHANGE','WOULD_APPLY_PRICE')`
  )
  const notPrimeFba = await query(
    `SELECT result_payload->'oxylabs_policy'->>'code' AS code, COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND id > 6940 AND status = 'COMPLETED'
       AND result_payload->'oxylabs_policy'->>'code' IN ('NOT_PRIME','NOT_FBA')
     GROUP BY 1`
  )
  const httpish = await query(
    `SELECT status, failure_code, COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND id > 6940
       AND (failure_code IS NOT NULL OR status IN ('FAILED','RETRYABLE'))
     GROUP BY 1, 2`
  )
  const workers = await query(
    `SELECT kind, status, COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind LIKE 'OXYLABS%' AND created_at > TIMESTAMPTZ '2026-09-24 09:54:00+00'
     GROUP BY 1, 2`
  )
  console.log(
    JSON.stringify(
      {
        listings: listings.rows,
        listingsAll: listingsAll.rows,
        dist20: dist.rows,
        later,
        failed: failed.rows,
        failDetail: failDetail.rows,
        priceChange: priceChange.rows,
        notPrimeFba: notPrimeFba.rows,
        httpish: httpish.rows,
        workers: workers.rows,
      },
      null,
      2
    )
  )
}

void main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
