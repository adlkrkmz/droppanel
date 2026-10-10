import { query } from "../../db/client"
import { observationPayloadHasForbiddenFields, type NormalizedKeepaEvidence } from "./keepaEvidencePolicy"
import { loadKeepaRegistryStatus } from "./keepaTrustedReference"
import { shouldEnqueueKeepaVerifyPrimary } from "./keepaVerifyChainPolicy"
import { loadAmazonScanConfig } from "../amazonScan/amazonScanConfig"
import { planKeepaCollectorObservation } from "./keepaBaselinePanelPrice"
import type { KeepaCommercialSnapshot } from "./keepaBaselinePanelPrice"
import { keepaCommercialFingerprint } from "./keepaSnapshotDiff"
import { createHash } from "crypto"

export { observationPayloadHasForbiddenFields }

function changedCommercialFields(prev: KeepaCommercialSnapshot | null, next: KeepaCommercialSnapshot): string[] {
  if (!prev) return []
  return Object.keys(next).filter(key => {
    const k = key as keyof KeepaCommercialSnapshot
    return (prev[k] ?? null) !== (next[k] ?? null)
  })
}

async function loadPanelAmazonSourcePrices(asin: string): Promise<string[]> {
  const key = asin.trim().toUpperCase()
  const res = await query<{ source_price: string | null }>(
    `SELECT scs.source_price::text
     FROM global_amazon_asins g
     JOIN global_asin_consumers c ON c.global_asin_id = g.id
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     WHERE g.asin = $1
       AND (scs.current_status IS NULL OR scs.current_status = 'live')
       AND COALESCE(scs.ebay_quantity, 0) > 0
       AND scs.source_price IS NOT NULL
       AND scs.source_price > 0
     ORDER BY scs.id ASC`,
    [key]
  )
  return res.rows.map(row => row.source_price).filter((price): price is string => price != null)
}

export type KeepaObservationPayload = {
  requestedAsin: string
  returnedAsin: string | null
  observedAt: string
  observationFingerprint: string
  priceEvidence: {
    amazonCents: number | null
    newCents: number | null
    buyBoxCents: number | null
    primeExclusiveCents: number | null
  }
  availability: string
  buyBoxIsPrimeExclusive: boolean | null
  newFbaCount: number | null
  newFbmCount: number | null
  requestedAsinPresent: boolean
  returnedAsinMismatch: boolean
  parentAsin: string | null
  variationAsinsFingerprint: string | null
  productUnavailable: boolean | null
}

function asCents(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n)
}

function asCount(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.trunc(n)
}

export function parseKeepaObservationPayload(body: Record<string, unknown>): KeepaObservationPayload | null {
  const requestedAsin = String(body.requestedAsin ?? "").trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(requestedAsin)) return null
  const returnedRaw = String(body.returnedAsin ?? "").trim().toUpperCase()
  const returnedAsin = /^[A-Z0-9]{10}$/.test(returnedRaw) ? returnedRaw : null
  const observedAt = String(body.observedAt ?? "").trim()
  if (!observedAt) return null
  const observationFingerprint = String(body.observationFingerprint ?? "").trim()
  if (observationFingerprint.length < 16) return null
  const prices = body.priceEvidence && typeof body.priceEvidence === "object" ? (body.priceEvidence as Record<string, unknown>) : {}
  const availabilityRaw = String(body.availability ?? "UNKNOWN").trim().toUpperCase()
  const availability =
    availabilityRaw === "IN_STOCK" || availabilityRaw === "NO_FBA" ? availabilityRaw : "UNKNOWN"
  const prime = body.buyBoxIsPrimeExclusive
  const parentRaw = String(body.parentAsin ?? "").trim().toUpperCase()
  const variationFp = String(body.variationAsinsFingerprint ?? "").trim()
  return {
    requestedAsin,
    returnedAsin,
    observedAt,
    observationFingerprint,
    priceEvidence: {
      amazonCents: asCents(prices.amazonCents),
      newCents: asCents(prices.newCents),
      buyBoxCents: asCents(prices.buyBoxCents),
      primeExclusiveCents: asCents(prices.primeExclusiveCents),
    },
    availability,
    buyBoxIsPrimeExclusive: typeof prime === "boolean" ? prime : null,
    newFbaCount: asCount(body.newFbaCount),
    newFbmCount: asCount(body.newFbmCount),
    requestedAsinPresent: body.requestedAsinPresent !== false,
    returnedAsinMismatch: body.returnedAsinMismatch === true,
    parentAsin: /^[A-Z0-9]{10}$/.test(parentRaw) ? parentRaw : null,
    variationAsinsFingerprint: variationFp.length >= 16 ? variationFp : null,
    productUnavailable: typeof body.productUnavailable === "boolean" ? body.productUnavailable : null,
  }
}

