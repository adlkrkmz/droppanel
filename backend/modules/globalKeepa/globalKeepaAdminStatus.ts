import { query } from "../../db/client"
import {
  avgTokensPerAsin,
  capacitySeverity,
  projectedDailyRequirement,
  safeDailyCapacity,
  theoreticalDailyCapacity,
  utilizationPercent,
} from "./globalKeepaCapacity"
import { loadGlobalKeepaFoundationConfig } from "./globalKeepaConfig"
import { countActiveGlobalAsins } from "./globalKeepaPlannerState"
import { countDuePlannerBuckets } from "./globalKeepaPlannerState"
import { rollingUsageTotals } from "./keepaPlatformUsage"

export async function getPlatformKeepaMonitorStatus(): Promise<Record<string, unknown>> {
  const cfg = loadGlobalKeepaFoundationConfig()
  const token = await query<{
    tokens_left: number | null
    refill_rate: number | null
    refill_in: number | null
  }>(`SELECT tokens_left, refill_rate, refill_in FROM keepa_platform_token_state WHERE id = 1`)
  const refillRate = token.rows[0]?.refill_rate ?? 20
  const tokensLeft = token.rows[0]?.tokens_left ?? null
  const refillIn = token.rows[0]?.refill_in ?? null

  const active = await countActiveGlobalAsins()
  const due = await countDuePlannerBuckets(cfg.hardMaxCheckAgeHours)
  const h1 = await rollingUsageTotals(1)
  const h24 = await rollingUsageTotals(24)
  const avg = avgTokensPerAsin(h24.tokensConsumed, h24.asinsProcessed)
  const theoretical = theoreticalDailyCapacity(refillRate)
  const safe = safeDailyCapacity(refillRate, cfg.safeUtilization)
  const projected = projectedDailyRequirement(active.activeUniqueAsinCount, avg)
  const baseUtil = utilizationPercent(projected.baseChecks, safe)
  const actualUtil = utilizationPercent(h24.tokensConsumed, theoretical)
  const severity = capacitySeverity(baseUtil, projected.baseChecks, safe)
  const oldest = await query<{ hours: string | null }>(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(last_success_at))) / 3600 AS hours
     FROM global_keepa_planner_state
     WHERE last_success_at IS NOT NULL`
  )
  const ambiguous = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM global_keepa_snapshots WHERE status = 'PRICE_AMBIGUOUS'`
  )
  const slaStatus =
    due.overdueUniqueAsins > 0 && (baseUtil ?? 0) >= 95
      ? "CRITICAL"
      : due.overdueUniqueAsins > 0
        ? "WARNING"
        : severity

  const status = {
    enabled: cfg.plannerEnabled && cfg.monitorEnabled,
    plannerEnabled: cfg.plannerEnabled,
    shadowMode: cfg.shadowMode,
    refillRate,
    tokensLeft,
    refillIn,
    activeConsumerCount: active.activeConsumerCount,
    activeUniqueAsinCount: active.activeUniqueAsinCount,
    dueUniqueAsins: due.dueUniqueAsins,
    overdueUniqueAsins: due.overdueUniqueAsins,
    checksLast1h: h1.checks,
    checksLast24h: h24.checks,
    successfulChecksLast24h: h24.successfulChecks,
    failedChecksLast24h: h24.failedChecks,
    tokensConsumed1h: h1.tokensConsumed,
    tokensConsumed24h: h24.tokensConsumed,
    avgTokensPerAsin24h: avg,
    theoreticalDailyCapacity: theoretical,
    safeDailyCapacity: safe,
    projectedDailyRequirement: projected.baseChecks,
    projectedDailyTokenRequirement: projected.observedTokens,
    optionalPriorityBudget: Math.max(0, due.soldDue + due.clickedDue - due.overdueUniqueAsins),
    capacityUtilizationPercent: baseUtil,
    baseCapacityUtilization: baseUtil,
    actualTokenUtilization: actualUtil,
    oldestSuccessfulCheckAgeHours: oldest.rows[0]?.hours != null ? Number(oldest.rows[0].hours) : null,
    soldAsins: active.soldAsins,
    clickedAsins: active.clickedAsins,
    normalAsins: active.normalAsins,
    soldDue: due.soldDue,
    clickedDue: due.clickedDue,
    normalDue: due.normalDue,
    priceAmbiguousCount: parseInt(ambiguous.rows[0]?.c ?? "0", 10) || 0,
    slaStatus,
    capacitySeverity: severity,
  }

  return status
}

export async function handleGetPlatformKeepaMonitorStatus(): Promise<{
  status: number
  body: unknown
}> {
  try {
    const body = await getPlatformKeepaMonitorStatus()
    return { status: 200, body }
  } catch (e) {
    return {
      status: 500,
      body: {
        error: "KeepaMonitorStatusFailed",
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

