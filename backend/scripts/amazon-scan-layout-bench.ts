/**
 * Layout comparison for the NEW scan server only.
 * Do not run against the production panel host under load.
 * Does not claim scan jobs or call eBay.
 *
 * A) 1 browser / 1 persistent context / 1 tab
 * B) 1 browser / 1 persistent context / 2 tabs
 * C) 1 browser / 2 contexts / 1 tab each (non-persistent)
 * D) 2 browsers / separate profiles / 1 tab each
 *
 * Success = public reader finished an observation (not navigation-only).
 *
 *   AMAZON_SCAN_BENCH_ASINS=B000000000,B000000001 AMAZON_SCAN_BENCH_LAYOUT=A \
 *     ./node_modules/.bin/ts-node --transpile-only scripts/amazon-scan-layout-bench.ts
 */
import fs from "fs"
import path from "path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { AmazonPublicWorker, type AmazonResult } from "../modules/amazonPublicWorker/amazonPublicWorker"
import type { AppConfig } from "../modules/amazonPublicWorker/types"

const LAYOUT = (process.env.AMAZON_SCAN_BENCH_LAYOUT ?? "A").toUpperCase()
const ASINS = (process.env.AMAZON_SCAN_BENCH_ASINS ?? "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(s => /^[A-Z0-9]{10}$/.test(s))
  .slice(0, 6)
const DEADLINE_MS = Math.max(30_000, parseInt(process.env.AMAZON_SCAN_BENCH_MS ?? "180000", 10) || 180000)

function cfg(): AppConfig {
  return {
    localPort: 0,
    keepaConcurrency: 1,
    amazonMode: "FAILOVER",
    amazonWorkers: ["BENCH"],
    amazonActiveConcurrency: 1,
    amazonHeadless: true,
    navigationTimeout: 45000,
    keepaHeadless: true,
    keepaDelayMs: 1500,
    amazonDelayMs: 2500,
    technicalRetryMax: 1,
  }
}

type Sample = { asin: string; ms: number; kind: string; status: string | null; valid: boolean }

function classify(r: AmazonResult): { kind: string; status: string | null; valid: boolean } {
  if (r.kind !== "done" || !r.observation) {
    return { kind: r.kind, status: r.status ?? r.reason ?? null, valid: false }
  }
  const status = r.status ?? "AMAZON_INCOMPLETE"
  const valid = status !== "AMAZON_INCOMPLETE"
  return { kind: r.kind, status, valid }
}

function readProc(): Map<number, { ppid: number; rssKb: number; cpuTicks: number; comm: string }> {
  const out = new Map<number, { ppid: number; rssKb: number; cpuTicks: number; comm: string }>()
  if (!fs.existsSync("/proc")) return out
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
      const rparen = stat.lastIndexOf(")")
      const rest = stat.slice(rparen + 2).split(" ")
      const comm = stat.slice(stat.indexOf("(") + 1, rparen)
      const ppid = parseInt(rest[1], 10) || 0
      const utime = parseInt(rest[11], 10) || 0
      const stime = parseInt(rest[12], 10) || 0
      let rssKb = 0
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8")
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(status)
      if (m) rssKb = parseInt(m[1], 10) || 0
      out.set(pid, { ppid, rssKb, cpuTicks: utime + stime, comm })
    } catch {
      /* process exited */
    }
  }
  return out
}

function treePids(roots: number[], procs: ReturnType<typeof readProc>): number[] {
  const kids = new Map<number, number[]>()
  for (const [pid, row] of procs) {
    const arr = kids.get(row.ppid) ?? []
    arr.push(pid)
    kids.set(row.ppid, arr)
  }
  const seen = new Set<number>()
  const stack = [...roots.filter(p => p > 0)]
  while (stack.length) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    for (const c of kids.get(pid) ?? []) stack.push(c)
  }
  return [...seen]
}

function measureTrees(rootPids: number[]): { rssMb: number; cpuTicks: number; pids: number[] } {
  const procs = readProc()
  const pids = treePids(rootPids, procs)
  let rssKb = 0
  let cpuTicks = 0
  for (const pid of pids) {
    const row = procs.get(pid)
    if (!row) continue
    rssKb += row.rssKb
    cpuTicks += row.cpuTicks
  }
  return { rssMb: Math.round((rssKb / 1024) * 10) / 10, cpuTicks, pids }
}

