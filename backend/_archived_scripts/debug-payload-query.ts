import "dotenv/config"
import { query, closeDbPool } from "./db/client"

const WORKSPACE_ID = process.env.WORKSPACE_ID!

async function main() {
  // Exactly what ebayPayloadService sends — raw result
  const sql = `
    SELECT
      ap.id                    AS "poolId",
      ap.assigned_store_id     AS "assignedStoreId",
      ar.asin                  AS "asin",
      apc.price                AS "amazonPrice_raw",
      apc.price::text          AS "amazonPrice_text",
      ss.store_id              AS "ss_store_id",
      ss.workspace_id          AS "ss_workspace_id",
      ss.enabled               AS "settingsEnabled_raw",
      ss.enabled::text         AS "settingsEnabled_text",
      ss.profit_margin_percent AS "profitMarginPercent_raw",
      ss.profit_margin_percent::text AS "profitMarginPercent_text",
      ss.tax_estimate_percent  AS "taxEstimatePercent_raw",
      ss.ebay_fee_percent      AS "ebayFeePercent_raw"
    FROM asin_pool ap
    INNER JOIN asin_registry ar ON ar.id = ap.asin_registry_id
    INNER JOIN stores s ON s.id = ap.assigned_store_id
    LEFT JOIN amazon_product_cache apc ON apc.asin_registry_id = ap.asin_registry_id
    LEFT JOIN store_settings ss
      ON ss.workspace_id = ap.workspace_id
     AND ss.store_id = ap.assigned_store_id
    WHERE ap.workspace_id = $1
      AND ap.status = 'ready'
      AND ap.pipeline_stage = 'ai_generated'
      AND ap.assigned_store_id IS NOT NULL
      AND s.status = 'active'
    LIMIT 3
  `

  const result = await query(sql, [WORKSPACE_ID])
  console.log("Row count:", result.rows.length)
  console.log(JSON.stringify(result.rows, null, 2))

  // Also check store_settings directly
  const ss = await query(
    `SELECT * FROM store_settings WHERE workspace_id = $1 LIMIT 5`,
    [WORKSPACE_ID]
  )
  console.log("\nstore_settings rows:")
  console.log(JSON.stringify(ss.rows, null, 2))

  await closeDbPool()
}
main().catch(console.error)
