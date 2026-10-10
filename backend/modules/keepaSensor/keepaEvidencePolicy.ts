import { createHash } from "crypto"
import type { KeepaMonitoredSnapshot } from "./keepaMonitoredSnapshot"

const FORBIDDEN_PAYLOAD_KEY =
  /^(api[_-]?key|keepa[_-]?api[_-]?key|authorization|bearer|password|secret|token|refresh|database_url|ebay|credential|cookie|listing|item[_-]?id|store_id|user_id|workspace)$/i

export function observationPayloadHasForbiddenFields(body: Record<string, unknown>): boolean {
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_PAYLOAD_KEY.test(key) || key.toLowerCase() === "asin") return true
  }
  const json = JSON.stringify(body).toLowerCase()
  if (json.includes("keepa_api_key") || json.includes("authorization") || json.includes("ebay_refresh")) return true
  if (json.includes("database_url")) return true
  return false
}

export type KeepaEvidenceEvaluationCode =
  | "PRICE_CONSISTENT"
  | "PRICE_EVIDENCE_MISMATCH"
  | "STOCK_RISK"
  | "PRIME_RISK"
  | "ASIN_IDENTITY_MISMATCH"
  | "NO_TRUSTED_REFERENCE"
  | "SKIP_DETACHED_OR_QTY_ZERO"
  | "SNAPSHOT_RECORDED"

export type TrustedAmazonReference = {
  asin: string
  priceCents: number | null
  inStock: boolean | null
  primeOrFba: boolean | null
  verifiedAt: string
  fingerprint: string
}

export type NormalizedKeepaEvidence = {
  requestedAsin: string
  returnedAsin: string | null
  amazonCents: number | null
  newCents: number | null
  buyBoxCents: number | null
  primeExclusiveCents: number | null
  availability: KeepaMonitoredSnapshot["availability"] | "UNKNOWN"
  buyBoxIsPrimeExclusive: boolean | null
  newFbaCount: number | null
  newFbmCount: number | null
  requestedAsinPresent?: boolean
  returnedAsinMismatch?: boolean
  parentAsin?: string | null
  variationAsinsFingerprint?: string | null
  productUnavailable?: boolean | null
}

export type KeepaEvidenceDecision = {
  code: KeepaEvidenceEvaluationCode
  createCandidate: boolean
  candidateFingerprint: string | null
  evidenceFingerprint: string
  trustedFingerprint: string | null
  mutation: false
  ebayMutationCalls: 0
}

const PRICE_TOLERANCE_CENTS = 1

/** Keepa sentinels (-1/-2), missing, and non-finite are not prices. Real 0 is not a positive offer. */
export function usdToPositiveCents(usd: number | null | undefined): number | null {
  if (usd == null || !Number.isFinite(usd)) return null
  if (usd <= 0) return null
  return Math.round(usd * 100)
}

export function dollarsFieldToPositiveCents(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === "") return null
  const n = typeof raw === "number" ? raw : Number(raw)
  return usdToPositiveCents(n)
}

export function keepaPositivePriceCents(evidence: NormalizedKeepaEvidence): number[] {
  const out: number[] = []
  for (const n of [evidence.amazonCents, evidence.newCents, evidence.buyBoxCents, evidence.primeExclusiveCents]) {
    if (n != null && n > 0) out.push(n)
  }
  return out
}

export function priceFoundInKeepaEvidence(trustedCents: number, evidence: NormalizedKeepaEvidence): boolean {
  return keepaPositivePriceCents(evidence).some(c => Math.abs(c - trustedCents) <= PRICE_TOLERANCE_CENTS)
}

export function keepaDefiniteStockLoss(evidence: NormalizedKeepaEvidence): boolean {
  if (keepaPositivePriceCents(evidence).length > 0) return false
  if (evidence.availability === "UNKNOWN") return false
  if (evidence.newFbaCount == null && evidence.availability !== "NO_FBA") return false
  return evidence.availability === "NO_FBA" || evidence.newFbaCount === 0
}

