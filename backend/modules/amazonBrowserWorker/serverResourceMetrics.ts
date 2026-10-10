/**
 * Read-only host + public-worker process memory metrics for admin observability.
 * No auto-scaling / process control.
 */
import fs from "node:fs"
import { execFileSync } from "node:child_process"

export type ServerResourceSnapshot = {
  ramTotalBytes: number
  ramUsedBytes: number
  ramAvailableBytes: number
  ramUsedPct: number
  swapTotalBytes: number
  swapUsedBytes: number
  cpuPct: number | null
  load1: number | null
  load5: number | null
  load15: number | null
  iowaitPct: number | null
  warning: "OK" | "CAPACITY WARNING" | "MEMORY PRESSURE"
  warningReason: string | null
}

export type PublicWorkerProcessMetrics = {
  slot: string
  pm2Name: string
  pid: number | null
  nodeRssBytes: number | null
  chromiumRssBytes: number | null
  chromiumProcessCount: number
}

function readMeminfoKb(): Record<string, number> {
  const out: Record<string, number> = {}
  try {
    const text = fs.readFileSync("/proc/meminfo", "utf8")
    for (const line of text.split("\n")) {
      const m = /^(\w+):\s+(\d+)/.exec(line)
      if (m) out[m[1]] = parseInt(m[2], 10) || 0
    }
  } catch {
    /* ignore */
  }
  return out
}

function readLoadavg(): { load1: number; load5: number; load15: number } | null {
  try {
    const parts = fs.readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/)
    return {
      load1: Number(parts[0]),
      load5: Number(parts[1]),
      load15: Number(parts[2]),
    }
  } catch {
    return null
  }
}

function readCpuTimes(): number[] | null {
  try {
    const line = fs.readFileSync("/proc/stat", "utf8").split("\n")[0]
    if (!line?.startsWith("cpu ")) return null
    return line.split(/\s+/).slice(1).map(n => parseInt(n, 10) || 0)
  } catch {
    return null
  }
}

function sleepSyncMs(ms: number): void {
  const sec = Math.max(0.05, ms / 1000)
  try {
    execFileSync("sleep", [String(sec)], { stdio: "ignore" })
  } catch {
    /* ignore */
  }
}

/** Short sample (~200ms) for CPU + iowait. */
function sampleCpu(sampleMs = 200): { cpuPct: number; iowaitPct: number } | null {
  const a = readCpuTimes()
  if (!a) return null
  sleepSyncMs(sampleMs)
  const b = readCpuTimes()
  if (!b || b.length < 5) return null
  const d = a.map((_, i) => Math.max(0, (b[i] ?? 0) - (a[i] ?? 0)))
  const total = d.reduce((s, n) => s + n, 0) || 1
  const idle = d[3] ?? 0
  const iowait = d[4] ?? 0
  return {
    cpuPct: Math.round(((total - idle) / total) * 1000) / 10,
    iowaitPct: Math.round((iowait / total) * 1000) / 10,
  }
}

function classifyMemoryWarning(input: {
  ramUsedPct: number
  swapTotalBytes: number
  swapUsedBytes: number
}): { warning: ServerResourceSnapshot["warning"]; warningReason: string | null } {
  const swapActive = input.swapTotalBytes > 0 && input.swapUsedBytes > 8 * 1024 * 1024
  if (input.ramUsedPct >= 90 || swapActive) {
    return {
      warning: "MEMORY PRESSURE",
      warningReason: swapActive
        ? `Swap in use (${Math.round(input.swapUsedBytes / (1024 * 1024))} MB)`
        : `RAM used ${input.ramUsedPct.toFixed(1)}%`,
    }
  }
  if (input.ramUsedPct >= 80) {
    return {
      warning: "CAPACITY WARNING",
      warningReason: `RAM used ${input.ramUsedPct.toFixed(1)}%`,
    }
  }
  return { warning: "OK", warningReason: null }
}

