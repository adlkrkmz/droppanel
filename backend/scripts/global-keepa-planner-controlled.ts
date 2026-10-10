/**
 * Controlled planner run. Default is fixture (no Keepa HTTP).
 * Live: GLOBAL_KEEPA_LIVE_TEST=true npm run global-keepa:planner:controlled -- --live --limit 5
 * Does not start the 10k production loop.
 */
import "dotenv/config"
import fs from "fs"
import path from "path"
import { Pool } from "pg"
import { closeDbPool } from "../db/client"
import { runGlobalKeepaPlannerTick } from "../modules/globalKeepa/globalKeepaPlannerTick"
import { countActiveGlobalAsins, syncPlannerStateFromActiveConsumers } from "../modules/globalKeepa/globalKeepaPlannerState"
import { getPlatformKeepaMonitorStatus } from "../modules/globalKeepa/globalKeepaAdminStatus"
import { theoreticalDailyCapacity, safeDailyCapacity, utilizationPercent } from "../modules/globalKeepa/globalKeepaCapacity"

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  if (i < 0) return undefined
  return process.argv[i + 1]
}

function assertLocalOrStagingDb(): void {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error("DATABASE_URL is not defined")
  const u = new URL(dbUrl)
  const host = (u.hostname || "").toLowerCase()
  const allowed =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    process.env.ALLOW_GLOBAL_KEEPA_PHASE11 === "1"
  if (!allowed) {
    throw new Error(`Refusing FAZ 2 DB writes: host=${host} is not local.`)
  }
  console.log("DB_TARGET", { host, port: u.port || "5432", database: u.pathname.replace(/^\//, "") })
}

async function applyPlannerMigrationIfNeeded(): Promise<void> {
  assertLocalOrStagingDb()
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/055_global_keepa_planner.sql"), "utf8")
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  await pool.query(sql)
  await pool.end()
  console.log("APPLIED migrations/055_global_keepa_planner.sql")
}

async function printLocalMetrics(): Promise<void> {
  const active = await countActiveGlobalAsins()
  const consumers = active.activeConsumerCount
  const unique = active.activeUniqueAsinCount
  const dedupePct = consumers > 0 ? Math.round((1 - unique / consumers) * 10000) / 100 : 0
  const theoretical = theoreticalDailyCapacity(20)
  const safe = safeDailyCapacity(20, 0.95)
  const util = utilizationPercent(unique, safe)
  console.log("LOCAL_FAZ2_METRICS", {
    activeConsumers: consumers,
    activeUniqueAsin: unique,
    dedupePercent: dedupePct,
    soldAsins: active.soldAsins,
    clickedAsins: active.clickedAsins,
    normalAsins: active.normalAsins,
    theoreticalDailyCapacity20: theoretical,
    safeDailyCapacity20: safe,
    baseRequirement: unique,
    baseUtilizationPercent: util,
  })
}

async function main(): Promise<void> {
  assertLocalOrStagingDb()
  await applyPlannerMigrationIfNeeded()
  const live = process.argv.includes("--live")
  const statusOnly = process.argv.includes("--status-only")
  const limit = parseInt(argValue("--limit") ?? "5", 10)
  if (live && process.env.GLOBAL_KEEPA_LIVE_TEST !== "true") {
    throw new Error("Refusing live Keepa: set GLOBAL_KEEPA_LIVE_TEST=true")
  }
  await syncPlannerStateFromActiveConsumers()
  await printLocalMetrics()
  if (statusOnly) {
    const status = await getPlatformKeepaMonitorStatus()
    console.log("PLATFORM_KEEPA_STATUS", status)
    return
  }
  const result = await runGlobalKeepaPlannerTick({
    maxAsins: Number.isFinite(limit) ? limit : 5,
    live,
    workerId: `controlled-${process.pid}`,
  })
  console.log("CONTROLLED_PLANNER_RESULT", result)
  if (!result.ok && !result.skipped) process.exitCode = 1
}

void main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => {
    void closeDbPool()
  })
