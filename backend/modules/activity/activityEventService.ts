import { query } from "../../db/client"
import { isPrimaryFeedEventType, PRIMARY_FEED_EVENT_TYPES } from "./activityFeedPolicy"

export type ActivityEventType =
  | "VERIFICATION_QUEUED"
  | "SOURCE_VERIFICATION_STARTED"
  | "SOURCE_VERIFICATION_COMPLETED"
  | "SOURCE_VERIFICATION_FAILED"
  | "SOURCE_ASIN_REDIRECTED"
  | "SOURCE_PRICE_INCREASED"
  | "SOURCE_NO_VALID_FBA"
  | "STOCK_ZEROED"
  | "STOCK_ZERO_FAILED"
  | "PRICE_PROTECTION_APPLIED"
  | "PRICE_APPROVAL_REQUIRED"
  | "SOURCE_RESTORED"
  | "ACTION_FAILED"
  | "LISTING_PUBLISHED"
  | "LISTING_PUBLISH_FAILED"
  | "IMPORT_COMPLETED"
  | "IMPORT_FAILED"
  | "ORDER_RECEIVED"
  | "TRACKING_UPDATED"

export type ActivitySeverity = "info" | "warning" | "error" | "success"

export type ActivityEventInput = {
  workspaceId: string
  storeId?: number | null
  userId?: string | null
  eventType: ActivityEventType
  severity?: ActivitySeverity
  title: string
  message: string
  entityType?: string | null
  entityId?: string | null
  catalogStateId?: number | null
  asin?: string | null
  ebayItemId?: string | null
  beforeData?: Record<string, unknown> | null
  afterData?: Record<string, unknown> | null
  source?: string
  idempotencyKey?: string | null
}

export async function findActivityByIdempotencyKey(
  workspaceId: string,
  key: string
): Promise<{ id: number; afterData: Record<string, unknown> | null } | null> {
  const trimmed = key.trim()
  if (!trimmed) return null
  const existing = await query<{ id: number; after_data: Record<string, unknown> | null }>(
    `SELECT id, after_data
     FROM workspace_activity_events
     WHERE workspace_id = $1::uuid
       AND idempotency_key = $2
     LIMIT 1`,
    [workspaceId, trimmed]
  )
  const row = existing.rows[0]
  if (!row?.id) return null
  return { id: Number(row.id), afterData: row.after_data ?? null }
}

export async function emitActivityEvent(input: ActivityEventInput): Promise<number | null> {
  if (!isPrimaryFeedEventType(input.eventType)) {
    return null
  }
  try {
    const key = input.idempotencyKey?.trim() || null
    if (key) {
      const existing = await query<{ id: number }>(
        `SELECT id FROM workspace_activity_events
         WHERE workspace_id = $1::uuid
           AND idempotency_key = $2
         LIMIT 1`,
        [input.workspaceId, key]
      )
      if (existing.rows[0]?.id) return Number(existing.rows[0].id)
    }
    const res = await query<{ id: number }>(
      `INSERT INTO workspace_activity_events (
         workspace_id, store_id, user_id, event_type, severity, title, message,
         entity_type, entity_id, catalog_state_id, asin, ebay_item_id,
         before_data, after_data, source, created_at, visible_until, idempotency_key
       ) VALUES (
         $1::uuid, $2::bigint, $3::uuid, $4, $5, $6, $7,
         $8, $9, $10::bigint, $11, $12,
         $13::jsonb, $14::jsonb, $15, NOW(), NOW() + INTERVAL '24 hours', $16
       )
       RETURNING id`,
      [
        input.workspaceId,
        input.storeId ?? null,
        input.userId ?? null,
        input.eventType,
        input.severity ?? "info",
        input.title,
        input.message,
        input.entityType ?? null,
        input.entityId ?? null,
        input.catalogStateId ?? null,
        input.asin ?? null,
        input.ebayItemId ?? null,
        input.beforeData ? JSON.stringify(input.beforeData) : null,
        input.afterData ? JSON.stringify(input.afterData) : null,
        input.source ?? "stock_guard_v2",
        key,
      ]
    )
    if (res.rows[0]?.id) return Number(res.rows[0].id)
    return null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (input.idempotencyKey && /duplicate key|unique/i.test(msg)) {
      const again = await query<{ id: number }>(
        `SELECT id FROM workspace_activity_events
         WHERE workspace_id = $1::uuid AND idempotency_key = $2
         LIMIT 1`,
        [input.workspaceId, input.idempotencyKey.trim()]
      )
      if (again.rows[0]?.id) return Number(again.rows[0].id)
    }
    console.warn("[activity] emit failed:", msg)
    return null
  }
}

export async function listVisibleActivityFeed(input: {
  workspaceId: string
  storeId?: number | null
  limit?: number
}): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 40))
  const res = await query(
    `SELECT id, store_id, event_type, severity, title, message, asin, ebay_item_id,
            catalog_state_id, before_data, after_data, source, created_at, read_at,
            visible_until
     FROM workspace_activity_events
     WHERE workspace_id = $1::uuid
       AND created_at > NOW() - INTERVAL '24 hours'
       AND visible_until > NOW()
       AND event_type = ANY($4::text[])
       AND ($2::bigint IS NULL OR store_id = $2::bigint)
     ORDER BY created_at DESC
     LIMIT $3`,
    [input.workspaceId, input.storeId ?? null, limit, [...PRIMARY_FEED_EVENT_TYPES]]
  )
  return res.rows
}

export async function countUnreadActivity(workspaceId: string): Promise<number> {
  const res = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM workspace_activity_events
     WHERE workspace_id = $1::uuid
       AND read_at IS NULL
       AND visible_until > NOW()
       AND event_type = ANY($2::text[])`,
    [workspaceId, [...PRIMARY_FEED_EVENT_TYPES]]
  )
  return parseInt(res.rows[0]?.c ?? "0", 10) || 0
}

export async function markActivityRead(workspaceId: string, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0
  const res = await query(
    `UPDATE workspace_activity_events
     SET read_at = COALESCE(read_at, NOW())
     WHERE workspace_id = $1::uuid
       AND id = ANY($2::bigint[])`,
    [workspaceId, ids]
  )
  return res.rowCount ?? 0
}

export async function markAllActivityRead(workspaceId: string): Promise<number> {
  const res = await query(
    `UPDATE workspace_activity_events
     SET read_at = NOW()
     WHERE workspace_id = $1::uuid
       AND read_at IS NULL
       AND visible_until > NOW()`,
    [workspaceId]
  )
  return res.rowCount ?? 0
}
