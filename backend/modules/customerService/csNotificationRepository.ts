import crypto from "crypto"
import { query } from "../../db/client"

export type TopicStatusRow = {
  topic_id: string
  subscription_id: string | null
  destination_id: string | null
  status: string | null
  topic_scope: string | null
  last_error: string | null
}

export async function getOrCreateDestinationConfig(endpoint: string): Promise<{
  endpoint: string
  verificationToken: string
  destinationId: string | null
  status: string | null
  lastError: string | null
}> {
  const existing = await query<{
    endpoint: string
    verification_token: string
    destination_id: string | null
    status: string | null
    last_error: string | null
  }>(
    `SELECT endpoint, verification_token, destination_id, status, last_error
     FROM ebay_notification_destinations
     WHERE endpoint = $1
     LIMIT 1`,
    [endpoint]
  )
  const row = existing.rows[0]
  if (row) {
    return {
      endpoint: row.endpoint,
      verificationToken: row.verification_token,
      destinationId: row.destination_id,
      status: row.status,
      lastError: row.last_error,
    }
  }
  const verificationToken = crypto.randomBytes(32).toString("hex")
  await query(
    `INSERT INTO ebay_notification_destinations (endpoint, verification_token, status)
     VALUES ($1, $2, 'PENDING')
     ON CONFLICT (endpoint) DO NOTHING`,
    [endpoint, verificationToken]
  )
  return getOrCreateDestinationConfig(endpoint)
}

export async function destinationByEndpoint(endpoint: string): Promise<{
  verificationToken: string
  destinationId: string | null
} | null> {
  const res = await query<{ verification_token: string; destination_id: string | null }>(
    `SELECT verification_token, destination_id
     FROM ebay_notification_destinations
     WHERE endpoint = $1
     LIMIT 1`,
    [endpoint]
  )
  const row = res.rows[0]
  if (!row) return null
  return { verificationToken: row.verification_token, destinationId: row.destination_id }
}

export async function saveDestinationId(endpoint: string, destinationId: string, status: string, lastError: string | null): Promise<void> {
  await query(
    `UPDATE ebay_notification_destinations
     SET destination_id = $2, status = $3, last_error = $4, updated_at = NOW()
     WHERE endpoint = $1`,
    [endpoint, destinationId, status, lastError]
  )
}

export async function saveDestinationError(endpoint: string, lastError: string): Promise<void> {
  await query(
    `UPDATE ebay_notification_destinations
     SET last_error = $2, updated_at = NOW()
     WHERE endpoint = $1`,
    [endpoint, lastError.slice(0, 1000)]
  )
}

export async function upsertSubscriptionRow(input: {
  workspaceId: string
  storeId: number
  topicId: string
  subscriptionId: string | null
  destinationId: string | null
  status: string | null
  topicScope: string | null
  lastError: string | null
}): Promise<void> {
  await query(
    `INSERT INTO ebay_notification_subscriptions (
       workspace_id, store_id, topic_id, subscription_id, destination_id, status, topic_scope, last_error, updated_at
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (workspace_id, store_id, topic_id) DO UPDATE SET
       subscription_id = EXCLUDED.subscription_id,
       destination_id = EXCLUDED.destination_id,
       status = EXCLUDED.status,
       topic_scope = EXCLUDED.topic_scope,
       last_error = EXCLUDED.last_error,
       updated_at = NOW()`,
    [
      input.workspaceId,
      input.storeId,
      input.topicId,
      input.subscriptionId,
      input.destinationId,
      input.status,
      input.topicScope,
      input.lastError,
    ]
  )
}

export async function listSubscriptionRows(workspaceId: string, storeId: number): Promise<TopicStatusRow[]> {
  const res = await query<TopicStatusRow>(
    `SELECT topic_id, subscription_id, destination_id, status, topic_scope, last_error
     FROM ebay_notification_subscriptions
     WHERE workspace_id = $1::uuid AND store_id = $2
     ORDER BY topic_id`,
    [workspaceId, storeId]
  )
  return res.rows
}