const clkTck = 100

async function sampleAsin(
  observe: () => Promise<AmazonResult>,
  asin: string,
  label: string
): Promise<Sample> {
  const t0 = Date.now()
  const r = await observe()
  const c = classify(r)
  const ms = Date.now() - t0
  console.log(`[bench ${label}] ${asin} kind=${c.kind} status=${c.status} valid=${c.valid} ${ms}ms`)
  return { asin, ms, ...c }
}

type LayoutRun = { samples: Sample[]; pids: number[]; rssMb: number; cpuSec: number }

async function layoutA(asins: string[], profileDir: string): Promise<LayoutRun> {
  const w = new AmazonPublicWorker("BENCH", cfg(), { profileDir })
  await w.open()
  const samples: Sample[] = []
  for (const asin of asins) {
    samples.push(await sampleAsin(() => w.observe(asin), asin, "A"))
  }
  const pids = [w.browserPid() ?? 0].filter(Boolean)
  const trees = measureTrees(pids)
  await w.close()
  return { samples, pids, rssMb: trees.rssMb, cpuSec: Math.round((trees.cpuTicks / clkTck) * 100) / 100 }
}

async function layoutB(asins: string[], profileDir: string): Promise<LayoutRun> {
  const w = new AmazonPublicWorker("BENCH", cfg(), { profileDir })
  await w.open()
  const pageA = w.primaryPage()
  if (!pageA) throw new Error("missing primary page")
  await w.ensureUsDeliveryLocation(pageA)
  const pageB = await w.newSiblingPage()
  const first = asins.filter((_, i) => i % 2 === 0)
  const second = asins.filter((_, i) => i % 2 === 1)
  const pids = [w.browserPid() ?? 0].filter(Boolean)
  const [a, b] = await Promise.all([
    (async () => {
      const out: Sample[] = []
      for (const asin of first) out.push(await sampleAsin(() => w.observeOnPage(pageA, asin), asin, "B1"))
      return out
    })(),
    (async () => {
      const out: Sample[] = []
      for (const asin of second) out.push(await sampleAsin(() => w.observeOnPage(pageB, asin), asin, "B2"))
      return out
    })(),
  ])
  const trees = measureTrees(pids)
  await w.close()
  return { samples: [...a, ...b], pids, rssMb: trees.rssMb, cpuSec: Math.round((trees.cpuTicks / clkTck) * 100) / 100 }
}

async function layoutC(asins: string[]): Promise<LayoutRun> {
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--lang=en-US"],
  })
  const proc = browser.process()
  const pids = proc?.pid ? [proc.pid] : []
  const helper = new AmazonPublicWorker("BENCH", cfg(), { profileDir: path.join(osTmp(), "unused-c") })
  async function ctxPage(): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York" })
    await ctx.addCookies([
      { name: "i18n-prefs", value: "USD", domain: ".amazon.com", path: "/" },
      { name: "lc-main", value: "en_US", domain: ".amazon.com", path: "/" },
    ])
    const page = await ctx.newPage()
    page.setDefaultTimeout(45000)
    await helper.ensureUsDeliveryLocation(page, { force: true })
    return { ctx, page }
  }
  const [left, right] = await Promise.all([ctxPage(), ctxPage()])
  const first = asins.filter((_, i) => i % 2 === 0)
  const second = asins.filter((_, i) => i % 2 === 1)
  const [a, b] = await Promise.all([
    (async () => {
      const out: Sample[] = []
      for (const asin of first) out.push(await sampleAsin(() => helper.observeOnPage(left.page, asin), asin, "C1"))
      return out
    })(),
    (async () => {
      const out: Sample[] = []
      for (const asin of second) out.push(await sampleAsin(() => helper.observeOnPage(right.page, asin), asin, "C2"))
      return out
    })(),
  ])
  const trees = measureTrees(pids)
  await browser.close()
  return { samples: [...a, ...b], pids, rssMb: trees.rssMb, cpuSec: Math.round((trees.cpuTicks / clkTck) * 100) / 100 }
}

