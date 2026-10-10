import type { PoolClient } from "pg"
import { query } from "../../db/client"
import { obsoleteQueuedVerificationTasks } from "../amazonVerification/amazonVerificationQueue"
import { markGlobalAsinImmediatelyDue } from "../globalKeepa/globalKeepaPlannerState"
import { trySyncGlobalAsinConsumerFromCatalog } from "../globalKeepa/globalAsinConsumerSync"
import { supersedeReviewsForGuardDisabled } from "../stockAlerts/stockAlertReviewLifecycle"

async function safeLifecycle(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    console.warn(`[stock-guard-v2] ${label}:`, e instanceof Error ? e.message : e)
  }
}

export async function afterSourceAsinRelinked(input: {
  workspaceId: string
  catalogStateId: number
  newAsin: string
  globalAsinId: number | null
  immediatelyDue?: boolean
  client?: PoolClient
}): Promise<void> {
  await obsoleteQueuedVerificationTasks({
    workspaceId: input.workspaceId,
    catalogStateIds: [input.catalogStateId],
    keepAsin: input.newAsin,
    reason: "OBSOLETE_SOURCE_RESULT",
    client: input.client,
  })
  if (input.immediatelyDue !== false && input.globalAsinId != null) {
    await markGlobalAsinImmediatelyDue(input.globalAsinId, input.client)
  }
}

export async function afterListingMonitoringStopped(input: {
  workspaceId: string
  catalogStateIds?: number[]
  ebayItemIds?: string[]
  reason?: "GUARD_DISABLED"
}): Promise<void> {
  await safeLifecycle("obsolete queued verification", () =>
    obsoleteQueuedVerificationTasks({
      workspaceId: input.workspaceId,
      catalogStateIds: input.catalogStateIds,
      ebayItemIds: input.ebayItemIds,
      reason: "OBSOLETE_SOURCE_RESULT",
    })
  )
  if (input.reason === "GUARD_DISABLED") {
    await safeLifecycle("supersede Guard-disabled reviews", () =>
      supersedeReviewsForGuardDisabled({
        workspaceId: input.workspaceId,
        catalogStateIds: input.catalogStateIds,
        ebayItemIds: input.ebayItemIds,
      })
    )
  }
  const { detachConsumersForListings } = await import("../amazonScan/amazonScanLifecycle")
  await safeLifecycle("detach asin consumers", () =>
    detachConsumersForListings({
      workspaceId: input.workspaceId,
      catalogStateIds: input.catalogStateIds,
      ebayItemIds: input.ebayItemIds,
    })
  )
  await safeLifecycle("keepa projection emit after stop", async () => {
    const { emitKeepaAsinSyncForCatalog } = await import("../keepaSensor/keepaAsinSyncOutbox")
    const ids = [...(input.catalogStateIds ?? [])]
    if ((input.ebayItemIds ?? []).length > 0) {
      const extra = await query<{ id: string }>(
        `SELECT id::text FROM store_catalog_state
         WHERE workspace_id = $1::uuid AND trim(ebay_item_id) = ANY($2::text[])`,
        [input.workspaceId, input.ebayItemIds]
      )
      for (const row of extra.rows) ids.push(Number(row.id))
    }
    for (const catalogStateId of ids.filter(id => Number.isFinite(id) && id > 0)) {
      await emitKeepaAsinSyncForCatalog({ workspaceId: input.workspaceId, storeId: 0, catalogStateId })
    }
  })
}

/** Stock Guard quantity zero is a five-day recovery monitor, not an ending. */
export async function afterListingStockGuardZeroed(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
}): Promise<void> {
  await safeLifecycle("attach recovery consumer", async () => {
    await trySyncGlobalAsinConsumerFromCatalog(input)
    const { emitKeepaAsinSyncForCatalog } = await import("../keepaSensor/keepaAsinSyncOutbox")
    await emitKeepaAsinSyncForCatalog(input)
  })
}

export async function afterManualQuantityChanged(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
  quantity: number
}): Promise<void> {
  if (input.quantity <= 0) {
    await afterListingMonitoringStopped({
      workspaceId: input.workspaceId,
      catalogStateIds: [input.catalogStateId],
    })
    return
  }
  await query(
    `UPDATE store_catalog_state
     SET bot_zeroed_at = NULL,
         bot_zeroed_by = NULL,
         bot_zeroed_reason = NULL,
         source_next_check_at = NOW(),
         updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND store_id = $2::bigint
       AND id = $3::bigint`,
    [input.workspaceId, input.storeId, input.catalogStateId]
  )
  await safeLifecycle("qty restore consumer due", async () => {
    await trySyncGlobalAsinConsumerFromCatalog({
      workspaceId: input.workspaceId,
      storeId: input.storeId,
      catalogStateId: input.catalogStateId,
    })
    try {
      const { emitKeepaAsinSyncForCatalog } = await import("../keepaSensor/keepaAsinSyncOutbox")
      await emitKeepaAsinSyncForCatalog({
        workspaceId: input.workspaceId,
        storeId: input.storeId,
        catalogStateId: input.catalogStateId,
      })
    } catch {
      /* Keepa emit must not fail qty restore */
    }
    const res = await query<{ global_asin_id: string }>(
      `SELECT global_asin_id::text
       FROM global_asin_consumers
       WHERE catalog_state_id = $1::bigint
       LIMIT 1`,
      [input.catalogStateId]
    )
    const id = Number(res.rows[0]?.global_asin_id)
    if (Number.isFinite(id)) await markGlobalAsinImmediatelyDue(id)
  })
}
