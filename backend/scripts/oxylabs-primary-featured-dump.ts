import "dotenv/config"
import { query } from "../db/client"

function featuredDump(payload: Record<string, unknown>) {
  const results = payload.results
  const first = Array.isArray(results) && results[0] && typeof results[0] === "object" ? (results[0] as Record<string, unknown>) : null
  const c = first?.content && typeof first.content === "object" ? (first.content as Record<string, unknown>) : {}
  const f = c.featured_merchant
  const featured =
    f && typeof f === "object"
      ? Object.fromEntries(
          Object.entries(f as Record<string, unknown>).map(([k, v]) => {
            if (typeof v === "string" && /^[A-Z0-9]{10}$/.test(v)) return [k, "ASIN"]
            if (/seller_id|seller_url/i.test(k) && typeof v === "string") return [k, "present"]
            return [k, v]
          })
        )
      : f ?? null
  const buybox0 = Array.isArray(c.buybox) ? (c.buybox[0] as Record<string, unknown> | undefined) : null
  return {
    price: c.price,
    currency: c.currency,
    stock: c.stock === "" ? "(empty)" : c.stock ?? null,
    parse: first?.parse_status_code ?? c.parse_status_code ?? null,
    http: first?.status_code ?? null,
    featured,
    buybox0keys: buybox0 ? Object.keys(buybox0) : null,
    buybox0primeish: buybox0?.delivery_details,
  }
}

async function main(): Promise<void> {
  const jobs = await query<{
    id: string
    kind: string
    status: string
    parent_job_id: string | null
    keepa_candidate_id: string | null
    failure_code: string | null
    result_payload: Record<string, unknown> | null
  }>(
    `SELECT id::text, kind, status, parent_job_id::text, keepa_candidate_id::text, failure_code, result_payload
     FROM amazon_scan_jobs
     WHERE id BETWEEN 6931 AND 6935
        OR parent_job_id BETWEEN 6931 AND 6935
     ORDER BY id`
  )
  for (const j of jobs.rows) {
    const dump = j.kind === "OXYLABS_PRODUCT_PRIMARY" && j.result_payload ? featuredDump(j.result_payload) : null
    console.log(JSON.stringify({ id: j.id, kind: j.kind, status: j.status, parent: j.parent_job_id, cand: j.keepa_candidate_id, failure_code: j.failure_code, dump }))
  }
  const cand = await query(
    `SELECT id::text, status, snapshot->>'purpose' AS purpose, snapshot->>'evaluationCode' AS eval, browser_decision
     FROM keepa_verify_candidates
     WHERE id IN (SELECT keepa_candidate_id FROM amazon_scan_jobs WHERE id BETWEEN 6931 AND 6935)`
  )
  console.log("candidates", JSON.stringify(cand.rows))
  const resv = await query<{ job_id: string }>(`SELECT job_id::text FROM oxylabs_verify_call_reservations ORDER BY job_id`)
  console.log("reservations", resv.rows.map(r => r.job_id))
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
