import { query } from "../../db/client"
import {
  defaultTemplateForType,
  type CsAutomationType,
} from "./csTemplate"

export const AUTOMATION_THANK_YOU = "THANK_YOU" as const
export const AUTOMATION_SHIPPED = "SHIPPED" as const
export const AUTOMATION_DELAYED = "DELAYED" as const
export const AUTOMATION_DELIVERED = "DELIVERED" as const

export type CsSendStatus = "queued" | "pending" | "sent" | "failed" | "skipped"

export type CsAutomationRow = {
  automationType: string
  enabled: boolean
  templateBody: string
  updatedAt: string | null
}

export type CsSendRow = {
  id: number
  ebayOrderId: string
  automationType: string
  status: CsSendStatus
  lastError: string | null
  createdAt: string
  sentAt: string | null
  sourceEventType: string | null
}

export async function getOrCreateAutomation(
  workspaceId: string,
  storeId: number,
  automationType: CsAutomationType
): Promise<CsAutomationRow> {
  await query(
    `INSERT INTO customer_service_automations (
       workspace_id, store_id, automation_type, enabled, template_body
     ) VALUES ($1::uuid, $2, $3, FALSE, $4)
     ON CONFLICT (workspace_id, store_id, automation_type) DO NOTHING`,
    [workspaceId, storeId, automationType, defaultTemplateForType(automationType)]
  )
  const res = await query<{
    automation_type: string
    enabled: boolean
    template_body: string
    updated_at: string | null
  }>(
    `SELECT automation_type, enabled, template_body, updated_at::text AS updated_at
     FROM customer_service_automations
     WHERE workspace_id = $1::uuid AND store_id = $2 AND automation_type = $3
     LIMIT 1`,
    [workspaceId, storeId, automationType]
  )
  const row = res.rows[0]
  return {
    automationType: row.automation_type,
    enabled: row.enabled,
    templateBody: row.template_body,
    updatedAt: row.updated_at,
  }
}

export async function getOrCreateStoreSettings(
  workspaceId: string,
  storeId: number
): Promise<{ enabled: boolean }> {
  await query(
    `INSERT INTO customer_service_store_settings (workspace_id, store_id, enabled)
     VALUES ($1::uuid, $2, FALSE)
     ON CONFLICT (workspace_id, store_id) DO NOTHING`,
    [workspaceId, storeId]
  )
  const res = await query<{ enabled: boolean }>(
    `SELECT enabled FROM customer_service_store_settings
     WHERE workspace_id = $1::uuid AND store_id = $2
     LIMIT 1`,
    [workspaceId, storeId]
  )
  return { enabled: Boolean(res.rows[0]?.enabled) }
}

