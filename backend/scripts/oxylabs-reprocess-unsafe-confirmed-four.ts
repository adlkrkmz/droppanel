import "dotenv/config"
import assert from "node:assert/strict"
import { query } from "../db/client"
import { isAutomaticZeroDecisionSafe } from "../modules/amazonVerification/verifiedSourceDecision"
import { planVerifiedStockAction } from "../modules/stockGuard/verifiedStockActionPlan"
import { applyConfirmedNoValidSource } from "../modules/stockGuard/confirmedNoValidSourcePipeline"
import { normalizeOxylabsAmazonProduct } from "../modules/oxylabsVerify/oxylabsProductNormalize"
import { decideOxylabsSingleQuery, mapOxylabsToVerifiedDecision } from "../modules/oxylabsVerify/oxylabsProductDecision"
import { runOxylabsGuardedMutation } from "../modules/oxylabsVerify/oxylabsApplyOperations"
import { readOxylabsApplyQuantity } from "../modules/oxylabsVerify/oxylabsApplyEbayReadback"

const targets = [
  { asin: "B0HCNFYQ8H", storeId: 9, itemId: "407228992181", jobId: 12138 },
  { asin: "B0HCNFYQ8H", storeId: 5, itemId: "407228992181", jobId: 12138 },
  { asin: "B0DX25128F", storeId: 4, itemId: "366489766429", jobId: 12253 },
  { asin: "B00WQY9PHW", storeId: 1, itemId: "178390242464", jobId: 12103 },
] as const

async function killState() {
  return (await query(`SELECT consecutive_successes, reserved_slots, active FROM oxylabs_zero_stock_kill_switch WHERE singleton=TRUE`)).rows[0]
}

