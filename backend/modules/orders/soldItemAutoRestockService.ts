// ----------------------------------------------------------------
// soldItemAutoRestockService.ts — sold-item auto-restock (target qty when live < target)
//
// Flow per store:
//   1. Fetch orders modified in last 24h → upsert via ordersSyncService
//   2. Restock only line items whose order creationDate is within 24h
//   3. Skip variations when variation-specific quantity cannot be read safely
//   4. If live eBay qty < SOLD_ITEM_RESTOCK_TARGET_QUANTITY → quantity-only update to target
// ----------------------------------------------------------------

import { EbayApiClient, type EbayOrderLineItem, type EbayOrderRow } from "../ebay/ebayApiClient"
import { getValidAccessTokenByStoreId } from "../ebayOAuth/ebayOAuthService"
import {
  RECENT_ORDER_WINDOW_MS,
  RESTOCK_ORDER_WINDOW_MINUTES,
  syncRecentOrdersForStore,
} from "./ordersSyncService"
import { syncOrderEarningsForEbayOrderIds } from "./ordersEarningsService"
import type { OrderStore } from "./ordersRepository"
import { setListingQuantityOnEbay } from "../stockAlerts/stockAlertsEbayZeroService"
import {
  SOLD_ITEM_RESTOCK_TARGET_QUANTITY,
  shouldRestockSoldItem,
} from "./soldItemAutoRestockDecision"
import {
  findCatalogForSale,
  hasBlockingRestockEvent,
  insertRestockEvent,
  listActiveEbayStores,
  listAllActiveEbayStores,
  updateLocalCatalogQuantity,
  type CatalogListingRow,
  type RestockAction,
  type RestockStore,
} from "./soldItemAutoRestockRepository"

const LOG = "[SoldItemAutoRestock]"

export {
  SOLD_ITEM_RESTOCK_TARGET_QUANTITY,
  shouldRestockSoldItem,
} from "./soldItemAutoRestockDecision"
export { RECENT_ORDER_WINDOW_MS as RESTOCK_ORDER_WINDOW_MS, RESTOCK_ORDER_WINDOW_MINUTES }

export type RestockStoreResult = {
  workspaceId?:               string
  storeId?:                   number
  storeCode:                  string
  storeName:                  string
  skipped:                    boolean
  skipReason?:                string
  ordersFetched:              number
  ordersUpserted:             number
  itemsUpserted:              number
  lineItemsSeen:              number
  alreadyHandled:             number
  stockChecks:                number
  restocked:                  number
  /** Live qty already at/above target — no eBay update. */
  skippedAtOrAboveTarget:     number
  skippedNoCatalog:           number
  skippedCheckFailed:         number
  skippedOldOrder:            number
  skippedVariation:           number
  failed:                     number
}

export type RestockRunResult = {
  windowMinutes: number
  stores:        RestockStoreResult[]
}

function lineItemKey(li: EbayOrderLineItem, orderId: string): string {
  return (
    li.lineItemId?.trim() ||
    li.legacyItemId?.trim() ||
    `${orderId}:${li.sku ?? ""}:${li.title ?? ""}`
  )
}

function toOrderStore(store: RestockStore): OrderStore {
  return { id: store.storeId, storeCode: store.storeCode, name: store.name }
}

/** Restock eligibility: order sale/creation time within window (not lastModified). */
function isOrderCreatedWithinWindow(order: EbayOrderRow, windowMs: number): boolean {
  const created = order.creationDate?.trim()
  if (!created) return false
  const t = new Date(created).getTime()
  if (Number.isNaN(t)) return false
  return t >= Date.now() - windowMs
}

function getLegacyVariationId(li: EbayOrderLineItem): string | null {
  const direct = li.legacyVariationId?.trim()
  if (direct) return direct
  const raw = li.raw?.legacyVariationId
  if (typeof raw === "string" && raw.trim()) return raw.trim()
  return null
}

function isVariationLineItem(li: EbayOrderLineItem): boolean {
  return getLegacyVariationId(li) != null
}

/** Variation lines need SKU or offerId to read variation-specific quantity — never parent itemId. */
function canReadVariationQuantity(
  li:      EbayOrderLineItem,
  catalog: CatalogListingRow | null
): boolean {
  if (!isVariationLineItem(li)) return true
  const sku = li.sku?.trim() || catalog?.internalSku?.trim() || ""
  const offerId = catalog?.ebayOfferId?.trim() || ""
  return !!(sku || offerId)
}

type QtyInput = {
  internalSku:  string | null
  ebayItemId:   string | null
  ebayOfferId:  string | null
}

