// ----------------------------------------------------------------
// appListingsPriceUpdateService.ts — user-scoped controlled price update (Phase 4B)
// Applies a server recommendation by default. An explicitly confirmed seller price
// is allowed through the same ownership and eBay identity/readback safeguards.
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { insertAuditLog } from "../auth/authRepository"
import { isTrustedCurrentKeepaPriceSource } from "../keepa/keepaPriceTypes"
import {
  getRecommendedPriceForListing,
  persistCatalogEbayPrice,
  updateListingPriceOnEbay,
} from "../listings/listingsEbayPriceService"
import { addNotification } from "../notifications/notificationService"
import { resolvePendingFailedPriceIncreaseAlerts } from "../stockGuard/stockGuardCleanupService"
import type { OwnedStore } from "./appOwnership"
import { AppHttpError, type AppUpdateListingPriceResponse } from "./appTypes"

type UserPriceUpdateListing = {
  id: number
  storeId: number
  storeCode: string
  storeName: string
  internalSku: string | null
  ebayItemId: string | null
  ebayOfferId: string | null
  ebayPrice: number | null
  sourcePrice: number | null
  sourceStatus: string | null
  sourcePriceSource: string | null
  currentStatus: string | null
}

function parsePositivePrice(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null
  const n = parseFloat(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Accept JSON numbers only when they represent a positive USD amount with <= 2 decimals. */
export function parseExplicitListingPrice(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new AppHttpError(400, "price must be a positive USD amount")
  }
  const cents = Math.round(value * 100)
  if (Math.abs(value * 100 - cents) > 0.000001) {
    throw new AppHttpError(400, "price must have no more than 2 decimal places")
  }
  return cents / 100
}

async function loadUserPriceUpdateListing(
  workspaceId: string,
  storeCode: string,
  catalogStateId: number
): Promise<UserPriceUpdateListing | null> {
  const res = await query<{
    id: number
    store_id: number
    store_code: string
    name: string
    internal_sku: string | null
    ebay_item_id: string | null
    ebay_offer_id: string | null
    ebay_price: string | null
    source_price: string | null
    source_status: string | null
    source_price_source: string | null
    current_status: string | null
  }>(
    `SELECT scs.id,
            scs.store_id,
            s.store_code,
            s.name,
            scs.internal_sku,
            scs.ebay_item_id,
            scs.ebay_offer_id,
            scs.ebay_price::text,
            scs.source_price::text,
            scs.source_status,
            scs.source_price_source,
            scs.current_status::text AS current_status
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id AND s.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND s.store_code = $2
       AND scs.id = $3::bigint
       AND s.status = 'active'
       AND scs.panel_hidden_at IS NULL
     LIMIT 1`,
    [workspaceId, storeCode.trim(), catalogStateId]
  )

  const row = res.rows[0]
  if (!row) return null

  return {
    id: row.id,
    storeId: row.store_id,
    storeCode: row.store_code,
    storeName: row.name,
    internalSku: row.internal_sku?.trim() || null,
    ebayItemId: row.ebay_item_id?.trim() || null,
    ebayOfferId: row.ebay_offer_id?.trim() || null,
    ebayPrice: parsePositivePrice(row.ebay_price),
    sourcePrice: parsePositivePrice(row.source_price),
    sourceStatus: row.source_status?.trim() || null,
    sourcePriceSource: row.source_price_source?.trim() || null,
    currentStatus: row.current_status?.trim() || null,
  }
}

function assertUserPriceUpdateEligible(
  listing: UserPriceUpdateListing,
  options: { requireTrustedSource: boolean }
): void {
  const status = listing.currentStatus?.toLowerCase() ?? ""
  if (status && status !== "live") {
    throw new AppHttpError(400, "Listing is not eligible for price update")
  }

  if (!listing.ebayItemId) {
    throw new AppHttpError(400, "eBay item ID is not available for this listing")
  }

  if (!options.requireTrustedSource) return

  if (listing.sourcePrice == null || listing.sourcePrice <= 0) {
    throw new AppHttpError(400, "Amazon source price is not available for this listing")
  }

  if (listing.sourceStatus === "PRICE_UNCERTAIN") {
    throw new AppHttpError(400, "Source price is uncertain — price update is not allowed")
  }

  if (!isTrustedCurrentKeepaPriceSource(listing.sourcePriceSource)) {
    throw new AppHttpError(400, "Source price is not from a trusted price source")
  }
}

async function writePriceUpdateAudit(input: {
  actorUserId: string
  success: boolean
  workspaceId: string
  storeCode: string
  storeId: number
  catalogStateId: number
  ebayItemId?: string | null
  oldPrice?: number
  newPrice?: number
  pricingSource?: string
  status?: number
  reason?: string
}): Promise<void> {
  try {
    await insertAuditLog({
      actorUserId: input.actorUserId,
      action: input.success
        ? "app.listings.price_update"
        : "app.listings.price_update.failed",
      targetType: "catalog_state",
      targetId: String(input.catalogStateId),
      metadata: input.success
        ? {
            workspaceId: input.workspaceId,
            storeCode: input.storeCode,
            storeId: input.storeId,
            catalogStateId: input.catalogStateId,
            ebayItemId: input.ebayItemId ?? null,
            oldPrice: input.oldPrice,
            newPrice: input.newPrice,
            pricingSource: input.pricingSource,
          }
        : {
            workspaceId: input.workspaceId,
            storeCode: input.storeCode,
            catalogStateId: input.catalogStateId,
            status: input.status ?? 500,
            reason: input.reason?.slice(0, 200) ?? "Price update failed",
          },
    })
  } catch (e) {
    console.warn(
      "[App][price-update] audit log failed:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

function mapRecommendedError(e: unknown): AppHttpError {
  const msg = e instanceof Error ? e.message : String(e)
  if (/not available|unavailable|not found/i.test(msg)) {
    return new AppHttpError(400, msg.length > 160 ? "Recommended price unavailable" : msg)
  }
  return new AppHttpError(400, msg.length > 160 ? "Recommended price unavailable" : msg)
}

function mapUpdateFailure(e: unknown): AppHttpError {
  if (e instanceof AppHttpError) return e
  return new AppHttpError(502, "Price update failed")
}

export async function appUpdateListingPrice(input: {
  workspaceId: string
  actorUserId: string
  store: OwnedStore
  catalogStateId: number
  /** Seller-entered final price; absent preserves recommendation-only behavior. */
  explicitPrice?: number
}): Promise<AppUpdateListingPriceResponse> {
  const listing = await loadUserPriceUpdateListing(
    input.workspaceId,
    input.store.storeCode,
    input.catalogStateId
  )
  if (!listing) {
    throw new AppHttpError(404, "Listing not found")
  }

  const hasExplicitPrice = input.explicitPrice != null
  assertUserPriceUpdateEligible(listing, { requireTrustedSource: !hasExplicitPrice })

  let pricingSource = "seller_manual_override"
  let currentEbayPrice = listing.ebayPrice ?? 0
  let newEbayPrice = input.explicitPrice ?? 0

  if (!hasExplicitPrice) {
    let pricing: Awaited<ReturnType<typeof getRecommendedPriceForListing>>
    try {
      pricing = await getRecommendedPriceForListing(
        input.workspaceId,
        input.store.storeCode,
        input.catalogStateId
      )
    } catch (e) {
      throw mapRecommendedError(e)
    }
    currentEbayPrice = listing.ebayPrice ?? pricing.currentEbayPrice ?? 0
    newEbayPrice = pricing.recommendedEbayPrice
    pricingSource = pricing.pricingSource

    if (newEbayPrice <= 0 || pricing.pricingSource === "unavailable") {
      throw new AppHttpError(400, "Recommended price unavailable")
    }
    if (newEbayPrice <= currentEbayPrice || Math.abs(newEbayPrice - currentEbayPrice) < 0.005) {
      throw new AppHttpError(400, "No price increase needed")
    }
  }

  try {
    await updateListingPriceOnEbay(input.workspaceId, input.store.storeCode, {
      internalSku: listing.internalSku,
      ebayItemId: listing.ebayItemId,
      ebayOfferId: listing.ebayOfferId,
      newPrice: newEbayPrice,
      catalogStateId: listing.id,
      storeId: listing.storeId,
      allowPriceDecrease: hasExplicitPrice,
    })

    await persistCatalogEbayPrice({
      workspaceId: input.workspaceId,
      storeId: listing.storeId,
      catalogStateId: listing.id,
      newPrice: newEbayPrice,
      manual: true,
    })

    await resolvePendingFailedPriceIncreaseAlerts({
      workspaceId: input.workspaceId,
      storeId: listing.storeId,
      catalogStateId: listing.id,
      reason: "Resolved by manual eBay price update",
    })

    void addNotification(
      input.workspaceId,
      "info",
      `eBay price updated: $${currentEbayPrice.toFixed(2)} → $${newEbayPrice.toFixed(2)}`,
      `${listing.storeName?.trim() || input.store.storeCode} · ${listing.internalSku ?? listing.ebayItemId ?? ""}`
    )

    await writePriceUpdateAudit({
      actorUserId: input.actorUserId,
      success: true,
      workspaceId: input.workspaceId,
      storeCode: input.store.storeCode,
      storeId: listing.storeId,
      catalogStateId: listing.id,
      ebayItemId: listing.ebayItemId,
      oldPrice: currentEbayPrice,
      newPrice: newEbayPrice,
      pricingSource,
    })

    return {
      ok: true,
      storeCode: input.store.storeCode,
      catalogStateId: listing.id,
      ebayItemId: listing.ebayItemId,
      oldEbayPrice: currentEbayPrice,
      newEbayPrice,
      pricingSource,
      message: "Price updated successfully.",
    }
  } catch (e) {
    const httpErr = mapUpdateFailure(e)
    await writePriceUpdateAudit({
      actorUserId: input.actorUserId,
      success: false,
      workspaceId: input.workspaceId,
      storeCode: input.store.storeCode,
      storeId: listing.storeId,
      catalogStateId: listing.id,
      status: httpErr.status,
      reason: httpErr.message,
    })
    throw httpErr
  }
}
