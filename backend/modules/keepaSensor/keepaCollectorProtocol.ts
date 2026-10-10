import crypto from "crypto"

export const KEEPA_COLLECTOR_PROTOCOL_FLAG = "KEEPA_COLLECTOR_PROTOCOL_ENABLED"

export function keepaCollectorProtocolEnabled(raw = process.env.KEEPA_COLLECTOR_PROTOCOL_ENABLED): boolean {
  return String(raw ?? "").trim().toLowerCase() === "true"
}

export function parseBearerToken(header: string | undefined): string {
  const raw = String(header ?? "").trim()
  if (!raw) return ""
  return raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw
}

export function timingSafeTokenEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  if (left.length === 0) return false
  return crypto.timingSafeEqual(left, right)
}

export type KeepaCollectorRouteAuth =
  | { ok: true }
  | { ok: false; status: 503; error: "KEEPA_COLLECTOR_PROTOCOL_DISABLED" | "KEEPA_COLLECTOR_TOKEN_MISSING" }
  | { ok: false; status: 401; error: "Unauthorized" }

export function evaluateKeepaCollectorRouteAuth(input: {
  protocolEnabled: boolean
  collectorTokenConfigured: boolean
  presentedToken: string
  collectorToken: string
  scanWorkerToken: string
}): KeepaCollectorRouteAuth {
  if (!input.protocolEnabled) {
    return { ok: false, status: 503, error: "KEEPA_COLLECTOR_PROTOCOL_DISABLED" }
  }
  if (!input.collectorTokenConfigured || input.collectorToken.length < 32) {
    return { ok: false, status: 503, error: "KEEPA_COLLECTOR_TOKEN_MISSING" }
  }
  const presented = input.presentedToken
  if (!presented) return { ok: false, status: 401, error: "Unauthorized" }
  const scan = input.scanWorkerToken
  if (scan.length >= 32 && timingSafeTokenEqual(presented, scan)) {
    return { ok: false, status: 401, error: "Unauthorized" }
  }
  if (!timingSafeTokenEqual(presented, input.collectorToken)) {
    return { ok: false, status: 401, error: "Unauthorized" }
  }
  return { ok: true }
}

export function evaluateAmazonScanRejectsCollectorToken(input: {
  presentedToken: string
  scanWorkerToken: string
  collectorToken: string
}): boolean {
  const presented = input.presentedToken
  const collector = input.collectorToken
  if (!presented || collector.length < 32) return false
  if (timingSafeTokenEqual(presented, collector)) return true
  return false
}

export function eventsAfterWatermark<T extends { createdAt: string }>(
  events: T[],
  watermark: { snapshotStartedAt: string }
): T[] {
  const startMs = Date.parse(watermark.snapshotStartedAt)
  return events.filter(ev => {
    const t = Date.parse(ev.createdAt)
    if (!Number.isFinite(t)) return false
    return t >= startMs
  })
}
