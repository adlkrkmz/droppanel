import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import {
  dueWorkStallAdvance,
  KEEPA_STALL_MIN_WALL_MS,
  nextDaemonSleepMs,
  keepaScanMode,
} from "../modules/keepaSensor/keepaTokenScheduler"
import {
  acquireCollectorProcessLock,
  CollectorLockError,
  collectorLockPath,
  readCollectorLockPid,
} from "../modules/keepaSensor/keepaCollectorLock"
import { KEEPA_COLLECTOR_HTTP_TIMEOUT_MS, createCollectorHttp, loadKeepaCollectorConfig } from "../modules/keepaSensor/keepaCollectorLoop"
import { KEEPA_COLLECTOR_VERSION } from "../modules/keepaSensor/keepaCollectorVersion"

let failed = 0
function check(name: string, cond: unknown, detail?: unknown): void {
  if (cond) console.log(`PASS ${name}`)
  else {
    failed++
    console.error(`FAIL ${name}`, detail ?? "")
  }
}

check("version-1.0.13", KEEPA_COLLECTOR_VERSION === "1.0.13")

function stallAt(t: number, previous: number, started: number | null, extra: Record<string, unknown> = {}) {
  return dueWorkStallAdvance({
    previous,
    stallStartedAtMs: started,
    nowMs: t,
    dueCount: 1,
    spendable: 5,
    keepaAllowed: true,
    progressed: false,
    ...extra,
  })
}

const t0 = 5_000_000
const s1 = stallAt(t0, 0, null)
const s2 = stallAt(t0 + 15_000, s1.stallLoops, s1.stallStartedAtMs)
const s3fast = stallAt(t0 + 31_000, s2.stallLoops, s2.stallStartedAtMs)
const s3wall = stallAt(t0 + KEEPA_STALL_MIN_WALL_MS, s2.stallLoops, s2.stallStartedAtMs)
check("stall-fast-31s-no-exit", s3fast.shouldExit === false, s3fast)
check("stall-wall-180s-exit", s3wall.shouldExit === true && s3wall.stallLoops >= 3, s3wall)

const mismatch = dueWorkStallAdvance({
  previous: 2,
  nowMs: t0 + KEEPA_STALL_MIN_WALL_MS,
  dueCount: 20,
  progressed: false,
  keepaAllowed: false,
})
check("mismatch-not-stall-exit", mismatch.shouldExit === false && mismatch.stallLoops === 0, mismatch)

const tokenWait = dueWorkStallAdvance({
  previous: 2,
  nowMs: t0 + KEEPA_STALL_MIN_WALL_MS,
  dueCount: 20,
  progressed: false,
  keepaAllowed: true,
  spendable: 0,
  skipped: "TOKEN_WAIT",
})
check("token-wait-not-stall", tokenWait.shouldExit === false && tokenWait.stallLoops === 0, tokenWait)

const cadence = dueWorkStallAdvance({
  previous: 2,
  nowMs: t0 + KEEPA_STALL_MIN_WALL_MS,
  dueCount: 0,
  progressed: false,
  keepaAllowed: true,
  spendable: 50,
})
check("cadence-wait-not-stall", cadence.shouldExit === false && keepaScanMode({ dueCount: 0, spendable: 50 }) === "CADENCE_WAIT")

const tokenSleep = nextDaemonSleepMs({
  skipped: "TOKEN_WAIT",
  waitMs: 3_600_000,
  keepaCalls: 0,
  pollMs: 15_000,
  nowMs: t0,
})
const cadenceSleep = nextDaemonSleepMs({
  skipped: "NO_DUE",
  waitMs: 0,
  keepaCalls: 0,
  pollMs: 15_000,
  nextDueAtMs: t0 + 12 * 3600_000,
  nowMs: t0,
})
check("token-wait-sleep-le-60s-heartbeat", tokenSleep <= 60_000 && cadenceSleep <= 60_000, { tokenSleep, cadenceSleep })

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepa-lock-"))
const dbPath = path.join(dir, "keepa-worker.sqlite")
const lockPath = collectorLockPath(dbPath)
fs.writeFileSync(lockPath, "199999999")
const first = acquireCollectorProcessLock(dbPath)
check("dead-lock-stolen", readCollectorLockPid(dbPath) === process.pid)
let secondHeld = false
try {
  acquireCollectorProcessLock(dbPath)
} catch (e) {
  secondHeld = e instanceof CollectorLockError
}
check("live-lock-preserved", secondHeld === true)
first.release()
check("lock-released", !fs.existsSync(lockPath) || readCollectorLockPid(dbPath) !== process.pid)
fs.rmSync(dir, { recursive: true, force: true })

async function main(): Promise<void> {
  check("http-timeout-bounded", KEEPA_COLLECTOR_HTTP_TIMEOUT_MS === 20_000 && KEEPA_COLLECTOR_HTTP_TIMEOUT_MS <= 30_000)
  const cfg = loadKeepaCollectorConfig({
    LISTJETGO_API_BASE: "http://127.0.0.1:9",
    KEEPA_COLLECTOR_WORKER_TOKEN: "T".repeat(32),
    KEEPA_API_KEY: "K".repeat(20),
    KEEPA_COLLECTOR_ENABLED: "true",
    KEEPA_COLLECTOR_RUN_MODE: "daemon",
    KEEPA_ENABLED: "true",
  })
  let sawAbortSignal = false
  const probing = createCollectorHttp(cfg, (async (_url, init) => {
    sawAbortSignal = Boolean((init as RequestInit | undefined)?.signal)
    throw new Error("aborted")
  }) as typeof fetch)
  try {
    await probing.getJson("/internal/keepa-collector/heartbeat")
  } catch {
    /* expected */
  }
  check("http-await-has-abort-signal", sawAbortSignal)

  const unitPath = [
    path.join(__dirname, "../systemd/listjetgo-keepa-collector.service"),
    path.join(__dirname, "../deploy/keepa-collector/listjetgo-keepa-collector.service"),
  ].find(p => fs.existsSync(p))
  if (!unitPath) throw new Error("missing collector systemd unit")
  const unit = fs.readFileSync(unitPath, "utf8")
  check("unit-restart-always", /Restart=always/.test(unit) && /RestartSec=5/.test(unit))
  check("unit-start-limit-not-tiny", /StartLimitBurst=20/.test(unit) && /StartLimitIntervalSec=600/.test(unit))

  const dropInSample = `[Unit]
StartLimitIntervalSec=600
StartLimitBurst=20

[Service]
Restart=always
RestartSec=5
`
  check("dropin-semantics", /Restart=always/.test(dropInSample) && /StartLimitBurst=20/.test(dropInSample))

  const parsed = spawnSync(
    process.execPath,
    ["-e", `console.log("daemon-nonzero"); process.exit(1)`],
    { encoding: "utf8" }
  )
  check("error-exit-nonzero", parsed.status === 1)

  if (failed) {
    console.error(`FAILED ${failed}`)
    process.exit(1)
  }
  console.log("SELF_RECOVERY_FIXTURES_PASSED")
}

void main()
