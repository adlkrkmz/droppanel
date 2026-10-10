import { query } from "../../db/client"
import {
  EbayApiClient,
  type EbayActiveListingPriceRow,
  type EbayGetOffersPage,
  type EbayTradingDiagnostic,
  type EbayTradingItemSnapshot,
} from "../ebay/ebayApiClient"
import { persistExactEbayOfferMapping, resolveEbayListingIdentity } from "../ebay/ebayListingIdentityService"
import { ebaySimulationExplicitlyOn, recordEbayMutation } from "../ebay/ebayMutationAudit"
import { getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import { addNotification } from "../notifications/notificationService"
import { calculateRecommendedEbayPrice } from "../pricing/pricingCalculatorService"
import { loadPromotionPricingContext } from "../pricing/promotionPricingContext"
import { getSettingsByStore } from "../storeSettings/storeSettingsRepository"
import { resolvePendingFailedPriceIncreaseAlerts } from "../stockGuard/stockGuardCleanupService"

export type CatalogListingPriceRow = {
  id: number
  storeId: number
  storeCode: string
  storeName: string
  internalSku: string | null
  ebayItemId: string | null
  ebayOfferId: string | null
  ebayPrice: number | null
  sourcePrice: number | null
}

export type RecommendedPriceResponse = {
  ok: true
  amazonPrice: number
  currentEbayPrice: number
  storeMarkupPercent: number
  recommendedEbayPrice: number
  pricingSource: string
  promotionAdRatePercent?: number | null
  promotionFeeImpactPercent?: number | null
  unpromotedRecommendedEbayPrice?: number | null
  promotedRecommendedEbayPrice?: number | null
  adFeeTaxPercent?: number | null
}

async function getStoreByCode(
  workspaceId: string,
  storeCode: string
): Promise<{ id: number; name: string; storeCode: string } | null> {
  const res = await query<{ id: number; name: string; store_code: string }>(
    `SELECT id, name, store_code FROM stores
     WHERE workspace_id = $1::uuid AND store_code = $2 AND status = 'active' LIMIT 1`,
    [workspaceId, storeCode.trim()]
  )
  const row = res.rows[0]
  if (!row) return null
  return { id: row.id, name: row.name, storeCode: row.store_code }
}

async function persistResolvedEbayOfferId(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
  offerId: string
}): Promise<void> {
  const offerId = input.offerId.trim()
  if (!offerId) return
  await query(
    `UPDATE store_catalog_state
     SET ebay_offer_id = $4::text,
         updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND store_id = $2::bigint
       AND id = $3::bigint
       AND (ebay_offer_id IS NULL OR ebay_offer_id <> $4::text)`,
    [input.workspaceId, input.storeId, input.catalogStateId, offerId]
  )
}

type OfferPricePolicyFallback = {
  categoryId?: string
  merchantLocationKey?: string
  listingDescription?: string
  listingPolicies?: {
    fulfillmentPolicyId: string
    paymentPolicyId: string
    returnPolicyId: string
  }
}

function priceCents(n: number): number {
  return Math.round(n * 100)
}

function pricesEqual(a: number, b: number): boolean {
  return priceCents(a) === priceCents(b)
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Inventory listings must only ever be changed through the Inventory API.
 * GetItem is the buyer-facing readback, but it can lag the accepted inventory
 * mutation briefly.  Do not turn that harmless propagation delay into a
 * ReviseFixedPriceItem call: eBay rejects Trading revisions for these offers.
 */
async function readInventoryPriceUntilVisible(
  client: ListingPriceUpdateEbayClient,
  itemId: string,
  targetPrice: number
): Promise<EbayTradingItemSnapshot | null> {
  let snapshot: EbayTradingItemSnapshot | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    snapshot = await client.getTradingItemSnapshot(itemId)
    const actual = snapshot?.currentPrice ?? snapshot?.startPrice
    if (actual != null && pricesEqual(actual, targetPrice)) return snapshot
    if (attempt < 3) await wait(750)
  }
  return snapshot
}