export function keepaDefinitePrimeFbaLoss(evidence: NormalizedKeepaEvidence): boolean {
  if (evidence.newFbaCount == null) return false
  if (evidence.buyBoxIsPrimeExclusive == null) return false
  if (evidence.newFbaCount !== 0) return false
  if (evidence.amazonCents != null && evidence.amazonCents > 0) return false
  if (evidence.primeExclusiveCents != null && evidence.primeExclusiveCents > 0) return false
  return evidence.buyBoxIsPrimeExclusive === false
}

export function evidenceFingerprint(evidence: NormalizedKeepaEvidence): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        requestedAsin: evidence.requestedAsin,
        returnedAsin: evidence.returnedAsin,
        amazonCents: evidence.amazonCents,
        newCents: evidence.newCents,
        buyBoxCents: evidence.buyBoxCents,
        primeExclusiveCents: evidence.primeExclusiveCents,
        availability: evidence.availability,
        buyBoxIsPrimeExclusive: evidence.buyBoxIsPrimeExclusive,
        newFbaCount: evidence.newFbaCount,
        newFbmCount: evidence.newFbmCount,
        requestedAsinPresent: evidence.requestedAsinPresent ?? true,
        returnedAsinMismatch: evidence.returnedAsinMismatch ?? false,
        parentAsin: evidence.parentAsin ?? null,
        variationAsinsFingerprint: evidence.variationAsinsFingerprint ?? null,
        productUnavailable: evidence.productUnavailable ?? null,
      })
    )
    .digest("hex")
}

export function trustedReferenceFingerprint(input: {
  asin: string
  priceCents: number | null
  inStock: boolean | null
  primeOrFba: boolean | null
  verifiedAt: string
  sourceId: string
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        asin: input.asin,
        priceCents: input.priceCents,
        inStock: input.inStock,
        primeOrFba: input.primeOrFba,
        verifiedAt: input.verifiedAt,
        sourceId: input.sourceId,
      })
    )
    .digest("hex")
}

export function candidateFingerprint(input: {
  asin: string
  code: KeepaEvidenceEvaluationCode
  evidence: NormalizedKeepaEvidence
  trustedFingerprint: string | null
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        asin: input.asin,
        code: input.code,
        evidence: {
          amazonCents: input.evidence.amazonCents,
          newCents: input.evidence.newCents,
          buyBoxCents: input.evidence.buyBoxCents,
          primeExclusiveCents: input.evidence.primeExclusiveCents,
          availability: input.evidence.availability,
          buyBoxIsPrimeExclusive: input.evidence.buyBoxIsPrimeExclusive,
          newFbaCount: input.evidence.newFbaCount,
          newFbmCount: input.evidence.newFbmCount,
        },
        trustedFingerprint: input.trustedFingerprint,
      })
    )
    .digest("hex")
}

export function triPrimeOrFba(
  isPrime: boolean | null,
  isFba: boolean | null,
  shipsFromAmazon: boolean | null
): boolean | null {
  if (isPrime == null && isFba == null && shipsFromAmazon == null) return null
  return isPrime === true || isFba === true || shipsFromAmazon === true
}

export function trustedFromBrowserVerificationRow(row: {
  id: string
  asin: string
  resultPrice: string | number | null
  resultIsPrime: boolean | null
  resultIsFba: boolean | null
  resultShipsFromAmazon: boolean | null
  resultPurchasable: string | null
  completedAt: string
  lastVerifiedAsin: string | null
  lastVerifiedDecision: string | null
}): TrustedAmazonReference | null {
  const asin = String(row.asin ?? "").trim().toUpperCase()
  const verifiedAsin = String(row.lastVerifiedAsin ?? "").trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) return null
  if (verifiedAsin && verifiedAsin !== asin) return null
  if (row.lastVerifiedDecision !== "VALID_SOURCE") return null
  const purchasable = String(row.resultPurchasable ?? "").trim().toUpperCase()
  if (purchasable === "UNKNOWN" || purchasable === "INCOMPLETE") return null
  const priceCents = dollarsFieldToPositiveCents(row.resultPrice)
  if (priceCents == null) return null
  const inStock = purchasable === "FALSE" ? false : purchasable === "TRUE" || priceCents > 0
  const primeOrFba = triPrimeOrFba(row.resultIsPrime, row.resultIsFba, row.resultShipsFromAmazon)
  const verifiedAt = row.completedAt
  return {
    asin,
    priceCents,
    inStock,
    primeOrFba,
    verifiedAt,
    fingerprint: trustedReferenceFingerprint({
      asin,
      priceCents,
      inStock,
      primeOrFba,
      verifiedAt,
      sourceId: String(row.id),
    }),
  }
}

