import { query } from "../../db/client"
import type { OwnedStore } from "./appOwnership"
import { AppHttpError } from "./appTypes"
import {
  applyListingPromotion,
  loadPromotionForCatalog,
  unknownPromotionPublic,
  verifyListingPromotion,
} from "../ebay/ebayPromotedAdService"
import { parsePromotedRequest, type PromotionPublic } from "../ebay/ebayPromotedTypes"
import { toMarketingAccess } from "../ebayOAuth/ebayOAuthService"

export type AppListingPromotionResponse = {
  ok: true
  storeCode: string
  catalogStateId: number
  listingId: string
  promotion: PromotionPublic
}

async function loadOwnedListing(input: {
  workspaceId: string
  store: OwnedStore
  catalogStateId: number
}): Promise<{ catalogStateId: number; ebayItemId: string | null }> {
  const res = await query<{ id: number; ebay_item_id: string | null }>(
    `SELECT scs.id, scs.ebay_item_id
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id
     WHERE scs.workspace_id = $1::uuid
       AND s.workspace_id = $1::uuid
       AND s.id = $2
       AND scs.id = $3
     LIMIT 1`,
    [input.workspaceId, input.store.id, input.catalogStateId]
  )
  const row = res.rows[0]
  if (!row) throw new AppHttpError(404, "Listing not found")
  return { catalogStateId: row.id, ebayItemId: row.ebay_item_id?.trim() || null }
}

export async function storeMarketingAccess(
  workspaceId: string,
  storeId: number
): Promise<{ granted: boolean; code: "MARKETING_SCOPE_REQUIRED" | null }> {
  const res = await query<{ scope: string | null }>(
    `SELECT scope FROM ebay_accounts WHERE workspace_id = $1::uuid AND store_id = $2 LIMIT 1`,
    [workspaceId, storeId]
  )
  return toMarketingAccess(res.rows[0]?.scope)
}

export async function storeNeedsMarketingReconnect(
  workspaceId: string,
  storeId: number
): Promise<boolean> {
  return !(await storeMarketingAccess(workspaceId, storeId)).granted
}

export async function appApplyListingPromotion(input: {
  workspaceId: string
  store: OwnedStore
  catalogStateId: number
  enabled: boolean
  rate: number | null
}): Promise<AppListingPromotionResponse> {
  const listing = await loadOwnedListing(input)
  if (!listing.ebayItemId) throw new AppHttpError(400, "Listing has no eBay item ID")
  const promotion = await applyListingPromotion({
    workspaceId: input.workspaceId,
    storeId: input.store.id,
    storeCode: input.store.storeCode,
    catalogStateId: listing.catalogStateId,
    listingId: listing.ebayItemId,
    enabled: input.enabled,
    rate: input.rate,
  })
  return {
    ok: true,
    storeCode: input.store.storeCode,
    catalogStateId: listing.catalogStateId,
    listingId: listing.ebayItemId,
    promotion,
  }
}

export async function appVerifyListingPromotion(input: {
  workspaceId: string
  store: OwnedStore
  catalogStateId: number
}): Promise<AppListingPromotionResponse> {
  const listing = await loadOwnedListing(input)
  if (!listing.ebayItemId) throw new AppHttpError(400, "Listing has no eBay item ID")
  const promotion = await verifyListingPromotion({
    workspaceId: input.workspaceId,
    storeId: input.store.id,
    storeCode: input.store.storeCode,
    catalogStateId: listing.catalogStateId,
    listingId: listing.ebayItemId,
  })
  return {
    ok: true,
    storeCode: input.store.storeCode,
    catalogStateId: listing.catalogStateId,
    listingId: listing.ebayItemId,
    promotion,
  }
}

export async function appRetryListingPromotion(input: {
  workspaceId: string
  store: OwnedStore
  catalogStateId: number
}): Promise<AppListingPromotionResponse> {
  const listing = await loadOwnedListing(input)
  if (!listing.ebayItemId) throw new AppHttpError(400, "Listing has no eBay item ID")
  const existing = await loadPromotionForCatalog(input.workspaceId, input.store.id, listing.catalogStateId)
  const rate = existing?.requestedRate ?? existing?.effectiveRate ?? null
  const promotion = await applyListingPromotion({
    workspaceId: input.workspaceId,
    storeId: input.store.id,
    storeCode: input.store.storeCode,
    catalogStateId: listing.catalogStateId,
    listingId: listing.ebayItemId,
    enabled: true,
    rate,
  })
  return {
    ok: true,
    storeCode: input.store.storeCode,
    catalogStateId: listing.catalogStateId,
    listingId: listing.ebayItemId,
    promotion,
  }
}

export async function appBulkApplyListingPromotion(input: {
  workspaceId: string
  store: OwnedStore
  catalogStateIds: number[]
  enabled: boolean
  rate: number | null
}): Promise<{
  ok: true
  storeCode: string
  requested: number
  succeeded: number
  failed: number
  results: Array<{ catalogStateId: number; ok: boolean; promotion?: PromotionPublic; error?: string }>
}> {
  const ids = [...new Set(input.catalogStateIds)].slice(0, 50)
  const results: Array<{ catalogStateId: number; ok: boolean; promotion?: PromotionPublic; error?: string }> = []
  const concurrency = 3
  let cursor = 0
  async function worker() {
    while (cursor < ids.length) {
      const index = cursor++
      const catalogStateId = ids[index]
      try {
        const one = await appApplyListingPromotion({
          workspaceId: input.workspaceId,
          store: input.store,
          catalogStateId,
          enabled: input.enabled,
          rate: input.rate,
        })
        results[index] = { catalogStateId, ok: one.promotion.status !== "FAILED", promotion: one.promotion }
      } catch (e) {
        results[index] = {
          catalogStateId,
          ok: false,
          error: e instanceof AppHttpError ? e.message : "Reklam işlemi başarısız",
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()))
  return {
    ok: true,
    storeCode: input.store.storeCode,
    requested: ids.length,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
  }
}

export function parsePromotionBody(body: Record<string, unknown>): { enabled: boolean; rate: number | null } {
  const parsed = parsePromotedRequest({
    promotedEnabled: body.promotedEnabled ?? body.enabled,
    promotedAdRate: body.promotedAdRate ?? body.rate,
  })
  if (!parsed.ok) throw new AppHttpError(400, parsed.message)
  return { enabled: parsed.enabled, rate: parsed.enabled ? parsed.rate : null }
}

export { unknownPromotionPublic }