async function writePriceMutationReceipt(input: {
  workspaceId: string; storeId?: number; storeCode: string; itemId: string; sku: string; offerId: string
  target: number; method: string; outcome: string; after?: number | null; error?: unknown
}): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : input.error == null ? null : String(input.error)
  const http = message?.match(/HTTP\s+(\d{3})/i)?.[1]
  const code = message?.match(/\b(25002)\b/)?.[1] ?? null
  await query(
    `INSERT INTO ebay_price_mutation_receipts (workspace_id,store_id,account_store_code,ebay_item_id,sku,offer_id,target_price,mutation_method,endpoint,http_status,ebay_error_code,ebay_error_message,trading_price_after,verified_at,final_outcome)
     VALUES ($1::uuid,$2::bigint,$3,$4,$5,$6,$7::numeric,$8,$9,$10::int,$11,$12,$13::numeric,NOW(),$14)`,
    [input.workspaceId,input.storeId ?? null,input.storeCode,input.itemId || null,input.sku || null,input.offerId || null,input.target,input.method,
      input.method === "inventory" ? "bulk_update_price_quantity" : "ReviseFixedPriceItem",http ? Number(http) : null,code,message,input.after ?? null,input.outcome]
  )
}

export type ListingPriceUpdateEbayClient = {
  getOffers(sku?: string, limit?: number, offset?: number): Promise<EbayGetOffersPage>
  getOfferById(offerId: string): Promise<EbayActiveListingPriceRow | null>
  getInventoryItemOrNull(sku: string): Promise<{
    sku: string
    availability?: { shipToLocationAvailability?: { quantity?: number } }
  } | null>
  getTradingItemSnapshot(itemId: string): Promise<EbayTradingItemSnapshot | null>
  updateOfferPriceById(
    offerId: string,
    newPrice: number,
    policyFallback?: OfferPricePolicyFallback
  ): Promise<void>
  reviseFixedPriceItemPrice(
    itemId: string,
    price: number
  ): Promise<{ warnings: EbayTradingDiagnostic[] }>
  updateLiveOfferPriceQuantity?(input: { sku: string; offerId: string; price: number; quantity: number }): Promise<void>
}

export type ListingPriceUpdateResult = {
  method: "inventory" | "trading"
  offerId?: string
  warnings?: EbayTradingDiagnostic[]
  mutated: boolean
  readbackPrice: number
  readbackQty: number | null
}

export async function readListingEbayPriceFromClient(
  client: ListingPriceUpdateEbayClient,
  input: { sku: string; itemId: string; offerIdFromDb: string }
): Promise<number | null> {
  if (input.itemId.trim()) {
    const live = await client.getTradingItemSnapshot(input.itemId)
    const price = live?.currentPrice ?? live?.startPrice
    if (price != null && price > 0) return price
  }
  const identity = await resolveEbayListingIdentity(client, input)
  if (identity.offerPrice != null && identity.offerPrice > 0) return identity.offerPrice
  return null
}

function inventoryQty(
  item: { availability?: { shipToLocationAvailability?: { quantity?: number } } } | null
): number | null {
  const q = item?.availability?.shipToLocationAvailability?.quantity
  return typeof q === "number" && Number.isFinite(q) ? q : null
}