async function main(): Promise<void> {
  const controlledWindowStart = new Date().toISOString()
  const results: unknown[] = []
  for (const target of targets) {
    const listing = (await query<{
      catalog_state_id: string
      workspace_id: string
      user_id: string | null
      ebay_quantity: string | null
      source_price: string | null
      current_status: string | null
      previous_operation_key: string | null
      previous_status: string | null
      previous_error: string | null
    }>(
      `SELECT scs.id::text AS catalog_state_id, scs.workspace_id::text, scs.ebay_quantity::text,
              scs.source_price::text, scs.current_status::text,
              (SELECT wm.user_id::text FROM workspace_members wm WHERE wm.workspace_id=scs.workspace_id
               ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, wm.created_at LIMIT 1) AS user_id,
              op.operation_key AS previous_operation_key, op.status AS previous_status, op.last_error AS previous_error
       FROM store_catalog_state scs
       LEFT JOIN LATERAL (
         SELECT operation_key,status,last_error FROM oxylabs_apply_operations o
         WHERE o.catalog_state_id=scs.id ORDER BY o.updated_at DESC LIMIT 1
       ) op ON TRUE
       WHERE scs.store_id=$1 AND scs.ebay_item_id=$2 LIMIT 1`,
      [target.storeId, target.itemId]
    )).rows[0]
    assert(listing, `${target.asin}/store${target.storeId}: listing missing`)
    assert(listing.user_id, `${target.asin}/store${target.storeId}: owner missing`)
    assert.equal(listing.previous_status, "SKIPPED", `${target.asin}/store${target.storeId}: latest status changed`)
    assert.equal(listing.previous_error, "unsafe_confirmed_result", `${target.asin}/store${target.storeId}: latest reason changed`)
    assert.notEqual(Number(listing.ebay_quantity ?? 0), 0, `${target.asin}/store${target.storeId}: already zero`)

    const job = (await query<{ result_payload: Record<string, unknown> }>(
      `SELECT result_payload FROM amazon_scan_jobs WHERE id=$1 AND asin=$2 AND status='COMPLETED'`,
      [target.jobId, target.asin]
    )).rows[0]
    assert(job?.result_payload, `${target.asin}: retained payload missing`)
    const normalized = normalizeOxylabsAmazonProduct({ requestedAsin: target.asin, payload: job.result_payload, geoLocation: "10001" })
    const classified = decideOxylabsSingleQuery({
      n: normalized,
      panel: {
        sourceAsin: target.asin,
        sourcePrice: listing.source_price == null ? null : Number(listing.source_price),
        listingLive: listing.current_status === "live",
        qty: Number(listing.ebay_quantity ?? 0),
      },
      mutationsEnabled: true,
    })
    assert.equal(classified.productClass, "SOURCE_INVALID", `${target.asin}: product class`)
    assert.equal(classified.evidenceCode, "NO_VERIFIED_NEW_FBA_OFFER", `${target.asin}: evidence code`)
    const decision = mapOxylabsToVerifiedDecision({ n: normalized, productClass: classified.productClass, code: classified.evidenceCode })
    assert.equal(isAutomaticZeroDecisionSafe(decision), true, `${target.asin}: confirmed-result safety`)
    const plan = planVerifiedStockAction({
      decision,
      settings: { enabled: true, mode: "auto", priceAlertEnabled: true, autoProfitProtectionEnabled: true },
      currentEbayQuantity: Number(listing.ebay_quantity),
      trustedBaselinePrice: null,
      lastVerifiedDecision: null,
      verifiedActionsEnabled: true,
      currentSourceAsin: target.asin,
    })
    assert.equal(plan.action, "zero_stock", `${target.asin}: Stock Guard plan`)

    const before = await killState()
    const catalogStateId = Number(listing.catalog_state_id)
    const replayId = `approved-nonblocking-20261004:${target.jobId}:${catalogStateId}`
    const operationKey = `${listing.previous_operation_key}:${replayId}`
    const guarded = await runOxylabsGuardedMutation({
      operationKey,
      jobId: target.jobId,
      catalogStateId,
      action: "zero_stock",
      target: "qty:0",
      owner: "controlled-nonblocking-replay",
      mutate: async () => {
        const applied = await applyConfirmedNoValidSource({
          workspaceId: listing.workspace_id,
          userId: listing.user_id!,
          catalogStateId,
          asin: target.asin,
          confirmationSource: "SERVER_BROWSER_PUBLIC",
          logicalOperationId: replayId,
          decision,
        })
        return {
          ok: applied.planAction !== "zero_stock_failed",
          ebayMutated: applied.ebayMutated === true,
          error: applied.planAction,
        }
      },
      readback: async () => {
        const qty = await readOxylabsApplyQuantity(listing.workspace_id, catalogStateId)
        return { matchesTarget: qty === 0, observed: qty == null ? null : String(qty) }
      },
    })
    const afterRow = (await query(`SELECT ebay_quantity,bot_zeroed_at,bot_zeroed_reason FROM store_catalog_state WHERE id=$1`, [catalogStateId])).rows[0]
    const operation = (await query(`SELECT operation_key,status,last_error,applied_at,updated_at,ebay_mutate_count,ebay_readback_count FROM oxylabs_apply_operations WHERE operation_key=$1`, [operationKey])).rows[0]
    const after = await killState()
    results.push({ target, quantityBefore: Number(listing.ebay_quantity), classified, decision, stockGuardAction: plan.action, operation, guarded, afterRow, countBefore: before, countAfter: after })
    console.log(JSON.stringify({ progress: results[results.length - 1] }))
    assert.equal(guarded.applied, true, `${target.asin}/store${target.storeId}: mutation not applied`)
    assert.equal(Number(afterRow.ebay_quantity), 0, `${target.asin}/store${target.storeId}: catalog quantity not zero`)
  }
  console.log(JSON.stringify({ controlledWindowStart, controlledWindowEnd: new Date().toISOString(), results }, null, 2))
}

void main().then(() => process.exit(0)).catch(error => {
  console.error(error)
  process.exit(1)
})
