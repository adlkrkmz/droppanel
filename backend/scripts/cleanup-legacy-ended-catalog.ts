/**
 * One-shot production cleanup: hard-delete legacy catalog rows with current_status=ended.
 * Does NOT call eBay. Uses the same dependency cleanup as End → hard-delete.
 *
 * Usage: npx ts-node --transpile-only scripts/cleanup-legacy-ended-catalog.ts
 */
import "dotenv/config"
import { query } from "../db/client"
import { hardDeleteCatalogListing } from "../modules/app/appListingEndService"

type EndedRow = {
  id: string | number
  workspace_id: string
  store_id: string | number
}

async function main(): Promise<void> {
  const before = await query<{ n: string }>(
    `SELECT count(*)::text AS n
     FROM store_catalog_state
     WHERE current_status::text = 'ended'`
  )
  const beforeN = Number(before.rows[0]?.n ?? 0)
  console.log(JSON.stringify({ LEGACY_ENDED_COUNT_BEFORE: beforeN }))

  if (beforeN === 0) {
    console.log(JSON.stringify({ LEGACY_ENDED_DELETED: 0, LIVE_ROWS_TOUCHED: false }))
    return
  }

  const rows = await query<EndedRow>(
    `SELECT id, workspace_id::text AS workspace_id, store_id
     FROM store_catalog_state
     WHERE current_status::text = 'ended'
     ORDER BY id ASC`
  )

  let deleted = 0
  let failed = 0
  for (const row of rows.rows) {
    const id = Number(row.id)
    const storeId = Number(row.store_id)
    if (!Number.isFinite(id) || !Number.isFinite(storeId) || id <= 0 || storeId <= 0) {
      failed++
      continue
    }
    try {
      await hardDeleteCatalogListing(row.workspace_id, storeId, id)
      deleted++
    } catch (e) {
      failed++
      console.warn(
        JSON.stringify({
          failedId: id,
          storeId,
          error: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160),
        })
      )
    }
  }

  const after = await query<{ n: string; live: string }>(
    `SELECT
       count(*) FILTER (WHERE current_status::text = 'ended')::text AS n,
       count(*) FILTER (WHERE current_status::text = 'live')::text AS live
     FROM store_catalog_state`
  )

  console.log(
    JSON.stringify({
      LEGACY_ENDED_DELETED: deleted,
      LEGACY_ENDED_FAILED: failed,
      LEGACY_ENDED_REMAINING: Number(after.rows[0]?.n ?? 0),
      LIVE_ROWS_AFTER: Number(after.rows[0]?.live ?? 0),
      LIVE_ROWS_TOUCHED: false,
    })
  )
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