export async function runListingPriceUpdate(input: {
  client: ListingPriceUpdateEbayClient
  sku: string
  itemId: string
  offerIdFromDb: string
  newPrice: number
  listingLive?: boolean
  /** Only explicit, user-confirmed price changes may lower a live listing price. */
  allowPriceDecrease?: boolean
  policyFallback?: OfferPricePolicyFallback
  persistOffer?: (offerId: string) => Promise<void>
  listingIdIndex?: Map<string, import("../ebay/ebayApiClient").EbayActiveListingPriceRow[]>
  maxListingScanPages?: number
}): Promise<ListingPriceUpdateResult> {
  if (!Number.isFinite(input.newPrice) || input.newPrice <= 0) {
    throw new Error("newPrice must be > 0")
  }
  if (input.listingLive === false) {
    throw new Error("Listing is not live — refusing price update")
  }

  const sku = input.sku.trim()
  const itemId = input.itemId.trim()
  if (!sku && !itemId && !input.offerIdFromDb.trim()) {
    throw new Error("Missing SKU, offer ID, and eBay item ID — cannot update price")
  }

  const identity = await resolveEbayListingIdentity(input.client, {
    sku,
    itemId,
    offerIdFromDb: input.offerIdFromDb,
    listingLive: input.listingLive,
    listingIdIndex: input.listingIdIndex,
    maxListingScanPages: input.maxListingScanPages ?? 0,
  })
  if (identity.status === "LISTING_ENDED") {
    throw new Error("Listing is not Active — refusing price update")
  }
  if (identity.status === "AMBIGUOUS" || identity.status === "STORE_MISMATCH" || identity.status === "MARKETPLACE_MISMATCH" || identity.status === "SKU_MISMATCH") {
    throw new Error(`eBay offer identity ${identity.status} — refusing mutation`)
  }
  if (identity.status === "API_ERROR") {
    throw new Error("eBay offer identity API_ERROR — refusing mutation")
  }

  const qtyBefore = identity.canonicalQty
  const offerId = identity.offerId
  const inventorySku = identity.inventorySku || sku

  if (identity.status === "RESOLVED_INVENTORY" && offerId) {
    await input.persistOffer?.(offerId)
    // Offer GET is not buyer-visible truth. Always check the live Trading item.
    const liveBefore = itemId ? await input.client.getTradingItemSnapshot(itemId) : null
    const liveBeforePrice = liveBefore?.currentPrice ?? liveBefore?.startPrice ?? null
    if (liveBeforePrice != null && pricesEqual(liveBeforePrice, input.newPrice)) {
      return {
        method: "inventory",
        offerId,
        mutated: false,
        readbackPrice: liveBeforePrice,
        readbackQty: qtyBefore,
      }
    }
    const noDecreaseBaseline = liveBeforePrice ?? identity.offerPrice
    if (!input.allowPriceDecrease && noDecreaseBaseline != null && noDecreaseBaseline > 0 && priceCents(input.newPrice) <= priceCents(noDecreaseBaseline)) {
      throw new Error("Refusing eBay price decrease or no-op")
    }
    if (qtyBefore == null || !itemId || !input.client.updateLiveOfferPriceQuantity) throw new Error("Live Inventory price update identity incomplete")
    await input.client.updateLiveOfferPriceQuantity({ sku: inventorySku, offerId, price: input.newPrice, quantity: qtyBefore })
    const liveAfter = await readInventoryPriceUntilVisible(input.client, itemId, input.newPrice)
    const liveAfterPrice = liveAfter?.currentPrice ?? liveAfter?.startPrice
    if (liveAfterPrice == null || !pricesEqual(liveAfterPrice, input.newPrice)) {
      throw new Error("eBay Inventory update was accepted but live listing readback did not match target price")
    }
    return {
      method: "inventory",
      offerId,
      mutated: true,
      readbackPrice: liveAfterPrice,
      readbackQty: liveAfter?.quantityAvailable ?? liveAfter?.quantity ?? qtyBefore,
    }
  }

  if (identity.model === "INVENTORY_SINGLE_SKU" || identity.model === "INVENTORY_VARIATION") {
    throw new Error(
      `Inventory offer not found for SKU=${sku}; refusing Trading ReviseFixedPriceItem`
    )
  }

  if (identity.status !== "RESOLVED_TRADING_LEGACY" || !itemId) {
    throw new Error("Inventory item price update failed; offer lookup required")
  }

  const snap = await input.client.getTradingItemSnapshot(itemId)
  if (!snap) {
    throw new Error("Trading GetItem failed — refusing price update")
  }
  const listingStatus = (snap.listingStatus ?? "").toUpperCase()
  if (listingStatus && listingStatus !== "ACTIVE") {
    throw new Error("Listing is not Active — refusing price update")
  }
  const current = snap.currentPrice ?? snap.startPrice
  const qtyTradingBefore = snap.quantityAvailable ?? snap.quantity
  if (current != null && pricesEqual(current, input.newPrice)) {
    return {
      method: "trading",
      mutated: false,
      readbackPrice: current,
      readbackQty: qtyTradingBefore,
    }
  }
  if (!input.allowPriceDecrease && current != null && current > 0 && priceCents(input.newPrice) <= priceCents(current)) {
    throw new Error("Refusing eBay price decrease or no-op")
  }

  console.log(`[eBayPriceUpdate] route=trading itemId=${itemId}`)
  const revised = await input.client.reviseFixedPriceItemPrice(itemId, input.newPrice)
  const afterSnap = await input.client.getTradingItemSnapshot(itemId)
  const afterPrice = afterSnap?.currentPrice ?? afterSnap?.startPrice
  if (afterPrice == null || !pricesEqual(afterPrice, input.newPrice)) {
    throw new Error("eBay Trading readback did not match target price")
  }
  const qtyTradingAfter = afterSnap?.quantityAvailable ?? afterSnap?.quantity ?? null
  if (qtyTradingBefore != null && qtyTradingAfter != null && qtyTradingAfter !== qtyTradingBefore) {
    throw new Error("Quantity changed during price update")
  }
  return {
    method: "trading",
    warnings: revised.warnings,
    mutated: true,
    readbackPrice: afterPrice,
    readbackQty: qtyTradingAfter,
  }
}

