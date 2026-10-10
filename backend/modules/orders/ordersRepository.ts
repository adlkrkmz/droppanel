// ----------------------------------------------------------------
// ordersRepository.ts — DB persistence for eBay orders
//
// Sync upsert only touches eBay-owned columns. Any future local operation
// columns (Amazon order no, Aqualine code, credit, profit) are NOT listed in
// the UPDATE SET clauses, so they are preserved across syncs.
// Order sync NEVER writes to store_catalog_state — listings are read-only here.
// ----------------------------------------------------------------

import { query } from "../../db/client"
import type { EbayOrderLineItem, EbayOrderRow } from "../ebay/ebayApiClient"
import { enqueueThankYouForNewOrder } from "../customerService/csThankYouService"
import { resolveListingAsin } from "../monitor/listingAsinResolve"
import {
  DEFAULT_OPERATION_STATUS,
  isOperationStatus,
  operationStatusLabel,
  OrdersHttpError,
  type AssistedOrderPacket,
  type OperationStatus,
  type OrderAddress,
  type OrderDetail,
  type OrderDetailItem,
  type OrderEvent,
  type OrderFinanceSummary,
  type OrderListItem,
  type OrderManualUpdateInput,
  type OrderStatusBadge,
} from "./ordersTypes"
import { orderProfitFromRemainingAndCost } from "../mailbox/mailboxTypes"
import {
  assertAmazonOrderNumberAvailable,
  linkExactAmazonMailsToOrder,
  parseAmazonOrderNumberInput,
} from "../mailbox/linkAmazonMailsFromOrderNumber"

/** Effective operation status: stored value, or sensible fallback for legacy rows. */
function effectiveOperationStatus(
  stored:            string | null,
  amazonOrderNumber: string | null
): OperationStatus {
  if (isOperationStatus(stored)) return stored
  return amazonOrderNumber?.trim() ? "AMAZON_ORDERED" : DEFAULT_OPERATION_STATUS
}

export type OrderStore = {
  id:        number
  storeCode: string
  name:      string
}

export async function getActiveStores(workspaceId: string): Promise<OrderStore[]> {
  const res = await query<{ id: number; store_code: string; name: string }>(
    `SELECT id, store_code, name
     FROM stores
     WHERE workspace_id = $1::uuid
       AND status = 'active'
     ORDER BY created_at ASC`,
    [workspaceId]
  )
  return res.rows.map((r) => ({ id: r.id, storeCode: r.store_code, name: r.name }))
}

export async function getStoreByCode(
  workspaceId: string,
  storeCode:   string
): Promise<OrderStore | null> {
  const code = storeCode.trim()
  if (!code) return null
  const res = await query<{ id: number; store_code: string; name: string }>(
    `SELECT id, store_code, name
     FROM stores
     WHERE workspace_id = $1::uuid
       AND store_code = $2
       AND status = 'active'
     LIMIT 1`,
    [workspaceId, code]
  )
  const row = res.rows[0]
  return row ? { id: row.id, storeCode: row.store_code, name: row.name } : null
}

