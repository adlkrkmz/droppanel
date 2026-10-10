import { query } from "../../db/client"
import type {
  EbayActiveListingPriceRow,
  EbayGetOffersPage,
  EbayOfferSummary,
  EbayTradingItemSnapshot,
} from "./ebayApiClient"

export const EBAY_US_MARKETPLACE = "EBAY_US"
export const EBAY_USD = "USD"

export type EbayListingModel =
  | "INVENTORY_SINGLE_SKU"
  | "INVENTORY_VARIATION"
  | "TRADING_LEGACY"
  | "UNKNOWN"

export type EbayOfferResolveStatus =
  | "RESOLVED_INVENTORY"
  | "RESOLVED_TRADING_LEGACY"
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "STORE_MISMATCH"
  | "MARKETPLACE_MISMATCH"
  | "SKU_MISMATCH"
  | "LISTING_ENDED"
  | "API_ERROR"

export type EbayIdentityClient = {
  getOffers(sku?: string, limit?: number, offset?: number): Promise<EbayGetOffersPage>
  listOffersPage?(limit?: number, offset?: number): Promise<EbayGetOffersPage>
  getOfferById(offerId: string): Promise<EbayActiveListingPriceRow | null>
  getInventoryItemOrNull(sku: string): Promise<{
    sku: string
    availability?: { shipToLocationAvailability?: { quantity?: number } }
  } | null>
  getTradingItemSnapshot(itemId: string): Promise<EbayTradingItemSnapshot | null>
}

export type EbayOfferResolveInput = {
  sku: string
  itemId: string
  offerIdFromDb: string
  listingLive?: boolean
  expectedMarketplace?: string
  expectedCurrency?: string
  listingIdIndex?: Map<string, EbayActiveListingPriceRow[]>
  maxListingScanPages?: number
}

export type EbayOfferResolveResult = {
  status: EbayOfferResolveStatus
  model: EbayListingModel
  offerId: string | null
  inventorySku: string | null
  listingId: string | null
  marketplaceId: string | null
  offerPrice: number | null
  offerCurrency: string | null
  offerAvailableQty: number | null
  inventoryQty: number | null
  offerStatus: string | null
  canonicalQty: number | null
}

function offerFromSummary(o: EbayOfferSummary): EbayActiveListingPriceRow | null {
  const sku = typeof o.sku === "string" ? o.sku.trim() : ""
  const offerId = typeof o.offerId === "string" ? o.offerId.trim() : ""
  if (!sku || !offerId) return null
  const raw = o.pricingSummary?.price?.value
  const price = raw == null || raw === "" ? NaN : parseFloat(String(raw))
  const listingRaw = o.listing?.listingId
  const listingId = typeof listingRaw === "string" && listingRaw.trim() ? listingRaw.trim() : null
  const q = o.availableQuantity
  const marketplaceId =
    typeof o.marketplaceId === "string" && o.marketplaceId.trim() ? o.marketplaceId.trim() : null
  return {
    sku,
    offerId,
    listingId,
    price: Number.isFinite(price) ? price : 0,
    availableQuantity: typeof q === "number" && Number.isFinite(q) ? q : 0,
    currency: o.pricingSummary?.price?.currency?.trim() || "USD",
    offerStatus: typeof o.status === "string" ? o.status.trim() : null,
    marketplaceId,
  }
}

function inventoryQty(
  item: { availability?: { shipToLocationAvailability?: { quantity?: number } } } | null
): number | null {
  const q = item?.availability?.shipToLocationAvailability?.quantity
  return typeof q === "number" && Number.isFinite(q) ? q : null
}

function resolved(
  status: EbayOfferResolveStatus,
  model: EbayListingModel,
  extra: Partial<EbayOfferResolveResult> = {}
): EbayOfferResolveResult {
  return {
    status,
    model,
    offerId: null,
    inventorySku: null,
    listingId: null,
    marketplaceId: extra.marketplaceId ?? null,
    offerPrice: null,
    offerCurrency: null,
    offerAvailableQty: null,
    inventoryQty: extra.inventoryQty ?? null,
    offerStatus: null,
    canonicalQty: extra.canonicalQty ?? extra.inventoryQty ?? null,
    ...extra,
  }
}

