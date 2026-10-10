// ----------------------------------------------------------------
// appStockAlertBulkIgnoreService.ts — user-scoped bulk stock alert ignore (Phase 5M)
// ----------------------------------------------------------------

import { randomUUID } from "crypto"
import { query } from "../../db/client"
import { insertAuditLog } from "../auth/authRepository"
import type { OwnedStockAlert, OwnedStore } from "./appOwnership"
import {
  ignoreOwnedStockAlertItem,
  type AppIgnoreStockAlertItemResult,
} from "./appStockAlertIgnoreService"
import type { AppBulkIgnoreStockAlertsResponse } from "./appTypes"
import { AppHttpError } from "./appTypes"

export const BULK_IGNORE_MAX_ALERTS = 50

function mapOwnedStockAlert(row: {
  id: number
  store_id: number
  catalog_state_id: number
  ebay_item_id: string | null
  asin: string
  review_status: string
  source_status: string
  source_status_reason: string | null
}): OwnedStockAlert {
  return {
    id:                 row.id,
    storeId:            row.store_id,
    catalogStateId:     row.catalog_state_id,
    ebayItemId:         row.ebay_item_id?.trim() || null,
    asin:               row.asin?.trim() ?? "",
    reviewStatus:       row.review_status?.trim() ?? "",
    sourceStatus:       row.source_status?.trim() ?? "",
    sourceStatusReason: row.source_status_reason?.trim() || null,
  }
}

export async function loadOwnedStockAlertsByIds(
  workspaceId: string,
  storeId:     number,
  storeCode:   string,
  alertIds:    number[]
): Promise<Map<number, OwnedStockAlert>> {
  if (alertIds.length === 0) return new Map()

  const res = await query<{
    id: number
    store_id: number
    catalog_state_id: number
    ebay_item_id: string | null
    asin: string
    review_status: string
    source_status: string
    source_status_reason: string | null
  }>(
    `SELECT
       sri.id,
       sri.store_id,
       sri.catalog_state_id,
       sri.ebay_item_id,
       sri.asin,
       sri.review_status,
       sri.source_status,
       sri.source_status_reason
     FROM stock_review_items sri
     INNER JOIN stores s ON s.id = sri.store_id AND s.workspace_id = sri.workspace_id
     WHERE sri.workspace_id = $1::uuid
       AND sri.store_id = $2::bigint
       AND s.store_code = $3
       AND s.status = 'active'
       AND sri.id = ANY($4::bigint[])`,
    [workspaceId, storeId, storeCode.trim(), alertIds]
  )

  const map = new Map<number, OwnedStockAlert>()
  for (const row of res.rows) {
    map.set(row.id, mapOwnedStockAlert(row))
  }
  return map
}

async function writeBulkIgnoreBatchAudit(input: {
  actorUserId: string
  success:     boolean
  workspaceId: string
  storeCode:   string
  batchId:     string
  requested:   number
  succeeded:   number
  failed:      number
  status?:     number
  reason?:     string
}): Promise<void> {
  try {
    await insertAuditLog({
      actorUserId: input.actorUserId,
      action: input.success
        ? "app.bulk.stock_alerts.ignore"
        : "app.bulk.stock_alerts.ignore.failed",
      targetType: "stock_review_item_batch",
      targetId:   input.batchId,
      metadata: input.success
        ? {
            workspaceId: input.workspaceId,
            storeCode:   input.storeCode,
            batchId:     input.batchId,
            requested:   input.requested,
            succeeded:   input.succeeded,
            failed:      input.failed,
            actorUserId: input.actorUserId,
          }
        : {
            workspaceId: input.workspaceId,
            storeCode:   input.storeCode,
            batchId:     input.batchId,
            status:      input.status ?? 400,
            reason:      input.reason?.slice(0, 200) ?? "Bulk ignore failed",
          },
    })
  } catch (e) {
    console.warn(
      "[App][stock-alerts-bulk-ignore] batch audit log failed:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

export function parseBulkAlertIdsBody(
  body: Record<string, unknown>,
  maxAlerts: number = BULK_IGNORE_MAX_ALERTS
): number[] {
  const raw = body.alertIds
  if (!Array.isArray(raw)) {
    throw new AppHttpError(400, "alertIds must be an array")
  }
  if (raw.length === 0) {
    throw new AppHttpError(400, "alertIds must not be empty")
  }

  const ids: number[] = []
  const seen = new Set<number>()

  for (const item of raw) {
    const id = Number(item)
    if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
      throw new AppHttpError(400, "alertIds must contain positive integers")
    }
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  if (ids.length === 0) {
    throw new AppHttpError(400, "alertIds must not be empty")
  }
  if (ids.length > maxAlerts) {
    throw new AppHttpError(400, `alertIds must not exceed ${maxAlerts}`)
  }

  return ids
}

export async function appBulkIgnoreStockAlerts(input: {
  workspaceId: string
  actorUserId: string
  store:       OwnedStore
  alertIds:    number[]
}): Promise<AppBulkIgnoreStockAlertsResponse> {
  const batchId = randomUUID()
  const alertMap = await loadOwnedStockAlertsByIds(
    input.workspaceId,
    input.store.id,
    input.store.storeCode,
    input.alertIds
  )

  const results: AppIgnoreStockAlertItemResult[] = []

  for (const alertId of input.alertIds) {
    const alert = alertMap.get(alertId)
    if (!alert) {
      results.push({
        alertId,
        ok:    false,
        error: "Alert not found.",
      })
      continue
    }

    const itemResult = await ignoreOwnedStockAlertItem({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      store:       input.store,
      alert,
      batchId,
    })
    results.push(itemResult)
  }

  const succeeded = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length

  await writeBulkIgnoreBatchAudit({
    actorUserId: input.actorUserId,
    success:     true,
    workspaceId: input.workspaceId,
    storeCode:   input.store.storeCode,
    batchId,
    requested:   input.alertIds.length,
    succeeded,
    failed,
  })

  return {
    ok:        true,
    storeCode: input.store.storeCode,
    batchId,
    requested: input.alertIds.length,
    succeeded,
    failed,
    results,
  }
}
