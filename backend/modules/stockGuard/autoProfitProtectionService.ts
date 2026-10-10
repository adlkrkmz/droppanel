import { query } from "../../db/client"
import { calculateRecommendedEbayPrice } from "../pricing/pricingCalculatorService"
import { loadPromotionPricingContext } from "../pricing/promotionPricingContext"
import {
  persistCatalogEbayPrice,
  updateListingPriceOnEbay,
  type CatalogListingPriceRow,
} from "../listings/listingsEbayPriceService"
import { addNotification } from "../notifications/notificationService"
import { resolvePendingFailedPriceIncreaseAlerts } from "./stockGuardCleanupService"
import { STOCK_GUARD_SCAN_ELIGIBLE_QTY } from "./stockGuardScanEligibility"
import { isTrustedCurrentKeepaPriceSource } from "../keepa/keepaPriceTypes"
import { getStockGuardSettingsByStoreCode } from "./stockGuardSettingsRepository"
import type { StockGuardSettingsRow } from "./stockGuardTypes"
import { markActiveReviewIgnored, markActiveReviewFailed } from "../stockAlerts/stockAlertReviewLifecycle"
import { PROFIT_PROTECTION_NOOP_IGNORE } from "../stockAlerts/stockAlertUserMessages"
import { isEligibleForAutomaticMutation } from "./automaticListingEligibility"

export type AutoProfitProtectionResult =
  | { action: "none" }
  | { action: "updated"; oldPrice: number; newPrice: number }
  | { action: "review"; reason: string }
  | { action: "failed"; error: string }

function parsePrice(s: string | null | undefined): number | null {
  if (s == null || s.trim() === "") return null
  const n = parseFloat(s)
  return Number.isFinite(n) && n > 0 ? n : null
}

export async function tryAutoProfitProtectionForListing(input: {
  workspaceId: string
  storeId: number
  storeCode: string
  storeName: string
  settings: StockGuardSettingsRow
  row: CatalogListingPriceRow & {
    ebayTitle?: string | null
    imageUrl?: string | null
    ebayQuantity?: number | null
    asin?: string | null
    sourcePriceSource?: string | null
    sourceStatus?: string | null
  }
}): Promise<AutoProfitProtectionResult> {
  if (input.row.sourceStatus === "PRICE_UNCERTAIN") {
    return { action: "none" }
  }

  const priceSource = input.row.sourcePriceSource?.trim()
  if (!priceSource || !isTrustedCurrentKeepaPriceSource(priceSource)) {
    return { action: "none" }
  }

  const amazon = input.row.sourcePrice
  const currentEbay = input.row.ebayPrice
  if (amazon == null || amazon <= 0 || currentEbay == null || currentEbay <= 0) {
    return { action: "none" }
  }

  const promotion = await loadPromotionPricingContext({
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    catalogStateId: input.row.id,
  })
  const calc = await calculateRecommendedEbayPrice({
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    amazonPrice: amazon,
    promotion,
  })

  if (calc.recommendedEbayPrice <= 0) {
    return { action: "none" }
  }

  const recommended = calc.recommendedEbayPrice
  if (recommended <= currentEbay) {
    await markActiveReviewIgnored({
      workspaceId: input.workspaceId,
      catalogStateId: input.row.id,
      reason: PROFIT_PROTECTION_NOOP_IGNORE,
      sourceStatus: "PRICE_INCREASE",
      sourcePrice: amazon,
      ebayPrice: currentEbay,
    }).catch(() => undefined)
    return { action: "none" }
  }

  if (!(await isEligibleForAutomaticMutation({
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    catalogStateId: input.row.id,
  }))) {
    return { action: "none" }
  }

  try {
    await updateListingPriceOnEbay(input.workspaceId, input.storeCode, {
      internalSku: input.row.internalSku,
      ebayItemId: input.row.ebayItemId,
      ebayOfferId: input.row.ebayOfferId,
      newPrice: recommended,
      catalogStateId: input.row.id,
      storeId: input.storeId,
    })

    await persistCatalogEbayPrice({
      workspaceId: input.workspaceId,
      storeId: input.storeId,
      catalogStateId: input.row.id,
      newPrice: recommended,
      manual: false,
      oldPrice: currentEbay,
      autoReason: "Auto profit protection",
    })

    await resolvePendingFailedPriceIncreaseAlerts({
      workspaceId: input.workspaceId,
      storeId: input.storeId,
      catalogStateId: input.row.id,
    })

    void addNotification(
      input.workspaceId,
      "info",
      `Kâr koruma: eBay fiyatı $${currentEbay.toFixed(2)} → $${recommended.toFixed(2)} güncellendi.`,
      `${input.storeName} · ${input.row.internalSku ?? input.row.ebayItemId ?? ""}`
    )

    return { action: "updated", oldPrice: currentEbay, newPrice: recommended }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markActiveReviewFailed({
      workspaceId: input.workspaceId,
      catalogStateId: input.row.id,
      reason: `Amazon kaynak fiyatı ${amazon.toFixed(2)} olarak doğrulandı. Kâr koruma için gerekli eBay fiyatı ${recommended.toFixed(2)} olarak hesaplandı; mevcut fiyat ${currentEbay.toFixed(2)}. eBay fiyat güncellemesi başarısız: ${msg}.`,
      actionError: msg,
      sourceStatus: "PRICE_INCREASE",
      sourcePrice: amazon,
      oldSourcePrice: amazon,
      newSourcePrice: amazon,
      operationType: "PRICE_PROTECTION",
      operationKey: `v2:price_protection:${input.row.id}:${Math.round(amazon * 100)}`,
    }).catch(() => undefined)
    return { action: "failed", error: msg }
  }
}