async function loadStoreOfferPolicyFallback(
  workspaceId: string,
  storeId: number
): Promise<OfferPricePolicyFallback | undefined> {
  const settings = await getSettingsByStore(workspaceId, storeId)
  if (!settings) return undefined
  const fulfillmentPolicyId = settings.fulfillmentPolicyId?.trim() ?? ""
  const paymentPolicyId = settings.paymentPolicyId?.trim() ?? ""
  const returnPolicyId = settings.returnPolicyId?.trim() ?? ""
  const merchantLocationKey = settings.merchantLocationKey?.trim() ?? ""
  if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId || !merchantLocationKey) {
    return undefined
  }
  return {
    merchantLocationKey,
    listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId },
  }
}

export async function loadCatalogListingForPrice(
  workspaceId: string,
  storeCode: string,
  catalogStateId: number
): Promise<CatalogListingPriceRow | null> {
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
  }>(
    `SELECT scs.id,
            scs.store_id,
            s.store_code,
            s.name,
            scs.internal_sku,
            scs.ebay_item_id,
            scs.ebay_offer_id,
            scs.ebay_price::text,
            scs.source_price::text
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id AND s.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND s.store_code = $2
       AND scs.id = $3::bigint
       AND s.status = 'active'
     LIMIT 1`,
    [workspaceId, storeCode.trim(), catalogStateId]
  )
  const row = res.rows[0]
  if (!row) return null
  const ep = row.ebay_price != null ? parseFloat(row.ebay_price) : NaN
  const sp = row.source_price != null ? parseFloat(row.source_price) : NaN
  return {
    id: row.id,
    storeId: row.store_id,
    storeCode: row.store_code,
    storeName: row.name,
    internalSku: row.internal_sku?.trim() || null,
    ebayItemId: row.ebay_item_id?.trim() || null,
    ebayOfferId: row.ebay_offer_id?.trim() || null,
    ebayPrice: Number.isFinite(ep) ? ep : null,
    sourcePrice: Number.isFinite(sp) ? sp : null,
  }
}

export async function getRecommendedPriceForListing(
  workspaceId: string,
  storeCode: string,
  catalogStateId: number
): Promise<RecommendedPriceResponse> {
  const listing = await loadCatalogListingForPrice(workspaceId, storeCode, catalogStateId)
  if (!listing) throw new Error("Listing not found")

  const amazon = listing.sourcePrice
  if (amazon == null || amazon <= 0) {
    throw new Error("Amazon source price is not available for this listing")
  }

  const promotion = await loadPromotionPricingContext({
    workspaceId,
    storeId: listing.storeId,
    catalogStateId,
  })
  const calc = await calculateRecommendedEbayPrice({
    workspaceId,
    storeId: listing.storeId,
    amazonPrice: amazon,
    promotion,
  })

  if (calc.pricingSource === "unavailable" || calc.recommendedEbayPrice <= 0) {
    throw new Error("Recommended price unavailable — check store pricing settings (markup %)")
  }

  return {
    ok: true,
    amazonPrice: calc.amazonPrice,
    currentEbayPrice: listing.ebayPrice ?? 0,
    storeMarkupPercent: calc.storeMarkupPercent,
    recommendedEbayPrice: calc.recommendedEbayPrice,
    pricingSource: calc.pricingSource,
    ...(calc.promotionApplied
      ? {
          promotionAdRatePercent: calc.promotionAdRatePercent,
          promotionFeeImpactPercent: calc.effectiveAdCostPercent,
          unpromotedRecommendedEbayPrice: calc.unpromotedRecommendedEbayPrice,
          promotedRecommendedEbayPrice: calc.promotedRecommendedEbayPrice,
          adFeeTaxPercent: calc.adFeeTaxPercent,
        }
      : {}),
  }
}

