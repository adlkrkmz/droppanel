// ----------------------------------------------------------------
// appStockAlertApproveZeroService.ts — user-scoped stock alert qty 0 (Phase 5D)
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { insertAuditLog } from "../auth/authRepository"
import { getValidAccessToken } from "../ebayOAuth/ebayOAuthService"
import { zeroListingQuantityOnEbay } from "../stockAlerts/stockAlertsEbayZeroService"
import { afterListingMonitoringStopped, afterListingStockGuardZeroed } from "../stockGuard/stockGuardV2LifecycleHooks"
import { isEligibleForAutomaticMutation } from "../stockGuard/automaticListingEligibility"
import type { OwnedStockAlert, OwnedStore } from "./appOwnership"
import type { AppStockAlertApproveZeroResponse } from "./appTypes"
import { AppHttpError } from "./appTypes"

const APPROVABLE_STATUSES = new Set(["pending", "processing", "failed"])

type ApproveZeroCatalog = {
  id:            number
  storeId:       number
  internalSku:   string | null
  ebayItemId:    string | null
  ebayOfferId:   string | null
  ebayQuantity:  number
  currentStatus: string | null
}

export type AppApproveZeroStockAlertItemResult = {
  alertId:         number
  ok:              boolean
  catalogStateId?: number
  ebayItemId?:     string
  oldQuantity?:    number | null
  newQuantity?:    number
  reviewStatus?:   string
  message?:        string
  error?:          string
}

async function loadApproveZeroCatalog(
  workspaceId:    string,
  storeCode:      string,
  catalogStateId: number
): Promise<ApproveZeroCatalog | null> {
  const res = await query<{
    id: number
    store_id: number
    internal_sku: string | null
    ebay_item_id: string | null
    ebay_offer_id: string | null
    ebay_quantity: number | null
    current_status: string | null
  }>(
    `SELECT scs.id,
            scs.store_id,
            scs.internal_sku,
            scs.ebay_item_id,
            scs.ebay_offer_id,
            scs.ebay_quantity,
            scs.current_status::text AS current_status
     FROM store_catalog_state scs
     INNER JOIN stores s ON s.id = scs.store_id AND s.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND s.store_code = $2
       AND scs.id = $3::bigint
       AND s.status = 'active'
       AND scs.panel_hidden_at IS NULL
     LIMIT 1`,
    [workspaceId, storeCode.trim(), catalogStateId]
  )

  const row = res.rows[0]
  if (!row) return null

  const ebayItemId = row.ebay_item_id?.trim() || ""

  return {
    id:            row.id,
    storeId:       row.store_id,
    internalSku:   row.internal_sku?.trim() || null,
    ebayItemId,
    ebayOfferId:   row.ebay_offer_id?.trim() || null,
    ebayQuantity:  row.ebay_quantity ?? 0,
    currentStatus: row.current_status?.trim() || null,
  }
}

async function writeApproveZeroAudit(input: {
  actorUserId:          string
  success:              boolean
  workspaceId:          string
  storeCode:            string
  alert:                OwnedStockAlert
  catalogStateId:       number
  ebayItemId:           string
  previousReviewStatus: string
  oldQuantity?:         number
  batchId?:             string
  status?:              number
  reason?:              string
}): Promise<void> {
  try {
    const batchMeta = input.batchId ? { batchId: input.batchId } : {}

    await insertAuditLog({
      actorUserId: input.actorUserId,
      action: input.success
        ? "app.stock_alerts.approve_zero"
        : "app.stock_alerts.approve_zero.failed",
      targetType: "stock_review_item",
      targetId:   String(input.alert.id),
      metadata: input.success
        ? {
            workspaceId:          input.workspaceId,
            storeCode:            input.storeCode,
            alertId:              input.alert.id,
            catalogStateId:       input.catalogStateId,
            ebayItemId:           input.ebayItemId,
            asin:                 input.alert.asin,
            previousReviewStatus: input.previousReviewStatus,
            newReviewStatus:      "actioned",
            oldQuantity:          input.oldQuantity ?? 0,
            newQuantity:          0,
            reason:               "user_approved_zero_quantity",
            ...batchMeta,
          }
        : {
            workspaceId:    input.workspaceId,
            storeCode:      input.storeCode,
            alertId:        input.alert.id,
            catalogStateId: input.catalogStateId,
            ebayItemId:     input.ebayItemId,
            status:         input.status ?? 502,
            reason:         input.reason?.slice(0, 200) ?? "Approve zero failed",
            ...batchMeta,
          },
    })
  } catch (e) {
    console.warn(
      "[App][stock-alerts-approve-zero] audit log failed:",
      e instanceof Error ? e.message : String(e)
    )
  }
}