function marketplaceOk(row: EbayActiveListingPriceRow, expected: string): boolean {
  const m = row.marketplaceId?.trim()
  if (!m) return true
  return m.toUpperCase() === expected.toUpperCase()
}

function currencyOk(row: EbayActiveListingPriceRow, expected: string): boolean {
  const c = row.currency?.trim()
  if (!c) return true
  return c.toUpperCase() === expected.toUpperCase()
}

async function verifyOffer(
  client: EbayIdentityClient,
  offerId: string,
  input: { sku: string; itemId: string; expectedMarketplace: string; expectedCurrency: string }
): Promise<
  | { ok: true; row: EbayActiveListingPriceRow }
  | { ok: false; status: EbayOfferResolveStatus }
> {
  const row = await client.getOfferById(offerId)
  if (!row?.offerId) return { ok: false, status: "NOT_FOUND" }
  if (input.itemId && row.listingId && row.listingId !== input.itemId) {
    return { ok: false, status: "STORE_MISMATCH" }
  }
  if (input.sku && row.sku && row.sku !== input.sku) {
    if (!(input.itemId && row.listingId === input.itemId)) {
      return { ok: false, status: "SKU_MISMATCH" }
    }
  }
  if (!marketplaceOk(row, input.expectedMarketplace)) {
    return { ok: false, status: "MARKETPLACE_MISMATCH" }
  }
  if (!currencyOk(row, input.expectedCurrency)) {
    return { ok: false, status: "MARKETPLACE_MISMATCH" }
  }
  return { ok: true, row }
}

function pickUniqueByListingId(
  rows: EbayActiveListingPriceRow[],
  itemId: string
): { unique: EbayActiveListingPriceRow | null; ambiguous: boolean } {
  const matched = itemId ? rows.filter(r => r.listingId === itemId) : rows
  if (matched.length > 1) return { unique: null, ambiguous: true }
  if (matched.length === 1) return { unique: matched[0], ambiguous: false }
  return { unique: null, ambiguous: false }
}

async function scanListingId(
  client: EbayIdentityClient,
  itemId: string,
  maxPages: number
): Promise<{ unique: EbayActiveListingPriceRow | null; ambiguous: boolean; error?: boolean }> {
  if (!itemId) return { unique: null, ambiguous: false }
  const hits: EbayActiveListingPriceRow[] = []
  const limit = 100
  let offset = 0
  try {
    for (let page = 0; page < maxPages; page++) {
      const p = await (client.listOffersPage
        ? client.listOffersPage(limit, offset)
        : client.getOffers(undefined, limit, offset))
      for (const raw of p.offers ?? []) {
        const row = offerFromSummary(raw)
        if (row?.listingId === itemId) hits.push(row)
      }
      const got = p.offers?.length ?? 0
      if (hits.length > 1) return { unique: null, ambiguous: true }
      if (got === 0) break
      const total = typeof p.total === "number" ? p.total : 0
      if (total > 0 && offset + got >= total) break
      if (got < limit) break
      offset += got
    }
  } catch {
    return { unique: null, ambiguous: false, error: true }
  }
  if (hits.length > 1) return { unique: null, ambiguous: true }
  return { unique: hits[0] ?? null, ambiguous: false }
}

