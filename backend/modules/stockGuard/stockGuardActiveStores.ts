import { query } from "../../db/client"

/** Same eligibility as GET /admin/stores (active store + ebay_accounts row). */
export type ConnectedStore = {
  storeId: number
  storeCode: string
  name: string
}

const CONNECTED_STORE_SUBQUERY = `
  SELECT s.id
  FROM stores s
  INNER JOIN ebay_accounts ea
    ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id
  WHERE s.workspace_id = $1::uuid
    AND s.status = 'active'
`

export async function listConnectedStores(workspaceId: string): Promise<ConnectedStore[]> {
  const res = await query<{ id: number; store_code: string; name: string }>(
    `SELECT s.id, s.store_code, s.name
     FROM stores s
     INNER JOIN ebay_accounts ea
       ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id
     WHERE s.workspace_id = $1::uuid
       AND s.status = 'active'
     ORDER BY s.store_code`,
    [workspaceId]
  )
  return res.rows.map(r => ({
    storeId: Number(r.id),
    storeCode: r.store_code,
    name: r.name,
  }))
}

export async function isStoreConnected(
  workspaceId: string,
  storeId: number
): Promise<boolean> {
  const res = await query<{ ok: number }>(
    `SELECT 1 AS ok
     FROM stores s
     INNER JOIN ebay_accounts ea
       ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id
     WHERE s.workspace_id = $1::uuid
       AND s.id = $2::bigint
       AND s.status = 'active'
     LIMIT 1`,
    [workspaceId, storeId]
  )
  return (res.rowCount ?? 0) > 0
}

/** Fail open jobs for stores that are not OAuth-connected (no DELETE). */
export async function cancelGhostStoreJobs(workspaceId: string): Promise<number> {
  try {
    const res = await query(
      `UPDATE stock_guard_scan_jobs j
       SET status = 'failed',
           error_message = 'inactive or disconnected store',
           completed_at = COALESCE(completed_at, NOW()),
           updated_at = NOW()
       WHERE j.workspace_id = $1::uuid
         AND j.status IN ('queued', 'running', 'skipped_waiting_tokens')
         AND j.store_id NOT IN (${CONNECTED_STORE_SUBQUERY})`,
      [workspaceId]
    )
    const n = res.rowCount ?? 0
    if (n > 0) {
      console.log(`[StockGuard] cancelled ${n} ghost store job(s)`)
    }
    return n
  } catch (e) {
    console.warn(
      "[StockGuard] cancelGhostStoreJobs:",
      e instanceof Error ? e.message : String(e)
    )
    return 0
  }
}

export function connectedStoreSubquery(): string {
  return CONNECTED_STORE_SUBQUERY
}
