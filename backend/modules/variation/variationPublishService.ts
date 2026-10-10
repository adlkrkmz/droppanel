import { db as pool } from '../../db/client'
import { getValidAccessToken } from '../ebayOAuth/ebayOAuthService'
import { processAndUploadImages } from '../imageProcessor/imageProcessorService'
import { EbayApiClient } from '../ebay/ebayApiClient'
import {
  ensureWarehouseMerchantLocationOnEbay,
  merchantAddressFromStoreRow,
  resolveMerchantLocationKey,
} from '../ebay/ebayLocationService'
import type { EbayCreateOfferRequest } from '../ebay/ebayApiTypes'
import { getSettingsByStore } from '../storeSettings/storeSettingsRepository'
import { getStoreByCode } from '../stores/storeRepository'
import { alertPublishFailed } from '../notifications/telegramService'
import { generateVariationListing } from './variationAiService'

const DEFAULT_MARKETPLACE = 'EBAY_US'

function getWorkspaceId(): string {
  const id = process.env.WORKSPACE_ID
  if (!id) throw new Error('WORKSPACE_ID is not defined')
  return id
}

function parseOfferIdFromCreateOfferError(message: string): string | null {
  const idx = message.indexOf('{')
  if (idx >= 0) {
    try {
      const o = JSON.parse(message.slice(idx)) as {
        errors?: { parameters?: { name?: string; value?: string }[] }[]
      }
      for (const err of o.errors ?? []) {
        for (const p of err.parameters ?? []) {
          const n = String(p.name ?? '').toLowerCase()
          const v = String(p.value ?? '').trim()
          if ((n === 'offerid' || n === 'offer_id') && v.length > 0) return v
        }
      }
    } catch {
      /* ignore */
    }
  }
  const m = message.match(/"offerId"\s*:\s*"(\d+)"/i)
  if (m?.[1]) return m[1]
  return null
}

function isOfferAlreadyExistsError(message: string): boolean {
  return /Offer entity already exists/i.test(message)
}

async function createOfferOrExisting(
  client: EbayApiClient,
  offerBody: EbayCreateOfferRequest,
  sku: string
): Promise<{ offerId: string; fromDuplicate: boolean }> {
  try {
    const r = await client.createOffer(offerBody)
    return { offerId: r.offerId, fromDuplicate: false }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!isOfferAlreadyExistsError(msg)) throw e

    const fromErr = parseOfferIdFromCreateOfferError(msg)
    if (fromErr) {
      console.log(
        `  [VariationPublish] createOffer duplicate — existing offerId=${fromErr} (will updateOffer)`
      )
      return { offerId: fromErr, fromDuplicate: true }
    }

    const got = await client.getOfferId(sku)
    if (got) {
      console.log(
        `  [VariationPublish] createOffer duplicate — getOfferId(sku) offerId=${got} (will updateOffer)`
      )
      return { offerId: got, fromDuplicate: true }
    }

    const page = await client.getOffers(sku, 20, 0)
    const offers = page.offers ?? []
    const draft = offers.find(
      o => o.sku === sku && o.offerId && (!o.listing?.listingId || o.status === 'UNPUBLISHED')
    )
    const anySku = offers.find(o => o.sku === sku && o.offerId)
    const pick = draft?.offerId ?? anySku?.offerId
    if (pick) {
      console.log(
        `  [VariationPublish] createOffer duplicate — getOffers(sku) offerId=${pick} (will updateOffer)`
      )
      return { offerId: pick, fromDuplicate: true }
    }

    throw e
  }
}

export type VariationPublishResult = {
  variationProductId: number
  listingId:          string | null
  status:             'ok' | 'failed'
  error:              string | null
}