export async function setMasterEnabled(
  workspaceId: string,
  storeId: number,
  enabled: boolean
): Promise<{ enabled: boolean }> {
  const types: CsAutomationType[] = [
    AUTOMATION_THANK_YOU,
    AUTOMATION_SHIPPED,
    AUTOMATION_DELAYED,
    AUTOMATION_DELIVERED,
  ]
  for (const type of types) {
    await getOrCreateAutomation(workspaceId, storeId, type)
  }
  await query(
    `INSERT INTO customer_service_store_settings (workspace_id, store_id, enabled, updated_at)
     VALUES ($1::uuid, $2, $3, NOW())
     ON CONFLICT (workspace_id, store_id)
     DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
    [workspaceId, storeId, enabled]
  )
  await query(
    `UPDATE customer_service_automations
     SET enabled = $3, updated_at = NOW()
     WHERE workspace_id = $1::uuid AND store_id = $2`,
    [workspaceId, storeId, enabled]
  )
  return { enabled }
}

export async function getOrCreateThankYouAutomation(
  workspaceId: string,
  storeId: number
): Promise<CsAutomationRow> {
  return getOrCreateAutomation(workspaceId, storeId, AUTOMATION_THANK_YOU)
}

export async function updateAutomation(
  workspaceId: string,
  storeId: number,
  automationType: CsAutomationType,
  patch: { enabled?: boolean; templateBody?: string }
): Promise<CsAutomationRow> {
  await getOrCreateAutomation(workspaceId, storeId, automationType)
  const sets: string[] = ["updated_at = NOW()"]
  const params: unknown[] = [workspaceId, storeId, automationType]
  if (patch.templateBody !== undefined) {
    params.push(patch.templateBody)
    sets.push(`template_body = $${params.length}`)
  }
  await query(
    `UPDATE customer_service_automations
     SET ${sets.join(", ")}
     WHERE workspace_id = $1::uuid AND store_id = $2 AND automation_type = $3`,
    params
  )
  return getOrCreateAutomation(workspaceId, storeId, automationType)
}

export async function updateThankYouAutomation(
  workspaceId: string,
  storeId: number,
  patch: { enabled?: boolean; templateBody?: string }
): Promise<CsAutomationRow> {
  return updateAutomation(workspaceId, storeId, AUTOMATION_THANK_YOU, patch)
}

export async function tryInsertQueuedSend(input: {
  workspaceId: string
  storeId: number
  ebayOrderId: string
  templateSnapshot: string
  automationType?: CsAutomationType
  sourceEventId?: number | null
  sourceMailboxMessageId?: number | null
  sourceEventType?: string | null
}): Promise<"inserted" | "duplicate"> {
  const automationType = input.automationType ?? AUTOMATION_THANK_YOU
  const res = await query<{ id: number }>(
    `INSERT INTO customer_service_sends (
       workspace_id, store_id, ebay_order_id, automation_type, status, template_snapshot,
       source_event_id, source_mailbox_message_id, source_event_type
     ) VALUES ($1::uuid, $2, $3, $4, 'queued', $5, $6, $7, $8)
     ON CONFLICT (workspace_id, store_id, ebay_order_id, automation_type) DO NOTHING
     RETURNING id`,
    [
      input.workspaceId,
      input.storeId,
      input.ebayOrderId,
      automationType,
      input.templateSnapshot,
      input.sourceEventId ?? null,
      input.sourceMailboxMessageId ?? null,
      input.sourceEventType ?? null,
    ]
  )
  return res.rows[0] ? "inserted" : "duplicate"
}

export async function claimNextQueuedSend(): Promise<{
  id: number
  workspaceId: string
  storeId: number
  ebayOrderId: string
  automationType: CsAutomationType
  templateSnapshot: string | null
  attemptCount: number
  sourceEventType: string | null
} | null> {
  const res = await query<{
    id: number
    workspace_id: string
    store_id: number
    ebay_order_id: string
    automation_type: CsAutomationType
    template_snapshot: string | null
    attempt_count: number
    source_event_type: string | null
  }>(
    `UPDATE customer_service_sends
     SET status = 'pending', updated_at = NOW()
     WHERE id = (
       SELECT id FROM customer_service_sends
       WHERE status = 'queued'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, workspace_id::text AS workspace_id, store_id, ebay_order_id, automation_type,
               template_snapshot, attempt_count, source_event_type`,
    []
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    storeId: row.store_id,
    ebayOrderId: row.ebay_order_id,
    automationType: row.automation_type,
    templateSnapshot: row.template_snapshot,
    attemptCount: row.attempt_count,
    sourceEventType: row.source_event_type,
  }
}

export async function markSendResult(input: {
  id: number
  status: "sent" | "failed" | "skipped"
  error?: string | null
  ebayMessageId?: string | null
  mediaAttempted?: boolean
  mediaIncluded?: boolean
  mediaUrl?: string | null
  mediaResult?: string | null
}): Promise<void> {
  await query(
    `UPDATE customer_service_sends
     SET status = $2,
         last_error = $3,
         ebay_message_id = COALESCE($4, ebay_message_id),
         attempt_count = attempt_count + 1,
         sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END,
         media_attempted = COALESCE($5, media_attempted),
         media_included = COALESCE($6, media_included),
         media_url = COALESCE($7, media_url),
         media_result = COALESCE($8, media_result),
         updated_at = NOW()
     WHERE id = $1`,
    [
      input.id,
      input.status,
      input.error ?? null,
      input.ebayMessageId ?? null,
      input.mediaAttempted ?? null,
      input.mediaIncluded ?? null,
      input.mediaUrl ?? null,
      input.mediaResult ?? null,
    ]
  )
}

export async function listRecentSends(
  workspaceId: string,
  storeId: number,
  limit = 25
): Promise<CsSendRow[]> {
  const res = await query<{
    id: number
    ebay_order_id: string
    automation_type: string
    status: CsSendStatus
    last_error: string | null
    created_at: string
    sent_at: string | null
    source_event_type: string | null
  }>(
    `SELECT id, ebay_order_id, automation_type, status, last_error,
            created_at::text AS created_at, sent_at::text AS sent_at,
            source_event_type
     FROM customer_service_sends
     WHERE workspace_id = $1::uuid AND store_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [workspaceId, storeId, limit]
  )
  return res.rows.map(r => ({
    id: r.id,
    ebayOrderId: r.ebay_order_id,
    automationType: r.automation_type,
    status: r.status,
    lastError: r.last_error,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    sourceEventType: r.source_event_type,
  }))
}

export async function sendStats(
  workspaceId: string,
  storeId: number,
  automationType: CsAutomationType = AUTOMATION_THANK_YOU
): Promise<{
  sentToday: number
  failed: number
  lastSentAt: string | null
}> {
  const res = await query<{ sent_today: string; failed: string; last_sent: string | null }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE status = 'sent' AND sent_at >= date_trunc('day', NOW())
       )::text AS sent_today,
       COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
       MAX(sent_at)::text AS last_sent
     FROM customer_service_sends
     WHERE workspace_id = $1::uuid AND store_id = $2 AND automation_type = $3`,
    [workspaceId, storeId, automationType]
  )
  const row = res.rows[0]
  return {
    sentToday: Number(row?.sent_today ?? 0),
    failed: Number(row?.failed ?? 0),
    lastSentAt: row?.last_sent ?? null,
  }
}

export async function loadOrderForSend(workspaceId: string, storeId: number, ebayOrderId: string): Promise<{
  buyerUsername: string | null
  buyerName: string | null
  orderStatus: string | null
  fulfillmentStatus: string | null
  paymentStatus: string | null
  storeCode: string
  storeName: string
  itemId: string | null
  amazonOrderNumber: string | null
  estimatedDelivery: string | null
  deliveryLocation: string | null
  deliveryProofR2Url: string | null
} | null> {
  const res = await query<{
    buyer_username: string | null
    buyer_name: string | null
    order_status: string | null
    fulfillment_status: string | null
    payment_status: string | null
    store_code: string
    store_name: string
    item_id: string | null
    amazon_order_number: string | null
    amazon_estimated_delivery: string | null
    amazon_delivery_location: string | null
    delivery_proof_r2_url: string | null
  }>(
    `SELECT o.buyer_username, o.buyer_name, o.order_status, o.fulfillment_status, o.payment_status,
            o.store_code, s.name AS store_name,
            o.amazon_order_number, o.amazon_estimated_delivery, o.amazon_delivery_location,
            o.delivery_proof_r2_url,
            (
              SELECT i.ebay_item_id
              FROM ebay_order_items i
              WHERE i.order_id = o.id AND i.workspace_id = o.workspace_id
                AND i.ebay_item_id IS NOT NULL AND btrim(i.ebay_item_id) <> ''
              ORDER BY i.id ASC
              LIMIT 1
            ) AS item_id
     FROM ebay_orders o
     INNER JOIN stores s ON s.id = o.store_id AND s.workspace_id = o.workspace_id
     WHERE o.workspace_id = $1::uuid AND o.store_id = $2 AND o.ebay_order_id = $3
     LIMIT 1`,
    [workspaceId, storeId, ebayOrderId]
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    buyerUsername: row.buyer_username,
    buyerName: row.buyer_name,
    orderStatus: row.order_status,
    fulfillmentStatus: row.fulfillment_status,
    paymentStatus: row.payment_status,
    storeCode: row.store_code,
    storeName: row.store_name,
    itemId: row.item_id,
    amazonOrderNumber: row.amazon_order_number,
    estimatedDelivery: row.amazon_estimated_delivery,
    deliveryLocation: row.amazon_delivery_location,
    deliveryProofR2Url: row.delivery_proof_r2_url,
  }
}

export async function storeEbayScope(workspaceId: string, storeId: number): Promise<string | null> {
  const res = await query<{ scope: string | null }>(
    `SELECT scope FROM ebay_accounts WHERE workspace_id = $1::uuid AND store_id = $2 LIMIT 1`,
    [workspaceId, storeId]
  )
  return res.rows[0]?.scope ?? null
}

export async function loadOrderByPk(workspaceId: string, storeId: number, orderPk: number): Promise<{
  ebayOrderId: string
  buyerUsername: string | null
  buyerName: string | null
  orderStatus: string | null
  fulfillmentStatus: string | null
  paymentStatus: string | null
  storeName: string
  amazonOrderNumber: string | null
  estimatedDelivery: string | null
  deliveryLocation: string | null
  deliveryProofR2Url: string | null
} | null> {
  const res = await query<{
    ebay_order_id: string
    buyer_username: string | null
    buyer_name: string | null
    order_status: string | null
    fulfillment_status: string | null
    payment_status: string | null
    store_name: string
    amazon_order_number: string | null
    amazon_estimated_delivery: string | null
    amazon_delivery_location: string | null
    delivery_proof_r2_url: string | null
  }>(
    `SELECT o.ebay_order_id, o.buyer_username, o.buyer_name, o.order_status, o.fulfillment_status, o.payment_status,
            s.name AS store_name, o.amazon_order_number, o.amazon_estimated_delivery, o.amazon_delivery_location,
            o.delivery_proof_r2_url
     FROM ebay_orders o
     INNER JOIN stores s ON s.id = o.store_id AND s.workspace_id = o.workspace_id
     WHERE o.workspace_id = $1::uuid AND o.store_id = $2 AND o.id = $3
     LIMIT 1`,
    [workspaceId, storeId, orderPk]
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    ebayOrderId: row.ebay_order_id,
    buyerUsername: row.buyer_username,
    buyerName: row.buyer_name,
    orderStatus: row.order_status,
    fulfillmentStatus: row.fulfillment_status,
    paymentStatus: row.payment_status,
    storeName: row.store_name,
    amazonOrderNumber: row.amazon_order_number,
    estimatedDelivery: row.amazon_estimated_delivery,
    deliveryLocation: row.amazon_delivery_location,
    deliveryProofR2Url: row.delivery_proof_r2_url,
  }
}