function buildQtyInput(
  li:              EbayOrderLineItem,
  catalog:         CatalogListingRow,
  variationSafe:   boolean
): QtyInput {
  const itemId = li.legacyItemId?.trim() || null
  return {
    internalSku: (catalog.internalSku ?? li.sku?.trim()) || null,
    ebayOfferId: catalog.ebayOfferId,
    // Variation: never fall back to parent listing itemId for qty read/update.
    ebayItemId: variationSafe && isVariationLineItem(li)
      ? null
      : (catalog.ebayItemId ?? itemId),
  }
}

/** Read current eBay listing quantity for one sold line (no catalog scan). */
async function getEbayListingQuantity(
  client:        EbayApiClient,
  input:         QtyInput,
  variationOnly: boolean
): Promise<number | null> {
  const sku     = input.internalSku?.trim() || ""
  const itemId  = input.ebayItemId?.trim() || ""
  const offerId = input.ebayOfferId?.trim() || ""

  if (offerId) {
    const row = await client.getOfferById(offerId)
    if (row) return row.availableQuantity
  }

  if (sku) {
    try {
      const page = await client.getOffers(sku, 10, 0)
      const offers = page.offers ?? []
      for (const o of offers) {
        const q = o.availableQuantity
        if (typeof q === "number" && Number.isFinite(q)) return q
      }
    } catch {
      /* fall through */
    }
    try {
      const inv = await client.getInventoryItem(sku) as {
        availability?: { shipToLocationAvailability?: { quantity?: number } }
      }
      const q = inv.availability?.shipToLocationAvailability?.quantity
      if (typeof q === "number" && Number.isFinite(q)) return q
    } catch {
      /* fall through */
    }
  }

  if (!variationOnly && itemId) {
    try {
      const oid = await client.getOfferIdByListingId(itemId)
      if (oid) {
        const row = await client.getOfferById(oid)
        if (row) return row.availableQuantity
      }
    } catch {
      /* fall through */
    }
    try {
      return await client.getItemQuantityAvailable(itemId)
    } catch {
      /* fall through */
    }
  }

  return null
}

async function recordEvent(
  workspaceId: string,
  storeId:     number,
  orderId:     string,
  lineId:      string,
  catalog:     CatalogListingRow | null,
  li:          EbayOrderLineItem,
  checkedQty:  number | null,
  action:      RestockAction,
  errorMessage?: string,
  restockedAt?: Date
): Promise<void> {
  await insertRestockEvent({
    workspaceId,
    storeId,
    ebayOrderId:     orderId,
    ebayLineItemId:  lineId,
    sku:             li.sku ?? catalog?.internalSku ?? null,
    ebayItemId:      li.legacyItemId ?? catalog?.ebayItemId ?? null,
    ebayOfferId:     catalog?.ebayOfferId ?? null,
    catalogStateId:  catalog?.catalogStateId ?? null,
    checkedQuantity: checkedQty,
    action,
    errorMessage:    errorMessage ?? null,
    restockedAt:     restockedAt ?? null,
  })
}

