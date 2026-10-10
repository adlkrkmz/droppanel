import { parseBearerToken, timingSafeTokenEqual } from "../keepaSensor/keepaCollectorProtocol"

function oxylabsToken(): string {
  return (process.env.OXYLABS_VERIFY_WORKER_TOKEN ?? "").trim()
}

function scanToken(): string {
  return (process.env.AMAZON_SCAN_WORKER_TOKEN ?? "").trim()
}

function collectorToken(): string {
  return (process.env.KEEPA_COLLECTOR_WORKER_TOKEN ?? "").trim()
}

export function oxylabsVerifyWorkerAuthConfigured(): boolean {
  return oxylabsToken().length >= 32
}

export function isForeignWorkerToken(presented: string): boolean {
  const token = String(presented ?? "")
  if (!token) return false
  const scan = scanToken()
  const collector = collectorToken()
  if (scan.length >= 32 && timingSafeTokenEqual(token, scan)) return true
  if (collector.length >= 32 && timingSafeTokenEqual(token, collector)) return true
  return false
}

export function authorizeOxylabsVerifyWorker(header: string | undefined): { ok: true } | { ok: false; foreign: boolean } {
  const expected = oxylabsToken()
  if (expected.length < 32) return { ok: false, foreign: false }
  const token = parseBearerToken(header)
  if (!token) return { ok: false, foreign: false }
  if (isForeignWorkerToken(token)) return { ok: false, foreign: true }
  if (!timingSafeTokenEqual(token, expected)) return { ok: false, foreign: false }
  return { ok: true }
}

export function oxylabsTokenIsScanOrCollector(header: string | undefined): boolean {
  return isForeignWorkerToken(parseBearerToken(header))
}

export function evaluateOxylabsBearerAuth(input: {
  tokenConfigured: boolean
  tokenOk: boolean
  foreignToken: boolean
  hasSessionCookie: boolean
}): { status: number; error: string } | { ok: true } {
  if (input.hasSessionCookie) {
    return { status: 401, error: "Unauthorized" }
  }
  if (!input.tokenConfigured) {
    return { status: 503, error: "OXYLABS_VERIFY_TOKEN_MISSING" }
  }
  if (input.foreignToken || !input.tokenOk) {
    return { status: 401, error: "Unauthorized" }
  }
  return { ok: true }
}

export function evaluateOxylabsProtocolGate(protocolEnabled: boolean): { status: number; error: string } | { ok: true } {
  if (!protocolEnabled) {
    return { status: 503, error: "OXYLABS_VERIFY_PROTOCOL_DISABLED" }
  }
  return { ok: true }
}

export function evaluateOxylabsVerifyRouteAuth(input: {
  protocolEnabled: boolean
  tokenConfigured: boolean
  tokenOk: boolean
  foreignToken: boolean
  hasSessionCookie: boolean
}): { status: number; error: string } | { ok: true } {
  const auth = evaluateOxylabsBearerAuth(input)
  if (!("ok" in auth)) return auth
  return evaluateOxylabsProtocolGate(input.protocolEnabled)
}
