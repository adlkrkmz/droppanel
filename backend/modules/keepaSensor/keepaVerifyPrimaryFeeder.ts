import { query } from "../../db/client"
import { countActiveScanJobs } from "../amazonScan/amazonScanJobQueue"
import { loadAmazonScanConfig } from "../amazonScan/amazonScanConfig"
import { enqueueKeepaVerifyPrimaryForCandidate } from "./keepaVerifyChain"
import {
  KEEPA_VERIFY_PRIMARY_ACTIVE_CAP,
  keepaVerifyPrimaryEnqueueSlots,
  shouldEnqueueKeepaVerifyPrimary,
} from "./keepaVerifyChainPolicy"

const ACTIVE_JOB = ["PENDING", "CLAIMED", "RUNNING", "WAITING_FOR_WORKER", "RETRYABLE"]
const FEED_INTERVAL_MS = 2000

let timer: NodeJS.Timeout | null = null
let running = false

export async function feedKeepaVerifyPrimaryOrphans(): Promise<{
  slots: number
  enqueued: number
  skipped: number
}> {
  const cfg = loadAmazonScanConfig()
  if (!cfg.keepaVerifyEnqueueEnabled) {
    return { slots: 0, enqueued: 0, skipped: 0 }
  }
  const cap = cfg.keepaVerifyPrimaryMaxActive || KEEPA_VERIFY_PRIMARY_ACTIVE_CAP
  const active = await countActiveScanJobs("KEEPA_VERIFY_PRIMARY")
  const slots = keepaVerifyPrimaryEnqueueSlots(active, cap)
  if (slots <= 0) return { slots: 0, enqueued: 0, skipped: 0 }

  const orphans = await query<{ id: string; asin: string; evaluation_code: string | null }>(
    `SELECT c.id::text, c.asin, c.snapshot->>'evaluationCode' AS evaluation_code
     FROM keepa_verify_candidates c
     WHERE c.status IN ('PENDING', 'RETRYABLE')
       AND COALESCE(c.snapshot->>'evaluationCode','') NOT LIKE 'BASELINE_%'
       AND NOT EXISTS (
         SELECT 1 FROM amazon_scan_jobs j
         WHERE j.keepa_candidate_id = c.id
           AND j.kind IN ('KEEPA_VERIFY_PRIMARY', 'KEEPA_VERIFY_CONFIRM')
           AND j.status = ANY($2::text[])
       )
       AND NOT EXISTS (
         SELECT 1 FROM amazon_scan_jobs j
         WHERE j.asin = c.asin
           AND j.kind = 'KEEPA_VERIFY_PRIMARY'
           AND j.status = ANY($2::text[])
       )
     ORDER BY
       CASE
         WHEN UPPER(COALESCE(c.snapshot->>'evaluationCode', '')) IN
           ('PRICE_EVIDENCE_MISMATCH','STOCK_RISK','PRIME_RISK','ASIN_IDENTITY_MISMATCH')
         THEN 0 ELSE 1
       END,
       c.created_at ASC
     LIMIT $1`,
    [slots, ACTIVE_JOB]
  )

  let enqueued = 0
  let skipped = 0
  for (const row of orphans.rows) {
    const code = String(row.evaluation_code ?? "").trim().toUpperCase()
    if (!shouldEnqueueKeepaVerifyPrimary(code)) {
      skipped++
      continue
    }
    const result = await enqueueKeepaVerifyPrimaryForCandidate({
      asin: row.asin,
      candidateId: row.id,
      evaluationCode: code,
    })
    if (result.created) enqueued++
    else skipped++
  }
  return { slots, enqueued, skipped }
}

export function startKeepaVerifyPrimaryFeeder(): void {
  const cfg = loadAmazonScanConfig()
  if (!cfg.keepaVerifyEnqueueEnabled) {
    console.log("[KeepaVerifyPrimaryFeeder] disabled")
    return
  }
  if (timer) return
  timer = setInterval(() => {
    if (running) return
    running = true
    void feedKeepaVerifyPrimaryOrphans()
      .catch(e => {
        console.warn(
          "[KeepaVerifyPrimaryFeeder] tick failed:",
          e instanceof Error ? e.message : String(e)
        )
      })
      .finally(() => {
        running = false
      })
  }, FEED_INTERVAL_MS)
  console.log(
    `[KeepaVerifyPrimaryFeeder] started cap=${cfg.keepaVerifyPrimaryMaxActive || KEEPA_VERIFY_PRIMARY_ACTIVE_CAP}`
  )
}
