// ----------------------------------------------------------------

// appListingsService.ts — user-safe listing reads

// ----------------------------------------------------------------



import { query } from "../../db/client"

import { getRecommendedPriceForListing } from "../listings/listingsEbayPriceService"

import { resolveListingAsin } from "../monitor/monitorService"

import {

  LISTINGS_BASE_FROM_JOIN,

  LISTINGS_BASE_WHERE,

  listingsFilterWhereClause,
  listingsOrderBy,
  listingsSearchWhereClause,

} from "./appListingFilters"

import type {

  AppListingItem,

  AppListingsFilter,

  AppListingsResponse,

  AppRecommendedPriceResponse,
  AppListingsSort,

} from "./appTypes"

import type { OwnedStore } from "./appOwnership"
import { toPromotionPublic } from "../ebay/ebayPromotedTypes"



function parsePrice(raw: string | null | undefined): number | null {

  const trimmed = raw?.trim()

  if (!trimmed) return null

  const n = parseFloat(trimmed)

  return Number.isFinite(n) ? n : null

}

function normalizeImageUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.protocol === "http:") url.protocol = "https:"
    return url.toString()
  } catch {
    return null
  }
}



export async function getAppListings(input: {

  workspaceId: string

  store:       OwnedStore

  page:        number

  limit:       number

  filter:      AppListingsFilter
  sort:        AppListingsSort | null
  direction:   string
  q:           string

}): Promise<AppListingsResponse> {

  const safeLimit  = Math.max(1, Math.min(100, input.limit))

  const safePage   = Math.max(1, input.page)

  const safeOffset = (safePage - 1) * safeLimit

  const filterWhere = listingsFilterWhereClause(input.filter)
  const searchWhere = listingsSearchWhereClause(input.q)
  const paginationSql = searchWhere.value ? "LIMIT $4 OFFSET $5" : "LIMIT $3 OFFSET $4"



  const countRes = await query<{ total: string }>(

    `SELECT COUNT(*)::text AS total

     ${LISTINGS_BASE_FROM_JOIN}

       ${LISTINGS_BASE_WHERE}

       ${filterWhere}
       ${searchWhere.sql}`,

    searchWhere.value
      ? [input.workspaceId, input.store.storeCode, searchWhere.value]
      : [input.workspaceId, input.store.storeCode]

  )

  const total = parseInt(countRes.rows[0]?.total ?? "0", 10) || 0



  const listRes = await query<{

    id: number

    ebay_item_id: string | null

    ebay_title: string | null
    image_url: string | null

    registry_asin: string | null

    source_url: string | null

    internal_sku: string | null

    ebay_price: string | null

    source_price: string | null

    source_price_source: string | null
    source_status: string | null
    source_status_reason: string | null

    ebay_quantity: number | null
    listed_at: string | null
    total_sold: number | null
    clicks_30d: number | null
    clicks_30d_checked_at: string | null

    auto_price_protected_at: string | null

    auto_price_old_ebay_price: string | null

    auto_price_new_ebay_price: string | null

    stock_guard_enabled: boolean

    current_status: string | null

    source_checked_at: string | null

    updated_at: string | null
    promo_status: string | null
    promo_requested: boolean | null
    promo_requested_rate: string | null
    promo_effective_rate: string | null
    promo_campaign_id: string | null
    promo_ad_id: string | null
    promo_error_code: string | null
    promo_error_message: string | null

  }>(

    `SELECT scs.id,

            scs.ebay_item_id,

            scs.ebay_title,

            scs.image_url,
            ar.asin AS registry_asin,

            scs.source_url,

            scs.internal_sku,

            scs.ebay_price::text AS ebay_price,

            scs.source_price::text AS source_price,

            scs.source_price_source,
            scs.source_status,
            scs.source_status_reason,

            scs.ebay_quantity,
            scs.listed_at::text AS listed_at,
            scs.total_sold,
            scs.clicks_30d,
            scs.clicks_30d_checked_at::text AS clicks_30d_checked_at,

            scs.auto_price_protected_at::text AS auto_price_protected_at,

            scs.auto_price_old_ebay_price::text AS auto_price_old_ebay_price,

            scs.auto_price_new_ebay_price::text AS auto_price_new_ebay_price,

            COALESCE(scs.stock_guard_enabled, true) AS stock_guard_enabled,

            scs.current_status::text AS current_status,

            scs.source_checked_at::text AS source_checked_at,

            scs.updated_at::text AS updated_at,
            elp.status AS promo_status,
            elp.requested AS promo_requested,
            elp.requested_rate::text AS promo_requested_rate,
            elp.effective_rate::text AS promo_effective_rate,
            elp.campaign_id AS promo_campaign_id,
            elp.ad_id AS promo_ad_id,
            elp.last_error_code AS promo_error_code,
            elp.last_error_message AS promo_error_message

     ${LISTINGS_BASE_FROM_JOIN}

     ${LISTINGS_BASE_WHERE}

       ${filterWhere}
       ${searchWhere.sql}

     ${listingsOrderBy(input.sort, input.direction)}

     ${paginationSql}`,

    searchWhere.value
      ? [input.workspaceId, input.store.storeCode, searchWhere.value, safeLimit, safeOffset]
      : [input.workspaceId, input.store.storeCode, safeLimit, safeOffset]

  )



  const items: AppListingItem[] = listRes.rows.map(r => ({

    catalogStateId:        r.id,

    ebayItemId:            r.ebay_item_id?.trim() || null,

    title:                 r.ebay_title?.trim() || null,
    imageUrl:              normalizeImageUrl(r.image_url),
    internalSku:           r.internal_sku?.trim() || null,
    sourceUrl:             r.source_url?.trim() || null,

    asin: resolveListingAsin({

      registryAsin: r.registry_asin,

      sourceUrl:    r.source_url,

      internalSku:  r.internal_sku?.trim() ?? "",

    }),

    ebayPrice:             parsePrice(r.ebay_price),

    sourcePrice:           parsePrice(r.source_price),

    sourcePriceSource:     r.source_price_source?.trim() || null,
    sourceStatus:          r.source_status?.trim() || null,
    sourceStatusReason:    r.source_status_reason?.trim() || null,

    ebayQuantity:          r.ebay_quantity ?? null,
    listedAt:              r.listed_at?.trim() || null,
    totalSold:             r.total_sold ?? null,
    clicks30d:             r.clicks_30d ?? null,
    clicks30dCheckedAt:    r.clicks_30d_checked_at?.trim() || null,

    status:                r.current_status?.trim() || null,

    autoPriceProtectedAt:  r.auto_price_protected_at?.trim() || null,

    autoPriceOldEbayPrice: parsePrice(r.auto_price_old_ebay_price),

    autoPriceNewEbayPrice: parsePrice(r.auto_price_new_ebay_price),

    stockGuardEnabled:     r.stock_guard_enabled !== false,

    lastCheckedAt:         r.source_checked_at?.trim() || null,

    updatedAt:             r.updated_at?.trim() || null,

    promotion: r.promo_status
      ? toPromotionPublic({
          requested: r.promo_requested === true,
          requestedRate: r.promo_requested_rate != null ? Number(r.promo_requested_rate) : null,
          status: r.promo_status as "OFF" | "PENDING" | "ACTIVE" | "FAILED" | "UNKNOWN",
          effectiveRate: r.promo_effective_rate != null ? Number(r.promo_effective_rate) : null,
          campaignId: r.promo_campaign_id,
          adId: r.promo_ad_id,
          lastErrorCode: r.promo_error_code,
          lastErrorMessage: r.promo_error_message,
        })
      : {
          requested: false,
          requestedRate: null,
          status: "UNKNOWN",
          effectiveRate: null,
          campaignId: null,
          adId: null,
          code: null,
          message: "Reklam durumu bilinmiyor",
          retryable: true,
        },

  }))



  return {

    ok:        true,

    storeCode: input.store.storeCode,

    page:      safePage,

    limit:     safeLimit,

    filter:    input.filter,

    total,

    items,

  }

}



export async function getAppRecommendedPrice(input: {

  workspaceId:    string

  storeCode:      string

  catalogStateId: number

}): Promise<AppRecommendedPriceResponse> {

  const pricing = await getRecommendedPriceForListing(

    input.workspaceId,

    input.storeCode,

    input.catalogStateId

  )



  return {

    ok:                   true,

    catalogStateId:       input.catalogStateId,

    amazonPrice:          pricing.amazonPrice,

    currentEbayPrice:     pricing.currentEbayPrice,

    storeMarkupPercent:   pricing.storeMarkupPercent,

    recommendedEbayPrice: pricing.recommendedEbayPrice,

    pricingSource:        pricing.pricingSource,

    promotionAdRatePercent: pricing.promotionAdRatePercent ?? null,

    promotionFeeImpactPercent: pricing.promotionFeeImpactPercent ?? null,

    unpromotedRecommendedEbayPrice: pricing.unpromotedRecommendedEbayPrice ?? null,

    promotedRecommendedEbayPrice: pricing.promotedRecommendedEbayPrice ?? null,

  }

}
