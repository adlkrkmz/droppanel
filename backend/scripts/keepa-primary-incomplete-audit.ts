import "dotenv/config"
import { query } from "../db/client"
import { mkdirSync, writeFileSync } from "fs"

function maskAsin(asin: string): string {
  const a = String(asin ?? "").toUpperCase()
  if (a.length < 6) return "ASIN****"
  return `${a.slice(0, 2)}******${a.slice(-2)}`
}

function pick(meta: Record<string, unknown>, payload: Record<string, unknown>, key: string): unknown {
  if (payload[key] !== undefined) return payload[key]
  return meta[key]
}

async function main(): Promise<void> {
  const rates = await query<{ status: string; c: string }>(
    `SELECT COALESCE(result_payload->'metadata'->>'publicStatus', result_payload->>'publicStatus', 'UNKNOWN') AS status,
            COUNT(*)::text AS c
     FROM amazon_scan_jobs
     WHERE kind = 'KEEPA_VERIFY_PRIMARY'
       AND status = 'COMPLETED'
       AND completed_at >= NOW() - interval '30 minutes'
     GROUP BY 1
     ORDER BY COUNT(*) DESC`
  )
  const validIncomplete = await query<{ bucket: string; c: string }>(
    `SELECT CASE
              WHEN COALESCE(result_payload->'metadata'->>'publicStatus','') = 'AMAZON_INCOMPLETE'
                OR COALESCE(result_payload->>'captcha','false') = 'true'
                OR COALESCE(result_payload->>'timeout','false') = 'true'
                OR COALESCE(result_payload->>'uncertain','false') = 'true'
              THEN 'INCOMPLETE'
              WHEN COALESCE(result_payload->'metadata'->>'publicStatus','') IN ('AMAZON_OK','VALID')
                OR (result_payload->>'displayedPrice') ~ '^[0-9]'
              THEN 'LIKELY_VALID'
              ELSE 'OTHER'
            END AS bucket,
            COUNT(*)::text AS c
     FROM amazon_scan_jobs
     WHERE kind = 'KEEPA_VERIFY_PRIMARY'
       AND status = 'COMPLETED'
       AND completed_at >= NOW() - interval '30 minutes'
     GROUP BY 1`
  )
  const laterValid = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM amazon_scan_jobs
     WHERE kind = 'KEEPA_VERIFY_PRIMARY'
       AND status = 'COMPLETED'
       AND completed_at >= NOW() - interval '30 minutes'
       AND COALESCE(result_payload->'metadata'->>'publicStatus','') <> 'AMAZON_INCOMPLETE'
       AND COALESCE(result_payload->>'captcha','false') <> 'true'
       AND COALESCE(result_payload->>'timeout','false') <> 'true'`
  )
  const last20 = await query<{
    asin: string
    completed_at: Date
    public_status: string | null
    page_ready: string | null
    offer_page_healthy: string | null
    displayed_price: string | null
    is_prime: string | null
    is_fba: string | null
    stock_status: string | null
    captcha: string | null
    redirected: string | null
    timeout: string | null
    page_url: string | null
    payload: Record<string, unknown>
  }>(
    `SELECT asin,
            completed_at,
            result_payload AS payload,
            result_payload->'metadata'->>'publicStatus' AS public_status,
            COALESCE(result_payload->'metadata'->>'pageReady', result_payload->>'pageReady') AS page_ready,
            COALESCE(result_payload->>'offerPageHealthy', result_payload->'metadata'->>'offerPageHealthy') AS offer_page_healthy,
            COALESCE(result_payload->>'displayedPrice', result_payload->'metadata'->>'displayedPrice') AS displayed_price,
            COALESCE(result_payload->>'isPrime', result_payload->'metadata'->>'isPrime') AS is_prime,
            COALESCE(result_payload->>'isFba', result_payload->'metadata'->>'isFba') AS is_fba,
            COALESCE(result_payload->>'stockStatus', result_payload->'metadata'->>'stockStatus') AS stock_status,
            COALESCE(result_payload->>'captcha', result_payload->'metadata'->>'captcha') AS captcha,
            COALESCE(result_payload->>'redirected', result_payload->'metadata'->>'redirected') AS redirected,
            COALESCE(result_payload->>'timeout', result_payload->'metadata'->>'timeout') AS timeout,
            COALESCE(result_payload->>'pageUrl', result_payload->>'finalUrl', result_payload->'metadata'->>'pageUrl') AS page_url
     FROM amazon_scan_jobs
     WHERE kind = 'KEEPA_VERIFY_PRIMARY'
       AND status = 'COMPLETED'
       AND COALESCE(result_payload->'metadata'->>'publicStatus','') = 'AMAZON_INCOMPLETE'
     ORDER BY completed_at DESC
     LIMIT 20`
  )
  const orphans = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM keepa_verify_candidates c
     WHERE c.status IN ('PENDING','RETRYABLE')
       AND NOT EXISTS (
         SELECT 1 FROM amazon_scan_jobs j
         WHERE j.keepa_candidate_id = c.id
           AND j.kind = 'KEEPA_VERIFY_PRIMARY'
           AND j.status IN ('PENDING','CLAIMED','RUNNING','WAITING_FOR_WORKER','RETRYABLE','COMPLETED')
           AND j.status NOT IN ('FAILED','CANCELLED')
       )`
  )
  const orphansNoActive = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM keepa_verify_candidates c
     WHERE c.status IN ('PENDING','RETRYABLE')
       AND NOT EXISTS (
         SELECT 1 FROM amazon_scan_jobs j
         WHERE j.keepa_candidate_id = c.id
           AND j.kind = 'KEEPA_VERIFY_PRIMARY'
           AND j.status IN ('PENDING','CLAIMED','RUNNING','WAITING_FOR_WORKER','RETRYABLE')
       )`
  )
  const activePrimary = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM amazon_scan_jobs
     WHERE kind = 'KEEPA_VERIFY_PRIMARY'
       AND status IN ('PENDING','CLAIMED','RUNNING','WAITING_FOR_WORKER','RETRYABLE')`
  )
  console.log(JSON.stringify({
    rates: rates.rows,
    validIncomplete: validIncomplete.rows,
    laterNonIncomplete: laterValid.rows[0]?.c,
    orphanPendingNoTerminalPrimary: orphans.rows[0]?.c,
    orphanNoActivePrimary: orphansNoActive.rows[0]?.c,
    activePrimary: activePrimary.rows[0]?.c,
    last20: last20.rows.map(r => {
      const payload = r.payload ?? {}
      const meta =
        payload.metadata && typeof payload.metadata === "object"
          ? (payload.metadata as Record<string, unknown>)
          : {}
      const url = String(r.page_url ?? pick(meta, payload, "pageUrl") ?? pick(meta, payload, "finalUrl") ?? "")
      const maskedUrl = url.replace(/\/dp\/[A-Z0-9]{10}/gi, "/dp/ASIN******").replace(/[A-Z0-9]{10}/g, "ASIN******")
      return {
        asin: maskAsin(r.asin),
        completedAt: r.completed_at,
        finalUrl: maskedUrl.slice(0, 180),
        publicStatus: r.public_status,
        pageReady: r.page_ready,
        offerPageHealthy: r.offer_page_healthy,
        displayedPrice: r.displayed_price,
        isPrime: r.is_prime,
        isFba: r.is_fba,
        stockStatus: r.stock_status,
        captcha: r.captcha,
        redirected: r.redirected,
        timeout: r.timeout,
        interstitial:
          String(meta.interstitial ?? payload.interstitial ?? meta.pageKind ?? meta.publicPageKind ?? ""),
        htmlSnippetHint: String(meta.pageTitle ?? meta.errorClass ?? meta.reason ?? "").slice(0, 80),
      }
    }),
  }, null, 2))

  const interstitialish = last20.rows.filter(r => {
    const payload = r.payload ?? {}
    const meta =
      payload.metadata && typeof payload.metadata === "object"
        ? (payload.metadata as Record<string, unknown>)
        : {}
    const title = String(meta.pageTitle ?? meta.reason ?? "").toLowerCase()
    const status = String(r.public_status ?? "")
    return status === "AMAZON_INCOMPLETE" && (title.includes("continue shopping") || title.includes("interstitial") || String(meta.interstitial) === "true")
  })
  mkdirSync("/home/listjetgo/app/backend/var/reports", { recursive: true })
  const sample = last20.rows.slice(0, 5).map(r => maskAsin(r.asin)).join("\n")
  writeFileSync(
    "/home/listjetgo/app/backend/var/reports/keepa-incomplete-masked-asins.txt",
    `generated=${new Date().toISOString()}\ncount=${last20.rows.length}\nmasked:\n${sample}\n`,
    "utf8"
  )
  void interstitialish
}

main().then(() => process.exit(0)).catch(e => {
  console.error(e)
  process.exit(1)
})
