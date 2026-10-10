import { randomUUID } from "crypto"
import { query } from "../../db/client"
import { addNotification } from "../notifications/notificationService"
import { zeroListingQuantityOnEbay } from "./stockAlertsEbayZeroService"
import { normReviewItemId } from "./stockAlertsId"
import { afterListingMonitoringStopped, afterListingStockGuardZeroed } from "../stockGuard/stockGuardV2LifecycleHooks"
import { isEligibleForAutomaticMutation } from "../stockGuard/automaticListingEligibility"

const APPROVE_ZERO_CONCURRENCY = 3

export type ApproveZeroJobItem = {
  id: number
  catalogStateId: number
  internalSku: string | null
  ebayItemId: string | null
  ebayOfferId: string | null
  sourceStatus: string
  sourceStatusReason: string | null
}

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
         bot_zeroed_by = 'manual_approval',
         bot_zeroed_reason = $4,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND store_id = $2
       AND id = $3`,
    [workspaceId, storeId, catalogStateId, reason]
  )
}

export async function processApproveZeroItem(input: {
  workspaceId: string
  storeId: number
  storeCode: string
  storeName: string
  item: ApproveZeroJobItem
  sandbox: boolean
  simulationMode: boolean
}): Promise<"ACTIONED" | "FAILED"> {
  const { workspaceId, storeId, storeCode, item, sandbox, simulationMode } = input
  const id = normReviewItemId(item.id)
  const sku = item.internalSku?.trim() || null
  const ebayItemId = item.ebayItemId?.trim() || null
  const ebayOfferId = item.ebayOfferId?.trim() || null

  if (!(await isEligibleForAutomaticMutation({
    workspaceId,
    storeId,
    catalogStateId: item.catalogStateId,
  }))) {
    await afterListingMonitoringStopped({
      workspaceId,
      catalogStateIds: [item.catalogStateId],
      reason: "GUARD_DISABLED",
    })
    return "FAILED"
  }

  console.log(
    `[StockAlerts][approve-zero] processing id=${id} catalog_state_id=${item.catalogStateId} ebayItemId=${ebayItemId ?? "(none)"} sku=${sku ?? "(none)"} offerId=${ebayOfferId ?? "(none)"}`
  )

  if (!sku && !ebayItemId) {
    const msg = "Missing internal_sku and ebay_item_id — cannot update eBay quantity"
    await query(
      `UPDATE stock_review_items
       SET review_status = 'failed',
           action_error = $4,
           processing_job_id = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint AND id = $3`,
      [workspaceId, storeId, id, msg]
    )
    console.error(`[StockAlerts][approve-zero] FAILED id=${id}: ${msg}`)
    return "FAILED"
  }

  const immediatelyEligible = await isEligibleForAutomaticMutation({ workspaceId, storeId, catalogStateId: item.catalogStateId })
  if (!immediatelyEligible) return "FAILED"

  if (simulationMode) {
    const msg = "EBAY_SIMULATION=true — no eBay or DB changes"
    await query(
      `UPDATE stock_review_items
       SET review_status = 'failed',
           action_error = $4,
           processing_job_id = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint AND id = $3`,
      [workspaceId, storeId, id, msg]
    )
    console.log(`[StockAlerts][approve-zero] SIMULATION id=${id}`)
    return "FAILED"
  }

  const reason =
    item.sourceStatusReason?.trim() ||
    item.sourceStatus?.trim() ||
    "stock_review_approved"

  try {
    console.log(`[StockAlerts][approve-zero] calling Qty0 service id=${id}`)
    const { method } = await zeroListingQuantityOnEbay(
      workspaceId,
      storeCode,
      { internalSku: sku, ebayItemId, ebayOfferId },
      sandbox
    )

    await markCatalogBotZeroed(workspaceId, storeId, item.catalogStateId, reason)
    await afterListingStockGuardZeroed({ workspaceId, storeId, catalogStateId: item.catalogStateId })

    await query(
      `UPDATE stock_review_items
       SET review_status = 'actioned',
           actioned_at = NOW(),
           action_error = NULL,
           ebay_quantity = 0,
           processing_job_id = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint AND id = $3`,
      [workspaceId, storeId, id]
    )

    console.log(`[StockAlerts][approve-zero] ACTIONED id=${id} method=${method}`)
    return "ACTIONED"
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await query(
      `UPDATE stock_review_items
       SET review_status = 'failed',
           action_error = $4,
           processing_job_id = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1::uuid AND store_id = $2::bigint AND id = $3`,
      [workspaceId, storeId, id, msg.slice(0, 500)]
    )
    console.error(`[StockAlerts][approve-zero] FAILED id=${id}: ${msg}`)
    return "FAILED"
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++
      await fn(items[i]!)
    }
  })
  await Promise.all(workers)
}

export function startApproveZeroBackgroundJob(input: {
  workspaceId: string
  storeId: number
  storeCode: string
  storeName: string
  jobId: string
  items: ApproveZeroJobItem[]
  sandbox: boolean
  simulationMode: boolean
}): void {
  const { workspaceId, storeId, storeCode, storeName, jobId, items, sandbox, simulationMode } = input

  void (async () => {
    let actioned = 0
    let failed = 0

    console.log(
      `[StockAlerts][approve-zero] job=${jobId} background start items=${items.length} concurrency=${APPROVE_ZERO_CONCURRENCY}`
    )

    await runWithConcurrency(items, APPROVE_ZERO_CONCURRENCY, async item => {
      const result = await processApproveZeroItem({
        workspaceId,
        storeId,
        storeCode,
        storeName,
        item,
        sandbox,
        simulationMode,
      })
      if (result === "ACTIONED") actioned++
      else failed++
    })

    console.log(
      `[StockAlerts][approve-zero] job=${jobId} done actioned=${actioned} failed=${failed}`
    )

    if (actioned > 0) {
      const title =
        actioned === 1
          ? "1 listing was set to quantity 0"
          : `${actioned} listings were set to quantity 0`
      void addNotification(workspaceId, "success", title, `Store: ${storeName}`)
    }
    if (failed > 0) {
      const title =
        failed === 1
          ? "1 listing failed to update"
          : `${failed} listings failed to update`
      if (actioned > 0) {
        void addNotification(
          workspaceId,
          "warning",
          title,
          `Store: ${storeName} (${actioned} succeeded)`
        )
      } else {
        void addNotification(workspaceId, "warning", title, `Store: ${storeName}`)
      }
    }
  })().catch(e => {
    console.error(`[StockAlerts][approve-zero] job=${jobId} fatal:`, e)
  })
}

export function newApproveZeroJobId(): string {
  return `approve-zero-${randomUUID()}`
}
