/** One-shot, idempotent lifecycle reconciliation. No product scan or external API call. */
import "dotenv/config"
import { query, db } from "../db/client"
import { trySyncGlobalAsinConsumerFromCatalog } from "../modules/globalKeepa/globalAsinConsumerSync"
import { emitKeepaAsinSyncForAsin } from "../modules/keepaSensor/keepaAsinSyncOutbox"
import { KEEPA_SNAPSHOT_RESOLVED_ASIN_SQL } from "../modules/keepaSensor/keepaCollectorSnapshot"

const live = "LOWER(COALESCE(scs.current_status::text, '')) NOT IN ('ended','ended_by_seller','ended_by_ebay')"
const eligible = `(${live} AND (COALESCE(scs.ebay_quantity,0)>0 OR scs.bot_zeroed_at IS NOT NULL))`
async function parallel<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0; let failed = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; try { await fn(x) } catch { failed++ } } }))
  return failed
}
async function main() {
  const missing = await query<{ workspace_id: string; store_id: string; id: string }>(
    `SELECT scs.workspace_id::text,scs.store_id::text,scs.id::text FROM store_catalog_state scs
     LEFT JOIN global_asin_consumers c ON c.catalog_state_id=scs.id
     LEFT JOIN asin_registry ar ON ar.id=scs.asin_registry_id AND ar.workspace_id=scs.workspace_id
     WHERE ${eligible} AND (${KEEPA_SNAPSHOT_RESOLVED_ASIN_SQL}) IS NOT NULL AND c.catalog_state_id IS NULL`)
  let repaired = 0
  const failed = await parallel(missing.rows, 6, async r => {
    await trySyncGlobalAsinConsumerFromCatalog({ workspaceId:r.workspace_id, storeId:Number(r.store_id), catalogStateId:Number(r.id) }); repaired++
  })
  const asins = await query<{ asin:string }>(
    `WITH catalog AS (
       SELECT DISTINCT ${KEEPA_SNAPSHOT_RESOLVED_ASIN_SQL} AS asin FROM store_catalog_state scs
       LEFT JOIN asin_registry ar ON ar.id=scs.asin_registry_id AND ar.workspace_id=scs.workspace_id
       WHERE ${live}
     ), state AS (SELECT asin FROM keepa_asin_sync_state)
     SELECT asin FROM catalog WHERE asin IS NOT NULL UNION SELECT asin FROM state`)
  const stateFailures = await parallel(asins.rows.map(r => r.asin), 6, async asin => { await emitKeepaAsinSyncForAsin(asin) })
  const remaining = await query<{ n:string }>(
    `SELECT COUNT(*)::text AS n FROM store_catalog_state scs LEFT JOIN global_asin_consumers c ON c.catalog_state_id=scs.id
     LEFT JOIN asin_registry ar ON ar.id=scs.asin_registry_id AND ar.workspace_id=scs.workspace_id
     WHERE ${eligible} AND (${KEEPA_SNAPSHOT_RESOLVED_ASIN_SQL}) IS NOT NULL AND c.catalog_state_id IS NULL`)
  console.log(JSON.stringify({ missingFound:missing.rows.length, repaired, failed, projectionAsins:asins.rows.length, stateFailures,
    missingRemaining:Number(remaining.rows[0]?.n||0) }))
  await db.end()
}
void main().catch(async e => { console.error(e); await db.end(); process.exit(1) })
