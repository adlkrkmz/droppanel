import "dotenv/config"
import { query } from "../db/client"

async function main(): Promise<void> {
  const asins = [
    "B08H4N3B8C","B08BG2FXBW","B08C7D3W6J","B08RZ4XSS2","B08XK97J33","B091SPGK1Z",
    "B097KCP35H","B09C1P1VBG","B09PLHQ1P6","B09X38Z8YZ","B09YLZRPTY","B0BBRCGBVL",
    "B0BFPVCLJ3","B0BGR6842K","B0BP9VWMPX","B0BPSR5MMP","B0BPXMJ14B","B0BQVSC7Y6",
    "B0BTGB25Y7","B0BV37VR5T",
  ]
  const ev = await query(
    `SELECT asin, catalog_state_id::text, ebay_item_id, event_type, created_at::text
     FROM workspace_activity_events
     WHERE created_at > TIMESTAMPTZ '2026-09-24 09:54:00+00'
       AND asin = ANY($1::text[])
       AND event_type IN ('STOCK_ZEROED','STOCK_ZERO_FAILED')
     ORDER BY asin, created_at`,
    [asins]
  )
  const cats = await query(
    `SELECT scs.id::text, ar.asin, scs.ebay_item_id, scs.ebay_quantity::text, scs.bot_zeroed_reason
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar ON ar.id = scs.asin_registry_id
     WHERE ar.asin = ANY($1::text[])
       AND scs.bot_zeroed_at > TIMESTAMPTZ '2026-09-24 09:54:00+00'`,
    [asins]
  )
  console.log(JSON.stringify({ ev: ev.rows, cats: cats.rows }, null, 2))
}

void main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
