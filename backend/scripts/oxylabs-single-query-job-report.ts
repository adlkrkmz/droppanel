import "dotenv/config"
import { query } from "../db/client"

function mask(s: string | null | undefined): string {
  const v = String(s ?? "")
  if (/^[A-Z0-9]{10}$/.test(v)) return `ASIN(${v.slice(0, 2)}…${v.slice(-2)})`
  return v || "null"
}

async function main(): Promise<void> {
  const jobs = await query<{
    id: string
    asin: string
    result_payload: Record<string, unknown>
  }>(`SELECT id::text, asin, result_payload FROM amazon_scan_jobs WHERE id BETWEEN 6931 AND 6935 ORDER BY id`)
  for (const j of jobs.rows) {
    const p = (j.result_payload?.oxylabs_policy ?? {}) as Record<string, unknown>
    console.log(
      JSON.stringify({
        id: j.id,
        asin: mask(j.asin),
        policy: p,
      })
    )
  }
  const r = await query(`SELECT COUNT(*)::int AS c FROM oxylabs_verify_call_reservations`)
  const c = await query(`SELECT success_result_count FROM oxylabs_verify_canary_state WHERE id=1`)
  const conf = await query(`SELECT COUNT(*)::int AS c FROM amazon_scan_jobs WHERE kind='OXYLABS_PRODUCT_CONFIRM'`)
  console.log("reservations", r.rows[0], "canary", c.rows[0], "confirmRows", conf.rows[0])
}

void main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
