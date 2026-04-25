import { query } from "../../db/client"
import { getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import { EbayApiClient } from "../ebay/ebayApiClient"

export type SyncStoreFromTradingResult = {
  tradingRows: number
  upserted: number
  errors: number
}

/**
 * GetMyeBaySelling (Trading) ile aktif ilanları çeker; store_catalog_state upsert.
 * internal_sku = SKU veya CustomLabel (varsa), yoksa ItemID.
 */
export async function syncStoreFromTrading(
  storeId: number,
  storeCode: string
): Promise<SyncStoreFromTradingResult> {
  const storeRes = await query<{ workspace_id: string; store_code: string }>(
    `SELECT workspace_id, store_code FROM stores WHERE id = $1 LIMIT 1`,
    [storeId]
  )
  const storeRow = storeRes.rows[0]
  if (!storeRow) {
    console.warn(`[EbayTradingSync] No store found for id=${storeId}`)
    return { tradingRows: 0, upserted: 0, errors: 0 }
  }
  if (storeRow.store_code !== storeCode) {
    throw new Error(
      `[EbayTradingSync] store_code mismatch: id=${storeId} has "${storeRow.store_code}", expected "${storeCode}"`
    )
  }

  const workspaceId = storeRow.workspace_id
  const token = await getValidAccessToken(workspaceId, storeCode, false)
  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
  const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })

  const tradingRows = await client.fetchGetMyeBaySellingAllPages()
  let upserted = 0
  let errors = 0

  for (const row of tradingRows) {
    const internalSku = (row.sku ?? "").trim()
    const itemId = row.listingId?.trim() ? row.listingId.trim() : null
    if (!internalSku) {
      errors++
      continue
    }

    try {
      await query(
        `INSERT INTO store_catalog_state (
           workspace_id,
           store_id,
           asin_registry_id,
           internal_sku,
           ebay_item_id,
           ebay_offer_id,
           ebay_price,
           ebay_quantity,
           ebay_title,
           image_url,
           ebay_price_synced_at,
           current_status,
           listed_at,
           last_seen_live_at,
           last_sync_at,
           source_of_truth,
           created_at,
           updated_at
         )
         VALUES ($1, $2, NULL, $3, $4, NULL, $5, $6, $7, $8, NOW(), 'live', NOW(), NOW(), NOW(), 'ebay_trading_sync', NOW(), NOW())
         ON CONFLICT (workspace_id, internal_sku)
         DO UPDATE SET
           ebay_item_id         = EXCLUDED.ebay_item_id,
           ebay_price           = EXCLUDED.ebay_price,
           ebay_quantity        = EXCLUDED.ebay_quantity,
           ebay_title           = EXCLUDED.ebay_title,
           image_url            = EXCLUDED.image_url,
           ebay_price_synced_at = NOW(),
           current_status       = 'live',
           last_seen_live_at    = NOW(),
           last_sync_at         = NOW(),
           updated_at           = NOW()`,
        [
          workspaceId,
          storeId,
          internalSku,
          itemId,
          row.currentPrice ?? row.price,
          row.quantityAvailable ?? row.availableQuantity,
          row.title ?? null,
          row.imageUrl ?? null,
        ]
      )
      upserted++
    } catch (e) {
      errors++
      console.error(`[EbayTradingSync] Failed internal_sku=${internalSku}:`, e)
    }
  }

  console.log(
    `[EbayTradingSync] store=${storeCode} tradingRows=${tradingRows.length} upserted=${upserted} errors=${errors}`
  )
  return { tradingRows: tradingRows.length, upserted, errors }
}

export async function syncAllStores(): Promise<void> {
  const result = await query<{ id: number; store_code: string }>(
    `SELECT id, store_code FROM stores WHERE status = 'active'`
  )
  for (const store of result.rows) {
    await syncStoreFromTrading(store.id, store.store_code)
  }
}
