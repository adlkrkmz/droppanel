import crypto from "crypto"
import { query } from "../../db/client"
import type { KeepaApiProduct, KeepaApiResponse } from "../keepa/keepaTypes"
import {
  adaptiveKeepaSpendPlan,
  isKeepaHardBrake,
  nextFailureCheckAt,
  nextSuccessCheckAt,
  projectedTokensLeft,
} from "./globalKeepaCapacity"
import { loadGlobalKeepaFoundationConfig } from "./globalKeepaConfig"
import { classifyKeepaRadarProduct } from "./keepaRadarClassifier"
import { extractKeepaTokenFields } from "./keepaRadarParser"
import { fetchGlobalKeepaProducts } from "./globalKeepaProductClient"
import {
  claimDuePlannerAsins,
  countDuePlannerBuckets,
  markPlannerFailure,
  markPlannerSuccess,
  syncPlannerStateFromActiveConsumers,
  withPlannerTickLock,
  type ClaimedPlannerAsin,
} from "./globalKeepaPlannerState"
import { persistKeepaSnapshotCandidate, persistKeepaSnapshotFailure, persistKeepaSnapshotSuccess } from "./globalKeepaSnapshot"
import { recordTokensAndUsage, type KeepaPlatformUsageStatus } from "./keepaPlatformUsage"
import { mapKeepaProductsByAsin } from "./keepaRadarParser"
import { loadKeepaConfig } from "../keepa/keepaClient"

export type PlannerTickResult = {
  ok: boolean
  skipped?: string
  live: boolean
  claimed: number
  requested: number
  returned: number
  succeeded: number
  failed: number
  missing: number
  tokensConsumed: number | null
  tokensLeft: number | null
  refillRate: number | null
  processingTimeMs: number | null
  errorCode?: string
  errorMessage?: string
  throttleMode?: string
}

function fixtureKeepaResponse(asins: string[], refillRate = 20): KeepaApiResponse {
  const keepaNow = Math.floor(Date.now() / 60000) - 21564000
  const products: KeepaApiProduct[] = asins.map(asin => ({
    asin,
    lastUpdate: keepaNow,
    lastPriceChange: keepaNow - 10,
    stats: { current: Object.assign(Array(36).fill(-1), { 1: 2499, 34: 2, 35: 0 }) },
  }))
  return {
    products,
    tokensLeft: 400,
    refillRate,
    refillIn: 3000,
    tokensConsumed: asins.length,
    processingTimeInMs: 12,
  }
}

