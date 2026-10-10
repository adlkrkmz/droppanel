// ----------------------------------------------------------------
// appStockAlertBulkApproveZeroService.ts — user-scoped bulk approve zero (Phase 5P)
// ----------------------------------------------------------------

import { randomUUID } from "crypto"
import { insertAuditLog } from "../auth/authRepository"
import type { OwnedStore } from "./appOwnership"
import {
  assertEbayAccountConnected,
  approveZeroOwnedStockAlertItem,
  type AppApproveZeroStockAlertItemResult,
} from "./appStockAlertApproveZeroService"
import {
  loadOwnedStockAlertsByIds,
  parseBulkAlertIdsBody,
} from "./appStockAlertBulkIgnoreService"
import type { AppBulkApproveZeroStockAlertsResponse } from "./appTypes"

export const BULK_APPROVE_ZERO_MAX_ALERTS = 10

async function writeBulkApproveZeroBatchAudit(input: {
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
        ? "app.bulk.stock_alerts.approve_zero"
        : "app.bulk.stock_alerts.approve_zero.failed",
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
            reason:      input.reason?.slice(0, 200) ?? "Bulk approve zero failed",
          },
    })
  } catch (e) {
    console.warn(
      "[App][stock-alerts-bulk-approve-zero] batch audit log failed:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

export function parseBulkApproveZeroAlertIdsBody(body: Record<string, unknown>): number[] {
  return parseBulkAlertIdsBody(body, BULK_APPROVE_ZERO_MAX_ALERTS)
}

export async function appBulkApproveZeroStockAlerts(input: {
  workspaceId: string
  actorUserId: string
  store:       OwnedStore
  alertIds:    number[]
}): Promise<AppBulkApproveZeroStockAlertsResponse> {
  await assertEbayAccountConnected(input.workspaceId, input.store.storeCode)

  const batchId = randomUUID()
  const alertMap = await loadOwnedStockAlertsByIds(
    input.workspaceId,
    input.store.id,
    input.store.storeCode,
    input.alertIds
  )

  const results: AppApproveZeroStockAlertItemResult[] = []

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

    const itemResult = await approveZeroOwnedStockAlertItem({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      store:       input.store,
      alert,
      batchId,
      botZeroedBy: "user_bulk_approval",
    })
    results.push(itemResult)
  }

  const succeeded = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length

  await writeBulkApproveZeroBatchAudit({
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
