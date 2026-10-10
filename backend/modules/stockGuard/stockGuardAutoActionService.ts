import { query } from "../../db/client"
import { addNotification } from "../notifications/notificationService"
import { zeroListingQuantityOnEbay } from "../stockAlerts/stockAlertsEbayZeroService"
import { normReviewItemId } from "../stockAlerts/stockAlertsId"
import type { ApproveZeroJobItem } from "../stockAlerts/stockAlertsApproveZeroWorker"
import { afterListingStockGuardZeroed } from "./stockGuardV2LifecycleHooks"
import { isEligibleForAutomaticMutation } from "./automaticListingEligibility"

const simulationMode = () => (process.env.EBAY_SIMULATION ?? "true") !== "false"
const sandbox = () => (process.env.EBAY_SANDBOX ?? "true") !== "false"

async function markCatalogBotZeroed(
  workspaceId: string,
  storeId: number,
  catalogStateId: number,
  reason: string
): Promise<void> {
  await query(
    `UPDATE store_catalog_state
     SET ebay_quantity = 0,
         bot_zeroed_at = NOW(),
         bot_zeroed_by = 'stock_guard_auto',
         bot_zeroed_reason = $4::text,
         updated_at = NOW()
     WHERE workspace_id = $1::uuid AND store_id = $2::bigint AND id = $3::bigint`,
    [workspaceId, storeId, catalogStateId, reason]
  )
}

export async function autoZeroCatalogListing(input: {
  workspaceId: string
  storeId: number
  storeCode: string
  storeName: string
  item: ApproveZeroJobItem
  reason: string
}): Promise<"ACTIONED" | "FAILED" | "SIMULATION"> {
  const { workspaceId, storeId, storeCode, item, reason } = input
  const id = normReviewItemId(item.id)

  if (!(await isEligibleForAutomaticMutation({
    workspaceId,
    storeId,
    catalogStateId: item.catalogStateId,
  }))) {
    return "FAILED"
  }

  const immediatelyEligible = await isEligibleForAutomaticMutation({ workspaceId, storeId, catalogStateId: item.catalogStateId })
  if (!immediatelyEligible) return "FAILED"

  if (simulationMode()) {
    console.log(`[StockGuard][Auto] SIMULATION qty0 catalog_state_id=${item.catalogStateId}`)
    return "SIMULATION"
  }

  const sku = item.internalSku?.trim() || null
  const ebayItemId = item.ebayItemId?.trim() || null
  if (!sku && !ebayItemId) return "FAILED"

  try {
    await zeroListingQuantityOnEbay(
      workspaceId,
      storeCode,
      {
        internalSku: sku,
        ebayItemId,
        ebayOfferId: item.ebayOfferId,
      },
      sandbox()
    )
    await markCatalogBotZeroed(workspaceId, storeId, item.catalogStateId, reason)
    await afterListingStockGuardZeroed({ workspaceId, storeId, catalogStateId: item.catalogStateId })

    await query(
      `UPDATE stock_review_items
       SET review_status = 'actioned',
           actioned_at = NOW(),
           action_error = NULL,
           ebay_quantity = 0,
           updated_at = NOW()
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint AND id = $3`,
      [workspaceId, storeId, id]
    ).catch(() => {
      /* review row may not exist for auto-direct */
    })

    return "ACTIONED"
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[StockGuard][Auto] FAILED catalog_state_id=${item.catalogStateId}: ${msg}`)
    return "FAILED"
  }
}

export async function notifyAutoZeroed(
  workspaceId: string,
  storeName: string,
  count: number
): Promise<void> {
  if (count <= 0) return
  const title =
    count === 1
      ? "1 listing was set to quantity 0 by Stock Guard"
      : `${count} listings were set to quantity 0 by Stock Guard`
  void addNotification(workspaceId, "success", title, `Store: ${storeName}`)
}