async function loadStoredEbayOfferId(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
}): Promise<string | null> {
  const res = await query<{ ebay_offer_id: string | null }>(
    `SELECT ebay_offer_id
     FROM store_catalog_state
     WHERE workspace_id = $1::uuid
       AND store_id = $2::bigint
       AND id = $3::bigint
     LIMIT 1`,
    [input.workspaceId, input.storeId, input.catalogStateId]
  )
  const id = res.rows[0]?.ebay_offer_id?.trim()
  return id && id.length > 0 ? id : null
}

export async function updateListingPriceOnEbay(
  workspaceId: string,
  storeCode: string,
  input: {
    internalSku: string | null
    ebayItemId: string | null
    ebayOfferId: string | null
    newPrice: number
    catalogStateId?: number
    storeId?: number
    listingLive?: boolean
    /** Only explicit, user-confirmed price changes may lower a live listing price. */
    allowPriceDecrease?: boolean
  }
): Promise<ListingPriceUpdateResult> {
  if (ebaySimulationExplicitlyOn()) {
    recordEbayMutation("price", "blocked")
    throw new Error("EBAY_SIMULATION=true — refusing eBay price mutation")
  }

  const sku = input.internalSku?.trim() || ""
  const itemId = input.ebayItemId?.trim() || ""
  let offerIdFromDb = input.ebayOfferId?.trim() || ""

  if (
    !offerIdFromDb &&
    input.catalogStateId != null &&
    input.storeId != null
  ) {
    offerIdFromDb = (await loadStoredEbayOfferId({
      workspaceId,
      storeId: input.storeId,
      catalogStateId: input.catalogStateId,
    })) ?? ""
  }

  let listingLive = input.listingLive
  if (listingLive == null && input.catalogStateId != null && input.storeId != null) {
    const liveRes = await query<{ current_status: string | null }>(
      `SELECT current_status::text AS current_status
       FROM store_catalog_state
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint AND id = $3::bigint
       LIMIT 1`,
      [workspaceId, input.storeId, input.catalogStateId]
    )
    const st = String(liveRes.rows[0]?.current_status ?? "live").trim().toLowerCase()
    listingLive = st === "live" || st === ""
  }

  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
  const token = await getValidAccessToken(workspaceId, storeCode, false)
  const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })
  const policyFallback =
    input.storeId != null
      ? await loadStoreOfferPolicyFallback(workspaceId, input.storeId)
      : undefined

  try {
    const result = await runListingPriceUpdate({
    client,
    sku,
    itemId,
    offerIdFromDb,
    newPrice: input.newPrice,
    listingLive,
    allowPriceDecrease: input.allowPriceDecrease,
    policyFallback,
    persistOffer: async (offerId: string) => {
      if (input.catalogStateId != null && input.storeId != null && itemId) {
        await persistExactEbayOfferMapping({
          workspaceId,
          storeId: input.storeId,
          catalogStateId: input.catalogStateId,
          ebayItemId: itemId,
          offerId,
        })
        return
      }
      if (input.catalogStateId != null && input.storeId != null) {
        await persistResolvedEbayOfferId({
          workspaceId,
          storeId: input.storeId,
          catalogStateId: input.catalogStateId,
          offerId,
        })
      }
    },
    })
    try {
      await writePriceMutationReceipt({ workspaceId, storeId: input.storeId, storeCode, itemId, sku, offerId: result.offerId ?? offerIdFromDb, target: input.newPrice, method: result.method, after: result.readbackPrice, outcome: result.method === "inventory" ? "INVENTORY_SUCCESS_TRADING_CONFIRMED" : "TRADING_FALLBACK_SUCCESS" })
    } catch (receiptError) {
      console.error("[eBayPriceUpdate] durable receipt write failed after verified mutation:", receiptError)
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const outcome = /25002|duplicate.*listing/i.test(message) ? "DUPLICATE_25002_FALLBACK_FAILED" : /429|5\d\d/.test(message) ? "RETRYABLE_PROVIDER_FAILURE" : /STORE_MISMATCH|SKU_MISMATCH|AMBIGUOUS/.test(message) ? "STORE_OR_MAPPING_BLOCKED" : "PERMANENT_PROVIDER_FAILURE"
    try { await writePriceMutationReceipt({ workspaceId, storeId: input.storeId, storeCode, itemId, sku, offerId: offerIdFromDb, target: input.newPrice, method: "price_update", outcome, error }) }
    catch (receiptError) { console.error("[eBayPriceUpdate] durable receipt write failed:", receiptError) }
    throw error
  }
}

