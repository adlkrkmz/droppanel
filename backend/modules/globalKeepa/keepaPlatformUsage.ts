import { query } from "../../db/client"
import type { KeepaApiResponse } from "../keepa/keepaTypes"
import { extractKeepaTokenFields } from "./keepaRadarParser"
import { recordPlatformKeepaTokensFromResponse } from "./keepaPlatformTokenState"

export type KeepaPlatformUsageStatus =
  | "OK"
  | "PARTIAL"
  | "CHECK_FAILED"
  | "HTTP_429"
  | "HTTP_5XX"
  | "TIMEOUT"
  | "NETWORK"
  | "MALFORMED_JSON"

export async function recordKeepaPlatformUsage(input: {
  requestId: string
  requestedAsinCount: number
  returnedProductCount: number
  tokensConsumed: number | null
  tokensLeftAfter: number | null
  refillRate: number | null
  processingTimeMs: number | null
  status: KeepaPlatformUsageStatus
  caller?: string | null
  tokensBefore?: number | null
  refillIn?: number | null
  durationMs?: number | null
  errorMessage?: string | null
}): Promise<void> {
  const core = [
    input.requestId,
    input.requestedAsinCount,
    input.returnedProductCount,
    input.tokensConsumed,
    input.tokensLeftAfter,
    input.refillRate,
    input.processingTimeMs,
    input.status,
  ]
  try {
    await query(
      `INSERT INTO keepa_platform_usage (
         request_id, requested_asin_count, returned_product_count,
         tokens_consumed, tokens_left_after, refill_rate, processing_time_ms, status, created_at,
         caller, tokens_before, refill_in, duration_ms, error_message
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10,$11,$12,$13)`,
      [
        ...core,
        input.caller ?? "V2_PLANNER",
        input.tokensBefore ?? null,
        input.refillIn ?? null,
        input.durationMs ?? null,
        input.errorMessage ? input.errorMessage.slice(0, 240) : null,
      ]
    )
  } catch {
    await query(
      `INSERT INTO keepa_platform_usage (
         request_id, requested_asin_count, returned_product_count,
         tokens_consumed, tokens_left_after, refill_rate, processing_time_ms, status, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
      core
    )
  }
}

export async function rollingUsageWindow(intervalSql: string): Promise<{
  tokensConsumed: number
  asinsProcessed: number
  checks: number
  successfulChecks: number
  failedChecks: number
}> {
  const res = await query<{
    tokens: string
    asins: string
    checks: string
    ok: string
    failed: string
  }>(
    `SELECT COALESCE(SUM(tokens_consumed),0)::text AS tokens,
            COALESCE(SUM(returned_product_count),0)::text AS asins,
            COUNT(*)::text AS checks,
            SUM(CASE WHEN status IN ('OK','PARTIAL') THEN 1 ELSE 0 END)::text AS ok,
            SUM(CASE WHEN status NOT IN ('OK','PARTIAL') THEN 1 ELSE 0 END)::text AS failed
     FROM keepa_platform_usage
     WHERE created_at >= NOW() - ${intervalSql}`
  )
  const r = res.rows[0]
  return {
    tokensConsumed: parseInt(r?.tokens ?? "0", 10) || 0,
    asinsProcessed: parseInt(r?.asins ?? "0", 10) || 0,
    checks: parseInt(r?.checks ?? "0", 10) || 0,
    successfulChecks: parseInt(r?.ok ?? "0", 10) || 0,
    failedChecks: parseInt(r?.failed ?? "0", 10) || 0,
  }
}

export async function rollingUsageTotals(hours: number): Promise<{
  tokensConsumed: number
  asinsProcessed: number
  checks: number
  successfulChecks: number
  failedChecks: number
}> {
  const res = await query<{
    tokens: string
    asins: string
    checks: string
    ok: string
    failed: string
  }>(
    `SELECT COALESCE(SUM(tokens_consumed),0)::text AS tokens,
            COALESCE(SUM(returned_product_count),0)::text AS asins,
            COUNT(*)::text AS checks,
            SUM(CASE WHEN status IN ('OK','PARTIAL') THEN 1 ELSE 0 END)::text AS ok,
            SUM(CASE WHEN status NOT IN ('OK','PARTIAL') THEN 1 ELSE 0 END)::text AS failed
     FROM keepa_platform_usage
     WHERE created_at >= NOW() - make_interval(hours => $1::int)`,
    [hours]
  )
  const r = res.rows[0]
  return {
    tokensConsumed: parseInt(r?.tokens ?? "0", 10) || 0,
    asinsProcessed: parseInt(r?.asins ?? "0", 10) || 0,
    checks: parseInt(r?.checks ?? "0", 10) || 0,
    successfulChecks: parseInt(r?.ok ?? "0", 10) || 0,
    failedChecks: parseInt(r?.failed ?? "0", 10) || 0,
  }
}

export async function recordTokensAndUsage(input: {
  requestId: string
  requestedAsinCount: number
  returnedProductCount: number
  status: KeepaPlatformUsageStatus
  resp: KeepaApiResponse | null
  caller?: string | null
  tokensBefore?: number | null
  durationMs?: number | null
  errorMessage?: string | null
}): Promise<void> {
  const tokens = extractKeepaTokenFields(input.resp)
  let tokensBefore = input.tokensBefore ?? null
  if (tokensBefore == null) {
    const before = await query<{ tokens_left: number | null }>(
      `SELECT tokens_left FROM keepa_platform_token_state WHERE id = 1`
    )
    tokensBefore = before.rows[0]?.tokens_left ?? null
  }
  const h1 = await rollingUsageTotals(1)
  const h24 = await rollingUsageTotals(24)
  if (input.status === "OK" || input.status === "PARTIAL") {
    await recordPlatformKeepaTokensFromResponse(input.resp, {
      rollingTokensConsumed1h: h1.tokensConsumed + (tokens.tokensConsumed ?? 0),
      rollingTokensConsumed24h: h24.tokensConsumed + (tokens.tokensConsumed ?? 0),
    })
    try {
      const { noteSuccessfulKeepaRequest } = await import("./keepaMonitorTelemetry")
      noteSuccessfulKeepaRequest()
    } catch {
      /* runtime note is best-effort */
    }
  }
  await recordKeepaPlatformUsage({
    requestId: input.requestId,
    requestedAsinCount: input.requestedAsinCount,
    returnedProductCount: input.returnedProductCount,
    tokensConsumed: tokens.tokensConsumed,
    tokensLeftAfter: tokens.tokensLeft,
    refillRate: tokens.refillRate,
    processingTimeMs: tokens.processingTimeInMs,
    status: input.status,
    caller: input.caller ?? "V2_PLANNER",
    tokensBefore,
    refillIn: tokens.refillIn ?? null,
    durationMs: input.durationMs ?? tokens.processingTimeInMs,
    errorMessage: input.errorMessage ?? null,
  })
}
