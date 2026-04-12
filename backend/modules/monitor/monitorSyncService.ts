import { query } from "../../db/client"
import { getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import { EbayApiClient } from "../ebay/ebayApiClient"

export async function syncEbayPricesForStore(storeId: number, storeCode: string): Promise<void> {
  try {
    const storeRes = await query<{ workspace_id: string }>(
      `SELECT workspace_id FROM stores WHERE id = $1 LIMIT 1`,
      [storeId]
    )
    const workspaceId = storeRes.rows[0]?.workspace_id
    if (!workspaceId) {
      console.warn(`[EbaySync] No store found for id=${storeId}`)
      return
    }

    const token = await getValidAccessToken(workspaceId, storeCode, false)
    const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
    const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })

    const result = await query<{ id: number; ebay_offer_id: string; internal_sku: string }>(
      `SELECT id, ebay_offer_id, internal_sku
       FROM store_catalog_state
       WHERE store_id = $1 AND workspace_id = $2
         AND ebay_offer_id IS NOT NULL AND trim(ebay_offer_id) <> ''`,
      [storeId, workspaceId]
    )

    const BATCH_SIZE = 20
    const rows = result.rows

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      await Promise.all(batch.map(async (row) => {
        try {
          const offer = await client.getOfferById(row.ebay_offer_id.trim())
          if (!offer) return
          await query(
            `UPDATE store_catalog_state
             SET ebay_price = $1,
                 ebay_quantity = $2,
                 ebay_price_synced_at = NOW(),
                 updated_at = NOW()
             WHERE id = $3`,
            [offer.price, offer.availableQuantity, row.id]
          )
        } catch (e) {
          console.error(`[EbaySync] Failed for offer ${row.ebay_offer_id}:`, e)
        }
      }))

      if (i + BATCH_SIZE < rows.length) {
        await new Promise(r => setTimeout(r, 500))
      }
    }

    console.log(`[EbaySync] Synced ${rows.length} offers for store ${storeCode}`)
  } catch (e) {
    console.error(`[EbaySync] Store ${storeCode} sync failed:`, e)
  }
}

export async function syncAllStores(): Promise<void> {
  const result = await query<{ id: number; store_code: string }>(
    `SELECT id, store_code FROM stores WHERE status = 'active'`
  )
  for (const store of result.rows) {
    await syncEbayPricesForStore(store.id, store.store_code)
  }
}
