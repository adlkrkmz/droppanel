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

export type ImportEbayListingsResult = {
  /** Toplu offer / Trading satır sayısı */
  offerRows: number
  imported:  number
  errors:    number
  /** REST yolunda offer yok sayısı (toplu akışta genelde 0) */
  skippedNoOffer: number
}

/**
 * 1) GET /sell/inventory/v1/offer?limit=100 (SKU yok) — toplu
 * 2) İlk yanıt 400 ise Trading GetMyeBaySelling
 * 3) store_catalog_state + listing_history (Trading'de offer_id boş olabilir)
 */
export async function importExistingEbayListings(
  storeId: number,
  storeCode: string
): Promise<ImportEbayListingsResult> {
  const storeRes = await query<{ workspace_id: string; store_code: string }>(
    `SELECT workspace_id, store_code FROM stores WHERE id = $1 LIMIT 1`,
    [storeId]
  )
  const storeRow = storeRes.rows[0]
  if (!storeRow) {
    console.warn(`[EbayImport] No store found for id=${storeId}`)
    return { offerRows: 0, imported: 0, errors: 0, skippedNoOffer: 0 }
  }
  if (storeRow.store_code !== storeCode) {
    throw new Error(
      `[EbayImport] store_code mismatch: id=${storeId} has "${storeRow.store_code}", expected "${storeCode}"`
    )
  }

  const workspaceId = storeRow.workspace_id
  const token         = await getValidAccessToken(workspaceId, storeCode, false)
  const sandbox       = (process.env.EBAY_SANDBOX ?? "true") !== "false"
  const client        = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })

  const rows = await client.getAllOffersForImportBulk()
  let imported       = 0
  let errors         = 0
  let skippedNoOffer = 0

  for (const row of rows) {
    const sku = row.sku?.trim() ?? ""
    if (!sku) {
      skippedNoOffer++
      continue
    }

    const offerIdDb = row.offerId?.trim() ? row.offerId.trim() : null
    const listingId = row.listingId?.trim() ? row.listingId.trim() : null

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
           ebay_price_synced_at,
           current_status,
           listed_at,
           last_seen_live_at,
           last_sync_at,
           source_of_truth,
           created_at,
           updated_at
         )
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, NOW(), 'live', NOW(), NOW(), NOW(), 'ebay_import', NOW(), NOW())
         ON CONFLICT (workspace_id, internal_sku)
         DO UPDATE SET
           ebay_item_id          = COALESCE(EXCLUDED.ebay_item_id, store_catalog_state.ebay_item_id),
           ebay_offer_id         = COALESCE(EXCLUDED.ebay_offer_id, store_catalog_state.ebay_offer_id),
           ebay_price            = EXCLUDED.ebay_price,
           ebay_quantity         = EXCLUDED.ebay_quantity,
           ebay_price_synced_at  = NOW(),
           current_status        = 'live',
           last_seen_live_at     = NOW(),
           last_sync_at          = NOW(),
           updated_at            = NOW()`,
        [
          workspaceId,
          storeId,
          sku,
          listingId,
          offerIdDb,
          row.price,
          row.availableQuantity,
        ]
      )

      await query(
        `INSERT INTO listing_history (
           workspace_id,
           store_id,
           asin_registry_id,
           internal_sku,
           ebay_item_id,
           ebay_offer_id,
           price_snapshot,
           status,
           listed_at,
           created_at,
           updated_at
         )
         VALUES ($1, $2, NULL, $3, $4, $5, $6, 'live', NOW(), NOW(), NOW())`,
        [
          workspaceId,
          storeId,
          sku,
          listingId,
          offerIdDb,
          row.price,
        ]
      )
      imported++
    } catch (e) {
      errors++
      console.error(`[EbayImport] Failed sku=${sku}:`, e)
    }
  }

  console.log(
    `[EbayImport] store=${storeCode} offerRows=${rows.length} imported=${imported} ` +
      `skippedNoOffer=${skippedNoOffer} errors=${errors}`
  )
  return { offerRows: rows.length, imported, errors, skippedNoOffer }
}
