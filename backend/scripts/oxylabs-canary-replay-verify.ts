import "dotenv/config"
import { query } from "../db/client"
import { applyOxylabsCompletedScanJob } from "../modules/oxylabsVerify/oxylabsVerifyApply"

const CATALOGS = [
  { jobId: 6936, catalogStateId: 11015 },
  { jobId: 6937, catalogStateId: 10323 },
  { jobId: 6938, catalogStateId: 2793 },
  { jobId: 6939, catalogStateId: 6142 },
  { jobId: 6940, catalogStateId: 7198 },
]

async function snap(catalogStateId: number) {
  const r = await query<{
    id: string
    ebay_item_id: string | null
    ebay_quantity: string | null
    ebay_price: string | null
    source_price: string | null
    current_status: string | null
    bot_zeroed_at: string | null
    bot_zeroed_reason: string | null
    last_verified_decision: string | null
    last_verified_asin: string | null
  }>(
    `SELECT id::text, ebay_item_id, ebay_quantity::text, ebay_price::text, source_price::text,
            current_status::text, bot_zeroed_at::text, bot_zeroed_reason,
            last_verified_decision, last_verified_asin
     FROM store_catalog_state WHERE id = $1::bigint`,
    [catalogStateId]
  )
  return r.rows[0] ?? null
}

async function main(): Promise<void> {
  const beforeSecond = []
  for (const c of CATALOGS) {
    beforeSecond.push({ jobId: c.jobId, listing: await snap(c.catalogStateId) })
  }
  const second = []
  for (const c of CATALOGS) {
    const result = await applyOxylabsCompletedScanJob(c.jobId)
    second.push({
      jobId: c.jobId,
      result,
      listing: await snap(c.catalogStateId),
    })
  }
  const jobs = await query(
    `SELECT id::text, kind, status, created_at::text, completed_at::text, failure_code
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND id > 6940
     ORDER BY id DESC
     LIMIT 40`
  )
  const reservations = await query(
    `SELECT COUNT(*)::int AS n FROM oxylabs_verify_call_reservations`
  ).catch(async () => {
    const t = await query(`SELECT to_regclass('oxylabs_verify_call_reservations')::text AS t`)
    return { rows: [{ n: t.rows[0]?.t ?? "missing" }] }
  })
  const pending = await query(
    `SELECT status, COUNT(*)::int AS n
     FROM amazon_scan_jobs
     WHERE kind = 'OXYLABS_PRODUCT_PRIMARY' AND id > 6940
     GROUP BY status`
  )
  console.log(JSON.stringify({ beforeSecond, second, newJobs: jobs.rows, reservations: reservations.rows, pending: pending.rows }, null, 2))
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
