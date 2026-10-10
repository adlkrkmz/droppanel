import "dotenv/config"
import { query } from "../db/client"

async function main(): Promise<void> {
  const jobs = await query(
    `SELECT id::text, kind, status, parent_job_id::text, keepa_candidate_id::text, failure_code, failure_message,
            created_at::text, completed_at::text
     FROM amazon_scan_jobs
     WHERE kind IN ('OXYLABS_PRODUCT_PRIMARY','OXYLABS_PRODUCT_CONFIRM')
     ORDER BY id`
  )
  console.log(JSON.stringify(jobs.rows, null, 2))
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
