import { query } from "../../db/client"
import type { KeepaApiResponse } from "../keepa/keepaTypes"
import { extractKeepaTokenFields } from "./keepaRadarParser"

/**
 * Platform-global token snapshot writer. Not called from existing Stock Guard.
 * Workspace keepa_token_state is left unchanged.
 */
export async function recordPlatformKeepaTokensFromResponse(
  resp: KeepaApiResponse | null | undefined,
  extras?: { rollingTokensConsumed1h?: number | null; rollingTokensConsumed24h?: number | null }
): Promise<void> {
  const tokens = extractKeepaTokenFields(resp)
  if (
    tokens.tokensLeft == null &&
    tokens.refillRate == null &&
    tokens.tokensConsumed == null
  ) {
    return
  }
  const refillRate = tokens.refillRate != null && tokens.refillRate > 0 ? tokens.refillRate : null

  await query(
    `INSERT INTO keepa_platform_token_state (
       id, tokens_left, refill_rate, refill_in, last_tokens_consumed,
       rolling_tokens_consumed_1h, rolling_tokens_consumed_24h,
       last_api_response_at, tokens_updated_at, updated_at
     )
     VALUES (
       1, $1::integer, $2::integer, $3::integer, $4::integer,
       $5::integer, $6::integer,
       NOW(), NOW(), NOW()
     )
     ON CONFLICT (id) DO UPDATE SET
       tokens_left = COALESCE(EXCLUDED.tokens_left, keepa_platform_token_state.tokens_left),
       refill_rate = COALESCE(EXCLUDED.refill_rate, keepa_platform_token_state.refill_rate),
       refill_in = COALESCE(EXCLUDED.refill_in, keepa_platform_token_state.refill_in),
       last_tokens_consumed = COALESCE(EXCLUDED.last_tokens_consumed, keepa_platform_token_state.last_tokens_consumed),
       rolling_tokens_consumed_1h = COALESCE(EXCLUDED.rolling_tokens_consumed_1h, keepa_platform_token_state.rolling_tokens_consumed_1h),
       rolling_tokens_consumed_24h = COALESCE(EXCLUDED.rolling_tokens_consumed_24h, keepa_platform_token_state.rolling_tokens_consumed_24h),
       last_api_response_at = NOW(),
       tokens_updated_at = NOW(),
       updated_at = NOW()`,
    [
      tokens.tokensLeft,
      refillRate,
      tokens.refillIn,
      tokens.tokensConsumed,
      extras?.rollingTokensConsumed1h ?? null,
      extras?.rollingTokensConsumed24h ?? null,
    ]
  )
}
