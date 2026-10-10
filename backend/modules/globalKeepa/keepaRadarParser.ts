import { KEEPA_CSV_INDEX } from "../keepa/keepaPriceTypes"
import { keepaCentsToUsd } from "../keepa/keepaPriceSelector"
import type { KeepaApiProduct, KeepaApiResponse } from "../keepa/keepaTypes"
import type { KeepaRadarProductFields, KeepaTokenFields } from "./globalKeepaTypes"

function asFiniteNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function pickNumber(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const n = asFiniteNumber(obj[key])
    if (n != null) return n
  }
  return null
}

/** Keepa Time minutes → Unix ms. Official KeepaTime.keepaMinuteToUnixInMillis. */
export function keepaMinuteToUnixMs(keepaMinute: number | null | undefined): number | null {
  if (keepaMinute == null) return null
  if (!Number.isFinite(keepaMinute) || keepaMinute <= 0) return null
  return (keepaMinute + 21564000) * 60000
}

export function keepaMinuteToDate(keepaMinute: number | null | undefined): Date | null {
  const ms = keepaMinuteToUnixMs(keepaMinute)
  if (ms == null) return null
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? d : null
}

function keepaMinuteRaw(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null
  return Math.floor(raw)
}

/** Offer-count CSV slots: -1 / missing → null; 0 is a valid count. */
export function keepaCountToInt(raw: number | null | undefined): number | null {
  if (raw == null) return null
  if (!Number.isFinite(raw)) return null
  if (raw < 0) return null
  return Math.floor(raw)
}

export function extractKeepaTokenFields(resp: KeepaApiResponse | null | undefined): KeepaTokenFields {
  const obj = (resp ?? {}) as Record<string, unknown>
  return {
    tokensLeft: pickNumber(obj, "tokensLeft", "tokens_left"),
    refillRate: pickNumber(obj, "refillRate", "refill_rate"),
    refillIn: pickNumber(obj, "refillIn", "refill_in"),
    tokensConsumed: pickNumber(obj, "tokensConsumed", "tokens_consumed"),
    processingTimeInMs: pickNumber(obj, "processingTimeInMs", "processing_time_in_ms"),
  }
}

function readCsvSlot(current: number[] | undefined, index: number): number | null {
  if (!Array.isArray(current) || index < 0 || index >= current.length) return null
  const v = current[index]
  if (typeof v !== "number" || !Number.isFinite(v)) return null
  return v
}

export function extractKeepaRadarProductFields(
  product: KeepaApiProduct | null | undefined
): KeepaRadarProductFields | null {
  const asin = product?.asin?.trim().toUpperCase() ?? ""
  if (!/^[A-Z0-9]{10}$/.test(asin)) return null

  const current = product?.stats?.current
  const lastUpdateMinutes = keepaMinuteRaw(product?.lastUpdate)
  const lastPriceChangeMinutes = keepaMinuteRaw(product?.lastPriceChange)

  return {
    asin,
    amazonPriceUsd: keepaCentsToUsd(readCsvSlot(current, KEEPA_CSV_INDEX.AMAZON)),
    newPriceUsd: keepaCentsToUsd(readCsvSlot(current, KEEPA_CSV_INDEX.NEW)),
    newFbaCount: keepaCountToInt(readCsvSlot(current, KEEPA_CSV_INDEX.COUNT_NEW_FBA)),
    newFbmCount: keepaCountToInt(readCsvSlot(current, KEEPA_CSV_INDEX.COUNT_NEW_FBM)),
    lastUpdateMinutes,
    lastPriceChangeMinutes,
    lastUpdateAt: keepaMinuteToDate(lastUpdateMinutes),
    lastPriceChangeAt: keepaMinuteToDate(lastPriceChangeMinutes),
  }
}

export function mapKeepaProductsByAsin(
  products: KeepaApiProduct[] | null | undefined
): Map<string, KeepaApiProduct> {
  const map = new Map<string, KeepaApiProduct>()
  if (!Array.isArray(products)) return map
  for (const p of products) {
    const a = p?.asin?.trim().toUpperCase()
    if (a && /^[A-Z0-9]{10}$/.test(a)) map.set(a, p)
  }
  return map
}
