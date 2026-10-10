import { query } from "../../db/client"
import type { AmazonEmailParse, EbayCancelParse, EbayCancelledParse, EbayPayoutParse, EbayReturnParse, EbaySaleParse } from "./mailboxTypes"
import { enqueueSourceStatusAutomation } from "../customerService/csThankYouService"

export async function insertOrderEventFromMailbox(input: {
  workspaceId: string
  orderPk: number
  type: string
  message: string
  mailboxMessageId: number
}): Promise<{ inserted: boolean; eventId: number | null }> {
  const res = await query<{ id: number }>(
    `INSERT INTO ebay_order_events (order_id, workspace_id, event_type, message, source_mailbox_message_id)
     SELECT $1, $2::uuid, $3, $4, $5
     WHERE NOT EXISTS (
       SELECT 1 FROM ebay_order_events
       WHERE order_id = $1 AND event_type = $3 AND source_mailbox_message_id = $5
     )
     RETURNING id`,
    [input.orderPk, input.workspaceId, input.type, input.message, input.mailboxMessageId]
  )
  const eventId = res.rows[0]?.id ? Number(res.rows[0].id) : null
  return { inserted: eventId != null, eventId }
}

function currenciesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "USD").trim().toUpperCase()
  const y = (b ?? "USD").trim().toUpperCase()
  return x === y
}

export async function applyAmazonParseToOrder(input: {
  workspaceId: string
  storeId: number
  orderPk: number
  mailboxMessageId: number
  parsed: AmazonEmailParse
  receivedAt: Date | null
}): Promise<{ applied: boolean; conflict: string | null }> {
  const cur = await query<{
    amazon_order_number: string | null
    amazon_order_url: string | null
    amazon_purchase_price: string | null
    amazon_cost_source: string | null
    currency: string | null
    operation_status: string | null
  }>(
    `SELECT amazon_order_number, amazon_order_url, amazon_purchase_price::text,
            amazon_cost_source, currency, operation_status
     FROM ebay_orders
     WHERE workspace_id = $1::uuid AND store_id = $2 AND id = $3
     LIMIT 1`,
    [input.workspaceId, input.storeId, input.orderPk]
  )
  const row = cur.rows[0]
  if (!row) return { applied: false, conflict: "order_not_in_store" }

  if (
    input.parsed.amazonOrderNumber &&
    row.amazon_order_number &&
    row.amazon_order_number !== input.parsed.amazonOrderNumber
  ) {
    return { applied: false, conflict: "amazon_order_number_mismatch" }
  }

  const sets: string[] = []
  const params: unknown[] = []
  const push = (col: string, val: unknown) => {
    params.push(val)
    sets.push(`${col} = $${params.length}`)
  }

  if (input.parsed.amazonOrderNumber && !row.amazon_order_number) {
    push("amazon_order_number", input.parsed.amazonOrderNumber)
  }
  if (input.parsed.amazonOrderUrl && !row.amazon_order_url) {
    push("amazon_order_url", input.parsed.amazonOrderUrl)
  }

  const cost = input.parsed.finalTotal
  let costConflict: string | null = null
  if (cost) {
    const isManual = (row.amazon_cost_source ?? "") === "MANUAL"
    if (!currenciesCompatible(cost.currency, row.currency)) {
      costConflict = "amazon_cost_currency_mismatch"
    } else if (row.amazon_purchase_price == null && !isManual) {
      push("amazon_purchase_price", cost.amount)
      push("amazon_purchase_currency", cost.currency)
      push("amazon_cost_source", "EMAIL_GRAND_TOTAL")
    } else if (row.amazon_purchase_price != null) {
      const existing = parseFloat(row.amazon_purchase_price)
      const same =
        Number.isFinite(existing) && Math.round(existing * 100) === Math.round(cost.amount * 100)
      if (!same) {
        costConflict = isManual ? "amazon_cost_manual_conflict" : "amazon_cost_conflict"
      }
    }
  }

  if (input.parsed.trackingUrl) push("amazon_tracking_url", input.parsed.trackingUrl)
  if (input.parsed.trackParts?.shipmentId) push("amazon_shipment_id", input.parsed.trackParts.shipmentId)
  if (input.parsed.trackParts?.packageIndex) push("amazon_package_index", input.parsed.trackParts.packageIndex)
  if (input.parsed.estimatedDelivery) push("amazon_estimated_delivery", input.parsed.estimatedDelivery)
  if (input.parsed.shipmentStatus) push("amazon_delivery_status", input.parsed.shipmentStatus)
  if (input.parsed.deliveryLocationText) push("amazon_delivery_location", input.parsed.deliveryLocationText)
  if (input.parsed.type === "AMAZON_DELIVERED") {
    push("amazon_delivered_at", input.receivedAt ?? new Date())
  }

  if (
    input.parsed.amazonOrderNumber &&
    (row.operation_status == null ||
      row.operation_status === "NEW_ORDER" ||
      row.operation_status === "AMAZON_PENDING")
  ) {
    push("operation_status", "AMAZON_ORDERED")
    sets.push("operation_status_updated_at = NOW()")
  }

  if (sets.length > 0) {
    sets.push("updated_at = NOW()")
    params.push(input.workspaceId, input.storeId, input.orderPk)
    await query(
      `UPDATE ebay_orders SET ${sets.join(", ")}
       WHERE workspace_id = $${params.length - 2}::uuid
         AND store_id = $${params.length - 1}
         AND id = $${params.length}`,
      params
    )
  }

  const eventType =
    input.parsed.type === "AMAZON_ORDERED"
      ? "SOURCE_ORDER_CONFIRMED"
      : input.parsed.type === "AMAZON_SHIPPED"
        ? "SOURCE_SHIPPED"
        : input.parsed.type === "AMAZON_DELAYED"
          ? "SOURCE_DELAYED"
          : "SOURCE_DELIVERED"
  const event = await insertOrderEventFromMailbox({
    workspaceId: input.workspaceId,
    orderPk: input.orderPk,
    type: eventType,
    message: eventMessage(input.parsed),
    mailboxMessageId: input.mailboxMessageId,
  })
  if (
    event.inserted &&
    event.eventId &&
    (eventType === "SOURCE_SHIPPED" || eventType === "SOURCE_DELAYED" || eventType === "SOURCE_DELIVERED")
  ) {
    try {
      await enqueueSourceStatusAutomation({
        workspaceId: input.workspaceId,
        storeId: input.storeId,
        orderPk: input.orderPk,
        eventType,
        sourceEventId: event.eventId,
        sourceMailboxMessageId: input.mailboxMessageId,
      })
    } catch (e) {
      console.warn(
        `[CustomerService] source enqueue failed store_id=${input.storeId} orderPk=${input.orderPk} type=${eventType}:`,
        e instanceof Error ? e.message : String(e)
      )
    }
  }
  return { applied: true, conflict: costConflict }
}

