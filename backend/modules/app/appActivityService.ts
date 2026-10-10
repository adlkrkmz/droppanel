// ----------------------------------------------------------------
// appActivityService.ts — user-scoped read-only activity log (Phase 5S)
// ----------------------------------------------------------------

import { query } from "../../db/client"
import type { AppActivityActionFilter, AppActivityItem, AppActivityResponse } from "./appTypes"
import {
  buildActivityActionFilterClause,
  buildActivitySearchClause,
} from "./appActivityFilters"

const ACTION_LABELS: Record<string, string> = {
  "app.bulk.stock_alerts.ignore":           "Bulk Ignore Alerts",
  "app.bulk.stock_alerts.ignore.failed":    "Bulk Ignore Alerts Failed",
  "app.bulk.listings.stock_guard.update":   "Bulk Stock Guard Update",
  "app.bulk.listings.stock_guard.update.failed": "Bulk Stock Guard Update Failed",
  "app.bulk.listings.hide":                 "Bulk Hide Listings",
  "app.bulk.listings.hide.failed":          "Bulk Hide Listings Failed",
  "app.bulk.stock_alerts.approve_zero":     "Bulk Set Quantity to 0",
  "app.bulk.stock_alerts.approve_zero.failed": "Bulk Set Quantity to 0 Failed",
  "app.bulk.listings.end":                  "Bulk End Listings",
  "app.bulk.listings.end.failed":           "Bulk End Listings Failed",
  "app.bulk.listings.set_quantity":          "Bulk Set Quantity",
  "app.bulk.listings.set_quantity.failed":   "Bulk Set Quantity Failed",
  "app.listings.set_quantity.uncertain":     "Set Quantity Outcome Uncertain",
  "app.stock_alerts.ignore":                "Ignore Stock Alert",
  "app.stock_alerts.ignore.failed":         "Ignore Stock Alert Failed",
  "app.stock_alerts.approve_zero":          "Set Quantity to 0",
  "app.stock_alerts.approve_zero.failed":   "Set Quantity to 0 Failed",
  "app.listings.stock_guard.update":        "Update Listing Stock Guard",
  "app.listings.stock_guard.update.failed": "Update Listing Stock Guard Failed",
  "app.listings.source_asin.update":        "Update Source ASIN",
  "app.listings.source_asin.update.failed": "Update Source ASIN Failed",
  "app.listings.end":                       "End Listing",
  "app.listings.end.failed":                "End Listing Failed",
  "app.listings.hide":                      "Hide Listing from Panel",
  "app.listings.hide.failed":               "Hide Listing Failed",
  "app.listings.price_update":              "Update Price",
  "app.listings.price_update.failed":       "Update Price Failed",
  "app.listings.sync":                      "Sync Listings",
  "app.listings.sync.failed":               "Sync Listings Failed",
  "app.listings.import_match":              "Import ASIN Match",
  "app.listings.import_match.failed":       "Import ASIN Match Failed",
  "app.stock_guard.settings.update":        "Update Stock Guard Settings",
  "app.stock_guard.settings.update.failed": "Update Stock Guard Settings Failed",
  "app.settings.markup.update":             "Update Store Settings",
  "app.settings.address.update":            "Update Store Settings",
  "app.settings.policies.update":           "Update Store Settings",
  "app.settings.warehouse_banner.update":   "Update Store Settings",
}

const METADATA_ALLOWLIST = new Set([
  "storeCode",
  "batchId",
  "requested",
  "succeeded",
  "failed",
  "catalogStateId",
  "alertId",
  "ebayItemId",
  "asin",
  "previousAsin",
  "newAsin",
  "oldQuantity",
  "newQuantity",
  "oldPrice",
  "newPrice",
  "previousStatus",
  "newStatus",
  "previousReviewStatus",
  "newReviewStatus",
  "enabled",
  "reason",
  "inserted",
  "updated",
  "skipped",
  "reconciled",
])

const METADATA_BLOCKLIST = [
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "password",
  "authorization",
  "cookie",
  "api_key",
  "apikey",
  "stack",
  "raw",
  "oauth",
  "keepa",
  "ebay_response",
  "ebayresponse",
]

function isBlockedMetadataKey(key: string): boolean {
  const lower = key.toLowerCase()
  return METADATA_BLOCKLIST.some(block => lower.includes(block))
}

export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {}
  }

  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(metadata)) {
    if (key === "actorUserId" || key === "workspaceId") continue
    if (isBlockedMetadataKey(key)) continue
    if (!METADATA_ALLOWLIST.has(key)) continue

    if (value === null || typeof value === "boolean") {
      out[key] = value
      continue
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value
      continue
    }
    if (typeof value === "string") {
      out[key] = key === "reason" ? value.slice(0, 200) : value.slice(0, 500)
    }
  }

  return out
}

export function getActivityActionLabel(action: string): string {
  const mapped = ACTION_LABELS[action]
  if (mapped) return mapped
  if (action.startsWith("app.settings.")) return "Update Store Settings"
  if (action.startsWith("app.")) {
    return action
      .replace(/^app\.(bulk\.)?/, "")
      .replace(/[._]/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase())
  }
  return action
}

