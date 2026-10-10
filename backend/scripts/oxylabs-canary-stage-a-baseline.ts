import "dotenv/config"
import { query } from "../db/client"

async function main(): Promise<void> {
  const reservations = await query("SELECT COUNT(*)::int AS c FROM oxylabs_verify_call_reservations")
  const canary = await query("SELECT success_result_count, updated_at FROM oxylabs_verify_canary_state WHERE id = 1")
  const oxylabsJobs = await query(
    `SELECT kind, status, count(*)::int AS n FROM amazon_scan_jobs WHERE kind LIKE 'OXYLABS%' GROUP BY 1,2 ORDER BY 1,2`
  )
  const allKinds = await query(`SELECT kind, count(*)::int AS n FROM amazon_scan_jobs GROUP BY 1 ORDER BY 1`)
  const candidates = await query(`SELECT status, count(*)::int AS n FROM keepa_verify_candidates GROUP BY 1 ORDER BY 1`)
  const evalTop = await query(
    `SELECT UPPER(COALESCE(snapshot->>'evaluationCode', '')) AS code, count(*)::int AS n
     FROM keepa_verify_candidates GROUP BY 1 ORDER BY 2 DESC LIMIT 12`
  )
  const outbox = await query(`SELECT status, count(*)::int AS n FROM amazon_scan_apply_outbox GROUP BY 1`)
  const scanHb = await query(
    `SELECT worker_id, status, browser_running, updated_at
     FROM amazon_scan_worker_heartbeat ORDER BY updated_at DESC LIMIT 16`
  )
  const browserHb = await query(
    `SELECT worker_id, status, updated_at
     FROM amazon_browser_worker_heartbeat ORDER BY updated_at DESC LIMIT 8`
  )
  const oxylabsProvider = await query(
    `SELECT COUNT(*)::int AS n FROM amazon_scan_jobs WHERE provider = 'OXYLABS_PRODUCT'`
  )
  console.log(
    JSON.stringify(
      {
        reservations: reservations.rows,
        canary: canary.rows,
        oxylabsJobs: oxylabsJobs.rows,
        allKinds: allKinds.rows,
        candidates: candidates.rows,
        evalTop: evalTop.rows,
        outbox: outbox.rows,
        scanHeartbeats: scanHb.rows,
        browserHeartbeats: browserHb.rows,
        oxylabsProviderJobs: oxylabsProvider.rows,
      },
      null,
      2
    )
  )
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
