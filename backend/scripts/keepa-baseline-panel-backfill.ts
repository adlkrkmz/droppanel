import "dotenv/config"
import { query } from "../db/client"
import {
  BASELINE_PRICE_MISMATCH,
  evaluateKeepaBaselinePanelPrice,
  keepaBaselineMismatchFingerprint,
} from "../modules/keepaSensor/keepaBaselinePanelPrice"
import { enqueueOxylabsProductPrimaryForCandidate, oxylabsPrimaryEnqueueSlots } from "../modules/oxylabsVerify/oxylabsVerifyChain"

type Row = {
  asin: string
  price_evidence: Record<string, unknown> | null
  source_price: string | null
}

async function main(): Promise<void> {
  const start = await query(
    `SELECT COUNT(*)::int AS c FROM keepa_asin_last_observations WHERE evaluation_code = 'SNAPSHOT_RECORDED'`
  )
  const examined = start.rows[0]?.c ?? 0
  const rows = await query<Row>(
    `SELECT o.asin,
            o.price_evidence,
            p.source_price
     FROM keepa_asin_last_observations o
     LEFT JOIN LATERAL (
       SELECT scs.source_price::text AS source_price
       FROM global_amazon_asins g
       JOIN global_asin_consumers c ON c.global_asin_id = g.id
       JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
       JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
       WHERE g.asin = o.asin
       ORDER BY
         CASE
           WHEN (scs.current_status IS NULL OR scs.current_status = 'live')
                AND COALESCE(scs.ebay_quantity, 0) > 0
           THEN 0 ELSE 1
         END,
         scs.id DESC
       LIMIT 1
     ) p ON true
     WHERE o.evaluation_code = 'SNAPSHOT_RECORDED'
     ORDER BY o.updated_at ASC`
  )

  let consistent = 0
  let mismatch = 0
  let missing = 0
  let skippedNoEvidence = 0
  let candidatesCreated = 0
  let primaryCreated = 0
  let primarySkippedCap = 0
  let replayDedup = 0

  for (const row of rows.rows) {
    if (!row.price_evidence || typeof row.price_evidence !== "object") {
      skippedNoEvidence++
      continue
    }
    const keepaPrices = {
      amazonCents: row.price_evidence.amazonCents,
      newCents: row.price_evidence.newCents,
      buyBoxCents: row.price_evidence.buyBoxCents,
      primeExclusiveCents: row.price_evidence.primeExclusiveCents,
    }
    const d = evaluateKeepaBaselinePanelPrice({
      panelSourcePrice: row.source_price,
      keepaPrices,
    })
    if (d.code === "BASELINE_PRICE_CONSISTENT") consistent++
    else if (d.code === "BASELINE_PRICE_MISMATCH") mismatch++
    else missing++

    let candidateId: string | null = null
    let candidateFp: string | null = null
    if (d.code === BASELINE_PRICE_MISMATCH && d.panelCents != null) {
      candidateFp = keepaBaselineMismatchFingerprint({ panelCents: d.panelCents, keepaPrices })
      const ins = await query<{ id: string }>(
        `INSERT INTO keepa_verify_candidates (asin, fingerprint, snapshot, status)
         VALUES ($1, $2, $3::jsonb, 'PENDING')
         ON CONFLICT (asin, fingerprint) DO NOTHING
         RETURNING id::text`,
        [
          row.asin,
          candidateFp,
          JSON.stringify({
            evaluationCode: d.code,
            commercial: keepaPrices,
            panelCents: d.panelCents,
            backfill: true,
          }),
        ]
      )
      if ((ins.rowCount ?? 0) > 0) candidatesCreated++
      else replayDedup++
      const found = await query<{ id: string }>(
        `SELECT id::text FROM keepa_verify_candidates WHERE asin = $1 AND fingerprint = $2`,
        [row.asin, candidateFp]
      )
      candidateId = found.rows[0]?.id ?? ins.rows[0]?.id ?? null
    }

    await query(
      `UPDATE keepa_asin_last_observations
       SET evaluation_code = $2,
           candidate_id = COALESCE($3::bigint, candidate_id),
           candidate_fingerprint = COALESCE($4, candidate_fingerprint)
       WHERE asin = $1 AND evaluation_code = 'SNAPSHOT_RECORDED'`,
      [row.asin, d.code, candidateId, candidateFp]
    )

    if (candidateId && d.code === BASELINE_PRICE_MISMATCH) {
      const slots = await oxylabsPrimaryEnqueueSlots()
      if (slots <= 0) {
        primarySkippedCap++
        continue
      }
      const enq = await enqueueOxylabsProductPrimaryForCandidate({
        asin: row.asin,
        candidateId,
        evaluationCode: BASELINE_PRICE_MISMATCH,
      })
      if (enq.created) primaryCreated++
      else if (enq.skipped === "PRIMARY_NOT_CREATED") primarySkippedCap++
    }
  }

  console.log(
    JSON.stringify(
      {
        examinedSnapshotRecorded: examined,
        processed: rows.rows.length,
        consistent,
        mismatch,
        panelMissing: missing,
        skippedNoEvidence,
        candidatesCreated,
        replayDedup,
        primaryCreated,
        primarySkippedCap,
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
