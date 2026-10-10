import { extractKeepaPriceCandidates } from "../keepa/keepaPriceSelector"
import type { KeepaApiProduct } from "../keepa/keepaTypes"
import { extractKeepaRadarProductFields } from "../globalKeepa/keepaRadarParser"
import { createHash } from "crypto"

/** Commercial Keepa fields reused from existing radar parser + CSV selector. */
export type KeepaMonitoredSnapshot = {
  asin: string
  requestedAsin?: string
  returnedAsin?: string | null
  requestedAsinPresent?: boolean
  returnedAsinMismatch?: boolean
  parentAsin?: string | null
  variationAsinsFingerprint?: string | null
  productUnavailable?: boolean | null
  buyBoxPriceUsd: number | null
  newPriceUsd: number | null
  amazonPriceUsd: number | null
  newFbaCount: number | null
  newFbmCount: number | null
  primeExclusivePriceUsd: number | null
  buyBoxIsPrimeExclusive: boolean | null
  buyBoxSellerId: string | null
  availability: "IN_STOCK" | "NO_FBA" | "UNKNOWN"
}

const IGNORE_KEYS = new Set([
  "lastUpdateMinutes",
  "lastPriceChangeMinutes",
  "lastUpdateAt",
  "lastPriceChangeAt",
  "tokensLeft",
  "refillRate",
  "refillIn",
  "tokensConsumed",
  "processingTimeInMs",
  "requestedAt",
  "responseTimestamp",
])

export function roundUsd(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null
  return Math.round(n * 100) / 100
}

function sellerIdFromProduct(product: KeepaApiProduct): string | null {
  const stats = product.stats as Record<string, unknown> | undefined
  const raw = stats?.buyBoxSellerId ?? stats?.buyBoxSeller
  if (typeof raw === "string" && raw.trim()) return raw.trim()
  return null
}

function normalizeAsin(raw: unknown): string | null {
  const asin = typeof raw === "string" ? raw.trim().toUpperCase() : ""
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : null
}

function variationFingerprint(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null
  const asins = [...new Set(raw.map(normalizeAsin).filter((v): v is string => Boolean(v)))].sort()
  return asins.length ? createHash("sha256").update(asins.join("|")).digest("hex") : null
}

export function monitoredAvailability(input: {
  amazonPriceUsd: number | null
  newFbaCount: number | null
}): KeepaMonitoredSnapshot["availability"] {
  if (input.newFbaCount === 0) return "NO_FBA"
  if (input.amazonPriceUsd != null || (input.newFbaCount != null && input.newFbaCount > 0)) return "IN_STOCK"
  return "UNKNOWN"
}

export function extractKeepaMonitoredSnapshot(product: KeepaApiProduct | null | undefined): KeepaMonitoredSnapshot | null {
  const radar = extractKeepaRadarProductFields(product)
  if (!radar || !product) return null
  const prices = extractKeepaPriceCandidates(product)
  return {
    asin: radar.asin,
    requestedAsin: radar.asin,
    returnedAsin: radar.asin,
    requestedAsinPresent: true,
    returnedAsinMismatch: false,
    parentAsin: normalizeAsin(product.parentAsin),
    variationAsinsFingerprint: variationFingerprint(product.variationCSV),
    productUnavailable: typeof product.availabilityAmazon === "number" ? product.availabilityAmazon < 0 : null,
    buyBoxPriceUsd: roundUsd(prices.buyBoxCurrent),
    newPriceUsd: roundUsd(radar.newPriceUsd),
    amazonPriceUsd: roundUsd(radar.amazonPriceUsd),
    newFbaCount: radar.newFbaCount,
    newFbmCount: radar.newFbmCount,
    primeExclusivePriceUsd: roundUsd(prices.primeExclusiveCurrent),
    buyBoxIsPrimeExclusive:
      typeof product.stats?.buyBoxIsPrimeExclusive === "boolean" ? product.stats.buyBoxIsPrimeExclusive : null,
    buyBoxSellerId: sellerIdFromProduct(product),
    availability: monitoredAvailability({
      amazonPriceUsd: roundUsd(radar.amazonPriceUsd),
      newFbaCount: radar.newFbaCount,
    }),
  }
}

export function missingKeepaMonitoredSnapshot(input: {
  requestedAsin: string
  returnedAsin?: string | null
}): KeepaMonitoredSnapshot {
  const requestedAsin = input.requestedAsin.trim().toUpperCase()
  const returnedAsin = normalizeAsin(input.returnedAsin)
  return {
    asin: returnedAsin ?? requestedAsin,
    requestedAsin,
    returnedAsin,
    requestedAsinPresent: false,
    returnedAsinMismatch: returnedAsin != null && returnedAsin !== requestedAsin,
    parentAsin: null,
    variationAsinsFingerprint: null,
    productUnavailable: null,
    buyBoxPriceUsd: null,
    newPriceUsd: null,
    amazonPriceUsd: null,
    newFbaCount: null,
    newFbmCount: null,
    primeExclusivePriceUsd: null,
    buyBoxIsPrimeExclusive: null,
    buyBoxSellerId: null,
    availability: "UNKNOWN",
  }
}

export function canonicalizeMonitoredSnapshot(snap: KeepaMonitoredSnapshot): string {
  const keys = (Object.keys(snap) as (keyof KeepaMonitoredSnapshot)[]).filter(k => !IGNORE_KEYS.has(String(k))).sort()
  const obj: Record<string, unknown> = {}
  for (const k of keys) obj[k] = snap[k]
  return JSON.stringify(obj)
}

export function monitoredSnapshotFingerprint(snap: KeepaMonitoredSnapshot): string {
  return createHash("sha256").update(canonicalizeMonitoredSnapshot(snap)).digest("hex")
}

export function auditHashFromRawProduct(product: KeepaApiProduct): string {
  const current = Array.isArray(product.stats?.current) ? product.stats.current.slice(0, 40) : []
  return createHash("sha256")
    .update(JSON.stringify({ asin: product.asin, current }))
    .digest("hex")
}