function osTmp(): string {
  return path.resolve(process.cwd(), "var", "amazon-scan-bench")
}

async function layoutD(asins: string[], root: string): Promise<LayoutRun> {
  const first = asins.filter((_, i) => i % 2 === 0)
  const second = asins.filter((_, i) => i % 2 === 1)
  const w1 = new AmazonPublicWorker("BENCH", cfg(), { profileDir: path.join(root, "D1") })
  const w2 = new AmazonPublicWorker("BENCH", cfg(), { profileDir: path.join(root, "D2") })
  await Promise.all([w1.open(), w2.open()])
  const pids = [w1.browserPid() ?? 0, w2.browserPid() ?? 0].filter(Boolean)
  const [a, b] = await Promise.all([
    (async () => {
      const out: Sample[] = []
      for (const asin of first) out.push(await sampleAsin(() => w1.observe(asin), asin, "D1"))
      return out
    })(),
    (async () => {
      const out: Sample[] = []
      for (const asin of second) out.push(await sampleAsin(() => w2.observe(asin), asin, "D2"))
      return out
    })(),
  ])
  const trees = measureTrees(pids)
  await Promise.all([w1.close(), w2.close()])
  return { samples: [...a, ...b], pids, rssMb: trees.rssMb, cpuSec: Math.round((trees.cpuTicks / clkTck) * 100) / 100 }
}

async function main(): Promise<void> {
  if (ASINS.length < 2) {
    console.error("Set AMAZON_SCAN_BENCH_ASINS to at least 2 ASINs. Do not run on the production API host.")
    process.exit(1)
  }
  const started = Date.now()
  const root = osTmp()
  fs.mkdirSync(root, { recursive: true })
  let samples: Sample[] = []
  let rootPids: number[] = []
  let rssMb = 0
  let cpuSec = 0
  if (LAYOUT === "A") {
    const r = await layoutA(ASINS, path.join(root, "A"))
    samples = r.samples
    rootPids = r.pids
    rssMb = r.rssMb
    cpuSec = r.cpuSec
  } else if (LAYOUT === "B") {
    const r = await layoutB(ASINS, path.join(root, "B"))
    samples = r.samples
    rootPids = r.pids
    rssMb = r.rssMb
    cpuSec = r.cpuSec
  } else if (LAYOUT === "C") {
    const r = await layoutC(ASINS)
    samples = r.samples
    rootPids = r.pids
    rssMb = r.rssMb
    cpuSec = r.cpuSec
  } else if (LAYOUT === "D") {
    const r = await layoutD(ASINS, root)
    samples = r.samples
    rootPids = r.pids
    rssMb = r.rssMb
    cpuSec = r.cpuSec
  } else {
    throw new Error(`Unknown layout ${LAYOUT}`)
  }
  const elapsed = Date.now() - started
  const times = samples.map(s => s.ms).sort((a, b) => a - b)
  const valid = samples.filter(s => s.valid).length
  const incomplete = samples.filter(s => s.kind === "done" && !s.valid).length
  const errors = samples.filter(s => s.kind !== "done").length
  const minutes = Math.max(elapsed / 60000, 1 / 60)
  console.log(JSON.stringify({
    layout: LAYOUT,
    asins: ASINS,
    n: samples.length,
    validObservations: valid,
    incompleteObservations: incomplete,
    errorOrChallenge: errors,
    validPerMinute: Math.round((valid / minutes) * 100) / 100,
    elapsedMs: elapsed,
    p50Ms: times[Math.floor(times.length * 0.5)] ?? null,
    p95Ms: times[Math.floor(times.length * 0.95)] ?? null,
    browserTreeRssMb: rssMb,
    browserTreeCpuSecApprox: cpuSec,
    browserRootPids: rootPids,
    kinds: samples.reduce((m, s) => {
      m[s.kind] = (m[s.kind] ?? 0) + 1
      return m
    }, {} as Record<string, number>),
    deadlineMs: DEADLINE_MS,
    note: "validObservations uses the public reader, not page.goto alone. Run only on the scan server.",
  }, null, 2))
  if (elapsed > DEADLINE_MS) process.exit(2)
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})
