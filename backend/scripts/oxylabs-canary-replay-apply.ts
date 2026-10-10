import "dotenv/config"
import { query } from "../db/client"
import { applyOxylabsCompletedScanJob } from "../modules/oxylabsVerify/oxylabsVerifyApply"
import { loadOxylabsVerifyConfig } from "../modules/oxylabsVerify/oxylabsVerifyConfig"

const JOBS = [6936, 6937, 6938, 6939, 6940]

async function listingSnapshot(jobId: number) {
  return query<{
    job_id: string
    asin: string
    ebay_item_id: string | null
    ebay_quantity: string | null
    ebay_price: string | null
    source_price: string | null
    bot_zeroed_at: string | null
    catalog_state_id: string
  }>(
    `SELECT $1::text AS job_id, j.asin, scs.ebay_item_id, scs.ebay_quantity::text,
            scs.ebay_price::text, scs.source_price::text, scs.bot_zeroed_at::text,
            scs.id::text AS catalog_state_id
     FROM amazon_scan_jobs j
     JOIN global_asin_consumers c ON c.global_asin_id = j.global_asin_id
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     WHERE j.id = $1::bigint
     ORDER BY scs.id
     LIMIT 1`,
    [jobId]
  )
}

async function main(): Promise<void> {
  const cfg = loadOxylabsVerifyConfig()
  console.log(
    JSON.stringify({
      mutationsEnabled: cfg.mutationsEnabled,
      canaryMax: cfg.canaryMaxSuccessResults,
      enqueue: cfg.enqueueEnabled,
    })
  )
  const rows = []
  for (const id of JOBS) {
    const before = (await listingSnapshot(id)).rows[0] ?? null
    const result = await applyOxylabsCompletedScanJob(id)
    const after = (await listingSnapshot(id)).rows[0] ?? null
    rows.push({ id, before, result, after })
  }
  console.log(JSON.stringify({ replay: rows }, null, 2))
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
