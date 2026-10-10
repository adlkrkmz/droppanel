import { query } from "../../db/client"
import { applyAmazonParseToOrder, openLinkReview } from "./mailboxApplyService"
import type { AmazonEmailParse } from "./mailboxTypes"
import { AMAZON_ORDER_NUMBER_RE } from "./mailboxTypes"
import { OrdersHttpError } from "../orders/ordersTypes"

const AMAZON_TYPES = [
  "AMAZON_ORDERED",
  "AMAZON_SHIPPED",
  "AMAZON_DELAYED",
  "AMAZON_DELIVERED",
] as const

export function normalizeAmazonOrderNumberInput(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, "")
    .trim()
}

export function parseAmazonOrderNumberInput(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const normalized = normalizeAmazonOrderNumberInput(raw)
  if (!normalized) return null
  const m = normalized.match(AMAZON_ORDER_NUMBER_RE)
  if (!m?.[1] || m[1] !== normalized) {
    throw new OrdersHttpError(400, "Geçersiz Amazon sipariş numarası. Beklenen format: 114-1234567-1234567")
  }
  return m[1]
}

export async function assertAmazonOrderNumberAvailable(input: {
  workspaceId: string
  storeId: number
  orderPk: number
  amazonOrderNumber: string
}): Promise<void> {
  const dup = await query<{ id: number }>(
    `SELECT id FROM ebay_orders
     WHERE workspace_id = $1::uuid
       AND id <> $2
       AND amazon_order_number = $3
     LIMIT 1`,
    [input.workspaceId, input.orderPk, input.amazonOrderNumber]
  )
  if (dup.rows[0]) {
    throw new OrdersHttpError(409, "Bu Amazon sipariş numarası başka bir eBay siparişiyle eşleşmiş.")
  }
}

function asAmazonParse(raw: unknown, classified: string): AmazonEmailParse | null {
  if (!raw || typeof raw !== "object") return null
  const p = raw as AmazonEmailParse
  const type = AMAZON_TYPES.includes(classified as (typeof AMAZON_TYPES)[number])
    ? (classified as AmazonEmailParse["type"])
    : p.type
  if (!AMAZON_TYPES.includes(type)) return null
  return { ...p, type }
}

export async function linkExactAmazonMailsToOrder(input: {
  workspaceId: string
  storeId: number
  orderPk: number
  amazonOrderNumber: string
}): Promise<{
  matched: number
  ordered: number
  shipped: number
  delayed: number
  delivered: number
  reviewsResolved: number
}> {
  const stats = { matched: 0, ordered: 0, shipped: 0, delayed: 0, delivered: 0, reviewsResolved: 0 }
  const msgs = await query<{
    id: number
    classified_type: string
    parsed_payload: unknown
    received_at: Date | null
    matched_ebay_order_pk: number | null
  }>(
    `SELECT id, classified_type, parsed_payload, received_at, matched_ebay_order_pk
     FROM mailbox_messages
     WHERE workspace_id = $1::uuid
       AND classified_type IN ('AMAZON_ORDERED', 'AMAZON_SHIPPED', 'AMAZON_DELAYED', 'AMAZON_DELIVERED')
       AND parsed_payload->>'amazonOrderNumber' = $2
     ORDER BY CASE classified_type
       WHEN 'AMAZON_ORDERED' THEN 1
       WHEN 'AMAZON_SHIPPED' THEN 2
       WHEN 'AMAZON_DELAYED' THEN 3
       ELSE 4
     END, received_at ASC NULLS LAST, id ASC`,
    [input.workspaceId, input.amazonOrderNumber]
  )

  const costConflicts: Array<{ mailboxMessageId: number; reason: string }> = []

  for (const row of msgs.rows) {
    if (row.matched_ebay_order_pk != null && Number(row.matched_ebay_order_pk) !== input.orderPk) {
      continue
    }
    const parsed = asAmazonParse(row.parsed_payload, row.classified_type)
    if (!parsed || parsed.amazonOrderNumber !== input.amazonOrderNumber) continue
    const applied = await applyAmazonParseToOrder({
      workspaceId: input.workspaceId,
      storeId: input.storeId,
      orderPk: input.orderPk,
      mailboxMessageId: Number(row.id),
      parsed,
      receivedAt: row.received_at,
    })
    if (!applied.applied) continue
    stats.matched++
    if (parsed.type === "AMAZON_ORDERED") stats.ordered++
    if (parsed.type === "AMAZON_SHIPPED") stats.shipped++
    if (parsed.type === "AMAZON_DELAYED") stats.delayed++
    if (parsed.type === "AMAZON_DELIVERED") stats.delivered++
    await query(
      `UPDATE mailbox_messages
       SET processing_status = 'PROCESSED',
           review_reason = $3,
           matched_ebay_order_pk = $2,
           store_id = $5,
           processed_at = COALESCE(processed_at, NOW()),
           updated_at = NOW()
       WHERE id = $1
         AND workspace_id = $4::uuid
         AND (matched_ebay_order_pk IS NULL OR matched_ebay_order_pk = $2)`,
      [
        row.id,
        input.orderPk,
        applied.conflict,
        input.workspaceId,
        input.storeId,
      ]
    )
    if (applied.conflict) {
      costConflicts.push({ mailboxMessageId: Number(row.id), reason: applied.conflict })
    }
  }

  const resolved = await query<{ id: number }>(
    `UPDATE mailbox_link_reviews
     SET status = 'RESOLVED'
     WHERE workspace_id = $1::uuid
       AND amazon_order_number = $2
       AND status = 'OPEN'
       AND reason IN ('no_candidates', 'ambiguous', 'weak_evidence')
     RETURNING id`,
    [input.workspaceId, input.amazonOrderNumber]
  )
  stats.reviewsResolved = resolved.rows.length
  for (const c of costConflicts) {
    await openLinkReview({
      workspaceId: input.workspaceId,
      storeId: input.storeId,
      mailboxMessageId: c.mailboxMessageId,
      amazonOrderNumber: input.amazonOrderNumber,
      candidateIds: [input.orderPk],
      reason: c.reason,
    })
  }
  return stats
}
