import { syncListingsForStore } from "../listings/listingsSyncService"
import { query } from "../../db/client"

export type SyncStoreFromTradingResult = {
  tradingRows: number
  upserted: number
  errors: number
}

/** @deprecated Prefer syncListingsForStore(workspaceId, storeCode). */
export async function syncStoreFromTrading(
  storeId: number,
  storeCode: string
): Promise<SyncStoreFromTradingResult> {
  const storeRes = await query<{ workspace_id: string; store_code: string }>(
    `SELECT workspace_id, store_code FROM stores WHERE id = $1 LIMIT 1`,
    [storeId]
  )
  const storeRow = storeRes.rows[0]
  if (!storeRow) {
    console.warn(`[EbayTradingSync] No store found for id=${storeId}`)
    return { tradingRows: 0, upserted: 0, errors: 0 }
  }
  if (storeRow.store_code !== storeCode) {
    throw new Error(
      `[EbayTradingSync] store_code mismatch: id=${storeId} has "${storeRow.store_code}", expected "${storeCode}"`
    )
  }

  const result = await syncListingsForStore(storeRow.workspace_id, storeCode)
  return {
    tradingRows: result.tradingRows,
    upserted:    result.inserted + result.updated,
    errors:      result.errors + result.skipped,
  }
}

export async function syncAllStores(): Promise<void> {
  const result = await query<{ workspace_id: string; id: number; store_code: string }>(
    `SELECT workspace_id, id, store_code FROM stores WHERE status = 'active'`
  )
  for (const store of result.rows) {
    await syncListingsForStore(store.workspace_id, store.store_code)
  }
}
