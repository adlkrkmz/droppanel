import { evaluateAmazonScanRejectsCollectorToken, parseBearerToken, timingSafeTokenEqual } from "../keepaSensor/keepaCollectorProtocol"

function scanWorkerToken(): string {
  return (process.env.AMAZON_SCAN_WORKER_TOKEN ?? "").trim()
}

function collectorToken(): string {
  return (process.env.KEEPA_COLLECTOR_WORKER_TOKEN ?? "").trim()
}

function oxylabsToken(): string {
  return (process.env.OXYLABS_VERIFY_WORKER_TOKEN ?? "").trim()
}

export function amazonScanWorkerAuthConfigured(): boolean {
  return scanWorkerToken().length >= 32
}

export function authorizeAmazonScanWorker(header: string | undefined): { ok: true; workerHint: string } | { ok: false } {
  const expected = scanWorkerToken()
  if (expected.length < 32) return { ok: false }
  const token = parseBearerToken(header)
  if (!token) return { ok: false }
  if (
    evaluateAmazonScanRejectsCollectorToken({
      presentedToken: token,
      scanWorkerToken: expected,
      collectorToken: collectorToken(),
    })
  ) {
    return { ok: false }
  }
  const oxy = oxylabsToken()
  if (oxy.length >= 32 && timingSafeTokenEqual(token, oxy)) {
    return { ok: false }
  }
  if (!timingSafeTokenEqual(token, expected)) return { ok: false }
  return { ok: true, workerHint: "scan" }
}
