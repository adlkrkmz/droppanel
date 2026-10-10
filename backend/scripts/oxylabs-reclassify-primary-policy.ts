import "dotenv/config"
import { evaluateStoredOxylabsPrimaryJob, supersedeOxylabsConfirmJobs } from "../modules/oxylabsVerify/oxylabsProductReclassify"
import { query } from "../db/client"

async function main(): Promise<void> {
  const cancelled = await supersedeOxylabsConfirmJobs()
  const ids = [6931, 6932, 6933, 6934, 6935]
  const rows = []
  for (const id of ids) rows.push(await evaluateStoredOxylabsPrimaryJob(id))
  const confirms = await query(
    `SELECT COUNT(*)::int AS c FROM amazon_scan_jobs WHERE kind='OXYLABS_PRODUCT_CONFIRM' AND status = ANY($1::text[])`,
    [["PENDING", "CLAIMED", "RUNNING", "WAITING_FOR_WORKER", "RETRYABLE"]]
  )
  const pendingPrimary = await query(
    `SELECT COUNT(*)::int AS c FROM amazon_scan_jobs WHERE kind='OXYLABS_PRODUCT_PRIMARY' AND status='PENDING'`
  )
  console.log(JSON.stringify({ cancelled, rows, activeConfirms: confirms.rows[0], pendingPrimary: pendingPrimary.rows[0] }, null, 2))
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
