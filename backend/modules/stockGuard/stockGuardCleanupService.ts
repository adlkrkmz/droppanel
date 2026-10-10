import { query } from "../../db/client"
import { STOCK_GUARD_SCAN_ELIGIBLE_QTY } from "./stockGuardScanEligibility"
import { recoverStaleStockGuardJobs } from "./keepaTokenGuardService"
import { STOCK_ALERTS_VISIBLE_SQL } from "../stockAlerts/stockAlertListQuery"

export const PRICE_INCREASE_RESOLVED_REASON =
  "Resolved by auto profit protection price update"

export const ZERO_QTY_PENDING_IGNORE_REASON =
  "Resolved automatically because eBay quantity is 0"

/** Pending alerts visible in UI / status (qty > 0 on catalog). */
export const PENDING_ALERT_OPEN_QTY_SQL = STOCK_GUARD_SCAN_ELIGIBLE_QTY

export async function cleanupZeroQtyPendingStockAlerts(
  workspaceId: string
): Promise<number> {
  try {
    const res = await query(
      `UPDATE stock_review_items sri
       SET review_status = 'ignored',
           ignored_at = NOW(),
           action_error = $2::text,
           updated_at = NOW()
       FROM store_catalog_state scs
       WHERE sri.catalog_state_id = scs.id
         AND sri.workspace_id = scs.workspace_id
         AND sri.store_id = scs.store_id
         AND sri.workspace_id = $1::uuid
         AND sri.review_status = 'pending'
         AND NOT (${PENDING_ALERT_OPEN_QTY_SQL})`,
      [workspaceId, ZERO_QTY_PENDING_IGNORE_REASON]
    )
    const n = res.rowCount ?? 0
    if (n > 0) {
      console.log(`[StockGuardCleanup] zeroQtyPendingIgnored=${n} workspace=${workspaceId}`)
    }
    return n
  } catch (e) {
    console.warn(
      "[StockGuardCleanup] cleanupZeroQtyPendingStockAlerts failed:",
      e instanceof Error ? e.message : String(e)
    )
    return 0
  }
}

export async function cleanupCompletedJobErrors(workspaceId: string): Promise<number> {
  try {
    const res = await query(
      `UPDATE stock_guard_scan_jobs
       SET error_message = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1::uuid
         AND status = 'completed'
         AND error_message IS NOT NULL`,
      [workspaceId]
    )
    const n = res.rowCount ?? 0
    if (n > 0) {
      console.log(`[StockGuardCleanup] completedJobErrorsCleared=${n}`)
    }
    return n
  } catch (e) {
    console.warn(
      "[StockGuardCleanup] cleanupCompletedJobErrors failed:",
      e instanceof Error ? e.message : String(e)
    )
    return 0
  }
}

export async function countPendingStockAlerts(
  workspaceId: string,
  storeId: number
): Promise<number> {
  try {
    const res = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM stock_review_items sri
       INNER JOIN store_catalog_state scs
         ON scs.id = sri.catalog_state_id
        AND scs.workspace_id = sri.workspace_id
        AND scs.store_id = sri.store_id
       WHERE sri.workspace_id = $1::uuid
         AND sri.store_id = $2::bigint
         AND sri.review_status = 'pending'
         AND ${PENDING_ALERT_OPEN_QTY_SQL}
         AND ${STOCK_ALERTS_VISIBLE_SQL}`,
      [workspaceId, storeId]
    )
    return parseInt(res.rows[0]?.c ?? "0", 10) || 0
  } catch {
    return 0
  }
}

/** Close pending PRICE_INCREASE alerts after a successful eBay price update. */
export async function resolvePendingFailedPriceIncreaseAlerts(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
  reason?: string
}): Promise<number> {
  try {
    const res = await query(
      `UPDATE stock_review_items
       SET review_status = 'actioned',
           actioned_at = NOW(),
           action_error = NULL,
           source_status_reason = $4::text,
           updated_at = NOW()
       WHERE workspace_id = $1::uuid
         AND store_id = $2::bigint
         AND catalog_state_id = $3::bigint
         AND review_status = 'pending'
         AND source_status = 'PRICE_INCREASE'`,
      [
        input.workspaceId,
        input.storeId,
        input.catalogStateId,
        input.reason ?? PRICE_INCREASE_RESOLVED_REASON,
      ]
    )
    const n = res.rowCount ?? 0
    if (n > 0) {
      console.log(
        `[StockGuardCleanup] resolvedFailedPriceIncreaseAlerts=${n} catalogStateId=${input.catalogStateId}`
      )
    }
    return n
  } catch (e) {
    console.warn(
      "[StockGuardCleanup] resolvePendingFailedPriceIncreaseAlerts failed:",
      e instanceof Error ? e.message : String(e)
    )
    return 0
  }
}

/**
 * Stale pending PRICE_INCREASE alerts where no additional eBay change is required.
 * A no-op is not a confirmed mutation, so it remains history as ignored rather
 * than being presented as actioned.
 */
export async function cleanupResolvedPriceIncreaseAlerts(
  workspaceId: string
): Promise<number> {
  try {
    const res = await query(
      `UPDATE stock_review_items sri
       SET review_status = 'ignored',
           ignored_at = NOW(),
           action_error = 'No eBay update required; price already at or above protected target',
           source_status_reason = 'Ignored — no eBay update required; price already at or above protected target',
           updated_at = NOW()
       FROM store_catalog_state scs
       WHERE sri.catalog_state_id = scs.id
         AND sri.workspace_id = scs.workspace_id
         AND sri.store_id = scs.store_id
         AND sri.workspace_id = $1::uuid
         AND sri.review_status = 'pending'
         AND sri.source_status = 'PRICE_INCREASE'
         AND (
           scs.auto_price_protected_at IS NOT NULL
           OR (
             scs.auto_price_new_ebay_price IS NOT NULL
             AND scs.ebay_price IS NOT NULL
             AND scs.ebay_price >= scs.auto_price_new_ebay_price - 0.005
           )
           OR scs.manual_price_updated_at IS NOT NULL
         )`,
      [workspaceId]
    )
    const n = res.rowCount ?? 0
    if (n > 0) {
      console.log(`[StockGuardCleanup] cleanupResolvedPriceIncreaseAlerts=${n}`)
    }
    return n
  } catch (e) {
    console.warn(
      "[StockGuardCleanup] cleanupResolvedPriceIncreaseAlerts failed:",
      e instanceof Error ? e.message : String(e)
    )
    return 0
  }
}

export async function runStockGuardMaintenance(workspaceId: string): Promise<{
  zeroQtyAlertsResolved: number
  completedJobErrorsCleared: number
  staleJobsRecovered: number
  resolvedPriceIncreaseAlerts: number
}> {
  const staleJobsRecovered = await recoverStaleStockGuardJobs(workspaceId)
  const zeroQtyAlertsResolved = await cleanupZeroQtyPendingStockAlerts(workspaceId)
  const completedJobErrorsCleared = await cleanupCompletedJobErrors(workspaceId)
  const resolvedPriceIncreaseAlerts =
    await cleanupResolvedPriceIncreaseAlerts(workspaceId)
  return {
    zeroQtyAlertsResolved,
    completedJobErrorsCleared,
    staleJobsRecovered,
    resolvedPriceIncreaseAlerts,
  }
}
