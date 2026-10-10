export type AmazonScanContext = {
  asin: string
  marketplace: string
  deliveryZip: string
  sessionClass: string
}

export function normalizeScanAsin(asin: string): string {
  return String(asin ?? "").trim().toUpperCase()
}

export function buildAmazonScanKey(input: AmazonScanContext): string {
  const asin = normalizeScanAsin(input.asin)
  const marketplace = String(input.marketplace ?? "US").trim().toUpperCase() || "US"
  const zip = String(input.deliveryZip ?? "10001").trim() || "10001"
  const session = String(input.sessionClass ?? "PUBLIC_UNAUTH").trim().toUpperCase() || "PUBLIC_UNAUTH"
  return `${asin}|${marketplace}|${zip}|${session}`
}

export function scanContextsCompatible(a: AmazonScanContext, b: AmazonScanContext): boolean {
  return buildAmazonScanKey(a) === buildAmazonScanKey(b)
}

/** Stable 0..spreadSec-1 jitter from ASIN so due times fan out across the day. */
export function scanSpreadSeconds(asin: string, spreadSec: number): number {
  const s = normalizeScanAsin(asin)
  const span = Math.max(1, Math.floor(spreadSec))
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % span
}