export function snapshotToKeepaEvidence(
  requestedAsin: string,
  snapshot: KeepaMonitoredSnapshot | null
): NormalizedKeepaEvidence {
  const requested = requestedAsin.trim().toUpperCase()
  return {
    requestedAsin: requested,
    returnedAsin: snapshot?.asin ? snapshot.asin.trim().toUpperCase() : null,
    amazonCents: usdToPositiveCents(snapshot?.amazonPriceUsd ?? null),
    newCents: usdToPositiveCents(snapshot?.newPriceUsd ?? null),
    buyBoxCents: usdToPositiveCents(snapshot?.buyBoxPriceUsd ?? null),
    primeExclusiveCents: usdToPositiveCents(snapshot?.primeExclusivePriceUsd ?? null),
    availability: snapshot?.availability ?? "UNKNOWN",
    buyBoxIsPrimeExclusive: snapshot?.buyBoxIsPrimeExclusive ?? null,
    newFbaCount: snapshot?.newFbaCount ?? null,
    newFbmCount: snapshot?.newFbmCount ?? null,
    requestedAsinPresent: snapshot?.requestedAsinPresent ?? false,
    returnedAsinMismatch: snapshot?.returnedAsinMismatch ?? false,
    parentAsin: snapshot?.parentAsin ?? null,
    variationAsinsFingerprint: snapshot?.variationAsinsFingerprint ?? null,
    productUnavailable: snapshot?.productUnavailable ?? null,
  }
}

export function evaluateKeepaTrustedEvidence(input: {
  evidence: NormalizedKeepaEvidence
  trusted: TrustedAmazonReference | null
  registryStatus: "ACTIVE" | "PAUSED_QTY_ZERO" | "REMOVED" | null
}): KeepaEvidenceDecision {
  const evidenceFp = evidenceFingerprint(input.evidence)
  const base = {
    evidenceFingerprint: evidenceFp,
    trustedFingerprint: input.trusted?.fingerprint ?? null,
    mutation: false as const,
    ebayMutationCalls: 0 as const,
  }
  const finish = (code: KeepaEvidenceEvaluationCode, createCandidate: boolean): KeepaEvidenceDecision => ({
    ...base,
    code,
    createCandidate,
    candidateFingerprint: createCandidate
      ? candidateFingerprint({
          asin: input.evidence.requestedAsin,
          code,
          evidence: input.evidence,
          trustedFingerprint: input.trusted?.fingerprint ?? null,
        })
      : null,
  })

  if (input.registryStatus === "PAUSED_QTY_ZERO" || input.registryStatus === "REMOVED") {
    return finish("SKIP_DETACHED_OR_QTY_ZERO", false)
  }

  const requested = input.evidence.requestedAsin
  const returned = input.evidence.returnedAsin
  if (returned && /^[A-Z0-9]{10}$/.test(returned) && /^[A-Z0-9]{10}$/.test(requested) && returned !== requested) {
    return finish("ASIN_IDENTITY_MISMATCH", true)
  }

  if (!input.trusted) {
    return finish("NO_TRUSTED_REFERENCE", true)
  }

  const trustedCents = input.trusted.priceCents
  const positive = keepaPositivePriceCents(input.evidence)
  if (trustedCents != null && trustedCents > 0 && positive.length > 0 && !priceFoundInKeepaEvidence(trustedCents, input.evidence)) {
    return finish("PRICE_EVIDENCE_MISMATCH", true)
  }

  if (input.trusted.inStock === true && keepaDefiniteStockLoss(input.evidence)) {
    return finish("STOCK_RISK", true)
  }

  if (input.trusted.primeOrFba === true && keepaDefinitePrimeFbaLoss(input.evidence)) {
    return finish("PRIME_RISK", true)
  }

  if (trustedCents != null && trustedCents > 0 && priceFoundInKeepaEvidence(trustedCents, input.evidence)) {
    return finish("PRICE_CONSISTENT", false)
  }

  return finish("SNAPSHOT_RECORDED", false)
}