export async function insertNotificationEvent(input: {
  workspaceId: string | null
  storeId: number | null
  topicId: string
  notificationId: string | null
  conversationId: string | null
  payload: unknown
  signatureStatus: string
}): Promise<boolean> {
  if (input.notificationId) {
    const res = await query<{ id: number }>(
      `INSERT INTO ebay_notification_events (
         workspace_id, store_id, topic_id, notification_id, conversation_id, payload, signature_status
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (notification_id) WHERE notification_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        input.workspaceId,
        input.storeId,
        input.topicId,
        input.notificationId,
        input.conversationId,
        JSON.stringify(input.payload ?? {}),
        input.signatureStatus,
      ]
    )
    return Boolean(res.rows[0]?.id)
  }
  const res = await query<{ id: number }>(
    `INSERT INTO ebay_notification_events (
       workspace_id, store_id, topic_id, notification_id, conversation_id, payload, signature_status
     ) VALUES ($1::uuid, $2, $3, NULL, $4, $5::jsonb, $6)
     RETURNING id`,
    [
      input.workspaceId,
      input.storeId,
      input.topicId,
      input.conversationId,
      JSON.stringify(input.payload ?? {}),
      input.signatureStatus,
    ]
  )
  return Boolean(res.rows[0]?.id)
}

export async function bumpInboxUnreadHint(workspaceId: string, storeId: number, topicId: string): Promise<void> {
  await query(
    `INSERT INTO customer_service_inbox_signals (
       workspace_id, store_id, unread_hint, last_topic, last_event_at, updated_at
     ) VALUES ($1::uuid, $2, 1, $3, NOW(), NOW())
     ON CONFLICT (workspace_id, store_id) DO UPDATE SET
       unread_hint = customer_service_inbox_signals.unread_hint + 1,
       last_topic = EXCLUDED.last_topic,
       last_event_at = NOW(),
       updated_at = NOW()`,
    [workspaceId, storeId, topicId]
  )
}

export async function resetInboxUnreadHint(workspaceId: string, storeId: number): Promise<void> {
  await query(
    `UPDATE customer_service_inbox_signals
     SET unread_hint = 0, updated_at = NOW()
     WHERE workspace_id = $1::uuid AND store_id = $2`,
    [workspaceId, storeId]
  )
}

export async function getInboxUnreadHint(workspaceId: string, storeId: number): Promise<{
  unreadHint: number
  lastTopic: string | null
  lastEventAt: string | null
}> {
  const res = await query<{ unread_hint: number; last_topic: string | null; last_event_at: Date | null }>(
    `SELECT unread_hint, last_topic, last_event_at
     FROM customer_service_inbox_signals
     WHERE workspace_id = $1::uuid AND store_id = $2
     LIMIT 1`,
    [workspaceId, storeId]
  )
  const row = res.rows[0]
  return {
    unreadHint: Number(row?.unread_hint ?? 0),
    lastTopic: row?.last_topic ?? null,
    lastEventAt: row?.last_event_at ? row.last_event_at.toISOString() : null,
  }
}

export async function findStoreByEbayUserKeys(keys: string[]): Promise<Array<{
  workspaceId: string
  storeId: number
}>> {
  const cleaned = [...new Set(keys.map(k => k.trim()).filter(Boolean))]
  if (cleaned.length === 0) return []
  const res = await query<{ workspace_id: string; store_id: number }>(
    `SELECT a.workspace_id, a.store_id
     FROM ebay_accounts a
     INNER JOIN stores s ON s.id = a.store_id AND s.workspace_id = a.workspace_id AND s.status = 'active'
     WHERE lower(a.ebay_user_id) = ANY($1::text[])
        OR lower(s.name) = ANY($1::text[])
        OR lower(s.store_code) = ANY($1::text[])`,
    [cleaned.map(k => k.toLowerCase())]
  )
  return res.rows.map(r => ({ workspaceId: r.workspace_id, storeId: Number(r.store_id) }))
}