export async function getLastSyncedAt(
  workspaceId: string,
  storeId:     number
): Promise<Date | null> {
  const res = await query<{ last_synced_at: string | null }>(
    `SELECT last_synced_at
     FROM ebay_order_sync_state
     WHERE workspace_id = $1::uuid AND store_id = $2
     LIMIT 1`,
    [workspaceId, storeId]
  )
  const raw = res.rows[0]?.last_synced_at
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function setLastSyncedAt(
  workspaceId: string,
  storeId:     number,
  ts:          Date
): Promise<void> {
  await query(
    `INSERT INTO ebay_order_sync_state (workspace_id, store_id, last_synced_at, updated_at)
     VALUES ($1::uuid, $2, $3, NOW())
     ON CONFLICT (workspace_id, store_id)
     DO UPDATE SET last_synced_at = EXCLUDED.last_synced_at, updated_at = NOW()`,
    [workspaceId, storeId, ts.toISOString()]
  )
}

type ListingMatch = {
  catalogStateId: number | null
  imageUrl:       string | null
  asin:           string | null
}

/**
 * Match a line item to an existing listing (read-only).
 * Priority: eBay item id → SKU/custom label → title fallback.
 */
async function matchListing(
  workspaceId: string,
  storeId:     number,
  itemId:      string | null,
  sku:         string | null,
  title:       string | null
): Promise<ListingMatch> {
  if (!itemId && !sku && !title) {
    return { catalogStateId: null, imageUrl: null, asin: null }
  }

  const res = await query<{
    catalog_state_id: number
    image_url: string | null
    asin: string | null
    source_url: string | null
    internal_sku: string | null
  }>(
    `SELECT scs.id AS catalog_state_id,
            scs.image_url,
            ar.asin,
            scs.source_url,
            scs.internal_sku
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND scs.store_id = $2
       AND (
         ($3::text IS NOT NULL AND trim(scs.ebay_item_id) = $3) OR
         ($4::text IS NOT NULL AND scs.internal_sku = $4) OR
         ($5::text IS NOT NULL AND lower(scs.ebay_title) = lower($5))
       )
     ORDER BY
       CASE
         WHEN $3::text IS NOT NULL AND trim(scs.ebay_item_id) = $3 THEN 1
         WHEN $4::text IS NOT NULL AND scs.internal_sku = $4 THEN 2
         WHEN $5::text IS NOT NULL AND lower(scs.ebay_title) = lower($5) THEN 3
         ELSE 9
       END
     LIMIT 1`,
    [workspaceId, storeId, itemId, sku, title]
  )

  const row = res.rows[0]
  if (!row) return { catalogStateId: null, imageUrl: null, asin: null }
  const asin = resolveListingAsin({
    registryAsin: row.asin,
    sourceUrl:    row.source_url,
    internalSku:  row.internal_sku || sku || "",
  })
  return {
    catalogStateId: row.catalog_state_id,
    imageUrl:       row.image_url?.trim() || null,
    asin,
  }
}

function lineKeyFor(li: EbayOrderLineItem): string {
  return (
    li.lineItemId?.trim() ||
    li.legacyItemId?.trim() ||
    li.title?.trim() ||
    "unknown"
  )
}

async function upsertOrderRow(
  workspaceId: string,
  store:       OrderStore,
  order:       EbayOrderRow
): Promise<{ id: number; inserted: boolean }> {
  const res = await query<{ id: number; inserted: boolean }>(
    // operation_status is set ONLY on first insert (new order -> AMAZON_PENDING)
    // and is intentionally absent from the DO UPDATE SET clause, so eBay sync can
    // never overwrite a manually-chosen operation status.
    `INSERT INTO ebay_orders (
       workspace_id, store_id, store_code, ebay_order_id, legacy_order_id,
       buyer_username, buyer_name, order_created_at, order_updated_at, order_status,
       fulfillment_status, payment_status, total_amount, currency, raw_ebay_order_json,
       operation_status, operation_status_updated_at,
       last_synced_at, created_at, updated_at
     )
     VALUES (
       $1::uuid, $2, $3, $4, $5,
       $6, $7, $8::timestamptz, $9::timestamptz, $10,
       $11, $12, $13, $14, $15::jsonb,
       '${DEFAULT_OPERATION_STATUS}', NOW(),
       NOW(), NOW(), NOW()
     )
     ON CONFLICT (workspace_id, store_id, ebay_order_id) DO UPDATE SET
       legacy_order_id     = EXCLUDED.legacy_order_id,
       buyer_username      = EXCLUDED.buyer_username,
       buyer_name          = EXCLUDED.buyer_name,
       order_created_at    = EXCLUDED.order_created_at,
       order_updated_at    = EXCLUDED.order_updated_at,
       order_status        = EXCLUDED.order_status,
       fulfillment_status  = EXCLUDED.fulfillment_status,
       payment_status      = EXCLUDED.payment_status,
       total_amount        = EXCLUDED.total_amount,
       currency            = EXCLUDED.currency,
       raw_ebay_order_json = EXCLUDED.raw_ebay_order_json,
       last_synced_at      = NOW(),
       updated_at          = NOW()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      workspaceId,
      store.id,
      store.storeCode,
      order.orderId,
      order.legacyOrderId,
      order.buyerUsername,
      order.buyerName ?? null,
      order.creationDate,
      order.lastModifiedDate ?? null,
      order.orderStatus ?? order.fulfillmentStatus,
      order.fulfillmentStatus,
      order.paymentStatus ?? null,
      Number.isFinite(order.total) ? order.total : null,
      order.currency,
      order.raw ? JSON.stringify(order.raw) : null,
    ]
  )
  return { id: res.rows[0].id, inserted: res.rows[0].inserted === true }
}

async function upsertOrderItemRow(
  workspaceId: string,
  store:       OrderStore,
  orderDbId:   number,
  ebayOrderId: string,
  li:          EbayOrderLineItem
): Promise<void> {
  const itemId = li.legacyItemId?.trim() || null
  const sku    = li.sku?.trim() || null
  const title  = li.title?.trim() || null
  const match  = await matchListing(workspaceId, store.id, itemId, sku, title)

  await query(
    `INSERT INTO ebay_order_items (
       order_id, workspace_id, ebay_order_id, line_key,
       ebay_line_item_id, ebay_item_id, sku, asin, title, quantity,
       item_price, currency, image_url, matched_catalog_state_id, raw_ebay_line_item_json,
       created_at, updated_at
     )
     VALUES (
       $1, $2::uuid, $3, $4,
       $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15::jsonb,
       NOW(), NOW()
     )
     ON CONFLICT (order_id, line_key) DO UPDATE SET
       ebay_line_item_id        = EXCLUDED.ebay_line_item_id,
       ebay_item_id             = EXCLUDED.ebay_item_id,
       sku                      = EXCLUDED.sku,
       asin                     = EXCLUDED.asin,
       title                    = EXCLUDED.title,
       quantity                 = EXCLUDED.quantity,
       item_price               = EXCLUDED.item_price,
       currency                 = EXCLUDED.currency,
       image_url                = EXCLUDED.image_url,
       matched_catalog_state_id = EXCLUDED.matched_catalog_state_id,
       raw_ebay_line_item_json  = EXCLUDED.raw_ebay_line_item_json,
       updated_at               = NOW()`,
    [
      orderDbId,
      workspaceId,
      ebayOrderId,
      lineKeyFor(li),
      li.lineItemId?.trim() || null,
      itemId,
      sku,
      match.asin,
      title,
      Number.isFinite(li.quantity) ? li.quantity : null,
      li.itemPrice ?? null,
      li.currency ?? null,
      match.imageUrl,
      match.catalogStateId,
      li.raw ? JSON.stringify(li.raw) : null,
    ]
  )
}

export async function upsertOrders(
  workspaceId: string,
  store:       OrderStore,
  orders:      EbayOrderRow[]
): Promise<{ upsertedOrders: number; upsertedItems: number }> {
  let upsertedOrders = 0
  let upsertedItems = 0

  for (const order of orders) {
    const upserted = await upsertOrderRow(workspaceId, store, order)
    const orderDbId = upserted.id
    upsertedOrders++
    for (const li of order.lineItems) {
      await upsertOrderItemRow(workspaceId, store, orderDbId, order.orderId, li)
      upsertedItems++
    }
    if (upserted.inserted) {
      void enqueueThankYouForNewOrder({
        workspaceId,
        storeId: store.id,
        storeName: store.name,
        ebayOrderId: order.orderId,
        buyerUsername: order.buyerUsername,
        buyerName: order.buyerName ?? null,
        orderStatus: order.orderStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        paymentStatus: order.paymentStatus,
      }).catch(e => {
        console.warn(
          `[CustomerServiceThankYou] enqueue failed store_id=${store.id} order=${order.orderId}:`,
          e instanceof Error ? e.message : String(e)
        )
      })
    }
  }

  return { upsertedOrders, upsertedItems }
}

// ----------------------------------------------------------------
// Read (DB listing)
// ----------------------------------------------------------------

type OrderRowDb = {
  id: number
  store_code: string
  ebay_order_id: string
  legacy_order_id: string | null
  buyer_username: string | null
  buyer_name: string | null
  order_created_at: string | null
  fulfillment_status: string | null
  total_amount: string | null
  currency: string | null
  store_name: string
  operation_status: string | null
  amazon_order_number: string | null
}

type OrderItemRowDb = {
  order_id: number
  title: string | null
  quantity: number | null
  image_url: string | null
}

function mapStatus(fulfillment: string | null): OrderStatusBadge {
  const s = (fulfillment ?? "").trim().toUpperCase()
  if (s === "FULFILLED") return "updated"
  if (s === "IN_PROGRESS") return "processing"
  if (s === "NOT_STARTED") return "new"
  return "new"
}

export async function listOrdersFromDb(
  workspaceId: string,
  opts: { storeId?: number; allStores: boolean }
): Promise<OrderListItem[]> {
  const conditions = ["o.workspace_id = $1::uuid"]
  const params: unknown[] = [workspaceId]
  if (!opts.allStores) {
    params.push(opts.storeId)
    conditions.push(`o.store_id = $${params.length}`)
  }

  const ordersRes = await query<OrderRowDb>(
    `SELECT o.id, o.store_code, o.ebay_order_id, o.legacy_order_id,
            o.buyer_username, o.buyer_name, o.order_created_at::text AS order_created_at,
            o.fulfillment_status, o.total_amount::text AS total_amount, o.currency,
            s.name AS store_name, o.operation_status, o.amazon_order_number
     FROM ebay_orders o
     INNER JOIN stores s ON s.id = o.store_id AND s.workspace_id = o.workspace_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY o.order_created_at DESC NULLS LAST, o.id DESC`,
    params
  )

  if (ordersRes.rows.length === 0) return []

  const orderIds = ordersRes.rows.map((r) => r.id)
  const itemsRes = await query<OrderItemRowDb>(
    `SELECT order_id, title, quantity, image_url
     FROM ebay_order_items
     WHERE order_id = ANY($1::bigint[])
     ORDER BY id ASC`,
    [orderIds]
  )

  const itemsByOrder = new Map<number, OrderItemRowDb[]>()
  for (const it of itemsRes.rows) {
    const list = itemsByOrder.get(it.order_id) ?? []
    list.push(it)
    itemsByOrder.set(it.order_id, list)
  }

  return ordersRes.rows.map((o) => {
    const items = itemsByOrder.get(o.id) ?? []
    const titles = items.map((i) => i.title?.trim()).filter((t): t is string => !!t)
    let productTitle = "Ürün bilgisi yok"
    if (titles.length === 1) productTitle = titles[0]
    else if (titles.length > 1) productTitle = `${titles[0]} (+${titles.length - 1} ürün)`

    const qtySum = items.reduce((acc, i) => acc + (i.quantity && i.quantity > 0 ? i.quantity : 0), 0)
    const quantity = qtySum > 0 ? qtySum : items.length
    const imageUrl = items.find((i) => i.image_url?.trim())?.image_url?.trim() || null

    const totalParsed = o.total_amount ? parseFloat(o.total_amount) : NaN
    const opStatus = effectiveOperationStatus(o.operation_status, o.amazon_order_number)

    return {
      id:            o.id,
      orderId:       o.legacy_order_id?.trim() || o.ebay_order_id,
      storeCode:     o.store_code,
      storeName:     o.store_name,
      creationDate:  o.order_created_at,
      buyerUsername: o.buyer_username?.trim() || null,
      buyerName:     o.buyer_name?.trim() || null,
      productTitle,
      imageUrl,
      quantity,
      total:         Number.isFinite(totalParsed) ? totalParsed : 0,
      currency:      o.currency?.trim() || "USD",
      status:        mapStatus(o.fulfillment_status),
      operationStatus:      opStatus,
      operationStatusLabel: operationStatusLabel(opStatus),
    }
  })
}

// ----------------------------------------------------------------
// Detail (single order)
// ----------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/** Normalize shipping address from raw eBay Fulfillment order JSON. */
function normalizeAddress(raw: unknown): OrderAddress | null {
  if (!raw || typeof raw !== "object") return null
  const order = raw as Record<string, unknown>

  const instructions = order["fulfillmentStartInstructions"]
  const firstInstruction = Array.isArray(instructions) ? instructions[0] : undefined
  const shippingStep =
    firstInstruction && typeof firstInstruction === "object"
      ? (firstInstruction as Record<string, unknown>)["shippingStep"]
      : undefined
  const shipTo =
    shippingStep && typeof shippingStep === "object"
      ? (shippingStep as Record<string, unknown>)["shipTo"]
      : undefined
  if (!shipTo || typeof shipTo !== "object") return null
  const shipToObj = shipTo as Record<string, unknown>

  const contact = shipToObj["contactAddress"]
  const contactObj =
    contact && typeof contact === "object" ? (contact as Record<string, unknown>) : {}

  const phoneObj = shipToObj["primaryPhone"]
  const phone =
    phoneObj && typeof phoneObj === "object"
      ? str((phoneObj as Record<string, unknown>)["phoneNumber"])
      : null

  const country = str(contactObj["countryCode"])
  const phones = buildPhones(phone, country)

  const address: OrderAddress = {
    name:         str(shipToObj["fullName"]),
    addressLine1: str(contactObj["addressLine1"]),
    addressLine2: str(contactObj["addressLine2"]),
    city:         str(contactObj["city"]),
    state:        str(contactObj["stateOrProvince"]),
    postalCode:   str(contactObj["postalCode"]),
    country,
    phone:            phones.phoneRaw,
    phoneRaw:         phones.phoneRaw,
    phoneDisplay:     phones.phoneDisplay,
    phoneAmazonInput: phones.phoneAmazonInput,
  }

  const hasAny = Object.values(address).some((v) => v !== null)
  return hasAny ? address : null
}

/**
 * Derive three phone variants from a raw eBay phone value:
 *  - phoneRaw:         exactly what eBay sent (never altered)
 *  - phoneDisplay:     country-coded, human-friendly (for panel + copy)
 *  - phoneAmazonInput: clean local digits for the Amazon address form
 * The raw eBay Fulfillment API typically stores only 10 bare digits for US/CA.
 */
function buildPhones(rawPhone: string | null, country: string | null): {
  phoneRaw: string | null
  phoneDisplay: string | null
  phoneAmazonInput: string | null
} {
  const raw = rawPhone ? rawPhone.trim() : null
  if (!raw) return { phoneRaw: null, phoneDisplay: null, phoneAmazonInput: null }

  const digits = raw.replace(/\D/g, "")
  const cc = (country ?? "").trim().toUpperCase()
  const isNA = cc === "US" || cc === "USA" || cc === "CA" || cc === ""

  // Amazon input: local digits (drop NA country code).
  let amazonInput = digits
  if (digits.length === 11 && digits.startsWith("1")) amazonInput = digits.slice(1)

  // Display: keep already-formatted input; otherwise format bare NA digits.
  let display = raw
  if (!/[+\-\s()]/.test(raw)) {
    if (isNA && digits.length === 10) {
      display = `+1${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
    } else if (isNA && digits.length === 11 && digits.startsWith("1")) {
      const d = digits.slice(1)
      display = `+1${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
    }
  }

  return {
    phoneRaw: raw,
    phoneDisplay: display,
    phoneAmazonInput: amazonInput || raw,
  }
}

type OrderDetailRowDb = {
  id: number
  store_code: string
  store_name: string
  ebay_order_id: string
  legacy_order_id: string | null
  buyer_username: string | null
  buyer_name: string | null
  order_created_at: string | null
  last_synced_at: string | null
  fulfillment_status: string | null
  payment_status: string | null
  total_amount: string | null
  currency: string | null
  raw_ebay_order_json: unknown
  notes: string | null
  amazon_order_number: string | null
  amazon_order_url: string | null
  amazon_purchase_price: string | null
  manual_updated_at: string | null
  operation_status: string | null
  operation_status_updated_at: string | null
  ebay_order_earnings: string | null
  ebay_order_earnings_currency: string | null
  ebay_order_earnings_source: string | null
  ebay_order_earnings_checked_at: string | null
  ebay_order_earnings_error: string | null
  ebay_tracking_number: string | null
  ebay_tracking_carrier: string | null
  ebay_shipment_status: string | null
  ebay_shipped_at: string | null
  amazon_tracking_url: string | null
  amazon_shipment_id: string | null
  amazon_package_index: string | null
  amazon_estimated_delivery: string | null
  amazon_delivery_status: string | null
  amazon_delivery_location: string | null
  amazon_delivered_at: string | null
}

type OrderDetailItemRowDb = {
  title: string | null
  image_url: string | null
  ebay_item_id: string | null
  asin: string | null
  sku: string | null
  quantity: number | null
  item_price: string | null
  currency: string | null
}

export async function getOrderDetail(
  workspaceId: string,
  orderId:     number
): Promise<OrderDetail | null> {
  const res = await query<OrderDetailRowDb>(
    `SELECT o.id, o.store_code, s.name AS store_name, o.ebay_order_id, o.legacy_order_id,
            o.buyer_username, o.buyer_name, o.order_created_at::text AS order_created_at,
            o.last_synced_at::text AS last_synced_at, o.fulfillment_status, o.payment_status,
            o.total_amount::text AS total_amount, o.currency, o.raw_ebay_order_json,
            o.notes, o.amazon_order_number, o.amazon_order_url,
            o.amazon_purchase_price::text AS amazon_purchase_price,
            o.manual_updated_at::text AS manual_updated_at,
            o.operation_status,
            o.operation_status_updated_at::text AS operation_status_updated_at,
            o.ebay_order_earnings::text AS ebay_order_earnings,
            o.ebay_order_earnings_currency,
            o.ebay_order_earnings_source,
            o.ebay_order_earnings_checked_at::text AS ebay_order_earnings_checked_at,
            o.ebay_order_earnings_error,
            o.ebay_tracking_number, o.ebay_tracking_carrier, o.ebay_shipment_status,
            o.ebay_shipped_at::text AS ebay_shipped_at,
            o.amazon_tracking_url, o.amazon_shipment_id, o.amazon_package_index,
            o.amazon_estimated_delivery, o.amazon_delivery_status, o.amazon_delivery_location,
            o.amazon_delivered_at::text AS amazon_delivered_at
     FROM ebay_orders o
     INNER JOIN stores s ON s.id = o.store_id AND s.workspace_id = o.workspace_id
     WHERE o.workspace_id = $1::uuid AND o.id = $2
     LIMIT 1`,
    [workspaceId, orderId]
  )

  const o = res.rows[0]
  if (!o) return null

  const itemsRes = await query<OrderDetailItemRowDb>(
    `SELECT title, image_url, ebay_item_id, asin, sku, quantity,
            item_price::text AS item_price, currency
     FROM ebay_order_items
     WHERE order_id = $1
     ORDER BY id ASC`,
    [o.id]
  )

  const items: OrderDetailItem[] = itemsRes.rows.map((i) => {
    const priceParsed = i.item_price ? parseFloat(i.item_price) : NaN
    return {
      title:      i.title?.trim() || "Ürün bilgisi yok",
      imageUrl:   i.image_url?.trim() || null,
      ebayItemId: i.ebay_item_id?.trim() || null,
      asin:       i.asin?.trim() || null,
      sku:        i.sku?.trim() || null,
      quantity:   i.quantity && i.quantity > 0 ? i.quantity : 0,
      itemPrice:  Number.isFinite(priceParsed) ? priceParsed : null,
      currency:   i.currency?.trim() || o.currency?.trim() || "USD",
    }
  })

  const eventsRes = await query<{ event_type: string; message: string | null; created_at: string }>(
    `SELECT event_type, message, created_at::text AS created_at
     FROM ebay_order_events
     WHERE order_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 50`,
    [o.id]
  )

  const events: OrderEvent[] = eventsRes.rows.map((e) => ({
    type:      e.event_type,
    message:   e.message?.trim() || null,
    createdAt: e.created_at,
  }))

  // Synthesize baseline events when no explicit log rows exist yet.
  if (o.order_created_at) {
    events.push({
      type:      "order_created",
      message:   "eBay'den çekildi / sipariş oluşturuldu",
      createdAt: o.order_created_at,
    })
  }
  if (o.last_synced_at) {
    events.push({
      type:      "synced",
      message:   "Son eBay sync",
      createdAt: o.last_synced_at,
    })
  }

  events.sort((a, b) => {
    const ta = new Date(a.createdAt).getTime()
    const tb = new Date(b.createdAt).getTime()
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta)
  })

  const totalParsed = o.total_amount ? parseFloat(o.total_amount) : NaN
  const purchaseParsed = o.amazon_purchase_price ? parseFloat(o.amazon_purchase_price) : NaN
  const opStatus = effectiveOperationStatus(o.operation_status, o.amazon_order_number)
  const finance = buildFinanceSummary(o)

  return {
    id:                o.id,
    ebayOrderId:       o.legacy_order_id?.trim() || o.ebay_order_id,
    legacyOrderId:     o.legacy_order_id?.trim() || null,
    storeCode:         o.store_code,
    storeName:         o.store_name,
    creationDate:      o.order_created_at,
    lastSyncedAt:      o.last_synced_at,
    status:            mapStatus(o.fulfillment_status),
    fulfillmentStatus: o.fulfillment_status?.trim() || null,
    paymentStatus:     o.payment_status?.trim() || null,
    operationStatus:          opStatus,
    operationStatusLabel:     operationStatusLabel(opStatus),
    operationStatusUpdatedAt: o.operation_status_updated_at,
    buyerUsername:     o.buyer_username?.trim() || null,
    buyerName:         o.buyer_name?.trim() || null,
    total:             Number.isFinite(totalParsed) ? totalParsed : 0,
    currency:          o.currency?.trim() || "USD",
    items,
    address:           normalizeAddress(o.raw_ebay_order_json),
    manual: {
      notes:               o.notes?.trim() || null,
      amazonOrderNumber:   o.amazon_order_number?.trim() || null,
      amazonOrderUrl:      o.amazon_order_url?.trim() || null,
      amazonPurchasePrice: Number.isFinite(purchaseParsed) ? purchaseParsed : null,
    },
    finance,
    tracking: {
      ebayTrackingNumber: o.ebay_tracking_number?.trim() || null,
      ebayCarrier: o.ebay_tracking_carrier?.trim() || null,
      ebayShipmentStatus: o.ebay_shipment_status?.trim() || null,
      ebayShippedAt: o.ebay_shipped_at?.trim() || null,
      amazonTrackingUrl: o.amazon_tracking_url?.trim() || null,
      amazonShipmentId: o.amazon_shipment_id?.trim() || null,
      amazonPackageIndex: o.amazon_package_index?.trim() || null,
      amazonEstimatedDelivery: o.amazon_estimated_delivery?.trim() || null,
      amazonDeliveryStatus: o.amazon_delivery_status?.trim() || null,
      amazonDeliveryLocation: o.amazon_delivery_location?.trim() || null,
      amazonDeliveredAt: o.amazon_delivered_at?.trim() || null,
    },
    events,
  }
}

function buildFinanceSummary(o: OrderDetailRowDb): OrderFinanceSummary {
  const amountRaw = o.ebay_order_earnings ? parseFloat(o.ebay_order_earnings) : NaN
  const amount = Number.isFinite(amountRaw) ? amountRaw : null
  const checkedAt = o.ebay_order_earnings_checked_at?.trim() || null
  const error = o.ebay_order_earnings_error?.trim() || null
  const source = o.ebay_order_earnings_source?.trim() || null
  const currency = o.ebay_order_earnings_currency?.trim() || null

  let status: OrderFinanceSummary["status"]
  if (amount != null) status = "available"
  else if (!checkedAt) status = "missing"
  else if (error === "NOT_READY" || (!error && amount == null)) status = "not_ready"
  else if (error) status = "error"
  else status = "not_ready"

  const purchaseParsed = o.amazon_purchase_price ? parseFloat(o.amazon_purchase_price) : NaN
  const amazonFinalCost = Number.isFinite(purchaseParsed) ? purchaseParsed : null
  const profit = orderProfitFromRemainingAndCost({
    ebayRemainingEarnings: amount,
    amazonFinalCost,
  })

  return {
    ebayOrderEarnings:          amount,
    ebayOrderEarningsCurrency:  currency,
    ebayOrderEarningsSource:    source,
    ebayOrderEarningsCheckedAt: checkedAt,
    ebayOrderEarningsError:     error && error !== "NOT_READY" ? error : null,
    status,
    ebayGrossSales: Number.isFinite(parseFloat(o.total_amount ?? "")) ? parseFloat(o.total_amount!) : null,
    amazonFinalCost,
    profit: profit.profit,
    profitPercent: profit.profitPercent,
  }
}

async function insertEvent(
  workspaceId: string,
  orderId:     number,
  type:        string,
  message:     string
): Promise<void> {
  await query(
    `INSERT INTO ebay_order_events (order_id, workspace_id, event_type, message)
     VALUES ($1, $2::uuid, $3, $4)`,
    [orderId, workspaceId, type, message]
  )
}

/**
 * Update local manual operation fields ONLY. eBay-owned columns are untouched,
 * and the sync upsert never writes these columns, so values survive re-sync.
 *
 * Operation status rules:
 *  - Explicit input.operationStatus -> manual status change (logged as status_changed).
 *  - Saving a non-empty amazonOrderNumber while current status is empty / NEW_ORDER /
 *    AMAZON_PENDING -> auto-advance to AMAZON_ORDERED (does not override later/problem states).
 */
export async function updateManualFields(
  workspaceId: string,
  orderId:     number,
  input:       OrderManualUpdateInput
): Promise<OrderDetail | null> {
  // Read current state first (to drive auto-status + readable event messages).
  const currentRes = await query<{
    operation_status: string | null
    amazon_order_number: string | null
    store_id: number
  }>(
    `SELECT operation_status, amazon_order_number, store_id
     FROM ebay_orders
     WHERE workspace_id = $1::uuid AND id = $2
     LIMIT 1`,
    [workspaceId, orderId]
  )
  const current = currentRes.rows[0]
  if (!current) return null

  if (input.amazonOrderNumber !== undefined) {
    input.amazonOrderNumber = parseAmazonOrderNumberInput(input.amazonOrderNumber)
    if (input.amazonOrderNumber) {
      await assertAmazonOrderNumberAvailable({
        workspaceId,
        storeId: Number(current.store_id),
        orderPk: orderId,
        amazonOrderNumber: input.amazonOrderNumber,
      })
    }
  }

  const currentEffective = effectiveOperationStatus(current.operation_status, current.amazon_order_number)

  const sets: string[] = []
  const params: unknown[] = []
  const push = (col: string, val: unknown) => {
    params.push(val)
    sets.push(`${col} = $${params.length}`)
  }

  let manualFieldTouched = false
  if (input.notes !== undefined) { push("notes", input.notes); manualFieldTouched = true }
  if (input.amazonOrderNumber !== undefined) { push("amazon_order_number", input.amazonOrderNumber); manualFieldTouched = true }
  if (input.amazonOrderUrl !== undefined) { push("amazon_order_url", input.amazonOrderUrl); manualFieldTouched = true }
  if (input.amazonPurchasePrice !== undefined) {
    push("amazon_purchase_price", input.amazonPurchasePrice)
    push("amazon_cost_source", input.amazonPurchasePrice == null ? null : "MANUAL")
    manualFieldTouched = true
  }

  // Resolve target operation status.
  let nextStatus: OperationStatus | null = null
  let autoFromAmazon = false

  if (input.operationStatus !== undefined && isOperationStatus(input.operationStatus)) {
    nextStatus = input.operationStatus
  } else if (
    input.amazonOrderNumber !== undefined &&
    input.amazonOrderNumber !== null &&
    input.amazonOrderNumber.trim().length > 0 &&
    (current.operation_status === null ||
      current.operation_status === "NEW_ORDER" ||
      current.operation_status === "AMAZON_PENDING")
  ) {
    nextStatus = "AMAZON_ORDERED"
    autoFromAmazon = true
  }

  const statusChanged = nextStatus !== null && nextStatus !== currentEffective
  if (nextStatus !== null) {
    push("operation_status", nextStatus)
    sets.push("operation_status_updated_at = NOW()")
  }

  if (sets.length === 0) {
    return getOrderDetail(workspaceId, orderId)
  }

  sets.push("manual_updated_at = NOW()")
  sets.push("updated_at = NOW()")

  params.push(workspaceId)
  const wsIdx = params.length
  params.push(orderId)
  const idIdx = params.length

  const res = await query<{ id: number }>(
    `UPDATE ebay_orders
     SET ${sets.join(", ")}
     WHERE workspace_id = $${wsIdx}::uuid AND id = $${idIdx}
     RETURNING id`,
    params
  )
  if (res.rows.length === 0) return null

  if (manualFieldTouched) {
    await insertEvent(workspaceId, orderId, "manual_updated", "Manuel bilgiler güncellendi")
  }
  if (statusChanged && nextStatus) {
    const fromLabel = operationStatusLabel(currentEffective)
    const toLabel = operationStatusLabel(nextStatus)
    const prefix = autoFromAmazon ? "Amazon order number girildi — durum" : "Durum"
    await insertEvent(
      workspaceId,
      orderId,
      "status_changed",
      `${prefix} ${fromLabel} → ${toLabel} olarak güncellendi`
    )
  }

  if (input.amazonOrderNumber) {
    await linkExactAmazonMailsToOrder({
      workspaceId,
      storeId: Number(current.store_id),
      orderPk: orderId,
      amazonOrderNumber: input.amazonOrderNumber,
    })
  }

  return getOrderDetail(workspaceId, orderId)
}

// ----------------------------------------------------------------
// Assisted Amazon order packet (read-only + assist_started event)
// ----------------------------------------------------------------

type PrimaryItemRowDb = {
  title: string | null
  image_url: string | null
  sku: string | null
  ebay_item_id: string | null
  quantity: number | null
  resolved_asin: string | null
}

/**
 * Resolve primary line item + ASIN with the same canonical chain as listings:
 *  1) ebay_order_items.asin (manual / prior sync)
 *  2) matched listing: asin_registry → source_url → SKU parse
 *  3) SKU / internal_sku listing match (same chain)
 *  4) eBay item id listing match (same chain)
 *  5) order-item SKU parse (DPB0… / bare ASIN)
 * Read-only: never mutates listing data.
 */
async function resolvePrimaryItem(
  workspaceId: string,
  orderId:     number
): Promise<PrimaryItemRowDb | null> {
  const res = await query<{
    title: string | null
    image_url: string | null
    sku: string | null
    ebay_item_id: string | null
    quantity: number | null
    oi_asin: string | null
    matched_registry_asin: string | null
    matched_source_url: string | null
    matched_internal_sku: string | null
    sku_registry_asin: string | null
    sku_source_url: string | null
    sku_internal_sku: string | null
    item_registry_asin: string | null
    item_source_url: string | null
    item_internal_sku: string | null
  }>(
    `SELECT
        oi.title,
        oi.image_url,
        oi.sku,
        oi.ebay_item_id,
        oi.quantity,
        NULLIF(trim(oi.asin), '') AS oi_asin,
        ar_matched.asin AS matched_registry_asin,
        scs_matched.source_url AS matched_source_url,
        scs_matched.internal_sku AS matched_internal_sku,
        ar_sku.asin AS sku_registry_asin,
        scs_sku.source_url AS sku_source_url,
        scs_sku.internal_sku AS sku_internal_sku,
        ar_item.asin AS item_registry_asin,
        scs_item.source_url AS item_source_url,
        scs_item.internal_sku AS item_internal_sku
     FROM ebay_order_items oi
     LEFT JOIN store_catalog_state scs_matched
       ON scs_matched.id = oi.matched_catalog_state_id
     LEFT JOIN asin_registry ar_matched
       ON ar_matched.id = scs_matched.asin_registry_id AND ar_matched.workspace_id = $1::uuid
     LEFT JOIN store_catalog_state scs_sku
       ON scs_sku.workspace_id = $1::uuid
      AND oi.sku IS NOT NULL AND oi.sku <> ''
      AND scs_sku.internal_sku = oi.sku
     LEFT JOIN asin_registry ar_sku
       ON ar_sku.id = scs_sku.asin_registry_id AND ar_sku.workspace_id = $1::uuid
     LEFT JOIN store_catalog_state scs_item
       ON scs_item.workspace_id = $1::uuid
      AND oi.ebay_item_id IS NOT NULL AND oi.ebay_item_id <> ''
      AND trim(scs_item.ebay_item_id) = oi.ebay_item_id
     LEFT JOIN asin_registry ar_item
       ON ar_item.id = scs_item.asin_registry_id AND ar_item.workspace_id = $1::uuid
     WHERE oi.order_id = $2
     ORDER BY oi.id ASC
     LIMIT 1`,
    [workspaceId, orderId]
  )
  const row = res.rows[0]
  if (!row) return null

  const oiAsin = row.oi_asin?.trim().toUpperCase() || null
  const fromMatched = resolveListingAsin({
    registryAsin: row.matched_registry_asin,
    sourceUrl:    row.matched_source_url,
    internalSku:  row.matched_internal_sku || row.sku || "",
  })
  const fromSkuListing = resolveListingAsin({
    registryAsin: row.sku_registry_asin,
    sourceUrl:    row.sku_source_url,
    internalSku:  row.sku_internal_sku || row.sku || "",
  })
  const fromItemListing = resolveListingAsin({
    registryAsin: row.item_registry_asin,
    sourceUrl:    row.item_source_url,
    internalSku:  row.item_internal_sku || row.sku || "",
  })
  const fromOrderSku = resolveListingAsin({
    registryAsin: null,
    sourceUrl:    null,
    internalSku:  row.sku || "",
  })

  const resolved =
    (oiAsin && /^[A-Z0-9]{10}$/.test(oiAsin) ? oiAsin : null) ||
    fromMatched ||
    fromSkuListing ||
    fromItemListing ||
    fromOrderSku ||
    null

  return {
    title:         row.title,
    image_url:     row.image_url,
    sku:           row.sku,
    ebay_item_id:  row.ebay_item_id,
    quantity:      row.quantity,
    resolved_asin: resolved,
  }
}

export async function buildAssistPacket(
  workspaceId: string,
  orderId:     number,
  autoRun = false
): Promise<AssistedOrderPacket> {
  const detail = await getOrderDetail(workspaceId, orderId)
  if (!detail) throw new OrdersHttpError(404, "Sipariş bulunamadı")

  const primary = await resolvePrimaryItem(workspaceId, orderId)
  const asin = primary?.resolved_asin?.trim().toUpperCase() || null
  if (!asin) throw new OrdersHttpError(422, "ASIN bulunamadı.")

  const title = primary?.title?.trim() || detail.items[0]?.title || "Ürün bilgisi yok"
  const imageUrl = primary?.image_url?.trim() || detail.items[0]?.imageUrl || null
  const sku = primary?.sku?.trim() || detail.items[0]?.sku || null
  const ebayItemId = primary?.ebay_item_id?.trim() || detail.items[0]?.ebayItemId || null
  const quantity =
    primary?.quantity && primary.quantity > 0
      ? primary.quantity
      : detail.items[0]?.quantity || 1

  await insertEvent(
    workspaceId,
    orderId,
    "assist_started",
    "Amazon assisted order başlatıldı (ASIN " + asin + ")"
  )

  return {
    orderId:          detail.id,
    ebayOrderId:      detail.ebayOrderId,
    storeCode:        detail.storeCode,
    title,
    imageUrl,
    asin,
    sku,
    ebayItemId,
    quantity,
    amazonProductUrl: `https://www.amazon.com/dp/${encodeURIComponent(asin)}`,
    buyerUsername:    detail.buyerUsername,
    buyerName:        detail.buyerName,
    shippingAddress:  detail.address,
    phone:            detail.address?.phoneRaw ?? null,
    phoneRaw:         detail.address?.phoneRaw ?? null,
    phoneNormalized:  detail.address?.phoneDisplay ?? null,
    phoneDisplay:     detail.address?.phoneDisplay ?? null,
    phoneAmazonInput: detail.address?.phoneAmazonInput ?? null,
    paidAmount:       detail.total,
    currency:         detail.currency,
    autoRun,
  }
}


/**
 * Manually set ASIN on the primary (first) order item only.
 * Never touches store_catalog_state / listing data. Writes an event.
 */
export async function setManualAsin(
  workspaceId: string,
  orderId:     number,
  asinRaw:     string
): Promise<{ asin: string }> {
  const asin = asinRaw.trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    throw new OrdersHttpError(422, "Geçersiz ASIN. 10 karakterli ASIN girin.")
  }

  // Confirm the order belongs to this workspace before mutating.
  const owner = await query<{ id: number }>(
    `SELECT id FROM ebay_orders WHERE id = $1 AND workspace_id = $2::uuid LIMIT 1`,
    [orderId, workspaceId]
  )
  if (owner.rows.length === 0) throw new OrdersHttpError(404, "Sipariş bulunamadı")

  const primary = await query<{ id: number }>(
    `SELECT id FROM ebay_order_items WHERE order_id = $1 ORDER BY id ASC LIMIT 1`,
    [orderId]
  )
  if (primary.rows.length === 0) throw new OrdersHttpError(422, "Sipariş kalemi bulunamadı")

  await query(
    `UPDATE ebay_order_items SET asin = $1 WHERE id = $2`,
    [asin, primary.rows[0].id]
  )

  await insertEvent(workspaceId, orderId, "manual_asin", `Manuel ASIN girildi: ${asin}`)

  return { asin }
}
