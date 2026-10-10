import type { AmazonScanHostTelemetry } from "./amazonScanHostTelemetry"

export const WORKER_ONLINE_AGE_SEC = 45
export const WORKER_DISPLAY_MAX_AGE_SEC = 24 * 60 * 60

const ROUTINE_ID = /^amazon-public-browser-worker-([A-Z](?:\d{0,2})?)$/
const CONFIRM_ID = /^amazon-scan-confirm-([A-Z](?:\d{0,2})?)$/

export type AmazonScanWorkerRole = "ROUTINE" | "CONFIRM"

export type ClassifiedAmazonScanWorker = {
  workerId: string
  slot: string
  role: AmazonScanWorkerRole
}

export function classifyAmazonScanWorker(workerId: string | null | undefined): ClassifiedAmazonScanWorker | null {
  const id = String(workerId ?? "").trim()
  if (!id) return null
  const routine = ROUTINE_ID.exec(id)
  if (routine) return { workerId: id, slot: routine[1], role: "ROUTINE" }
  const confirm = CONFIRM_ID.exec(id)
  if (confirm) return { workerId: id, slot: confirm[1], role: "CONFIRM" }
  return null
}

export function isStaleAmazonScanWorker(heartbeatAgeSec: number | null, nowSec = 0): boolean {
  void nowSec
  if (heartbeatAgeSec == null) return true
  return heartbeatAgeSec > WORKER_DISPLAY_MAX_AGE_SEC
}

export function isOnlineAmazonScanWorker(status: string | null | undefined, heartbeatAgeSec: number | null): boolean {
  return status === "ONLINE" && heartbeatAgeSec != null && heartbeatAgeSec < WORKER_ONLINE_AGE_SEC
}

export function sortAmazonScanWorkers<T extends { role: AmazonScanWorkerRole; slot: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.role !== b.role) return a.role === "ROUTINE" ? -1 : 1
    return a.slot.localeCompare(b.slot, "en", { numeric: true })
  })
}

export function parseHostTelemetry(raw: unknown): AmazonScanHostTelemetry | null {
  let v: unknown = raw
  if (typeof v === "string") {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!v || typeof v !== "object") return null
  const o = v as AmazonScanHostTelemetry
  if (!o.hostname) return null
  return o
}

/** One scanner host: RAM/load/disk/chromium from newest sample; Node RSS summed across workers. */
export function mergeScraperTelemetry(
  rows: Array<{ host_telemetry?: unknown; hostTelemetry?: unknown }>
): AmazonScanHostTelemetry | null {
  const items = rows
    .map(r => parseHostTelemetry(r.host_telemetry ?? r.hostTelemetry))
    .filter((x): x is AmazonScanHostTelemetry => Boolean(x))
  if (!items.length) return null
  const byHost = new Map<string, AmazonScanHostTelemetry[]>()
  for (const item of items) {
    const list = byHost.get(item.hostname) ?? []
    list.push(item)
    byHost.set(item.hostname, list)
  }
  const hosts = [...byHost.entries()].map(([hostname, list]) => {
    list.sort((a, b) => String(b.collectedAt).localeCompare(String(a.collectedAt)))
    const newest = list[0]
    return {
      hostname,
      newest,
      nodeRssBytes: list.reduce((s, i) => s + (i.nodeRssBytes || 0), 0),
    }
  })
  hosts.sort((a, b) => String(b.newest.collectedAt).localeCompare(String(a.newest.collectedAt)))
  const primary = hosts[0]
  return {
    ...primary.newest,
    hostname: primary.hostname,
    nodeRssBytes: primary.nodeRssBytes,
    chromiumProcessCount: primary.newest.chromiumProcessCount || 0,
  }
}

export function includeActivityRow(kind: string, workerId: string | null | undefined): boolean {
  const cls = classifyAmazonScanWorker(workerId)
  if (kind === "ROUTINE") return cls?.role === "ROUTINE"
  if (kind === "CONFIRM") return !workerId || cls?.role === "CONFIRM"
  return false
}