function parseOptionalInt(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function resolveStoreCode(
  metadata: Record<string, unknown>,
  targetType: string | null,
  targetId: string | null
): string | null {
  const fromMeta = metadata.storeCode
  if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta.trim()
  if (targetType === "store" && targetId?.trim()) return targetId.trim()
  return null
}

function buildActivitySummary(input: {
  action:    string
  requested: number | null
  succeeded: number | null
  failed:    number | null
}): string | null {
  if (input.requested != null && input.succeeded != null && input.failed != null) {
    if (input.failed === 0) {
      return `${input.succeeded} succeeded`
    }
    if (input.succeeded === 0) {
      return `${input.failed} failed`
    }
    return `${input.succeeded} succeeded, ${input.failed} failed`
  }
  if (input.action.endsWith(".failed")) return "Failed"
  return null
}

function resolveActivityResult(input: {
  action:    string
  requested: number | null
  succeeded: number | null
  failed:    number | null
}): AppActivityItem["result"] {
  if (input.action.endsWith(".failed")) return "failed"
  if (input.requested != null && input.failed != null && input.succeeded != null) {
    if (input.failed === 0) return "success"
    if (input.succeeded === 0) return "failed"
    return "partial"
  }
  return "success"
}

function buildWorkspaceScopeClause(paramIndex: number): { clause: string; nextIndex: number } {
  const p = `$${paramIndex}`
  return {
    clause: `(
      al.metadata->>'workspaceId' = ${p}
      OR EXISTS (
        SELECT 1
        FROM stores s
        WHERE s.workspace_id = ${p}::uuid
          AND s.status = 'active'
          AND (
            (al.metadata->>'storeCode' IS NOT NULL AND s.store_code = al.metadata->>'storeCode')
            OR (al.target_type = 'store' AND al.target_id IS NOT NULL AND s.store_code = al.target_id)
            OR (
              al.metadata->>'storeId' IS NOT NULL
              AND s.id = NULLIF(al.metadata->>'storeId', '')::bigint
            )
          )
      )
      OR (
        al.actor_user_id IN (
          SELECT wm.user_id
          FROM workspace_members wm
          WHERE wm.workspace_id = ${p}::uuid
        )
        AND COALESCE(al.metadata->>'workspaceId', '') = ''
      )
    )`,
    nextIndex: paramIndex + 1,
  }
}

export async function getAppActivity(input: {
  workspaceId: string
  storeCode?:  string | null
  action:      AppActivityActionFilter
  q?:          string | null
  page:        number
  limit:       number
}): Promise<AppActivityResponse> {
  const params: unknown[] = [input.workspaceId]
  let paramIndex = 2

  const workspaceScope = buildWorkspaceScopeClause(1)
  const whereParts: string[] = [
    buildActivityActionFilterClause(input.action),
    workspaceScope.clause,
  ]

  if (input.storeCode?.trim()) {
    const storeParam = `$${paramIndex}`
    params.push(input.storeCode.trim())
    paramIndex += 1
    whereParts.push(
      `(al.metadata->>'storeCode' = ${storeParam} OR (al.target_type = 'store' AND al.target_id = ${storeParam}))`
    )
  }

  if (input.q?.trim()) {
    const search = buildActivitySearchClause(input.q.trim(), paramIndex)
    whereParts.push(search.clause)
    params.push(...search.params)
    paramIndex += search.params.length
  }

  const whereSql = whereParts.map(part => `(${part})`).join("\n      AND ")

  const countRes = await query<{ total: string }>(
    `SELECT COUNT(*)::text AS total
     FROM audit_logs al
     WHERE ${whereSql}`,
    params
  )
  const total = parseInt(countRes.rows[0]?.total ?? "0", 10) || 0

  const offset = (input.page - 1) * input.limit
  const limitParam = `$${paramIndex}`
  const offsetParam = `$${paramIndex + 1}`
  params.push(input.limit, offset)

  const rowsRes = await query<{
    id: string
    action: string
    target_type: string | null
    target_id: string | null
    metadata: Record<string, unknown>
    created_at: string
  }>(
    `SELECT al.id::text AS id,
            al.action,
            al.target_type,
            al.target_id,
            al.metadata,
            al.created_at::text AS created_at
     FROM audit_logs al
     WHERE ${whereSql}
     ORDER BY al.created_at DESC, al.id DESC
     LIMIT ${limitParam}::int
     OFFSET ${offsetParam}::int`,
    params
  )

  const items: AppActivityItem[] = rowsRes.rows.map(row => {
    const metadata = row.metadata ?? {}
    const preview = sanitizeAuditMetadata(metadata)
    const requested = parseOptionalInt(metadata.requested)
    const succeeded = parseOptionalInt(metadata.succeeded)
    const failed = parseOptionalInt(metadata.failed)
    const batchIdRaw = metadata.batchId
    const batchId =
      typeof batchIdRaw === "string" && batchIdRaw.trim() ? batchIdRaw.trim() : null

    return {
      id:              row.id,
      action:          row.action,
      label:           getActivityActionLabel(row.action),
      targetType:      row.target_type,
      targetId:        row.target_id,
      storeCode:       resolveStoreCode(metadata, row.target_type, row.target_id),
      batchId,
      requested,
      succeeded,
      failed,
      summary:         buildActivitySummary({
        action: row.action,
        requested,
        succeeded,
        failed,
      }),
      result:          resolveActivityResult({
        action: row.action,
        requested,
        succeeded,
        failed,
      }),
      createdAt:       row.created_at,
      metadataPreview: preview,
    }
  })

  return {
    ok:    true,
    page:  input.page,
    limit: input.limit,
    total,
    items,
  }
}
