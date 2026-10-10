// ----------------------------------------------------------------

// appStockAlertIgnoreService.ts — user-scoped stock alert ignore (Phase 5C)

// ----------------------------------------------------------------



import { query } from "../../db/client"

import { insertAuditLog } from "../auth/authRepository"

import type { OwnedStockAlert, OwnedStore } from "./appOwnership"

import type { AppStockAlertIgnoreResponse } from "./appTypes"

import { AppHttpError } from "./appTypes"



const IGNORABLE_STATUSES = new Set(["pending", "processing", "failed"])



export type AppIgnoreStockAlertItemResult = {

  alertId:      number

  ok:           boolean

  reviewStatus?: string

  message?:     string

  error?:       string

}



async function writeIgnoreAudit(input: {

  actorUserId:          string

  success:              boolean

  workspaceId:          string

  storeCode:            string

  alert:                OwnedStockAlert

  previousReviewStatus: string

  batchId?:             string

  status?:              number

  reason?:              string

}): Promise<void> {

  try {

    const batchMeta = input.batchId ? { batchId: input.batchId } : {}



    await insertAuditLog({

      actorUserId: input.actorUserId,

      action: input.success

        ? "app.stock_alerts.ignore"

        : "app.stock_alerts.ignore.failed",

      targetType: "stock_review_item",

      targetId:   String(input.alert.id),

      metadata: input.success

        ? {

            workspaceId:          input.workspaceId,

            storeCode:            input.storeCode,

            alertId:              input.alert.id,

            catalogStateId:       input.alert.catalogStateId,

            ebayItemId:           input.alert.ebayItemId,

            asin:                 input.alert.asin,

            previousReviewStatus: input.previousReviewStatus,

            newReviewStatus:      "ignored",

            ...batchMeta,

          }

        : {

            storeCode: input.storeCode,

            alertId:   input.alert.id,

            status:    input.status ?? 400,

            reason:    input.reason?.slice(0, 200) ?? "Ignore failed",

            ...batchMeta,

          },

    })

  } catch (e) {

    console.warn(

      "[App][stock-alerts-ignore] audit log failed:",

      e instanceof Error ? e.message : String(e)

    )

  }

}



export async function ignoreOwnedStockAlertItem(input: {

  workspaceId: string

  actorUserId: string

  store:       OwnedStore

  alert:       OwnedStockAlert

  batchId?:    string

}): Promise<AppIgnoreStockAlertItemResult> {

  const previousReviewStatus = input.alert.reviewStatus.trim().toLowerCase()

  const alertId = input.alert.id



  if (previousReviewStatus === "ignored") {

    return {

      alertId,

      ok:           true,

      reviewStatus: "ignored",

      message:      "Alert is already ignored.",

    }

  }



  if (previousReviewStatus === "actioned") {

    await writeIgnoreAudit({

      actorUserId:          input.actorUserId,

      success:              false,

      workspaceId:          input.workspaceId,

      storeCode:            input.store.storeCode,

      alert:                input.alert,

      previousReviewStatus: input.alert.reviewStatus,

      batchId:              input.batchId,

      status:               400,

      reason:               "Actioned alert cannot be ignored.",

    })

    return {

      alertId,

      ok:    false,

      error: "Actioned alert cannot be ignored.",

    }

  }



  if (!IGNORABLE_STATUSES.has(previousReviewStatus)) {

    await writeIgnoreAudit({

      actorUserId:          input.actorUserId,

      success:              false,

      workspaceId:          input.workspaceId,

      storeCode:            input.store.storeCode,

      alert:                input.alert,

      previousReviewStatus: input.alert.reviewStatus,

      batchId:              input.batchId,

      status:               400,

      reason:               "Alert cannot be ignored.",

    })

    return {

      alertId,

      ok:    false,

      error: "Alert cannot be ignored.",

    }

  }



  await query(

    `UPDATE stock_review_items

     SET review_status = 'ignored',

         ignored_at = NOW(),

         action_error = NULL,

         updated_at = NOW()

     WHERE id = $1::bigint

       AND workspace_id = $2::uuid

       AND store_id = $3::bigint`,

    [input.alert.id, input.workspaceId, input.store.id]

  )



  await writeIgnoreAudit({

    actorUserId:          input.actorUserId,

    success:              true,

    workspaceId:          input.workspaceId,

    storeCode:            input.store.storeCode,

    alert:                input.alert,

    previousReviewStatus: input.alert.reviewStatus,

    batchId:              input.batchId,

  })



  return {

    alertId,

    ok:           true,

    reviewStatus: "ignored",

    message:      "Alert ignored.",

  }

}



export async function appIgnoreStockAlert(input: {

  workspaceId: string

  actorUserId: string

  store:       OwnedStore

  alert:       OwnedStockAlert

}): Promise<AppStockAlertIgnoreResponse> {

  const result = await ignoreOwnedStockAlertItem({

    workspaceId: input.workspaceId,

    actorUserId: input.actorUserId,

    store:       input.store,

    alert:       input.alert,

  })



  if (!result.ok) {

    throw new AppHttpError(400, result.error ?? "Alert cannot be ignored.")

  }



  return {

    ok:           true,

    storeCode:    input.store.storeCode,

    alertId:      input.alert.id,

    reviewStatus: "ignored",

    message:      result.message ?? "Alert ignored.",

  }

}