export async function persistKeepaCollectorObservation(payload: KeepaObservationPayload): Promise<{
  ok: true
  stored: true
  mutation: false
  enqueueEnabled: boolean
  evaluationCode: string
  candidateId: string | null
  created: boolean
  ebayMutationCalls: 0
}> {
  const evidence: NormalizedKeepaEvidence = {
    requestedAsin: payload.requestedAsin,
    returnedAsin: payload.returnedAsin,
    amazonCents: payload.priceEvidence.amazonCents,
    newCents: payload.priceEvidence.newCents,
    buyBoxCents: payload.priceEvidence.buyBoxCents,
    primeExclusiveCents: payload.priceEvidence.primeExclusiveCents,
    availability: payload.availability as NormalizedKeepaEvidence["availability"],
    buyBoxIsPrimeExclusive: payload.buyBoxIsPrimeExclusive,
    newFbaCount: payload.newFbaCount,
    newFbmCount: payload.newFbmCount,
    requestedAsinPresent: payload.requestedAsinPresent,
    returnedAsinMismatch: payload.returnedAsinMismatch,
    parentAsin: payload.parentAsin,
    variationAsinsFingerprint: payload.variationAsinsFingerprint,
    productUnavailable: payload.productUnavailable,
  }
  const commercial = {
    amazonCents: evidence.amazonCents,
    newCents: evidence.newCents,
    buyBoxCents: evidence.buyBoxCents,
    primeExclusiveCents: evidence.primeExclusiveCents,
    availability: evidence.availability,
    buyBoxIsPrimeExclusive: evidence.buyBoxIsPrimeExclusive,
    newFbaCount: evidence.newFbaCount,
    newFbmCount: evidence.newFbmCount,
    requestedAsin: evidence.requestedAsin,
    returnedAsin: evidence.returnedAsin,
    requestedAsinPresent: evidence.requestedAsinPresent,
    returnedAsinMismatch: evidence.returnedAsinMismatch,
    parentAsin: evidence.parentAsin,
    variationAsinsFingerprint: evidence.variationAsinsFingerprint,
    productUnavailable: evidence.productUnavailable,
  }
  const prevRow = await query<{
    observed_at: string
    price_evidence: Record<string, unknown>
    availability: string | null
    prime_fba_evidence: Record<string, unknown>
    seller_counts: Record<string, unknown>
  }>(`SELECT observed_at::text, price_evidence, availability, prime_fba_evidence, seller_counts FROM keepa_asin_last_observations WHERE asin = $1`, [
    payload.requestedAsin,
  ])
  const prev = prevRow.rows[0]
    ? {
        amazonCents: (prevRow.rows[0].price_evidence?.amazonCents as number | null) ?? null,
        newCents: (prevRow.rows[0].price_evidence?.newCents as number | null) ?? null,
        buyBoxCents: (prevRow.rows[0].price_evidence?.buyBoxCents as number | null) ?? null,
        primeExclusiveCents: (prevRow.rows[0].price_evidence?.primeExclusiveCents as number | null) ?? null,
        availability: prevRow.rows[0].availability,
        buyBoxIsPrimeExclusive:
          typeof prevRow.rows[0].prime_fba_evidence?.buyBoxIsPrimeExclusive === "boolean"
            ? (prevRow.rows[0].prime_fba_evidence.buyBoxIsPrimeExclusive as boolean)
            : null,
        newFbaCount: (prevRow.rows[0].seller_counts?.newFbaCount as number | null) ?? null,
        newFbmCount: (prevRow.rows[0].seller_counts?.newFbmCount as number | null) ?? null,
        requestedAsin: payload.requestedAsin,
        returnedAsin: (prevRow.rows[0].prime_fba_evidence?.returnedAsin as string | null) ?? null,
        requestedAsinPresent:
          typeof prevRow.rows[0].prime_fba_evidence?.requestedAsinPresent === "boolean"
            ? (prevRow.rows[0].prime_fba_evidence.requestedAsinPresent as boolean)
            : null,
        returnedAsinMismatch:
          typeof prevRow.rows[0].prime_fba_evidence?.returnedAsinMismatch === "boolean"
            ? (prevRow.rows[0].prime_fba_evidence.returnedAsinMismatch as boolean)
            : null,
        parentAsin: (prevRow.rows[0].prime_fba_evidence?.parentAsin as string | null) ?? null,
        variationAsinsFingerprint:
          (prevRow.rows[0].prime_fba_evidence?.variationAsinsFingerprint as string | null) ?? null,
        productUnavailable:
          typeof prevRow.rows[0].prime_fba_evidence?.productUnavailable === "boolean"
            ? (prevRow.rows[0].prime_fba_evidence.productUnavailable as boolean)
            : null,
      }
    : null
  // Existing rows predate identity fields. Seed those fields from this first upgraded
  // exact observation so rollout itself does not enqueue the entire catalog.
  if (prev && !Object.prototype.hasOwnProperty.call(prevRow.rows[0].prime_fba_evidence ?? {}, "requestedAsinPresent")) {
    prev.requestedAsin = payload.requestedAsin
    prev.returnedAsin = payload.requestedAsinPresent ? payload.returnedAsin : null
    prev.requestedAsinPresent = payload.requestedAsinPresent
    prev.returnedAsinMismatch = payload.returnedAsinMismatch
    prev.parentAsin = payload.parentAsin
    prev.variationAsinsFingerprint = payload.variationAsinsFingerprint
    prev.productUnavailable = payload.productUnavailable
  }
  const registryStatus = await loadKeepaRegistryStatus(payload.requestedAsin)
  let panelSourcePrices: string[] = []
  if (registryStatus !== "PAUSED_QTY_ZERO" && registryStatus !== "REMOVED") {
    try {
      panelSourcePrices = await loadPanelAmazonSourcePrices(payload.requestedAsin)
    } catch {
      panelSourcePrices = []
    }
  }
  const staleReplay = prevRow.rows[0]
    ? Date.parse(payload.observedAt) < Date.parse(prevRow.rows[0].observed_at)
    : false
  const plan = staleReplay
    ? {
        trigger: "unchanged" as const,
        evaluationCode: "STALE_OBSERVATION_IGNORED",
        createCandidate: false,
        enqueuePrimary: false,
        candidateFingerprint: null,
        panelCents: null,
      }
    : planKeepaCollectorObservation({
    prev,
    registryStatus,
    panelSourcePrice: panelSourcePrices[0] ?? null,
    panelSourcePrices,
    commercial,
  })
  const evaluationCode = plan.evaluationCode
  let candidateId: string | null = null
  let created = false
  await query(
    `INSERT INTO keepa_asin_last_observations (
       asin, observed_at, price_evidence, availability, prime_fba_evidence, seller_counts,
       trusted_reference_fingerprint, evaluation_code, candidate_id, observation_fingerprint,
       candidate_fingerprint, updated_at
     ) VALUES (
       $1, $2::timestamptz, $3::jsonb, $4, $5::jsonb, $6::jsonb,
       $7, $8, $9::bigint, $10, $11, NOW()
     )
     ON CONFLICT (asin) DO UPDATE SET
       observed_at = EXCLUDED.observed_at,
       price_evidence = EXCLUDED.price_evidence,
       availability = EXCLUDED.availability,
       prime_fba_evidence = EXCLUDED.prime_fba_evidence,
       seller_counts = EXCLUDED.seller_counts,
       trusted_reference_fingerprint = EXCLUDED.trusted_reference_fingerprint,
       evaluation_code = EXCLUDED.evaluation_code,
       candidate_id = EXCLUDED.candidate_id,
       observation_fingerprint = EXCLUDED.observation_fingerprint,
       candidate_fingerprint = EXCLUDED.candidate_fingerprint,
       updated_at = NOW()
     WHERE keepa_asin_last_observations.observed_at <= EXCLUDED.observed_at`,
    [
      payload.requestedAsin,
      payload.observedAt,
      JSON.stringify(payload.priceEvidence),
      payload.availability,
      JSON.stringify({
        buyBoxIsPrimeExclusive: payload.buyBoxIsPrimeExclusive,
        newFbaCount: payload.newFbaCount,
        returnedAsin: payload.returnedAsin,
        requestedAsinPresent: payload.requestedAsinPresent,
        returnedAsinMismatch: payload.returnedAsinMismatch,
        parentAsin: payload.parentAsin,
        variationAsinsFingerprint: payload.variationAsinsFingerprint,
        productUnavailable: payload.productUnavailable,
      }),
      JSON.stringify({ newFbaCount: payload.newFbaCount, newFbmCount: payload.newFbmCount }),
      null,
      evaluationCode,
      null,
      payload.observationFingerprint,
      plan.candidateFingerprint,
    ]
  )
  if (plan.createCandidate && plan.candidateFingerprint) {
    try {
      const ins = await query<{ id: string }>(
        `INSERT INTO keepa_verify_candidates (asin, fingerprint, snapshot, status)
         VALUES ($1, $2, $3::jsonb, 'PENDING')
         ON CONFLICT (asin, fingerprint) DO NOTHING
         RETURNING id::text`,
        [
          payload.requestedAsin,
          plan.candidateFingerprint,
          JSON.stringify({
            evaluationCode,
            commercial,
            panelCents: plan.panelCents,
            confirmedPanelCents: panelSourcePrices,
            previousFingerprint: prev ? createHash("sha256").update(keepaCommercialFingerprint(prev)).digest("hex") : null,
            currentFingerprint: createHash("sha256").update(keepaCommercialFingerprint(commercial)).digest("hex"),
            changedFields: changedCommercialFields(prev, commercial),
            requestedAsin: payload.requestedAsin,
            returnedAsin: payload.returnedAsin,
            observedAt: payload.observedAt,
          }),
        ]
      )
      created = (ins.rowCount ?? 0) > 0
      const found = await query<{ id: string }>(
        `SELECT id::text FROM keepa_verify_candidates WHERE asin = $1 AND fingerprint = $2`,
        [payload.requestedAsin, plan.candidateFingerprint]
      )
      candidateId = found.rows[0]?.id ?? ins.rows[0]?.id ?? null
      if (candidateId) {
        await query(`UPDATE keepa_asin_last_observations SET candidate_id = $2::bigint WHERE asin = $1`, [
          payload.requestedAsin,
          candidateId,
        ])
      }
    } catch (e) {
      console.warn(
        "[KeepaObservation] candidate insert failed after snapshot",
        e instanceof Error ? e.message : String(e)
      )
    }
  }
  const oxyCfg = (await import("../oxylabsVerify/oxylabsVerifyConfig")).loadOxylabsVerifyConfig()
  const enqueueEnabled = oxyCfg.enqueueEnabled || loadAmazonScanConfig().keepaVerifyEnqueueEnabled
  if (candidateId && plan.enqueuePrimary && shouldEnqueueKeepaVerifyPrimary(evaluationCode) && oxyCfg.enqueueEnabled) {
    try {
      const { enqueueOxylabsProductPrimaryForCandidate } = await import("../oxylabsVerify/oxylabsVerifyChain")
      await enqueueOxylabsProductPrimaryForCandidate({
        asin: payload.requestedAsin,
        candidateId,
        evaluationCode,
      })
    } catch (e) {
      console.warn(
        "[KeepaObservation] oxylabs enqueue failed after snapshot",
        e instanceof Error ? e.message : String(e)
      )
    }
  }
  return {
    ok: true,
    stored: true,
    mutation: false,
    enqueueEnabled,
    evaluationCode,
    candidateId,
    created,
    ebayMutationCalls: 0,
  }
}
