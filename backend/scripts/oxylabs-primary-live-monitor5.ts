import "dotenv/config"
import { query } from "../db/client"

async function main(): Promise<void> {
  const rows = await query(
    `SELECT scs.id::text, scs.ebay_item_id, scs.ebay_quantity::text, scs.bot_zeroed_reason,
            scs.bot_zeroed_at::text, scs.internal_sku, ar.asin AS registry_asin
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar ON ar.id = scs.asin_registry_id
     WHERE scs.bot_zeroed_at >= TIMESTAMPTZ '2026-09-24 09:54:00+00'
       AND scs.bot_zeroed_at < TIMESTAMPTZ '2026-09-24 09:57:10+00'
     ORDER BY scs.bot_zeroed_at`
  )
  const sku = await query(
    `SELECT id::text, kind, asin, status, completed_at::text,
            result_payload->'oxylabs_policy'->>'code' AS code
     FROM amazon_scan_jobs WHERE id BETWEEN 6941 AND 6960 ORDER BY id`
  )
  console.log(JSON.stringify({ botWindow: rows.rows, jobs: sku.rows }, null, 2))
}

void main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