async function processStore(
  workspaceId: string,
  store:       RestockStore,
  sandbox:     boolean
): Promise<RestockStoreResult> {
  const base: RestockStoreResult = {
    workspaceId:        workspaceId,
    storeId:            store.storeId,
    storeCode:          store.storeCode,
    storeName:          store.name,
    skipped:            false,
    ordersFetched:      0,
    ordersUpserted:     0,
    itemsUpserted:      0,
    lineItemsSeen:      0,
    alreadyHandled:     0,
    stockChecks:        0,
    restocked:          0,
    skippedAtOrAboveTarget: 0,
    skippedNoCatalog:   0,
    skippedCheckFailed: 0,
    skippedOldOrder:    0,
    skippedVariation:   0,
    failed:             0,
  }

  const syncOutcome = await syncRecentOrdersForStore(
    workspaceId,
    toOrderStore(store),
    RECENT_ORDER_WINDOW_MS
  )

  if (syncOutcome.skipped) {
    console.log(`${LOG} store_id=${store.storeId} store=${store.storeCode} skipped: ${syncOutcome.skipReason ?? "unknown"}`)
    return { ...base, skipped: true, skipReason: syncOutcome.skipReason }
  }

  const orders = syncOutcome.orders
  base.ordersFetched = orders.length
  base.ordersUpserted = syncOutcome.upsertedOrders
  base.itemsUpserted = syncOutcome.upsertedItems

  if (orders.length === 0) {
    console.log(`${LOG} store_id=${store.storeId} store=${store.storeCode} no orders in last 24 hours — no stock checks`)
    return base
  }

  console.log(
    `${LOG} store_id=${store.storeId} store=${store.storeCode} upserted ${syncOutcome.upsertedOrders} order(s), ` +
    `${syncOutcome.upsertedItems} item(s); evaluating restock eligibility (24h window)`
  )

  // Same tick / same fetched order set: fill eBay Order earnings (not full-history scan).
  try {
    await syncOrderEarningsForEbayOrderIds(
      workspaceId,
      store.storeCode,
      orders.map((o) => o.orderId).filter((id): id is string => typeof id === "string" && id.trim().length > 0),
      store.storeId
    )
  } catch (e) {
    console.warn(
      `${LOG} store_id=${store.storeId} store=${store.storeCode} earnings sync error:`,
      e instanceof Error ? e.message : String(e)
    )
  }

  let token: string
  try {
    token = await getValidAccessTokenByStoreId(workspaceId, store.storeId, false)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`${LOG} store_id=${store.storeId} store=${store.storeCode} restock skipped: token unavailable (${msg})`)
    return { ...base, skipReason: "token_unavailable_for_restock" }
  }

  const client = new EbayApiClient({ oauthToken: token, sandbox, simulationMode: false })

  for (const order of orders) {
    const orderId = order.orderId?.trim()
    if (!orderId) continue

    const orderEligible = isOrderCreatedWithinWindow(order, RECENT_ORDER_WINDOW_MS)

    for (const li of order.lineItems ?? []) {
      base.lineItemsSeen++
      const lineId = lineItemKey(li, orderId)

      if (await hasBlockingRestockEvent(workspaceId, store.storeId, orderId, lineId)) {
        base.alreadyHandled++
        continue
      }

      if (!orderEligible) {
        base.skippedOldOrder++
        await recordEvent(workspaceId, store.storeId, orderId, lineId, null, li, null, "skipped_old_order")
        continue
      }

      if (isVariationLineItem(li) && !canReadVariationQuantity(li, null)) {
        base.skippedVariation++
        await recordEvent(
          workspaceId, store.storeId, orderId, lineId, null, li, null,
          "skipped_variation_not_supported",
          `legacyVariationId=${getLegacyVariationId(li)}`
        )
        console.log(
          `${LOG} store_id=${store.storeId} store=${store.storeCode} order=${orderId} line=${lineId} ` +
          `skipped: variation without sku/offerId variationId=${getLegacyVariationId(li)}`
        )
        continue
      }

      const itemId = li.legacyItemId?.trim() || null
      const sku    = li.sku?.trim() || null
      const title  = li.title?.trim() || null

      const catalog = await findCatalogForSale(
        workspaceId,
        store.storeId,
        null,
        itemId,
        sku,
        title
      )

      if (!catalog) {
        base.skippedNoCatalog++
        await recordEvent(workspaceId, store.storeId, orderId, lineId, null, li, null, "skipped_no_catalog")
        console.log(
          `${LOG} store_id=${store.storeId} store=${store.storeCode} order=${orderId} line=${lineId} skipped: no catalog match sku=${sku ?? "-"} itemId=${itemId ?? "-"}`
        )
        continue
      }

      if (isVariationLineItem(li) && !canReadVariationQuantity(li, catalog)) {
        base.skippedVariation++
        await recordEvent(
          workspaceId, store.storeId, orderId, lineId, catalog, li, null,
          "skipped_variation_not_supported",
          `legacyVariationId=${getLegacyVariationId(li)}`
        )
        console.log(
          `${LOG} store_id=${store.storeId} store=${store.storeCode} order=${orderId} line=${lineId} ` +
          `skipped: variation without variation-specific sku/offerId`
        )
        continue
      }

      const variationOnly = isVariationLineItem(li)
      const qtyInput = buildQtyInput(li, catalog, true)

      let ebayQty: number | null
      try {
        ebayQty = await getEbayListingQuantity(client, qtyInput, variationOnly)
        base.stockChecks++
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        base.skippedCheckFailed++
        await recordEvent(workspaceId, store.storeId, orderId, lineId, catalog, li, null, "skipped_check_failed", msg)
        console.warn(
          `${LOG} store_id=${store.storeId} store=${store.storeCode} order=${orderId} line=${lineId} qty check failed: ${msg}`
        )
        continue
      }

      if (ebayQty === null) {
        const action: RestockAction = variationOnly
          ? "skipped_quantity_unknown"
          : "skipped_check_failed"
        if (variationOnly) base.skippedVariation++
        else base.skippedCheckFailed++
        await recordEvent(
          workspaceId, store.storeId, orderId, lineId, catalog, li, null,
          action,
          variationOnly ? "variation_quantity_unknown" : "quantity_unavailable"
        )
        console.warn(
          `${LOG} store_id=${store.storeId} store=${store.storeCode} order=${orderId} line=${lineId} skipped: ${action}`
        )
        continue
      }

      if (!shouldRestockSoldItem(ebayQty, SOLD_ITEM_RESTOCK_TARGET_QUANTITY)) {
        base.skippedAtOrAboveTarget++
        await recordEvent(
          workspaceId, store.storeId, orderId, lineId, catalog, li, ebayQty, "skipped_not_zero"
        )
        console.log(
          `${LOG} store_id=${store.storeId} store=${store.storeCode} order=${orderId} line=${lineId} ` +
          `live qty ${ebayQty} >= target ${SOLD_ITEM_RESTOCK_TARGET_QUANTITY}, no update`
        )
        continue
      }

      // live qty is 0, 1, or 2 (below target) — quantity-only update to target
      const targetQty = SOLD_ITEM_RESTOCK_TARGET_QUANTITY
      try {
        await setListingQuantityOnEbay(
          workspaceId,
          store.storeCode,
          qtyInput,
          targetQty,
          "sold_item_restock",
          sandbox,
          store.storeId
        )
        await updateLocalCatalogQuantity(workspaceId, store.storeId, catalog.catalogStateId, targetQty)
        try {
          const { afterManualQuantityChanged } = await import("../stockGuard/stockGuardV2LifecycleHooks")
          await afterManualQuantityChanged({
            workspaceId,
            storeId: store.storeId,
            catalogStateId: catalog.catalogStateId,
            quantity: targetQty,
          })
        } catch (e) {
          console.warn(
            `${LOG} keepa emit after restock skipped:`,
            e instanceof Error ? e.message : e
          )
        }
        base.restocked++
        await recordEvent(
          workspaceId,
          store.storeId,
          orderId,
          lineId,
          catalog,
          li,
          ebayQty,
          "restocked",
          undefined,
          new Date()
        )
        console.log(
          `${LOG} store_id=${store.storeId} store=${store.storeCode} order=${orderId} line=${lineId} ` +
          `restocked qty ${ebayQty}→${targetQty} sku=${catalog.internalSku ?? "-"} itemId=${catalog.ebayItemId ?? "-"}`
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        base.failed++
        await recordEvent(workspaceId, store.storeId, orderId, lineId, catalog, li, ebayQty, "failed", msg)
        console.warn(
          `${LOG} store_id=${store.storeId} store=${store.storeCode} order=${orderId} line=${lineId} restock failed: ${msg}`
        )
      }
    }
  }

  return base
}

