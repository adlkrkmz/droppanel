import { createHash } from "crypto"
import { keepaCommercialFingerprint, keepaSnapshotTrigger } from "./keepaSnapshotDiff"

export const BASELINE_PRICE_CONSISTENT = "BASELINE_PRICE_CONSISTENT"
export const BASELINE_PRICE_MISMATCH = "BASELINE_PRICE_MISMATCH"
export const BASELINE_PANEL_PRICE_MISSING = "BASELINE_PANEL_PRICE_MISSING"
export const CONFIRMED_PRICE_MISMATCH = "CONFIRMED_PRICE_MISMATCH"

export type KeepaPriceFields = {
  amazonCents?: unknown
  newCents?: unknown
  buyBoxCents?: unknown
  primeExclusiveCents?: unknown
}

export type KeepaBaselinePanelDecision = {
  code: typeof BASELINE_PRICE_CONSISTENT | typeof BASELINE_PRICE_MISMATCH | typeof BASELINE_PANEL_PRICE_MISSING
  enqueuePrimary: boolean
  panelCents: number | null
  keepaPriceCents: number[]
}

/** Positive Keepa/panel cents only. Drops null, empty, 0, -1, -2, and any non-finite/non-positive value. */
export function asPositivePriceCents(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n)
}

/** Panel `source_price` is stored as dollars. */
export function panelSourcePriceToCents(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100)
}

export function keepaPositivePriceCentsSet(prices: KeepaPriceFields): number[] {
  const out: number[] = []
  for (const v of [prices.amazonCents, prices.newCents, prices.buyBoxCents, prices.primeExclusiveCents]) {
    const c = asPositivePriceCents(v)
    if (c != null) out.push(c)
  }
  return out
}

export function panelPriceMatchesKeepaSet(panelCents: number, keepaPriceCents: number[]): boolean {
  return keepaPriceCents.some(c => Math.abs(c - panelCents) <= 1)
}

export function evaluateKeepaBaselinePanelPrice(input: {
  panelSourcePrice: unknown
  panelCents?: number | null
  keepaPrices: KeepaPriceFields
}): KeepaBaselinePanelDecision {
  const panelCents =
    input.panelCents !== undefined ? (input.panelCents != null ? asPositivePriceCents(input.panelCents) : null) : panelSourcePriceToCents(input.panelSourcePrice)
  const keepaPriceCents = keepaPositivePriceCentsSet(input.keepaPrices)
  if (panelCents == null) {
    return { code: BASELINE_PANEL_PRICE_MISSING, enqueuePrimary: false, panelCents: null, keepaPriceCents }
  }
  if (panelPriceMatchesKeepaSet(panelCents, keepaPriceCents)) {
    return { code: BASELINE_PRICE_CONSISTENT, enqueuePrimary: false, panelCents, keepaPriceCents }
  }
  return { code: BASELINE_PRICE_MISMATCH, enqueuePrimary: true, panelCents, keepaPriceCents }
}

export function keepaBaselineMismatchFingerprint(input: {
  panelCents: number
  keepaPrices: KeepaPriceFields
}): string {
  const body = JSON.stringify({
    kind: BASELINE_PRICE_MISMATCH,
    panelCents: input.panelCents,
    amazonCents: asPositivePriceCents(input.keepaPrices.amazonCents),
    newCents: asPositivePriceCents(input.keepaPrices.newCents),
    buyBoxCents: asPositivePriceCents(input.keepaPrices.buyBoxCents),
    primeExclusiveCents: asPositivePriceCents(input.keepaPrices.primeExclusiveCents),
  })
  return createHash("sha256").update(body).digest("hex")
}

/**
 * A repeat collector observation must still be verified when it disagrees with
 * any active listing consumer's confirmed source price.  The sorted set makes
 * the fingerprint stable, while allowing a later confirmed-price update to
 * produce a new candidate when it remains unresolved.
 */
export function confirmedPriceMismatchFingerprint(input: {
  panelCents: number[]
  keepaPrices: KeepaPriceFields
}): string {
  const body = JSON.stringify({
    kind: CONFIRMED_PRICE_MISMATCH,
    panelCents: [...new Set(input.panelCents)].sort((a, b) => a - b),
    amazonCents: asPositivePriceCents(input.keepaPrices.amazonCents),
    newCents: asPositivePriceCents(input.keepaPrices.newCents),
    buyBoxCents: asPositivePriceCents(input.keepaPrices.buyBoxCents),
    primeExclusiveCents: asPositivePriceCents(input.keepaPrices.primeExclusiveCents),
  })
  return createHash("sha256").update(body).digest("hex")
}

