import {
  evaluateKeepaCollectorRouteAuth,
  keepaCollectorProtocolEnabled,
  parseBearerToken,
} from "./keepaCollectorProtocol"

function collectorToken(): string {
  return (process.env.KEEPA_COLLECTOR_WORKER_TOKEN ?? "").trim()
}

function scanWorkerToken(): string {
  return (process.env.AMAZON_SCAN_WORKER_TOKEN ?? "").trim()
}

export function keepaCollectorAuthConfigured(): boolean {
  return collectorToken().length >= 32
}

export function authorizeKeepaCollector(header: string | undefined): ReturnType<typeof evaluateKeepaCollectorRouteAuth> {
  return evaluateKeepaCollectorRouteAuth({
    protocolEnabled: keepaCollectorProtocolEnabled(),
    collectorTokenConfigured: keepaCollectorAuthConfigured(),
    presentedToken: parseBearerToken(header),
    collectorToken: collectorToken(),
    scanWorkerToken: scanWorkerToken(),
  })
}