async function readPreviousPrice(globalAsinId: number): Promise<number | null> {
  const res = await query<{ new_price: string | null }>(
    `SELECT new_price::text AS new_price FROM global_keepa_snapshots WHERE global_asin_id = $1`,
    [globalAsinId]
  )
  const v = res.rows[0]?.new_price
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function processClaimedBatch(input: {
  claimed: ClaimedPlannerAsin[]
  live: boolean
  timeoutMs: number
  policy: ReturnType<typeof loadGlobalKeepaFoundationConfig>
}): Promise<PlannerTickResult> {
  const asins = input.claimed.map(c => c.asin)
  const domain = input.claimed[0]?.keepaDomain ?? input.policy.keepaDomain
  const requestId = crypto.randomUUID()
  const now = new Date()
  const empty: PlannerTickResult = {
    ok: true,
    live: input.live,
    claimed: input.claimed.length,
    requested: asins.length,
    returned: 0,
    succeeded: 0,
    failed: 0,
    missing: 0,
    tokensConsumed: null,
    tokensLeft: null,
    refillRate: null,
    processingTimeMs: null,
  }
  if (asins.length === 0) return empty

  const domainGroups = new Map<number, ClaimedPlannerAsin[]>()
  for (const row of input.claimed) {
    const list = domainGroups.get(row.keepaDomain) ?? []
    list.push(row)
    domainGroups.set(row.keepaDomain, list)
  }
  if (domainGroups.size > 1) {
    const merged: PlannerTickResult = { ...empty, claimed: input.claimed.length, requested: asins.length }
    for (const [, group] of domainGroups) {
      const part = await processClaimedBatch({ ...input, claimed: group })
      merged.returned += part.returned
      merged.succeeded += part.succeeded
      merged.failed += part.failed
      merged.missing += part.missing
      merged.tokensConsumed = (merged.tokensConsumed ?? 0) + (part.tokensConsumed ?? 0)
      merged.tokensLeft = part.tokensLeft
      merged.refillRate = part.refillRate
      merged.processingTimeMs = (merged.processingTimeMs ?? 0) + (part.processingTimeMs ?? 0)
      if (!part.ok) merged.ok = false
    }
    return merged
  }

  let body: KeepaApiResponse | null = null
  let usageStatus: KeepaPlatformUsageStatus = "OK"
  let keepaDurationMs: number | null = null
  if (!input.live) {
    body = fixtureKeepaResponse(asins)
  } else {
    const cfg = loadKeepaConfig()
    if (!cfg.apiKey) {
      return { ...empty, ok: false, skipped: "missingKeepaApiKey" }
    }
    const fetched = await fetchGlobalKeepaProducts({
      apiKey: cfg.apiKey,
      domain,
      asins,
      timeoutMs: input.timeoutMs,
    })
    if (!fetched.ok) {
      usageStatus =
        fetched.code === "HTTP_429"
          ? "HTTP_429"
          : fetched.code === "HTTP_5XX"
            ? "HTTP_5XX"
            : fetched.code === "TIMEOUT"
              ? "TIMEOUT"
              : fetched.code === "MALFORMED_JSON"
                ? "MALFORMED_JSON"
                : fetched.code === "NETWORK"
                  ? "NETWORK"
                  : "CHECK_FAILED"
      body = fetched.body
      await recordTokensAndUsage({
        requestId,
        requestedAsinCount: asins.length,
        returnedProductCount: fetched.body?.products?.length ?? 0,
        status: usageStatus,
        resp: fetched.body,
        durationMs: fetched.durationMs,
        errorMessage: fetched.message,
      })
      const tokens = extractKeepaTokenFields(fetched.body)
      const refillWait = fetched.code === "HTTP_429" ? tokens.refillIn : null
      for (const row of input.claimed) {
        const next = nextFailureCheckAt({
          now,
          failureCount: row.failureCount + 1,
          refillInMs: refillWait,
        })
        await persistKeepaSnapshotFailure(row.globalAsinId, "CHECK_FAILED", "FAILED")
        await markPlannerFailure({ globalAsinId: row.globalAsinId, nextCheckAt: next, code: fetched.code })
        try {
          const { syncEligibleListingsKeepaCheckFailed } = await import("./keepaListingSourceSync")
          await syncEligibleListingsKeepaCheckFailed({
            globalAsinId: row.globalAsinId,
            reasonCode: fetched.code,
          })
        } catch {
          /* listing current-state sync must not fail the tick */
        }
        const { recordKeepaAsinScanEvent } = await import("./keepaMonitorTelemetry")
        await recordKeepaAsinScanEvent({
          requestId,
          globalAsinId: row.globalAsinId,
          asin: row.asin,
          priority: row.priority,
          snapshotStatus: "CHECK_FAILED",
          decisionCode: fetched.code,
          verifyQueued: false,
          durationMs: fetched.durationMs,
          errorType: fetched.code,
          caller: "V2_PLANNER",
        })
      }
      return {
        ...empty,
        ok: false,
        failed: input.claimed.length,
        tokensConsumed: tokens.tokensConsumed,
        tokensLeft: tokens.tokensLeft,
        refillRate: tokens.refillRate,
        processingTimeMs: tokens.processingTimeInMs,
        errorCode: fetched.code,
        errorMessage: `HTTP ${fetched.status ?? "n/a"}: ${fetched.message.slice(0, 240)}`,
      }
    }
    body = fetched.body
    keepaDurationMs = fetched.durationMs
  }

  const products = mapKeepaProductsByAsin(body?.products)
  const returned = products.size
  if (returned < asins.length && returned > 0) usageStatus = "PARTIAL"
  else if (returned === 0) usageStatus = "CHECK_FAILED"

  await recordTokensAndUsage({
    requestId,
    requestedAsinCount: asins.length,
    returnedProductCount: returned,
    status: usageStatus === "CHECK_FAILED" && returned === 0 && input.live === false ? "OK" : usageStatus,
    resp: body,
    durationMs: keepaDurationMs,
  })
  const batchTokens = extractKeepaTokenFields(body)
  const tokensPerAsin =
    asins.length > 0 && batchTokens.tokensConsumed != null
      ? Math.max(0, Math.round(batchTokens.tokensConsumed / asins.length))
      : null

  let succeeded = 0
  let failed = 0
  let missing = 0
  for (const row of input.claimed) {
    const product = products.get(row.asin)
    if (!product) {
      missing++
      const classified = classifyKeepaRadarProduct({ requestedAsin: row.asin, product: null })
      await persistKeepaSnapshotFailure(row.globalAsinId, classified.status, classified.priceConfidence)
      await markPlannerFailure({
        globalAsinId: row.globalAsinId,
        nextCheckAt: nextFailureCheckAt({ now, failureCount: row.failureCount + 1 }),
        code: "PRODUCT_NOT_RETURNED",
      })
      try {
        const { enqueueVerificationForKeepaSignal } = await import(
          "../amazonVerification/amazonVerificationKeepaBridge"
        )
        await enqueueVerificationForKeepaSignal({
          signal: "PRODUCT_NOT_RETURNED",
          keepaFailureCount: row.failureCount + 1,
          globalAsinId: row.globalAsinId,
          asin: row.asin,
        })
      } catch {
        /* dispatch flag / outage circuit handles skip */
      }
      const { recordKeepaAsinScanEvent } = await import("./keepaMonitorTelemetry")
      await recordKeepaAsinScanEvent({
        requestId,
        globalAsinId: row.globalAsinId,
        asin: row.asin,
        priority: row.priority,
        snapshotStatus: classified.status,
        decisionCode: "PRODUCT_NOT_RETURNED",
        verifyQueued: true,
        errorType: "PRODUCT_NOT_RETURNED",
        caller: "V2_PLANNER",
      })
      continue
    }
    const previousPrice = await readPreviousPrice(row.globalAsinId)
    const previousFba = await query<{ new_fba_count: string | null }>(
      `SELECT new_fba_count::text AS new_fba_count FROM global_keepa_snapshots WHERE global_asin_id = $1`,
      [row.globalAsinId]
    )
    const previousFbaCount =
      previousFba.rows[0]?.new_fba_count != null ? Number(previousFba.rows[0].new_fba_count) : null
    const classified = classifyKeepaRadarProduct({
      requestedAsin: row.asin,
      product,
      previous: { newPriceUsd: previousPrice },
    })
    const fields = classified.fields
    if (!fields) {
      failed++
      await persistKeepaSnapshotFailure(row.globalAsinId, classified.status, classified.priceConfidence)
      await markPlannerFailure({
        globalAsinId: row.globalAsinId,
        nextCheckAt: nextFailureCheckAt({ now, failureCount: row.failureCount + 1 }),
        code: classified.status,
      })
      if (classified.status === "CHECK_FAILED") {
        try {
          const { syncEligibleListingsKeepaCheckFailed } = await import("./keepaListingSourceSync")
          await syncEligibleListingsKeepaCheckFailed({
            globalAsinId: row.globalAsinId,
            reasonCode: classified.status,
          })
        } catch {
          /* listing current-state sync must not fail the tick */
        }
      }
      const { recordKeepaAsinScanEvent } = await import("./keepaMonitorTelemetry")
      await recordKeepaAsinScanEvent({
        requestId,
        globalAsinId: row.globalAsinId,
        asin: row.asin,
        priority: row.priority,
        snapshotStatus: classified.status,
        decisionCode: classified.status,
        verifyQueued: false,
        tokensUsed: tokensPerAsin,
        durationMs: keepaDurationMs,
        errorType: classified.status,
        caller: "V2_PLANNER",
      })
      continue
    }
    await persistKeepaSnapshotSuccess(row.globalAsinId, {
      newPrice: fields.newPriceUsd,
      newFbaCount: fields.newFbaCount,
      newFbmCount: fields.newFbmCount,
      keepaLastUpdate: fields.lastUpdateAt,
      keepaLastPriceChange: fields.lastPriceChangeAt,
      keepaLastUpdateMinutes: fields.lastUpdateMinutes,
      keepaLastPriceChangeMinutes: fields.lastPriceChangeMinutes,
      checkedAt: now,
      status: classified.status,
      priceConfidence: classified.priceConfidence,
      previousNewPrice: previousPrice,
      previousNewFbaCount: null,
      previousNewFbmCount: null,
      previousCheckedAt: null,
    })
    try {
      const { candidateFromRadarFields } = await import("./keepaRadarCandidate")
      const cand = candidateFromRadarFields(fields)
      await persistKeepaSnapshotCandidate(row.globalAsinId, {
        amazonPrice: fields.amazonPriceUsd,
        candidatePrice: cand.candidate,
        signalClass: cand.signalClass,
      })
    } catch {
      /* candidate columns optional */
    }
    await markPlannerSuccess({
      globalAsinId: row.globalAsinId,
      checkedAt: now,
      nextCheckAt: nextSuccessCheckAt({
        lastSuccessAt: now,
        priority: row.priority,
        policy: input.policy,
      }),
    })
    let verifyQueued = false
    let decisionCode: string | null = classified.status
    try {
      const { dispatchKeepaRadarVerification } = await import(
        "../amazonVerification/amazonVerificationKeepaBridge"
      )
      const dispatched = await dispatchKeepaRadarVerification({
        globalAsinId: row.globalAsinId,
        asin: row.asin,
        fields,
        previousFbaCount: Number.isFinite(previousFbaCount as number) ? previousFbaCount : null,
        productReturned: true,
        keepaFailureCount: 0,
      })
      verifyQueued = dispatched.created > 0
      decisionCode =
        dispatched.skipped === "OK" || dispatched.created > 0
          ? dispatched.created > 0
            ? "VERIFY"
            : "STABLE"
          : dispatched.skipped
    } catch (e) {
      console.warn(
        "[GlobalKeepaPlanner] verification dispatch skipped:",
        e instanceof Error ? e.message : e
      )
    }
    try {
      const { recordKeepaAsinScanEvent } = await import("./keepaMonitorTelemetry")
      const { candidateFromRadarFields } = await import("./keepaRadarCandidate")
      const cand = candidateFromRadarFields(fields)
      await recordKeepaAsinScanEvent({
        requestId,
        globalAsinId: row.globalAsinId,
        asin: row.asin,
        priority: row.priority,
        snapshotStatus: classified.status,
        decisionCode,
        candidatePrice: cand.candidate,
        amazonPrice: fields.amazonPriceUsd,
        fbaCount: fields.newFbaCount,
        fbmCount: fields.newFbmCount,
        verifyQueued,
        tokensUsed: tokensPerAsin,
        durationMs: keepaDurationMs,
        caller: "V2_PLANNER",
      })
    } catch {
      /* observability must not fail the tick */
    }
    succeeded++
  }

  const tokens = extractKeepaTokenFields(body)
  return {
    ok: true,
    live: input.live,
    claimed: input.claimed.length,
    requested: asins.length,
    returned,
    succeeded,
    failed,
    missing,
    tokensConsumed: tokens.tokensConsumed,
    tokensLeft: tokens.tokensLeft,
    refillRate: tokens.refillRate,
    processingTimeMs: tokens.processingTimeInMs,
  }
}

export async function runGlobalKeepaPlannerTick(options?: {
  maxAsins?: number
  live?: boolean
  workerId?: string
}): Promise<PlannerTickResult> {
  const cfg = loadGlobalKeepaFoundationConfig()
  if (!cfg.plannerEnabled && options?.live !== true && options?.maxAsins == null) {
    const { notePlannerTickRuntime } = await import("./keepaMonitorTelemetry")
    notePlannerTickRuntime({ skipped: "plannerDisabled" })
    return {
      ok: true,
      skipped: "plannerDisabled",
      live: false,
      claimed: 0,
      requested: 0,
      returned: 0,
      succeeded: 0,
      failed: 0,
      missing: 0,
      tokensConsumed: null,
      tokensLeft: null,
      refillRate: null,
      processingTimeMs: null,
    }
  }

  const live = options?.live === true || (cfg.plannerEnabled && cfg.monitorEnabled)
  const workerId = options?.workerId ?? `planner-${process.pid}`
  const { notePlannerTickRuntime, recordKeepaMonitorSample } = await import("./keepaMonitorTelemetry")

  const locked = await withPlannerTickLock(async client => {
    await syncPlannerStateFromActiveConsumers()
    const tokenRow = await query<{
      tokens_left: number | null
      refill_rate: number | null
      last_api_response_at: Date | null
    }>(
      `SELECT tokens_left, refill_rate, last_api_response_at FROM keepa_platform_token_state WHERE id = 1`
    )
    const snapshotLeft = tokenRow.rows[0]?.tokens_left ?? 250
    const refillRate = tokenRow.rows[0]?.refill_rate ?? 20
    const tokensLeft = projectedTokensLeft({
      tokensLeft: snapshotLeft,
      refillRate,
      lastApiAt: tokenRow.rows[0]?.last_api_response_at ?? null,
    })
    const due = await countDuePlannerBuckets(cfg.hardMaxCheckAgeHours)
    const spendPlan = adaptiveKeepaSpendPlan({
      tokensLeft,
      refillRate,
      tokenReserve: cfg.tokenReserve,
      tokenCostPerAsin: cfg.tokenCostPerAsin,
      dueAsins: due.dueUniqueAsins,
      productBatchMax: cfg.productBatchMax,
      capacityTargetPercent: cfg.targetMaxCapacityUtilization,
      tickIntervalMs: cfg.tickIntervalMs,
    })
    const emptyTick: PlannerTickResult = {
      ok: true,
      live,
      claimed: 0,
      requested: 0,
      returned: 0,
      succeeded: 0,
      failed: 0,
      missing: 0,
      tokensConsumed: null,
      tokensLeft,
      refillRate,
      processingTimeMs: null,
      throttleMode: spendPlan.mode,
    }
    if (spendPlan.asinsThisTick <= 0 || spendPlan.maxBatches <= 0) {
      return {
        ...emptyTick,
        skipped: due.dueUniqueAsins > 0 ? "waitRefill" : "noDue",
      }
    }

    const merged: PlannerTickResult = { ...emptyTick }
    const started = Date.now()
    let liveTokens = tokensLeft
    let liveRefill = refillRate
    const maxWallMs = Math.min(45_000, Math.max(cfg.tickIntervalMs - 5_000, 20_000))
    for (let i = 0; i < spendPlan.maxBatches; i++) {
      if (Date.now() - started > maxWallMs) break
      const step = adaptiveKeepaSpendPlan({
        tokensLeft: liveTokens,
        refillRate: liveRefill,
        tokenReserve: cfg.tokenReserve,
        tokenCostPerAsin: cfg.tokenCostPerAsin,
        dueAsins: Math.max(0, due.dueUniqueAsins - merged.claimed),
        productBatchMax: cfg.productBatchMax,
        capacityTargetPercent: cfg.targetMaxCapacityUtilization,
        tickIntervalMs: cfg.tickIntervalMs,
      })
      if (step.batchSize <= 0) break
      const claimed = await claimDuePlannerAsins({
        domain: cfg.keepaDomain,
        limit: options?.maxAsins != null
          ? Math.max(0, Math.min(options.maxAsins - merged.claimed, step.batchSize))
          : step.batchSize,
        workerId,
        leaseSeconds: cfg.claimLeaseSeconds,
        hardMaxCheckAgeHours: cfg.hardMaxCheckAgeHours,
        client,
      })
      if (claimed.length === 0) break
      const part = await processClaimedBatch({ claimed, live, timeoutMs: cfg.plannerTimeoutMs, policy: cfg })
      merged.claimed += part.claimed
      merged.requested += part.requested
      merged.returned += part.returned
      merged.succeeded += part.succeeded
      merged.failed += part.failed
      merged.missing += part.missing
      merged.tokensConsumed = (merged.tokensConsumed ?? 0) + (part.tokensConsumed ?? 0)
      merged.tokensLeft = part.tokensLeft ?? liveTokens
      merged.refillRate = part.refillRate ?? liveRefill
      merged.processingTimeMs = (merged.processingTimeMs ?? 0) + (part.processingTimeMs ?? 0)
      merged.throttleMode = spendPlan.mode
      if (!part.ok) {
        merged.ok = false
        merged.errorCode = part.errorCode
        merged.errorMessage = part.errorMessage
        if (isKeepaHardBrake(part.errorCode)) break
      }
      if (options?.maxAsins != null && merged.claimed >= options.maxAsins) break
      liveTokens =
        part.tokensLeft != null && Number.isFinite(part.tokensLeft)
          ? part.tokensLeft
          : Math.max(0, liveTokens - (part.tokensConsumed ?? claimed.length))
      liveRefill = part.refillRate != null && part.refillRate > 0 ? part.refillRate : liveRefill
    }
    return merged
  })

  if (locked !== "locked" && options?.maxAsins == null) {
    const { getPlatformKeepaMonitorStatus } = await import("./globalKeepaAdminStatus")
    const { maybeEmitCapacityAlert } = await import("./keepaPlatformCapacityAlert")
    const { capacitySeverity } = await import("./globalKeepaCapacity")
    try {
      const status = await getPlatformKeepaMonitorStatus()
      const sev = status.capacitySeverity as ReturnType<typeof capacitySeverity>
      await maybeEmitCapacityAlert({
        severity: sev,
        slaStatus: String(status.slaStatus),
        utilizationPercent: (status.capacityUtilizationPercent as number | null) ?? null,
        message: `base utilization ${status.capacityUtilizationPercent ?? 0}% requirement=${status.projectedDailyRequirement} safe=${status.safeDailyCapacity} overdue=${status.overdueUniqueAsins}`,
      })
    } catch {
      /* status/alert is best-effort */
    }
  }

  if (locked === "locked") {
    notePlannerTickRuntime({ skipped: "tickLocked" })
    return {
      ok: true,
      skipped: "tickLocked",
      live,
      claimed: 0,
      requested: 0,
      returned: 0,
      succeeded: 0,
      failed: 0,
      missing: 0,
      tokensConsumed: null,
      tokensLeft: null,
      refillRate: null,
      processingTimeMs: null,
    }
  }
  notePlannerTickRuntime({ skipped: locked.skipped ?? null })
  try {
    const cfgAfter = loadGlobalKeepaFoundationConfig()
    const dueAfter = await countDuePlannerBuckets(cfgAfter.hardMaxCheckAgeHours)
    await recordKeepaMonitorSample({
      tokensLeft: locked.tokensLeft,
      backlog: dueAfter.dueUniqueAsins,
      uniqueAsinsProcessed: locked.returned,
    })
  } catch {
    /* sample is best-effort */
  }
  return locked
}

function chunkAsins<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Controlled Keepa+dispatch for an explicit ASIN list. Does not claim the rest of the due pool. */
export async function runGlobalKeepaPlannerForAsins(input: {
  asins: string[]
  live: boolean
  timeoutMs?: number
  batchSize?: number
}): Promise<PlannerTickResult> {
  const cfg = loadGlobalKeepaFoundationConfig()
  await syncPlannerStateFromActiveConsumers()
  const unique = [
    ...new Set(input.asins.map(a => a.trim().toUpperCase()).filter(a => /^[A-Z0-9]{10}$/.test(a))),
  ]
  const empty: PlannerTickResult = {
    ok: true,
    live: input.live,
    claimed: 0,
    requested: 0,
    returned: 0,
    succeeded: 0,
    failed: 0,
    missing: 0,
    tokensConsumed: null,
    tokensLeft: null,
    refillRate: null,
    processingTimeMs: null,
  }
  if (unique.length === 0) return { ...empty, skipped: "noAsins" }
  const res = await query<{
    global_asin_id: string
    keepa_domain: number
    asin: string
    priority: number | null
    failure_count: number | null
    last_success_at: Date | null
    last_checked_at: Date | null
    next_check_at: Date | null
  }>(
    `SELECT p.global_asin_id::text,
            g.keepa_domain,
            g.asin,
            p.priority,
            p.failure_count,
            p.last_success_at,
            p.last_checked_at,
            p.next_check_at
     FROM global_keepa_planner_state p
     JOIN global_amazon_asins g ON g.id = p.global_asin_id
     WHERE g.asin = ANY($1::text[])
     ORDER BY g.asin ASC`,
    [unique]
  )
  const claimed: ClaimedPlannerAsin[] = res.rows.map(r => ({
    globalAsinId: Number(r.global_asin_id),
    keepaDomain: Number(r.keepa_domain),
    asin: r.asin,
    priority: r.priority === 0 || r.priority === 1 ? r.priority : 2,
    failureCount: Math.max(0, Number(r.failure_count) || 0),
    lastSuccessAt: r.last_success_at ? new Date(r.last_success_at) : null,
    lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at) : null,
    nextCheckAt: r.next_check_at ? new Date(r.next_check_at) : null,
  }))
  if (claimed.length === 0) return { ...empty, skipped: "noPlannerRows" }
  const batchSize = Math.max(1, Math.min(20, input.batchSize ?? 10))
  const merged: PlannerTickResult = { ...empty, claimed: claimed.length }
  for (const group of chunkAsins(claimed, batchSize)) {
    const part = await processClaimedBatch({
      claimed: group,
      live: input.live,
      timeoutMs: input.timeoutMs ?? cfg.plannerTimeoutMs,
      policy: cfg,
    })
    merged.requested += part.requested
    merged.returned += part.returned
    merged.succeeded += part.succeeded
    merged.failed += part.failed
    merged.missing += part.missing
    merged.tokensConsumed = (merged.tokensConsumed ?? 0) + (part.tokensConsumed ?? 0)
    merged.tokensLeft = part.tokensLeft
    merged.refillRate = part.refillRate
    merged.processingTimeMs = (merged.processingTimeMs ?? 0) + (part.processingTimeMs ?? 0)
    if (!part.ok) {
      merged.ok = false
      merged.errorCode = part.errorCode
      merged.errorMessage = part.errorMessage
      if (isKeepaHardBrake(part.errorCode)) {
        return merged
      }
    }
  }
  return merged
}