export async function persistCatalogEbayPrice(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
  newPrice: number
  manual?: boolean
  autoReason?: string | null
  oldPrice?: number | null
}): Promise<void> {
  if (input.manual) {
    await query(
      `UPDATE store_catalog_state
       SET ebay_price = $4::numeric,
           manual_price_updated_at = NOW(),
           updated_at = NOW()
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint AND id = $3::bigint`,
      [input.workspaceId, input.storeId, input.catalogStateId, input.newPrice]
    )
    return
  }

  await query(
    `UPDATE store_catalog_state
     SET ebay_price = $4::numeric,
         auto_price_protected_at = NOW(),
         auto_price_old_ebay_price = $5::numeric,
         auto_price_new_ebay_price = $4::numeric,
         auto_price_reason = $6::text,
         updated_at = NOW()
     WHERE workspace_id = $1::uuid AND store_id = $2::bigint AND id = $3::bigint
       AND ebay_price IS DISTINCT FROM $4::numeric`,
    [
      input.workspaceId,
      input.storeId,
      input.catalogStateId,
      input.newPrice,
      input.oldPrice ?? null,
      input.autoReason ?? "Auto profit protection",
    ]
  )
}

export async function updateEbayListingPrice(input: {
  workspaceId: string
  storeCode: string
  catalogStateId: number
  newPrice: number
}): Promise<{ ok: true; oldPrice: number; newPrice: number }> {
  const storeCode = input.storeCode.trim()
  if (!storeCode) throw new Error("storeCode is required")
  if (!Number.isFinite(input.newPrice) || input.newPrice <= 0) {
    throw new Error("newPrice must be > 0")
  }

  const listing = await loadCatalogListingForPrice(
    input.workspaceId,
    storeCode,
    input.catalogStateId
  )
  if (!listing) throw new Error("Listing not found")

  const oldPrice = listing.ebayPrice ?? 0
  if (Math.abs(oldPrice - input.newPrice) < 0.005) {
    throw new Error("New price is the same as current eBay price")
  }

  await updateListingPriceOnEbay(input.workspaceId, storeCode, {
    internalSku: listing.internalSku,
    ebayItemId: listing.ebayItemId,
    ebayOfferId: listing.ebayOfferId,
    newPrice: input.newPrice,
    catalogStateId: listing.id,
    storeId: listing.storeId,
  })

  await persistCatalogEbayPrice({
    workspaceId: input.workspaceId,
    storeId: listing.storeId,
    catalogStateId: listing.id,
    newPrice: input.newPrice,
    manual: true,
  })

  await resolvePendingFailedPriceIncreaseAlerts({
    workspaceId: input.workspaceId,
    storeId: listing.storeId,
    catalogStateId: listing.id,
    reason: "Resolved by manual eBay price update",
  })

  const store = await getStoreByCode(input.workspaceId, storeCode)
  void addNotification(
    input.workspaceId,
    "info",
    `eBay fiyatı güncellendi: $${oldPrice.toFixed(2)} → $${input.newPrice.toFixed(2)}`,
    `${store?.name?.trim() || storeCode} · ${listing.internalSku ?? listing.ebayItemId ?? ""}`
  )

  return { ok: true, oldPrice, newPrice: input.newPrice }
}
