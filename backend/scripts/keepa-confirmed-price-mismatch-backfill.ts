/**
 * One-time submission of collector/confirmed-price gaps through the normal
 * Keepa observation persistence path.  It creates candidates (and lets the
 * configured application pipeline enqueue primary verification); it never
 * updates source prices, eBay, or verification outcomes.
 *
 * Run only with --execute. Without it, reports the eligible population.
 */
import "dotenv/config"
import { query, closeDbPool } from "../db/client"
import { persistKeepaCollectorObservation, type KeepaObservationPayload } from "../modules/keepaSensor/keepaObservationEvaluate"

type Row = {
  asin: string
  observed_at: string
  price_evidence: KeepaObservationPayload["priceEvidence"]
  availability: string
  prime_fba_evidence: Record<string, unknown>
  seller_counts: Record<string, unknown>
  observation_fingerprint: string
}

const STALE_GAP_SQL = `
  SELECT DISTINCT ON (o.asin)
         o.asin, o.observed_at::text, o.price_evidence, o.availability,
         o.prime_fba_evidence, o.seller_counts, o.observation_fingerprint
  FROM keepa_asin_last_observations o
  WHERE o.evaluation_code = 'PRICE_CONSISTENT'
    AND COALESCE((SELECT s.status FROM keepa_asin_sync_state s WHERE s.asin = o.asin), 'ACTIVE') NOT IN ('PAUSED_QTY_ZERO', 'REMOVED')
    AND EXISTS (
      SELECT 1
      FROM global_amazon_asins g
      JOIN global_asin_consumers c ON c.global_asin_id = g.id
      JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
      JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
      WHERE g.asin = o.asin
        AND (scs.current_status IS NULL OR scs.current_status = 'live')
        AND COALESCE(scs.ebay_quantity, 0) > 0
        AND scs.source_price IS NOT NULL AND scs.source_price > 0
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_each_text(o.price_evidence) p(key, value)
          WHERE p.key IN ('amazonCents', 'newCents', 'buyBoxCents', 'primeExclusiveCents')
            AND NULLIF(p.value, '')::numeric > 0
            AND abs(NULLIF(p.value, '')::numeric - round(scs.source_price * 100)) <= 1
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM keepa_verify_candidates k
      WHERE k.asin = o.asin
        AND k.snapshot->>'evaluationCode' = 'CONFIRMED_PRICE_MISMATCH'
        AND (k.status IN ('PENDING', 'RETRYABLE') OR k.created_at > NOW() - interval '7 days')
    )
  ORDER BY o.asin, o.observed_at DESC`

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null
}

function payloadFromRow(row: Row): KeepaObservationPayload {
  const prime = row.prime_fba_evidence ?? {}
  const counts = row.seller_counts ?? {}
  return {
    requestedAsin: row.asin,
    returnedAsin: typeof prime.returnedAsin === "string" ? prime.returnedAsin : null,
    observedAt: row.observed_at,
    observationFingerprint: row.observation_fingerprint,
    priceEvidence: row.price_evidence,
    availability: row.availability,
    buyBoxIsPrimeExclusive: asBool(prime.buyBoxIsPrimeExclusive),
    newFbaCount: typeof counts.newFbaCount === "number" ? counts.newFbaCount : null,
    newFbmCount: typeof counts.newFbmCount === "number" ? counts.newFbmCount : null,
    requestedAsinPresent: prime.requestedAsinPresent !== false,
    returnedAsinMismatch: prime.returnedAsinMismatch === true,
    parentAsin: typeof prime.parentAsin === "string" ? prime.parentAsin : null,
    variationAsinsFingerprint: typeof prime.variationAsinsFingerprint === "string" ? prime.variationAsinsFingerprint : null,
    productUnavailable: asBool(prime.productUnavailable),
  }
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute")
  const rows = await query<Row>(STALE_GAP_SQL)
  const listingCount = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM (${STALE_GAP_SQL}) gaps
     JOIN global_amazon_asins g ON g.asin = gaps.asin
     JOIN global_asin_consumers c ON c.global_asin_id = g.id
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     WHERE (scs.current_status IS NULL OR scs.current_status = 'live')
       AND COALESCE(scs.ebay_quantity, 0) > 0
       AND scs.source_price IS NOT NULL AND scs.source_price > 0
       AND NOT EXISTS (
         SELECT 1
         FROM jsonb_each_text(gaps.price_evidence) p(key, value)
         WHERE p.key IN ('amazonCents', 'newCents', 'buyBoxCents', 'primeExclusiveCents')
           AND NULLIF(p.value, '')::numeric > 0
           AND abs(NULLIF(p.value, '')::numeric - round(scs.source_price * 100)) <= 1
       )`
  )
  const result = {
    staleGapAsinsFound: rows.rowCount ?? 0,
    staleGapListingsFound: Number(listingCount.rows[0]?.count ?? 0),
    alreadyCoveredByExistingCandidate: 0,
    newCandidatesCreated: 0,
    skippedByDedupe: 0,
    enqueueFailed: 0,
    failureSamples: [] as string[],
    b0f5psjsttIncluded: false,
    b0f5psjsttCandidateId: null as string | null,
    b0f5psjsttEnqueueStatus: "NOT_IN_POPULATION",
    execute,
  }
  if (!execute) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const submit = async (row: Row): Promise<void> => {
    try {
      const submission = await persistKeepaCollectorObservation(payloadFromRow(row))
      if (submission.created) result.newCandidatesCreated++
      else if (submission.candidateId) result.skippedByDedupe++
      else {
        result.enqueueFailed++
        if (result.failureSamples.length < 5) result.failureSamples.push(`${row.asin}: NO_CANDIDATE_CREATED`)
      }
      if (row.asin === "B0F5PSJSTT") {
        result.b0f5psjsttIncluded = true
        result.b0f5psjsttCandidateId = submission.candidateId
        result.b0f5psjsttEnqueueStatus = submission.created
          ? "CANDIDATE_CREATED"
          : submission.candidateId
            ? "DEDUPED_EXISTING_CANDIDATE"
            : "NO_CANDIDATE_CREATED"
      }
    } catch (error) {
      result.enqueueFailed++
      if (result.failureSamples.length < 5) result.failureSamples.push(`${row.asin}: ${error instanceof Error ? error.message : String(error)}`)
      if (row.asin === "B0F5PSJSTT") {
        result.b0f5psjsttIncluded = true
        result.b0f5psjsttEnqueueStatus = `SUBMISSION_FAILED: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  // Submission is deliberately bounded below the database-pool size.  This is
  // only parallel candidate submission; it does not poll or supervise jobs.
  const queue = [...rows.rows]
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    for (;;) {
      const row = queue.shift()
      if (!row) return
      await submit(row)
    }
  })
  await Promise.all(workers)
  console.log(JSON.stringify(result, null, 2))
}

void main()
  .then(() => closeDbPool())
  .catch(async error => {
    console.error(error)
    await closeDbPool().catch(() => undefined)
    process.exitCode = 1
  })
