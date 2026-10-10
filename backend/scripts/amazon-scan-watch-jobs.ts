import "dotenv/config"
import { query } from "../db/client"
import { isScanObservationIncomplete } from "../modules/amazonScan/amazonScanApplyPolicy"

const IDS = (process.env.WATCH_JOB_IDS ?? "40,41").split(",").map(Number)
const KIND = process.env.WATCH_KIND ?? "ROUTINE"
const LIMIT_MS = 120_000

function classify(row: {
  status: string
  kind: string
  worker_id: string | null
  failure_code: string | null
  result_payload: Record<string, unknown> | null
}): string {
  if (row.status !== "COMPLETED") return row.status
  if (isScanObservationIncomplete(row.result_payload)) return "incomplete"
  const payload = row.result_payload ?? {}
  const meta = (payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}) as Record<string, unknown>
  if (payload.captcha === true) return "captcha"
  if (payload.timeout === true) return "timeout"
  if (String(meta.publicStatus ?? "") === "AMAZON_INCOMPLETE" || payload.uncertain === true) return "incomplete"
  return "valid"
}

async function snap() {
  const jobs = await query<{
    id: string
    kind: string
    status: string
    worker_id: string | null
    failure_code: string | null
    require_fresh_nav: boolean
    parent_job_id: string | null
    observed_at: Date | null
    claimed_at: Date | null
    result_payload: Record<string, unknown> | null
  }>(
    `SELECT id::text, kind, status, worker_id, failure_code, require_fresh_nav, parent_job_id::text,
            observed_at, claimed_at, result_payload
     FROM amazon_scan_jobs WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [IDS]
  )
  return jobs.rows.map(r => ({
    id: Number(r.id),
    kind: r.kind,
    status: r.status,
    worker: r.worker_id,
    class: classify(r),
    fresh: r.require_fresh_nav,
    parent: r.parent_job_id,
    observed_at: r.observed_at,
    claimed_at: r.claimed_at,
  }))
}

async function main(): Promise<void> {
  const t0 = Date.now()
  let last: Awaited<ReturnType<typeof snap>> = []
  while (Date.now() - t0 < LIMIT_MS) {
    last = await snap()
    console.log("tick", JSON.stringify({ elapsedMs: Date.now() - t0, jobs: last }))
    const done = last.length === IDS.length && last.every(j => j.status === "COMPLETED" || j.status === "FAILED" || j.status === "WAITING_FOR_WORKER")
    if (done) break
    if (Date.now() - t0 + 8000 >= LIMIT_MS) break
    await new Promise(r => setTimeout(r, 8000))
  }
  last = await snap()
  const wrongKind = last.filter(j => KIND === "ROUTINE" && String(j.worker ?? "").startsWith("amazon-scan-confirm-"))
  const confirmStolen = last.filter(j => KIND === "CONFIRM" && String(j.worker ?? "").startsWith("amazon-public-browser-worker-"))
  const allValid = last.length === IDS.length && last.every(j => j.status === "COMPLETED" && j.class === "valid")
  console.log("FINAL", JSON.stringify({ kind: KIND, jobs: last, allValid, wrongKind, confirmStolen, watchMs: Date.now() - t0 }))
  if (!allValid) process.exit(2)
}

void main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
