import { query } from "../../db/client"
import type { VerifiedSourceDecision } from "../amazonVerification/verifiedSourceDecision"
import { persistVerifiedCatalogState } from "../stockGuard/acceptedSourcePricePipeline"
import { KEEPA_TRUSTED_BASELINE_PURPOSE } from "./keepaVerifyChainPolicy"

export async function loadKeepaCandidatePurpose(candidateId: number | null): Promise<string | null> {
  if (candidateId == null || !Number.isFinite(candidateId) || candidateId <= 0) return null
  const res = await query<{ purpose: string | null; evaluation_code: string | null }>(
    `SELECT snapshot->>'purpose' AS purpose, snapshot->>'evaluationCode' AS evaluation_code
     FROM keepa_verify_candidates WHERE id = $1::bigint`,
    [candidateId]
  )
  const purpose = String(res.rows[0]?.purpose ?? "").trim().toUpperCase()
  if (purpose) return purpose
  const code = String(res.rows[0]?.evaluation_code ?? "").trim().toUpperCase()
  return code === "NO_TRUSTED_REFERENCE" ? KEEPA_TRUSTED_BASELINE_PURPOSE : null
}

export async function recordBrowserConfirmedTrustedState(input: {
  workspaceId: string
  catalogStateId: number
  userId: string
  globalAsinId: number
  asin: string
  workerId: string | null
  payload: Record<string, unknown>
  decision: VerifiedSourceDecision
  purpose: string | null
  applySourcePrice: boolean
  skipCatalogPersist?: boolean
}): Promise<void> {
  if (input.skipCatalogPersist !== true) {
    await persistVerifiedCatalogState({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
      decision: input.decision,
      applySourcePrice: input.applySourcePrice === true && input.decision.outcome === "VALID_SOURCE",
    })
  }
  const purchasableRaw = String(input.payload.purchasable ?? "").trim().toUpperCase()
  const purchasable =
    purchasableRaw === "TRUE" || purchasableRaw === "FALSE" || purchasableRaw === "UNKNOWN" ? purchasableRaw : null
  const workerId = String(input.workerId ?? "").trim() || "amazon-keepa-verify-confirm-C"
  const price =
    input.decision.acceptedPrice != null && Number.isFinite(input.decision.acceptedPrice)
      ? input.decision.acceptedPrice
      : typeof input.payload.displayedPrice === "number"
        ? input.payload.displayedPrice
        : null
  await query(
    `INSERT INTO amazon_price_verification_tasks (
       global_asin_id, workspace_id, preferred_user_id, catalog_state_id,
       asin, amazon_url, reason, priority, status, worker_id,
       completed_at, result_price, result_currency, result_condition,
       result_is_prime, result_is_fba, result_ships_from_amazon, result_purchasable,
       result_source_url, result_metadata, failure_code, failure_message,
       created_at, updated_at
     ) VALUES (
       $1::bigint, $2::uuid, $3::uuid, $4::bigint,
       $5, $6, 'KEEPA_UNRESOLVED', 2, 'COMPLETED', $7,
       NOW(), $8::numeric, 'USD', $9,
       $10::boolean, $11::boolean, $12::boolean, $13,
       $14, $15::jsonb, NULL, NULL,
       NOW(), NOW()
     )`,
    [
      input.globalAsinId,
      input.workspaceId,
      input.userId,
      input.catalogStateId,
      input.asin.trim().toUpperCase(),
      typeof input.payload.pageUrl === "string" && input.payload.pageUrl.trim()
        ? input.payload.pageUrl
        : `https://www.amazon.com/dp/${encodeURIComponent(input.asin.trim().toUpperCase())}`,
      workerId,
      price,
      typeof input.payload.condition === "string" ? input.payload.condition : null,
      typeof input.payload.isPrime === "boolean" ? input.payload.isPrime : null,
      typeof input.payload.isFba === "boolean" ? input.payload.isFba : null,
      typeof input.payload.shipsFromAmazon === "boolean" ? input.payload.shipsFromAmazon : null,
      purchasable,
      typeof input.payload.pageUrl === "string" ? input.payload.pageUrl : null,
      JSON.stringify({
        purpose: input.purpose ?? KEEPA_VERIFY_PURPOSE_FALLBACK,
        confirmationSource: "SERVER_BROWSER_PUBLIC",
        decisionOutcome: input.decision.outcome,
        decisionCode: input.decision.code,
      }),
    ]
  )
}

const KEEPA_VERIFY_PURPOSE_FALLBACK = "VERIFY"
