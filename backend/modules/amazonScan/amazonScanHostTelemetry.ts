import fs from "node:fs"
import os from "node:os"

export type AmazonScanHostTelemetry = {
  hostname: string
  ramTotalBytes: number
  ramUsedBytes: number
  ramAvailableBytes: number
  ramUsedPct: number
  swapTotalBytes: number
  swapUsedBytes: number
  load1: number | null
  load5: number | null
  load15: number | null
  diskUsedPct: number | null
  chromiumProcessCount: number
  nodeRssBytes: number
  uptimeSec: number
  collectedAt: string
}

function meminfoKb(): Record<string, number> {
  const out: Record<string, number> = {}
  try {
    for (const line of fs.readFileSync("/proc/meminfo", "utf8").split("\n")) {
      const m = /^(\w+):\s+(\d+)/.exec(line)
      if (m) out[m[1]] = parseInt(m[2], 10) || 0
    }
  } catch {
    /* ignore */
  }
  return out
}

function loadavg(): { load1: number; load5: number; load15: number } | null {
  try {
    const parts = fs.readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/)
    return { load1: Number(parts[0]), load5: Number(parts[1]), load15: Number(parts[2]) }
  } catch {
    const a = os.loadavg()
    return { load1: a[0] ?? 0, load5: a[1] ?? 0, load15: a[2] ?? 0 }
  }
}

function diskUsedPct(): number | null {
  const statfs = (fs as unknown as { statfsSync?: (p: string) => { blocks: number; bavail: number; bsize: number } })
    .statfsSync
  if (typeof statfs !== "function") return null
  try {
    const s = statfs("/")
    const total = s.blocks * s.bsize
    const avail = s.bavail * s.bsize
    if (total <= 0) return null
    return (100 * (total - avail)) / total
  } catch {
    return null
  }
}

function chromiumCount(): number {
  let n = 0
  try {
    const names = fs.readdirSync("/proc")
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue
      try {
        const comm = fs.readFileSync(`/proc/${name}/comm`, "utf8").trim().toLowerCase()
        if (comm.includes("chrome") || comm.includes("chromium") || comm.includes("headless")) n++
      } catch {
        /* gone */
      }
    }
  } catch {
    /* ignore */
  }
  return n
}

export function collectAmazonScanHostTelemetry(): AmazonScanHostTelemetry {
  const mem = meminfoKb()
  const totalKb = mem.MemTotal ?? Math.round(os.totalmem() / 1024)
  const availKb = mem.MemAvailable ?? mem.MemFree ?? Math.round(os.freemem() / 1024)
  const usedKb = Math.max(0, totalKb - availKb)
  const swapTotalKb = mem.SwapTotal ?? 0
  const swapUsedKb = Math.max(0, swapTotalKb - (mem.SwapFree ?? 0))
  const ramUsedPct = totalKb > 0 ? (100 * usedKb) / totalKb : 0
  const load = loadavg()
  let diskPct = diskUsedPct()
  if (diskPct != null) diskPct = Math.round(diskPct * 10) / 10
  let uptimeSec = os.uptime()
  try {
    const raw = fs.readFileSync("/proc/uptime", "utf8").split(/\s+/)[0]
    const n = parseFloat(raw)
    if (Number.isFinite(n)) uptimeSec = n
  } catch {
    /* ignore */
  }
  return {
    hostname: os.hostname().slice(0, 64),
    ramTotalBytes: totalKb * 1024,
    ramUsedBytes: usedKb * 1024,
    ramAvailableBytes: availKb * 1024,
    ramUsedPct: Math.round(ramUsedPct * 10) / 10,
    swapTotalBytes: swapTotalKb * 1024,
    swapUsedBytes: swapUsedKb * 1024,
    load1: load?.load1 ?? null,
    load5: load?.load5 ?? null,
    load15: load?.load15 ?? null,
    diskUsedPct: diskPct,
    chromiumProcessCount: chromiumCount(),
    nodeRssBytes: process.memoryUsage().rss,
    uptimeSec: Math.round(uptimeSec),
    collectedAt: new Date().toISOString(),
  }
}

export function sanitizeAmazonScanHostTelemetry(raw: unknown): AmazonScanHostTelemetry | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const hostname = String(o.hostname ?? "").trim().slice(0, 64)
  if (!hostname || /[\\/]|proc|env|secret|token/i.test(hostname)) return null
  const num = (k: string): number | null => {
    const v = o[k]
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null
    return v
  }
  const collectedAt = typeof o.collectedAt === "string" ? o.collectedAt.slice(0, 40) : new Date().toISOString()
  return {
    hostname,
    ramTotalBytes: num("ramTotalBytes") ?? 0,
    ramUsedBytes: num("ramUsedBytes") ?? 0,
    ramAvailableBytes: num("ramAvailableBytes") ?? 0,
    ramUsedPct: num("ramUsedPct") ?? 0,
    swapTotalBytes: num("swapTotalBytes") ?? 0,
    swapUsedBytes: num("swapUsedBytes") ?? 0,
    load1: num("load1"),
    load5: num("load5"),
    load15: num("load15"),
    diskUsedPct: num("diskUsedPct"),
    chromiumProcessCount: Math.floor(num("chromiumProcessCount") ?? 0),
    nodeRssBytes: num("nodeRssBytes") ?? 0,
    uptimeSec: Math.floor(num("uptimeSec") ?? 0),
    collectedAt,
  }
}