export async function resolveEbayListingIdentity(
  client: EbayIdentityClient,
  input: EbayOfferResolveInput
): Promise<EbayOfferResolveResult> {
  const sku = input.sku.trim()
  const itemId = input.itemId.trim()
  const expectedMarketplace = (input.expectedMarketplace ?? EBAY_US_MARKETPLACE).trim() || EBAY_US_MARKETPLACE
  const expectedCurrency = (input.expectedCurrency ?? EBAY_USD).trim() || EBAY_USD
  if (input.listingLive === false) {
    return resolved("LISTING_ENDED", "UNKNOWN")
  }

  let inventoryQtyVal: number | null = null
  let inventoryExists = false
  if (sku) {
    try {
      const inv = await client.getInventoryItemOrNull(sku)
      if (inv) {
        inventoryExists = true
        inventoryQtyVal = inventoryQty(inv)
      }
    } catch {
      return resolved("API_ERROR", "UNKNOWN")
    }
  }

  const toInventoryResult = async (
    row: EbayActiveListingPriceRow
  ): Promise<EbayOfferResolveResult> => {
    const checked = await verifyOffer(client, row.offerId, {
      sku: sku || row.sku,
      itemId,
      expectedMarketplace,
      expectedCurrency,
    })
    if (checked.ok === false) {
      return resolved(checked.status, inventoryExists ? "INVENTORY_SINGLE_SKU" : "UNKNOWN", {
        inventoryQty: inventoryQtyVal,
        canonicalQty: inventoryQtyVal,
      })
    }
    const v = checked.row
    const invSku = v.sku || sku
    let qty = inventoryQtyVal
    if (qty == null && invSku) {
      const inv = await client.getInventoryItemOrNull(invSku)
      qty = inventoryQty(inv)
    }
    return resolved("RESOLVED_INVENTORY", "INVENTORY_SINGLE_SKU", {
      offerId: v.offerId,
      inventorySku: invSku,
      listingId: v.listingId,
      marketplaceId: v.marketplaceId ?? expectedMarketplace,
      offerPrice: v.price,
      offerCurrency: v.currency,
      offerAvailableQty: v.availableQuantity,
      inventoryQty: qty,
      offerStatus: v.offerStatus ?? null,
      canonicalQty: qty,
    })
  }

  if (input.offerIdFromDb.trim()) {
    const checked = await verifyOffer(client, input.offerIdFromDb.trim(), {
      sku,
      itemId,
      expectedMarketplace,
      expectedCurrency,
    }).catch(() => null)
    if (checked && checked.ok) {
      return toInventoryResult(checked.row)
    }
    if (
      checked &&
      (checked.status === "STORE_MISMATCH" ||
        checked.status === "MARKETPLACE_MISMATCH" ||
        checked.status === "SKU_MISMATCH")
    ) {
      return resolved(checked.status, inventoryExists ? "INVENTORY_SINGLE_SKU" : "UNKNOWN", {
        inventoryQty: inventoryQtyVal,
        canonicalQty: inventoryQtyVal,
      })
    }
  }

  if (sku) {
    try {
      const page = await client.getOffers(sku, 50, 0)
      const rows = (page.offers ?? [])
        .map(offerFromSummary)
        .filter((r): r is EbayActiveListingPriceRow => r != null)
      const { unique, ambiguous } = pickUniqueByListingId(rows, itemId)
      if (ambiguous) {
        return resolved("AMBIGUOUS", inventoryExists ? "INVENTORY_SINGLE_SKU" : "UNKNOWN", {
          inventoryQty: inventoryQtyVal,
          canonicalQty: inventoryQtyVal,
        })
      }
      if (unique) return toInventoryResult(unique)
    } catch {
      return resolved("API_ERROR", inventoryExists ? "INVENTORY_SINGLE_SKU" : "UNKNOWN", {
        inventoryQty: inventoryQtyVal,
      })
    }
  }

  if (itemId && input.listingIdIndex) {
    const indexed = input.listingIdIndex.get(itemId) ?? []
    if (indexed.length > 1) {
      return resolved("AMBIGUOUS", inventoryExists ? "INVENTORY_SINGLE_SKU" : "UNKNOWN", {
        inventoryQty: inventoryQtyVal,
      })
    }
    if (indexed.length === 1) return toInventoryResult(indexed[0])
  } else if (itemId && (input.maxListingScanPages ?? 0) > 0) {
    const scanned = await scanListingId(client, itemId, input.maxListingScanPages ?? 0)
    if (scanned.error) {
      return resolved("API_ERROR", inventoryExists ? "INVENTORY_SINGLE_SKU" : "UNKNOWN", {
        inventoryQty: inventoryQtyVal,
      })
    }
    if (scanned.ambiguous) {
      return resolved("AMBIGUOUS", inventoryExists ? "INVENTORY_SINGLE_SKU" : "UNKNOWN", {
        inventoryQty: inventoryQtyVal,
      })
    }
    if (scanned.unique) return toInventoryResult(scanned.unique)
  }

  if (inventoryExists) {
    return resolved("NOT_FOUND", "INVENTORY_SINGLE_SKU", {
      inventoryQty: inventoryQtyVal,
      canonicalQty: inventoryQtyVal,
      inventorySku: sku || null,
      listingId: itemId || null,
    })
  }

  if (!itemId) {
    return resolved("NOT_FOUND", "UNKNOWN")
  }

  try {
    const snap = await client.getTradingItemSnapshot(itemId)
    if (!snap) return resolved("NOT_FOUND", "UNKNOWN")
    const st = (snap.listingStatus ?? "").toUpperCase()
    if (st && st !== "ACTIVE") {
      return resolved("LISTING_ENDED", "TRADING_LEGACY", { listingId: itemId })
    }
    if (snap.hasVariations) {
      return resolved("AMBIGUOUS", "INVENTORY_VARIATION", { listingId: itemId })
    }
    return resolved("RESOLVED_TRADING_LEGACY", "TRADING_LEGACY", {
      listingId: itemId,
      inventorySku: snap.sku,
      offerPrice: snap.currentPrice ?? snap.startPrice,
      canonicalQty: snap.quantityAvailable ?? snap.quantity,
    })
  } catch {
    return resolved("API_ERROR", "UNKNOWN")
  }
}

