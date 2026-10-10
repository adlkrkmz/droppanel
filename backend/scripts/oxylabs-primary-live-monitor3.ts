import "dotenv/config"
import { query } from "../db/client"

async function main(): Promise<void> {
  const failQty = await query(
    `SELECT id::text, ebay_item_id, ebay_quantity::text, bot_zeroed_at::text, bot_zeroed_reason, last_verified_decision
     FROM store_catalog_state WHERE id IN (2489, 4120, 13573, 7411, 11015, 10323, 2793, 6142, 7198)`
  )
  const zeros = await query(
    `SELECT DISTINCT ON (asin) asin, catalog_state_id::text, ebay_item_id, event_type, created_at::text
     FROM workspace_activity_events
     WHERE created_at > TIMESTAMPTZ '2026-09-24 09:54:00+00'
       AND event_type IN ('STOCK_ZEROED','STOCK_ZERO_FAILED')
       AND asin IN (
         'B08H4N3B8C','B08BG2FXBW','B08C7D3W6J','B08RZ4XSS2','B08XK97J33','B091SPGK1Z',
         'B097KCP35H','B09C1P1VBG','B09PLHQ1P6','B09X38Z8YZ','B09YLZRPTY','B0BBRCGBVL',
         'B0BFPVCLJ3','B0BGR6842K','B0BP9VWMPX','B0BPSR5MMP','B0BPXMJ14B','B0BQVSC7Y6',
         'B0BTGB25Y7','B0BV37VR5T','B07GCJY7XG','B0881XRXKN','B08DN57GYK','B08FD8P2WL','B08FX81Y7Y'
       )
     ORDER BY asin, created_at DESC`
  )
  const counts = await query(
    `SELECT COUNT(*) FILTER (WHERE status='PENDING')::int AS pending,
            COUNT(*) FILTER (WHERE status='COMPLETED')::int AS completed,
            COUNT(*) FILTER (WHERE status='CLAIMED')::int AS claimed,
            COUNT(*) FILTER (WHERE status='RUNNING')::int AS running
     FROM amazon_scan_jobs
     WHERE kind='OXYLABS_PRODUCT_PRIMARY' AND id > 6940`
  )
  const reservations = await query(`SELECT COUNT(*)::int AS n FROM oxylabs_verify_call_reservations`)
  const canary = await query(`SELECT success_result_count FROM oxylabs_verify_canary_state WHERE id=1`)
  console.log(JSON.stringify({ failQty: failQty.rows, zeros: zeros.rows, counts: counts.rows, reservations: reservations.rows, canary: canary.rows }, null, 2))
}

void main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