export type AutoProfitProtectionPassResult = {
  checked: number
  updated: number
  review: number
  failed: number
  skipped: number
}

export async function runAutoProfitProtectionPass(input: {
  workspaceId: string
  storeId: number
  storeCode: string
  storeName: string
  settings: StockGuardSettingsRow
  /** When set, only these catalog rows are evaluated (e.g. after Keepa scan). */
  catalogStateIds?: number[]
}): Promise<AutoProfitProtectionPassResult> {
  const ids = input.catalogStateIds?.filter(id => Number.isFinite(id) && id > 0) ?? []
  const idFilter =
    ids.length > 0 ? ` AND scs.id = ANY($3::bigint[])` : ""
  const queryParams: unknown[] = [input.workspaceId, input.storeId]
  if (ids.length > 0) queryParams.push(ids)

  const res = await query<{
    id: number
    internal_sku: string | null
    ebay_item_id: string | null
    ebay_offer_id: string | null
    ebay_price: string | null
    source_price: string | null
    source_price_source: string | null
    source_status: string | null
    ebay_title: string | null
    image_url: string | null
    ebay_quantity: number | null
    registry_asin: string | null
    source_url: string | null
  }>(
    `SELECT scs.id,
            scs.internal_sku,
            scs.ebay_item_id,
            scs.ebay_offer_id,
            scs.ebay_price::text,
            scs.source_price::text,
            scs.source_price_source,
            scs.source_status,
            scs.ebay_title,
            scs.image_url,
            scs.ebay_quantity,
            ar.asin AS registry_asin,
            scs.source_url
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND scs.store_id = $2::bigint
       AND scs.panel_hidden_at IS NULL
       AND scs.current_status = 'live'
       AND COALESCE(scs.stock_guard_enabled, true) = true
       AND ${STOCK_GUARD_SCAN_ELIGIBLE_QTY}
       AND scs.source_price IS NOT NULL
       AND scs.source_price::numeric > 0
       AND scs.ebay_price IS NOT NULL
       AND scs.ebay_price::numeric > 0
       AND scs.source_status IS DISTINCT FROM 'PRICE_UNCERTAIN'
       AND scs.ebay_item_id IS NOT NULL
       AND trim(scs.ebay_item_id) <> ''
       AND scs.source_price_source IN (
         'PRIME_EXCLUSIVE_CURRENT',
         'BUY_BOX_CURRENT',
         'NEW_CURRENT',
         'NEW_FBA_CURRENT'
       )${idFilter}`,
    queryParams
  )

  console.log(
    `[AutoProfitProtection] start store=${input.storeCode} candidates=${res.rows.length}${ids.length > 0 ? ` scopedIds=${ids.length}` : ""}`
  )

  let updated = 0
  let review = 0
  let failed = 0
  let skipped = 0

  for (const r of res.rows) {
    const row: CatalogListingPriceRow & {
      ebayTitle: string | null
      imageUrl: string | null
      ebayQuantity: number | null
      asin: string | null
      sourcePriceSource: string | null
      sourceStatus: string | null
    } = {
      id: r.id,
      storeId: input.storeId,
      storeCode: input.storeCode,
      storeName: input.storeName,
      internalSku: r.internal_sku?.trim() || null,
      ebayItemId: r.ebay_item_id?.trim() || null,
      ebayOfferId: r.ebay_offer_id?.trim() || null,
      ebayPrice: parsePrice(r.ebay_price),
      sourcePrice: parsePrice(r.source_price),
      sourcePriceSource: r.source_price_source?.trim() || null,
      sourceStatus: r.source_status?.trim() || null,
      ebayTitle: r.ebay_title?.trim() || null,
      imageUrl: r.image_url?.trim() || null,
      ebayQuantity: r.ebay_quantity,
      asin: r.registry_asin?.trim() || null,
    }

    const result = await tryAutoProfitProtectionForListing({
      workspaceId: input.workspaceId,
      storeId: input.storeId,
      storeCode: input.storeCode,
      storeName: input.storeName,
      settings: input.settings,
      row,
    })

    if (result.action === "updated") {
      updated++
      console.log(
        `[AutoProfitProtection] updated catalogStateId=${r.id} old=${result.oldPrice.toFixed(2)} new=${result.newPrice.toFixed(2)}`
      )
    } else if (result.action === "review") {
      review++
      console.log(
        `[AutoProfitProtection] review catalogStateId=${r.id} reason=${result.reason}`
      )
    } else if (result.action === "failed") {
      failed++
      console.log(
        `[AutoProfitProtection] failed catalogStateId=${r.id} error=${result.error.slice(0, 120)}`
      )
    } else {
      skipped++
    }
  }

  console.log(
    `[AutoProfitProtection] done store=${input.storeCode} updated=${updated} skipped=${skipped} review=${review} failed=${failed} checked=${res.rows.length}`
  )

  return {
    checked: res.rows.length,
    updated,
    review,
    failed,
    skipped,
  }
}

/** After Keepa (or any) source_price refresh — same pass as background Stock Guard scan. */
export async function runForStoreAfterSourceScan(input: {
  workspaceId: string
  storeCode: string
  catalogStateIds?: number[]
}): Promise<AutoProfitProtectionPassResult> {
  const store = await getStockGuardSettingsByStoreCode(input.workspaceId, input.storeCode)
  if (!store) {
    return { checked: 0, updated: 0, review: 0, failed: 0, skipped: 0 }
  }
  return runAutoProfitProtectionPass({
    workspaceId: input.workspaceId,
    storeId: store.storeId,
    storeCode: store.storeCode,
    storeName: store.storeName,
    settings: store,
    catalogStateIds: input.catalogStateIds,
  })
}
