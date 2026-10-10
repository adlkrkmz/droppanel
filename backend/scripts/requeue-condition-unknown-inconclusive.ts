import "dotenv/config"
import { createHash } from "node:crypto"
import { closeDbPool, query } from "../db/client"
import { decideOxylabsSingleQuery } from "../modules/oxylabsVerify/oxylabsProductDecision"
import { normalizeOxylabsAmazonProduct } from "../modules/oxylabsVerify/oxylabsProductNormalize"
import { enqueueOxylabsProductPrimaryForCandidate } from "../modules/oxylabsVerify/oxylabsVerifyChain"

type CandidateRow = {
  id: string
  asin: string
  fingerprint: string
  snapshot: Record<string, unknown>
  result_payload: Record<string, unknown> | null
}

type Counts = {
  reviewed: number
  eligible: number
  hardRejected: number
  created: number
  skipped: number
  enqueueFailed: number
  b0: { eligible: boolean; candidateId: string | null; jobId: number | null; status: string }
}

const REPROCESS_VERSION = "condition-unknown-v1"

function reprocessFingerprint(row: CandidateRow): string {
  return createHash("sha256")
    .update(`${REPROCESS_VERSION}|${row.id}|${row.fingerprint}`)
    .digest("hex")
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute")
  const rows = await query<CandidateRow>(
    `SELECT c.id::text, c.asin, c.fingerprint, c.snapshot, j.result_payload
     FROM keepa_verify_candidates c
     JOIN LATERAL (
       SELECT result_payload
       FROM amazon_scan_jobs
       WHERE keepa_candidate_id = c.id
         AND kind = 'OXYLABS_PRODUCT_PRIMARY'
         AND status = 'COMPLETED'
         AND result_payload IS NOT NULL
       ORDER BY completed_at DESC NULLS LAST, id DESC
       LIMIT 1
     ) j ON TRUE
     WHERE c.status = 'INCONCLUSIVE'
       AND c.snapshot->>'evaluationCode' = 'CONFIRMED_PRICE_MISMATCH'
     ORDER BY c.id ASC`
  )
  const counts: Counts = {
    reviewed: 0,
    eligible: 0,
    hardRejected: 0,
    created: 0,
    skipped: 0,
    enqueueFailed: 0,
    b0: { eligible: false, candidateId: null, jobId: null, status: "NOT_REVIEWED" },
  }

  for (const row of rows.rows) {
    counts.reviewed++
    if (!row.result_payload) {
      counts.hardRejected++
      continue
    }
    const n = normalizeOxylabsAmazonProduct({ requestedAsin: row.asin, payload: row.result_payload })
    const decision = decideOxylabsSingleQuery({
      n,
      panel: { sourceAsin: row.asin, sourcePrice: null, listingLive: true, qty: 1 },
      mutationsEnabled: true,
    })
    const eligible = decision.productClass === "VALID_SOURCE"
    if (!eligible) {
      counts.hardRejected++
      if (row.asin === "B0F5PSJSTT") counts.b0.status = `HARD_REJECTED:${decision.evidenceCode}`
      continue
    }
    counts.eligible++
    if (row.asin === "B0F5PSJSTT") counts.b0.eligible = true
    if (!execute) continue

    const fingerprint = reprocessFingerprint(row)
    const inserted = await query<{ id: string }>(
      `INSERT INTO keepa_verify_candidates (asin, fingerprint, snapshot, status, previous_fingerprint)
       VALUES ($1, $2, $3::jsonb, 'PENDING', $4)
       ON CONFLICT (asin, fingerprint) DO NOTHING
       RETURNING id::text`,
      [
        row.asin,
        fingerprint,
        JSON.stringify({ ...row.snapshot, reprocessOfCandidateId: row.id, reprocessReason: "CONDITION_UNKNOWN_POLICY_FIX" }),
        row.fingerprint,
      ]
    )
    const newCandidateId = inserted.rows[0]?.id ?? null
    if (!newCandidateId) {
      counts.skipped++
      if (row.asin === "B0F5PSJSTT") counts.b0.status = "SKIPPED_BY_DEDUPE"
      continue
    }
    counts.created++
    const enqueued = await enqueueOxylabsProductPrimaryForCandidate({
      asin: row.asin,
      candidateId: newCandidateId,
      evaluationCode: "CONFIRMED_PRICE_MISMATCH",
    })
    if (!enqueued.created) {
      counts.enqueueFailed++
      if (row.asin === "B0F5PSJSTT") {
        counts.b0 = { eligible: true, candidateId: newCandidateId, jobId: enqueued.jobId || null, status: `ENQUEUE_FAILED:${enqueued.skipped ?? "UNKNOWN"}` }
      }
      continue
    }
    if (row.asin === "B0F5PSJSTT") {
      counts.b0 = { eligible: true, candidateId: newCandidateId, jobId: enqueued.jobId, status: "ENQUEUED" }
    }
  }
  console.log(JSON.stringify({ execute, ...counts }, null, 2))
}

void main()
  .then(() => closeDbPool())
  .catch(async error => {
    console.error(error)
    await closeDbPool().catch(() => undefined)
    process.exitCode = 1
  })