export type KeepaCommercialSnapshot = {
  amazonCents: number | null
  newCents: number | null
  buyBoxCents: number | null
  primeExclusiveCents: number | null
  availability: string | null
  buyBoxIsPrimeExclusive: boolean | null
  newFbaCount: number | null
  newFbmCount: number | null
  requestedAsin?: string | null
  returnedAsin?: string | null
  requestedAsinPresent?: boolean | null
  returnedAsinMismatch?: boolean | null
  parentAsin?: string | null
  variationAsinsFingerprint?: string | null
  productUnavailable?: boolean | null
}

export type KeepaCollectorObservationPlan = {
  trigger: "baseline" | "unchanged" | "changed"
  evaluationCode: string
  createCandidate: boolean
  enqueuePrimary: boolean
  candidateFingerprint: string | null
  panelCents: number | null
}

export function planKeepaCollectorObservation(input: {
  prev: KeepaCommercialSnapshot | null
  registryStatus: string | null
  panelSourcePrice: unknown
  /** Confirmed source prices for every eligible active consumer of this ASIN. */
  panelSourcePrices?: unknown[]
  commercial: KeepaCommercialSnapshot
}): KeepaCollectorObservationPlan {
  const trigger: "baseline" | "unchanged" | "changed" =
    input.registryStatus === "PAUSED_QTY_ZERO" || input.registryStatus === "REMOVED"
      ? "unchanged"
      : keepaSnapshotTrigger(input.prev, input.commercial)
  const identitySuspicious = input.commercial.requestedAsinPresent === false || input.commercial.returnedAsinMismatch === true
  const unknownSuspicious =
    input.commercial.amazonCents == null &&
    input.commercial.newCents == null &&
    input.commercial.buyBoxCents == null &&
    input.commercial.primeExclusiveCents == null &&
    input.commercial.availability === "UNKNOWN"
  if (trigger === "changed" || ((identitySuspicious || unknownSuspicious) && input.prev != null)) {
    const candidateFingerprint = createHash("sha256").update(keepaCommercialFingerprint(input.commercial)).digest("hex")
    return {
      trigger,
      evaluationCode: identitySuspicious
        ? input.commercial.returnedAsinMismatch
          ? "KEEPA_IDENTITY_SUSPECT"
          : "KEEPA_REQUESTED_ASIN_MISSING"
        : trigger === "unchanged"
          ? "KEEPA_UNVERIFIED_SUSPICIOUS_STATE"
          : "KEEPA_SNAPSHOT_CHANGED",
      createCandidate: true,
      enqueuePrimary: true,
      candidateFingerprint,
      panelCents: null,
    }
  }
  if (trigger === "baseline") {
    const d = evaluateKeepaBaselinePanelPrice({
      panelSourcePrice: input.panelSourcePrice,
      keepaPrices: input.commercial,
    })
    const candidateFingerprint =
      d.code === BASELINE_PRICE_MISMATCH && d.panelCents != null
        ? keepaBaselineMismatchFingerprint({ panelCents: d.panelCents, keepaPrices: input.commercial })
        : null
    return {
      trigger,
      evaluationCode: d.code,
      createCandidate: d.enqueuePrimary,
      enqueuePrimary: d.enqueuePrimary,
      candidateFingerprint,
      panelCents: d.panelCents,
    }
  }
  const confirmedPanelCents = (input.panelSourcePrices ?? [input.panelSourcePrice])
    .map(panelSourcePriceToCents)
    .filter((c): c is number => c != null)
  const keepaPrices = keepaPositivePriceCentsSet(input.commercial)
  // Keepa values are evidence only: this creates verification work and never
  // mutates the confirmed price or any listing directly.
  if (
    confirmedPanelCents.length > 0 &&
    keepaPrices.length > 0 &&
    confirmedPanelCents.some(panelCents => !panelPriceMatchesKeepaSet(panelCents, keepaPrices))
  ) {
    return {
      trigger,
      evaluationCode: CONFIRMED_PRICE_MISMATCH,
      createCandidate: true,
      enqueuePrimary: true,
      candidateFingerprint: confirmedPriceMismatchFingerprint({ panelCents: confirmedPanelCents, keepaPrices: input.commercial }),
      panelCents: null,
    }
  }
  return {
    trigger,
    evaluationCode: "PRICE_CONSISTENT",
    createCandidate: false,
    enqueuePrimary: false,
    candidateFingerprint: null,
    panelCents: null,
  }
}