export function validateApproveZeroRequestBody(body: Record<string, unknown>): void {
  if (body.confirm !== true) {
    throw new AppHttpError(400, "confirm must be true")
  }
  if (body.confirmationText !== "ZERO") {
    throw new AppHttpError(400, 'confirmationText must be "ZERO"')
  }
  if (body.quantity !== undefined) {
    throw new AppHttpError(400, "Quantity is not accepted for this action.")
  }
}

export async function assertEbayAccountConnected(
  workspaceId: string,
  storeCode:   string
): Promise<void> {
  try {
    await getValidAccessToken(workspaceId, storeCode, false)
  } catch {
    throw new AppHttpError(400, "eBay account is not connected for this store")
  }
}

export async function approveZeroOwnedStockAlertItem(input: {
  workspaceId:  string
  actorUserId:  string
  store:        OwnedStore
  alert:        OwnedStockAlert
  batchId?:     string
  botZeroedBy?: "user_approval" | "user_bulk_approval"
}): Promise<AppApproveZeroStockAlertItemResult> {
  const alertId = input.alert.id
  const previousReviewStatus = input.alert.reviewStatus.trim().toLowerCase()
  const sourceStatus = input.alert.sourceStatus.trim().toUpperCase()
  const botZeroedBy = input.botZeroedBy ?? "user_approval"

  if (previousReviewStatus === "ignored") {
    return {
      alertId,
      ok:    false,
      error: "Ignored alert cannot be approved.",
    }
  }

  if (previousReviewStatus === "actioned") {
    return {
      alertId,
      ok:    false,
      error: "Alert is already actioned.",
    }
  }

  if (!APPROVABLE_STATUSES.has(previousReviewStatus)) {
    return {
      alertId,
      ok:    false,
      error: "Alert cannot be approved.",
    }
  }

  if (sourceStatus === "PRICE_INCREASE") {
    return {
      alertId,
      ok:    false,
      error: "Price increase alerts should be handled with price update.",
    }
  }

  if (!input.alert.catalogStateId || input.alert.catalogStateId <= 0) {
    return {
      alertId,
      ok:    false,
      error: "Listing is missing catalog reference.",
    }
  }

  const catalog = await loadApproveZeroCatalog(
    input.workspaceId,
    input.store.storeCode,
    input.alert.catalogStateId
  )
  if (!catalog) {
    return {
      alertId,
      ok:    false,
      error: "Listing not found.",
    }
  }

  if (!(await isEligibleForAutomaticMutation({
    workspaceId: input.workspaceId,
    storeId: catalog.storeId,
    catalogStateId: catalog.id,
  }))) {
    await afterListingMonitoringStopped({
      workspaceId: input.workspaceId,
      catalogStateIds: [catalog.id],
      reason: "GUARD_DISABLED",
    })
    return {
      alertId,
      ok: false,
      error: "Stock Guard is disabled for this listing.",
    }
  }

  if (!catalog.ebayItemId) {
    return {
      alertId,
      ok:    false,
      error: "Listing is missing eBay item ID.",
    }
  }

  if (catalog.currentStatus?.toLowerCase() === "ended") {
    return {
      alertId,
      ok:    false,
      error: "Ended listing cannot be updated.",
    }
  }

  const simulationMode = (process.env.EBAY_SIMULATION ?? "true") !== "false"
  if (simulationMode) {
    await writeApproveZeroAudit({
      actorUserId:          input.actorUserId,
      success:              false,
      workspaceId:          input.workspaceId,
      storeCode:            input.store.storeCode,
      alert:                input.alert,
      catalogStateId:       catalog.id,
      ebayItemId:           catalog.ebayItemId,
      previousReviewStatus: input.alert.reviewStatus,
      batchId:              input.batchId,
      status:               502,
      reason:               "eBay simulation mode",
    })
    return {
      alertId,
      ok:    false,
      error: "Could not set quantity to 0.",
    }
  }

  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
  const oldQuantity = catalog.ebayQuantity
  const zeroReason =
    input.alert.sourceStatusReason?.trim() ||
    input.alert.sourceStatus?.trim() ||
    "Approved by user: quantity set to 0"

  try {
    await zeroListingQuantityOnEbay(
      input.workspaceId,
      input.store.storeCode,
      {
        internalSku: catalog.internalSku,
        ebayItemId:  catalog.ebayItemId,
        ebayOfferId: catalog.ebayOfferId,
      },
      sandbox
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const safeReason = msg.slice(0, 500)

    await query(
      `UPDATE stock_review_items
       SET action_error = $4,
           updated_at = NOW()
       WHERE workspace_id = $1::uuid
         AND store_id = $2::bigint
         AND id = $3::bigint`,
      [input.workspaceId, input.store.id, input.alert.id, safeReason]
    )

    await writeApproveZeroAudit({
      actorUserId:          input.actorUserId,
      success:              false,
      workspaceId:          input.workspaceId,
      storeCode:            input.store.storeCode,
      alert:                input.alert,
      catalogStateId:       catalog.id,
      ebayItemId:           catalog.ebayItemId,
      previousReviewStatus: input.alert.reviewStatus,
      batchId:              input.batchId,
      status:               502,
      reason:               safeReason.slice(0, 200),
    })

    return {
      alertId,
      ok:    false,
      error: "Could not set quantity to 0.",
    }
  }

  await query(
    `UPDATE store_catalog_state
     SET ebay_quantity = 0,
         bot_zeroed_at = NOW(),
         bot_zeroed_by = $4,
         bot_zeroed_reason = $5,
         updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND store_id = $2::bigint
       AND id = $3::bigint`,
    [input.workspaceId, input.store.id, catalog.id, botZeroedBy, zeroReason]
  )

  await afterListingStockGuardZeroed({ workspaceId: input.workspaceId, storeId: input.store.id, catalogStateId: catalog.id })

  await query(
    `UPDATE stock_review_items
     SET review_status = 'actioned',
         actioned_at = NOW(),
         action_error = NULL,
         ebay_quantity = 0,
         updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND store_id = $2::bigint
       AND id = $3::bigint`,
    [input.workspaceId, input.store.id, input.alert.id]
  )

  await writeApproveZeroAudit({
    actorUserId:          input.actorUserId,
    success:              true,
    workspaceId:          input.workspaceId,
    storeCode:            input.store.storeCode,
    alert:                input.alert,
    catalogStateId:       catalog.id,
    ebayItemId:           catalog.ebayItemId,
    previousReviewStatus: input.alert.reviewStatus,
    oldQuantity,
    batchId:              input.batchId,
  })

  return {
    alertId,
    ok:              true,
    catalogStateId:  catalog.id,
    ebayItemId:      catalog.ebayItemId,
    oldQuantity,
    newQuantity:     0,
    reviewStatus:    "actioned",
    message:         "Listing quantity was set to 0.",
  }
}

export async function appApproveZeroStockAlert(input: {
  workspaceId: string
  actorUserId: string
  store:       OwnedStore
  alert:       OwnedStockAlert
}): Promise<AppStockAlertApproveZeroResponse> {
  await assertEbayAccountConnected(input.workspaceId, input.store.storeCode)

  const result = await approveZeroOwnedStockAlertItem({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    store:       input.store,
    alert:       input.alert,
    botZeroedBy: "user_approval",
  })

  if (!result.ok) {
    const status =
      result.error === "Listing not found." ? 404 : 400
    if (result.error === "Could not set quantity to 0.") {
      throw new AppHttpError(502, result.error)
    }
    throw new AppHttpError(status, result.error ?? "Alert cannot be approved")
  }

  return {
    ok:             true,
    storeCode:      input.store.storeCode,
    alertId:        input.alert.id,
    catalogStateId: result.catalogStateId!,
    ebayItemId:     result.ebayItemId!,
    oldQuantity:    result.oldQuantity ?? 0,
    newQuantity:    0,
    reviewStatus:   "actioned",
    message:        result.message ?? "Listing quantity was set to 0.",
  }
}