export async function publishVariationListing(
  variationProductId: number,
  simulationMode = false
): Promise<VariationPublishResult> {
  console.log('[VariationPublish] START variationProductId:', variationProductId)
  console.log('[VariationPublish] simulationMode:', simulationMode)
  const result: VariationPublishResult = {
    variationProductId,
    listingId: null,
    status:    'failed',
    error:     null,
  }

  let alertPublishRef: string | number = variationProductId
  try {
    const workspaceId = getWorkspaceId()

    const productRes = await pool.query(
      `SELECT * FROM variation_products WHERE id = $1`,
      [variationProductId]
    )
    const product = productRes.rows[0] as {
      id: number
      asin: string
      source: string
      title: string
      brand: string
      description: string
      images: string[]
      video_url: string | null
      category: string
      store_code: string
      status: string
      ai_title: string | null
      ai_description: string | null
      ai_item_specifics: Record<string, string> | null
    }
    if (!product) throw new Error(`variation_products id=${variationProductId} bulunamadı`)
    alertPublishRef = product.asin

    const itemsRes = await pool.query(
      `SELECT * FROM variation_items WHERE variation_product_id = $1 ORDER BY id`,
      [variationProductId]
    )
    const items = itemsRes.rows
    if (!items.length) throw new Error('Hiç variation_items yok')
    console.log('[VariationPublish] items count:', items.length, 'items:', JSON.stringify(items.slice(0,2)))

    console.log('[VariationPublish] Before AI generate')
    await generateVariationListing(variationProductId)
    console.log('[VariationPublish] After AI generate')

    const refreshedRes = await pool.query(
      `SELECT * FROM variation_products WHERE id = $1`,
      [variationProductId]
    )
    const refreshed = refreshedRes.rows[0]
    if (!refreshed) throw new Error(`variation_products id=${variationProductId} bulunamadı`)
    Object.assign(product, refreshed)

    const storeCode = String(product.store_code ?? '')

    const store = await getStoreByCode(workspaceId, storeCode)
    if (!store) throw new Error('Store bulunamadı')

    const storeRow = await getSettingsByStore(workspaceId, store.id)
    if (!storeRow) throw new Error('Store settings bulunamadı')

    const fulfillmentPolicyId = storeRow.fulfillmentPolicyId?.trim() ?? ''
    const paymentPolicyId     = storeRow.paymentPolicyId?.trim()     ?? ''
    const returnPolicyId      = storeRow.returnPolicyId?.trim()      ?? ''
    if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
      throw new Error('Store policy ID eksik')
    }

    const accessToken = await getValidAccessToken(workspaceId, storeCode, simulationMode)
    const client = new EbayApiClient({
      oauthToken:     accessToken,
      sandbox:        false,
      simulationMode,
    })

    const title80 = (product.ai_title || product.title || '').slice(0, 80)
    const description = product.ai_description || product.title || ''

    const mainImages = await processAndUploadImages({
      imageUrls: product.images ?? [],
      asin:      String(product.asin),
      warehouseShippingBannerEnabled: storeRow.warehouseShippingBannerEnabled === true,
    })

    const suggestions = await client.getCategorySuggestions(
      String(product.title ?? product.asin),
      String(product.category ?? '')
    )
    const categoryId = suggestions[0]?.categoryId ?? '0'
    const whKey = resolveMerchantLocationKey(storeCode, storeRow)
    const merchantAddr = merchantAddressFromStoreRow(storeRow)
    if (!merchantAddr) {
      throw new Error('Store address incomplete. Configure Location in Settings before publishing.')
    }

    console.log(
      `[eBayPublish] storeCode=${storeCode} using merchantLocationKey=${whKey} from fresh store settings`
    )
    await ensureWarehouseMerchantLocationOnEbay(client, storeCode, merchantAddr, { strict: true })

    const groupKey = `DPVG${product.asin}${storeCode}`
    const aspectName = String(items[0].aspect_name)

    const baseAspectsForGroup: Record<string, string[]> = {}
    const aiSpecsGroup = (product.ai_item_specifics as Record<string, string>) || {}
    for (const [k, v] of Object.entries(aiSpecsGroup)) {
      if (!v || !String(v).trim()) continue
      if (k === aspectName || k === 'Brand') continue
      baseAspectsForGroup[k] = [String(v)]
    }

    const commonAspects: Record<string, string[]> = {
      Brand: [String(product.brand || 'Generic')],
      Color: ['Multicolor'],
      ...baseAspectsForGroup,
    }

    // Zorunlu aspect'leri eBay taxonomy'den çek ve baseAspects'e ekle
    try {
      const requiredAspects = await client.getRequiredAspectsForCategory(categoryId)
      if (requiredAspects.length > 0) {
        console.log('[VariationPublish] Required aspects:', requiredAspects.map(a => a.name).join(', '))
        for (const ra of requiredAspects) {
          const existing = commonAspects[ra.name]
          if (!existing || existing.length === 0 || existing[0] === 'Does Not Apply') {
            const fallbackValue = ra.values[0] || 'Does Not Apply'
            commonAspects[ra.name] = [fallbackValue]
            console.log('[VariationPublish] Required aspect filled:', ra.name, '=', fallbackValue)
          }
        }
      }
    } catch (e) {
      console.warn('[VariationPublish] Required aspects fetch failed:', e)
    }

    for (const item of items) {
      const baseAspects: Record<string, string[]> = { ...commonAspects }
      const aiSpecs = (product.ai_item_specifics as Record<string, string>) || {}
      for (const [k, v] of Object.entries(aiSpecs)) {
        if (v && String(v).trim()) baseAspects[k] = [String(v)]
      }
      // Varyant aspect her zaman kazanır
      baseAspects[aspectName] = [String(item.aspect_value)]
      baseAspects['Brand'] = [String(product.brand || 'Generic')]
      baseAspects['MPN'] = ['Does Not Apply']
      baseAspects['UPC'] = ['Does Not Apply']
      baseAspects['Color'] = ['Multicolor']

      const variantImages = await processAndUploadImages({
        imageUrls: Array.isArray(item.images) && item.images.length > 0
          ? item.images
          : (product.images ?? []),
        asin: String(item.sku),
        warehouseShippingBannerEnabled: storeRow.warehouseShippingBannerEnabled === true,
      })

      console.log('[VariationPublish] createOrReplaceInventoryItem sku:', String(item.sku), 'aspects:', JSON.stringify(baseAspects))

      await client.createOrReplaceInventoryItem(String(item.sku), {
        availability: {
          shipToLocationAvailability: { quantity: Number(item.quantity) },
        },
        condition: 'NEW',
        product: {
          title:       title80,
          description: description,
          aspects: baseAspects,
          imageUrls: variantImages.length > 0 ? variantImages : mainImages,
        },
      })

      const skuStr = String(item.sku)
      const offerBody: EbayCreateOfferRequest = {
        sku:                skuStr,
        marketplaceId:      DEFAULT_MARKETPLACE,
        format:             'FIXED_PRICE',
        availableQuantity:  Number(item.quantity),
        categoryId,
        listingDescription: description,
        listingPolicies: {
          fulfillmentPolicyId,
          paymentPolicyId,
          returnPolicyId,
        },
        merchantLocationKey: whKey,
        pricingSummary: {
          price: {
            value:    Number(item.price).toFixed(2),
            currency: 'USD',
          },
        },
      }

      const offerResp = await createOfferOrExisting(client, offerBody, skuStr)
      if (!offerResp.offerId) throw new Error('createOffer did not return an offerId')

      if (offerResp.fromDuplicate) {
        await client.updateOffer(offerResp.offerId, {
          categoryId:          offerBody.categoryId,
          pricingSummary:      offerBody.pricingSummary,
          listingDescription:  offerBody.listingDescription,
          listingPolicies:     offerBody.listingPolicies,
          merchantLocationKey: whKey,
        })
      }

      await pool.query(
        `UPDATE variation_items SET ebay_offer_id = $1 WHERE id = $2`,
        [offerResp.offerId, item.id]
      )
    }

    console.log('[VariationPublish] Creating group, groupKey:', groupKey)
    await client.createOrReplaceInventoryItemGroup(groupKey, {
      variantSKUs: items.map(i => String(i.sku)),
      variesBy: {
        specifications: [{
          name:   aspectName,
          values: items.map(i => String(i.aspect_value)),
        }],
      },
      aspects: { ...commonAspects },
      title:       title80,
      description: description,
      imageUrls:   mainImages.slice(0, 12),
    })
    console.log('[VariationPublish] Group created successfully')

    console.log('[VariationPublish] Publishing group, groupKey:', groupKey)
    const publishRes = await client.publishOfferByInventoryItemGroup(groupKey, DEFAULT_MARKETPLACE)

    await pool.query(
      `UPDATE variation_products SET status='published', ebay_item_id=$1, updated_at=NOW() WHERE id=$2`,
      [publishRes.listingId, variationProductId]
    )

    result.status    = 'ok'
    result.listingId = publishRes.listingId

  } catch (e) {
    console.error('[VariationPublish] ERROR:', e)
    const msg = e instanceof Error ? e.message : String(e)
    result.error = msg
    await pool.query(
      `UPDATE variation_products SET status='failed', updated_at=NOW() WHERE id=$1`,
      [variationProductId]
    ).catch(() => {})
    await alertPublishFailed(String(alertPublishRef), msg)
  }

  return result
}
