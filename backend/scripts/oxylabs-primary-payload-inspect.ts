import "dotenv/config"
import { query } from "../db/client"
import { normalizeOxylabsAmazonProduct } from "../modules/oxylabsVerify/oxylabsProductNormalize"
import { classifyOxylabsProduct } from "../modules/oxylabsVerify/oxylabsProductDecision"

function redactAsin(s: string | null | undefined): string {
  const v = String(s ?? "")
  if (/^[A-Z0-9]{10}$/.test(v)) return `ASIN(${v.slice(0, 2)}…${v.slice(-2)})`
  return v || "null"
}

function keysOf(v: unknown, depth = 0): unknown {
  if (v == null) return v
  if (Array.isArray(v)) return v.slice(0, 1).map(x => keysOf(x, depth + 1))
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(o)) {
      if (k.toLowerCase().includes("token") || k.toLowerCase().includes("password") || k === "authorization") continue
      if (typeof val === "string" && /^[A-Z0-9]{10}$/.test(val)) out[k] = redactAsin(val)
      else if (depth < 3 && val && typeof val === "object") out[k] = keysOf(val, depth + 1)
      else if (typeof val === "string") out[k] = val.length > 80 ? `${val.slice(0, 40)}…` : val
      else out[k] = val
    }
    return out
  }
  return v
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
    asin: string
  }>(
    `SELECT id::text, kind, status, parent_job_id::text, keepa_candidate_id::text, failure_code, result_payload, asin
     FROM amazon_scan_jobs
     WHERE id BETWEEN 6931 AND 7000
        OR parent_job_id BETWEEN 6931 AND 6935
        OR (kind LIKE 'OXYLABS%' AND created_at > NOW() - interval '2 days')
     ORDER BY id`
  )
  for (const j of jobs.rows) {
    const n = j.result_payload
      ? normalizeOxylabsAmazonProduct({ requestedAsin: j.asin, payload: j.result_payload })
      : null
    const cls = n ? classifyOxylabsProduct(n) : null
    const featured = n
      ? {
          featuredOfferPresent: n.featuredOfferPresent,
          sellerName: n.sellerName,
          sellerId: n.sellerId ? "present" : null,
          isAmazonFulfilled: n.isAmazonFulfilled,
          shippedFrom: n.shippedFrom,
          shipsFromAmazon: n.shipsFromAmazon,
          isPrimeEligible: n.isPrimeEligible,
          stockText: n.stockText,
          stockClass: n.stockClass,
          priceKind: n.priceKind,
          pricePositive: n.pricePositive,
          currency: n.currency,
          httpStatus: n.httpStatus,
          parseStatus: n.parseStatus,
          buyboxRaw: n.buyboxRaw,
          asinMatch: n.requestedAsin === (n.returnedAsin ?? n.finalAsin),
        }
      : null
    console.log(
      JSON.stringify(
        {
          id: j.id,
          kind: j.kind,
          status: j.status,
          parent: j.parent_job_id,
          candidate: j.keepa_candidate_id,
          failure_code: j.failure_code,
          payloadShape: keysOf(j.result_payload),
          currentClass: cls,
          fields: featured,
        },
        null,
        2
      )
    )
  }
  const r = await query("SELECT COUNT(*)::int AS c FROM oxylabs_verify_call_reservations")
  console.log("reservations", r.rows[0])
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