export function collectServerResourceSnapshot(): ServerResourceSnapshot {
  const mem = readMeminfoKb()
  const totalKb = mem.MemTotal ?? 0
  const availKb = mem.MemAvailable ?? mem.MemFree ?? 0
  const usedKb = Math.max(0, totalKb - availKb)
  const swapTotalKb = mem.SwapTotal ?? 0
  const swapFreeKb = mem.SwapFree ?? 0
  const swapUsedKb = Math.max(0, swapTotalKb - swapFreeKb)
  const ramUsedPct = totalKb > 0 ? (100 * usedKb) / totalKb : 0
  const load = readLoadavg()
  const cpu = sampleCpu(180)
  const warn = classifyMemoryWarning({
    ramUsedPct,
    swapTotalBytes: swapTotalKb * 1024,
    swapUsedBytes: swapUsedKb * 1024,
  })
  return {
    ramTotalBytes: totalKb * 1024,
    ramUsedBytes: usedKb * 1024,
    ramAvailableBytes: availKb * 1024,
    ramUsedPct: Math.round(ramUsedPct * 10) / 10,
    swapTotalBytes: swapTotalKb * 1024,
    swapUsedBytes: swapUsedKb * 1024,
    cpuPct: cpu?.cpuPct ?? null,
    load1: load?.load1 ?? null,
    load5: load?.load5 ?? null,
    load15: load?.load15 ?? null,
    iowaitPct: cpu?.iowaitPct ?? null,
    warning: warn.warning,
    warningReason: warn.warningReason,
  }
}

type PsRow = { pid: number; ppid: number; rssKb: number; comm: string }

function readProcessTable(): { byPid: Map<number, PsRow>; children: Map<number, number[]> } {
  const byPid = new Map<number, PsRow>()
  const children = new Map<number, number[]>()
  try {
    const out = execFileSync("ps", ["-eo", "pid,ppid,rss,comm", "--no-headers"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    })
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 3) continue
      const pid = parseInt(parts[0], 10)
      const ppid = parseInt(parts[1], 10)
      const rssKb = parseInt(parts[2], 10)
      if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKb)) continue
      const comm = parts.slice(3).join(" ") || ""
      byPid.set(pid, { pid, ppid, rssKb, comm })
      const list = children.get(ppid) ?? []
      list.push(pid)
      children.set(ppid, list)
    }
  } catch {
    /* ignore */
  }
  return { byPid, children }
}

function walkDescendants(root: number, children: Map<number, number[]>): number[] {
  const out: number[] = []
  const stack = [...(children.get(root) ?? [])]
  while (stack.length) {
    const pid = stack.pop()!
    out.push(pid)
    const kids = children.get(pid)
    if (kids) stack.push(...kids)
  }
  return out
}

function isChromiumComm(comm: string): boolean {
  const c = comm.toLowerCase()
  return c.includes("chrome") || c.includes("chromium") || c.includes("headless")
}

function resolvePm2PidByName(pm2Name: string): number | null {
  try {
    const out = execFileSync("pm2", ["jlist"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    })
    const apps = JSON.parse(out) as Array<{ name?: string; pid?: number; pm2_env?: { status?: string } }>
    const hit = apps.find(a => a.name === pm2Name && a.pm2_env?.status === "online" && a.pid)
    return hit?.pid && Number.isFinite(hit.pid) ? Number(hit.pid) : null
  } catch {
    return null
  }
}

export function collectPublicWorkerProcessMetrics(slots: string[]): PublicWorkerProcessMetrics[] {
  const { byPid, children } = readProcessTable()
  return slots.map(slot => {
    const pm2Name = `listjetgo-amazon-public-worker-${slot}`
    const pid = resolvePm2PidByName(pm2Name)
    if (!pid || !byPid.has(pid)) {
      return {
        slot,
        pm2Name,
        pid: null,
        nodeRssBytes: null,
        chromiumRssBytes: null,
        chromiumProcessCount: 0,
      }
    }
    const nodeRssKb = byPid.get(pid)!.rssKb
    const desc = walkDescendants(pid, children)
    let chromiumRssKb = 0
    let chromiumProcessCount = 0
    for (const cpid of desc) {
      const row = byPid.get(cpid)
      if (!row) continue
      if (isChromiumComm(row.comm)) {
        chromiumRssKb += row.rssKb
        chromiumProcessCount += 1
      }
    }
    return {
      slot,
      pm2Name,
      pid,
      nodeRssBytes: nodeRssKb * 1024,
      chromiumRssBytes: chromiumRssKb * 1024,
      chromiumProcessCount,
    }
  })
}