function eventMessage(parsed: AmazonEmailParse): string {
  const no = parsed.amazonOrderNumber ?? "Amazon order"
  if (parsed.type === "AMAZON_ORDERED") return `Source order confirmed (${no})`
  if (parsed.type === "AMAZON_SHIPPED") return `Source shipped (${no})`
  if (parsed.type === "AMAZON_DELAYED") return `Source delayed (${no})`
  return `Source delivered (${no})`
}

export async function applyEbaySaleEvent(input: {
  workspaceId: string
  storeId: number
  orderPk: number
  mailboxMessageId: number
  parsed: EbaySaleParse
}): Promise<void> {
  await insertOrderEventFromMailbox({
    workspaceId: input.workspaceId,
    orderPk: input.orderPk,
    type: "EBAY_SALE_EMAIL",
    message: `eBay sale email (${input.parsed.ebayOrderId ?? "order"})`,
    mailboxMessageId: input.mailboxMessageId,
  })
}

export async function applyEbayCancelEvent(input: {
  workspaceId: string
  storeId: number
  orderPk: number
  mailboxMessageId: number
  parsed: EbayCancelParse
}): Promise<void> {
  await insertOrderEventFromMailbox({
    workspaceId: input.workspaceId,
    orderPk: input.orderPk,
    type: "EBAY_CANCEL_REQUEST",
    message: `Cancel request ${input.parsed.cancelId ?? ""}`.trim(),
    mailboxMessageId: input.mailboxMessageId,
  })
}

export async function applyEbayCancelledEvent(input: {
  workspaceId: string
  storeId: number
  orderPk: number
  mailboxMessageId: number
  parsed: EbayCancelledParse
}): Promise<void> {
  await insertOrderEventFromMailbox({
    workspaceId: input.workspaceId,
    orderPk: input.orderPk,
    type: "EBAY_CANCELLED",
    message: `Cancellation completed ${input.parsed.cancelId ?? ""}`.trim(),
    mailboxMessageId: input.mailboxMessageId,
  })
}

export async function applyEbayReturnEvent(input: {
  workspaceId: string
  storeId: number
  orderPk: number
  mailboxMessageId: number
  parsed: EbayReturnParse
}): Promise<void> {
  await insertOrderEventFromMailbox({
    workspaceId: input.workspaceId,
    orderPk: input.orderPk,
    type: "EBAY_RETURN_REQUEST",
    message: `Return request ${input.parsed.returnId ?? ""}`.trim(),
    mailboxMessageId: input.mailboxMessageId,
  })
}

export async function applyEbayPayout(input: {
  workspaceId: string
  storeId: number
  mailboxMessageId: number
  parsed: EbayPayoutParse
}): Promise<void> {
  const payoutId = input.parsed.payoutId?.trim()
  if (!payoutId) return
  await query(
    `INSERT INTO mailbox_store_payouts (
       workspace_id, store_id, mailbox_message_id, payout_id, amount, currency,
       destination, payout_type, payout_date, estimated_arrival
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (workspace_id, store_id, payout_id) DO NOTHING`,
    [
      input.workspaceId,
      input.storeId,
      input.mailboxMessageId,
      payoutId,
      input.parsed.amount?.amount ?? null,
      input.parsed.amount?.currency ?? null,
      input.parsed.destination,
      input.parsed.payoutType,
      input.parsed.payoutDate,
      input.parsed.estimatedArrival,
    ]
  )
}

export async function openLinkReview(input: {
  workspaceId: string
  storeId: number | null
  mailboxMessageId: number
  amazonOrderNumber: string | null
  candidateIds: number[]
  reason: string
}): Promise<void> {
  await query(
    `INSERT INTO mailbox_link_reviews (
       workspace_id, store_id, mailbox_message_id, amazon_order_number, candidate_order_ids, reason
     ) VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6)`,
    [
      input.workspaceId,
      input.storeId,
      input.mailboxMessageId,
      input.amazonOrderNumber,
      JSON.stringify(input.candidateIds),
      input.reason,
    ]
  )
}