export async function persistExactEbayOfferMapping(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
  ebayItemId: string
  offerId: string
}): Promise<boolean> {
  const offerId = input.offerId.trim()
  const itemId = input.ebayItemId.trim()
  if (!offerId || !itemId) return false
  const res = await query<{ id: number }>(
    `UPDATE store_catalog_state
     SET ebay_offer_id = $4::text, updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND store_id = $2::bigint
       AND id = $3::bigint
       AND current_status = 'live'
       AND trim(ebay_item_id) = $5
       AND (ebay_offer_id IS NULL OR trim(ebay_offer_id) <> $4::text)
     RETURNING id`,
    [input.workspaceId, input.storeId, input.catalogStateId, offerId, itemId]
  )
  return Boolean(res.rows[0]?.id)
}

export async function persistExactEbayOfferMappingUniqueLiveItem(input: {
  workspaceId: string
  storeId: number
  ebayItemId: string
  offerId: string
}): Promise<boolean> {
  const offerId = input.offerId.trim()
  const itemId = input.ebayItemId.trim()
  if (!offerId || !itemId) return false
  const res = await query<{ id: number }>(
    `UPDATE store_catalog_state t
     SET ebay_offer_id = $3::text, updated_at = NOW()
     FROM (
       SELECT id
       FROM store_catalog_state
       WHERE workspace_id = $1::uuid
         AND store_id = $2::bigint
         AND current_status = 'live'
         AND panel_hidden_at IS NULL
         AND trim(ebay_item_id) = $4
     ) s
     WHERE t.id = s.id
       AND (
         SELECT COUNT(*)::int
         FROM store_catalog_state
         WHERE workspace_id = $1::uuid
           AND store_id = $2::bigint
           AND current_status = 'live'
           AND panel_hidden_at IS NULL
           AND trim(ebay_item_id) = $4
       ) = 1
       AND (t.ebay_offer_id IS NULL OR trim(t.ebay_offer_id) <> $3::text)
     RETURNING t.id`,
    [input.workspaceId, input.storeId, offerId, itemId]
  )
  return Boolean(res.rows[0]?.id)
}

export function canonicalQuantityForIdentity(result: EbayOfferResolveResult): number | null {
  if (result.model === "INVENTORY_SINGLE_SKU" || result.model === "INVENTORY_VARIATION") {
    return result.inventoryQty
  }
  return result.canonicalQty
}