export async function runSoldItemAutoRestock(
  workspaceId: string,
  storeCode?:  string
): Promise<RestockRunResult> {
  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
  const stores = await listActiveEbayStores(workspaceId, storeCode)

  if (storeCode && stores.length === 0) {
    throw new Error(`Store not found or not active eBay: ${storeCode}`)
  }

  const results: RestockStoreResult[] = []
  for (const store of stores) {
    try {
      results.push(await processStore(workspaceId, store, sandbox))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`${LOG} store_id=${store.storeId} store=${store.storeCode} fatal: ${msg}`)
      results.push({
        workspaceId,
        storeId: store.storeId,
        storeCode: store.storeCode,
        storeName: store.name,
        skipped: true,
        skipReason: `store_fatal:${msg}`,
        ordersFetched: 0,
        ordersUpserted: 0,
        itemsUpserted: 0,
        lineItemsSeen: 0,
        alreadyHandled: 0,
        stockChecks: 0,
        restocked: 0,
        skippedAtOrAboveTarget: 0,
        skippedNoCatalog: 0,
        skippedCheckFailed: 0,
        skippedOldOrder: 0,
        skippedVariation: 0,
        failed: 0,
      })
    }
  }

  return {
    windowMinutes: RESTOCK_ORDER_WINDOW_MINUTES,
    stores:        results,
  }
}

/** Platform tick: all workspaces / all active eBay stores by exact store_id. */
export async function runSoldItemAutoRestockAllWorkspaces(): Promise<RestockRunResult> {
  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
  const stores = await listAllActiveEbayStores()
  console.log(`${LOG} platform tick stores=${stores.length}`)

  const results: RestockStoreResult[] = []
  for (const store of stores) {
    try {
      results.push(await processStore(store.workspaceId, store, sandbox))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(
        `${LOG} workspace=${store.workspaceId} store_id=${store.storeId} store=${store.storeCode} fatal: ${msg}`
      )
      results.push({
        workspaceId: store.workspaceId,
        storeId: store.storeId,
        storeCode: store.storeCode,
        storeName: store.name,
        skipped: true,
        skipReason: `store_fatal:${msg}`,
        ordersFetched: 0,
        ordersUpserted: 0,
        itemsUpserted: 0,
        lineItemsSeen: 0,
        alreadyHandled: 0,
        stockChecks: 0,
        restocked: 0,
        skippedAtOrAboveTarget: 0,
        skippedNoCatalog: 0,
        skippedCheckFailed: 0,
        skippedOldOrder: 0,
        skippedVariation: 0,
        failed: 0,
      })
    }
  }

  return {
    windowMinutes: RESTOCK_ORDER_WINDOW_MINUTES,
    stores:        results,
  }
}
