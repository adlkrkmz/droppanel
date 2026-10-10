import { db as pool } from '../../db/client'
import { getSettingsByStore } from '../storeSettings/storeSettingsRepository'
import { getStoreByCode } from '../stores/storeRepository'
import type { VariationCaptureData, VariationProductRow } from './variationTypes'
import { calculateListingPrice } from '../pricing/pricingService'

function buildSku(asin: string, storeCode: string, aspectValue: string): string {
  const clean = aspectValue.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase()
  return `DPV${asin}${storeCode}${clean}`
}

export async function extractVariationProduct(
  data: VariationCaptureData,
  workspaceId: string
): Promise<{ variationProductId: number }> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    console.log('[VariationExtract] Starting, asin:', data.asin, 'variations:', data.variations?.length)

    const productRes = await client.query<VariationProductRow>(
      `INSERT INTO variation_products
         (workspace_id, asin, source, title, brand, description, images, video_url, category, store_code, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
       ON CONFLICT (asin, store_code) DO UPDATE SET
         title = EXCLUDED.title,
         brand = EXCLUDED.brand,
         description = EXCLUDED.description,
         images = EXCLUDED.images,
         status = 'pending',
         updated_at = NOW()
       RETURNING id`,
      [
        workspaceId,
        data.asin,
        data.source,
        data.title,
        data.brand,
        null,
        JSON.stringify(data.images),
        data.videoUrl,
        null,
        data.storeCode,
      ]
    )

    const variationProductId = productRes.rows[0]?.id
    if (!variationProductId) throw new Error('variation_products INSERT failed')

    for (const item of data.variations) {
      const sku = item.sku ?? buildSku(data.asin, data.storeCode, item.aspectValue)
      // fiyat hesaplama — store_settings'ten markup ve ebay fee kullan
      const store = await getStoreByCode(workspaceId, data.storeCode)
      const storeSettings = store ? await getSettingsByStore(workspaceId, store.id) : null
      if (!storeSettings?.enabled) throw new Error(`PRICING_SETTINGS_UNAVAILABLE: store=${data.storeCode}`)
      const price = calculateListingPrice({
        amazonCost: item.price,
        pricingMode: storeSettings.pricingMode,
        percentageNetProfitPercent: storeSettings.percentageNetProfitPercent,
        tieredProfitOverrides: storeSettings.tieredProfitOverrides,
      }).calculatedListingPrice

      await client.query(
        `INSERT INTO variation_items
           (variation_product_id, sku, aspect_name, aspect_value, price, quantity, images, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
         ON CONFLICT (sku) DO UPDATE SET
           variation_product_id = EXCLUDED.variation_product_id,
           aspect_value = EXCLUDED.aspect_value,
           price = EXCLUDED.price,
           updated_at = NOW()`,
        [
          variationProductId,
          sku,
          item.aspectName,
          item.aspectValue,
          price.toFixed(2),
          item.quantity,
          JSON.stringify(item.images.length > 0 ? item.images : data.images),
        ]
      )
      console.log('[VariationExtract] Item inserted, sku:', sku, 'aspectValue:', item.aspectValue)
    }

    console.log('[VariationExtract] COMMIT, variationProductId:', variationProductId)
    await client.query('COMMIT')
    return { variationProductId }
  } catch (e) {
    console.error('[VariationExtract] ROLLBACK, error:', e)
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
