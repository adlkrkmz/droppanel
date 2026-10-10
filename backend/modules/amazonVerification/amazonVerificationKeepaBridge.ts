import { query } from "../../db/client"
import { isKeepaOutage } from "./amazonVerificationPolicy"
import { loadAmazonVerificationConfig } from "./amazonVerificationConfig"
import { enqueueFromKeepaSignal } from "./amazonVerificationQueue"
import { rollingUsageTotals } from "../globalKeepa/keepaPlatformUsage"
import {
  candidateFromRadarFields,
  keepaConfirmedNoValidSourceDecision,
  keepaConfirmedSourceDecision,
  resolveTrustedBaselinePrice,
  shouldVerifyFromKeepaRadar,
} from "../globalKeepa/keepaRadarCandidate"
import type { KeepaRadarProductFields } from "../globalKeepa/globalKeepaTypes"
import type { KeepaVerificationSignal } from "./amazonVerificationTypes"
import { emitActivityEvent } from "../activity/activityEventService"
import { syncReviewAfterVerificationEnqueue } from "../stockAlerts/stockAlertReviewLifecycle"
import { GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE } from "../globalKeepa/globalKeepaEligibility"
import { resolveListingAsin } from "../monitor/listingAsinResolve"
import { activityLogicalKey } from "../globalKeepa/sourceAsinLifecycle"
import { applyAcceptedSourcePrice } from "../stockGuard/acceptedSourcePricePipeline"
import { applyConfirmedNoValidSource } from "../stockGuard/confirmedNoValidSourcePipeline"
import { loadAmazonScanConfig } from "../amazonScan/amazonScanConfig"
import { keepaDirectMutationsEnabled } from "../keepaSensor/keepaDirectMutationGate"

async function afterEnqueueSync(input: {
  workspaceId: string
  catalogStateId: number
  asin: string
  created: boolean
  status?: string
  taskId: number | null
}): Promise<void> {
  if (input.taskId == null) return
  const taskId = input.taskId
  const waitingForWorker = input.status === "WAITING_FOR_WORKER"
  await syncReviewAfterVerificationEnqueue({
    workspaceId: input.workspaceId,
    catalogStateId: input.catalogStateId,
    asin: input.asin,
    waitingForWorker,
    emitEvent: input.created
      ? async payload => {
          await emitActivityEvent({
            workspaceId: payload.workspaceId,
            storeId: payload.storeId,
            eventType: "VERIFICATION_QUEUED",
            severity: "warning",
            title: waitingForWorker ? "Doğrulama bekliyor" : "Kaynak doğrulamasına gönderildi",
            message: payload.reason,
            catalogStateId: payload.catalogStateId,
            asin: payload.asin,
            ebayItemId: payload.ebayItemId,
            idempotencyKey: activityLogicalKey("verification_queued", taskId),
          })
        }
      : undefined,
  })
}

export async function detectKeepaPlatformOutage(): Promise<boolean> {
  const cfg = loadAmazonVerificationConfig()
  const window = await rollingUsageTotals(cfg.keepaOutageWindowMinutes)
  return isKeepaOutage({
    checks: window.checks,
    failedChecks: window.failedChecks,
    failureRateThreshold: cfg.keepaOutageFailureRate,
  })
}

export async function enqueueVerificationForKeepaSignal(input: {
  signal: KeepaVerificationSignal
  keepaFailureCount: number
  globalAsinId: number
  asin: string
}): Promise<{ created: number; skipped: string }> {
  if (loadAmazonScanConfig().keepaRoutineActionsDisabled) {
    return { created: 0, skipped: "BROWSER_OWNS_ROUTINE" }
  }
  if (!keepaDirectMutationsEnabled()) {
    return { created: 0, skipped: "KEEPA_DIRECT_MUTATION_DISABLED" }
  }
  const cfg = loadAmazonVerificationConfig()
  if (!cfg.keepaDispatchEnabled) {
    return { created: 0, skipped: "DISPATCH_DISABLED" }
  }
  const outage = await detectKeepaPlatformOutage()
  const consumers = await query<{
    workspace_id: string
    catalog_state_id: string
    user_id: string | null
  }>(
    `SELECT c.workspace_id::text AS workspace_id,
            c.catalog_state_id::text AS catalog_state_id,
            (
              SELECT wm.user_id::text
              FROM workspace_members wm
              WHERE wm.workspace_id = c.workspace_id
              ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, wm.created_at ASC
              LIMIT 1
            ) AS user_id
     FROM global_asin_consumers c
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     WHERE c.global_asin_id = $1::bigint
       AND ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE}`,
    [input.globalAsinId]
  )
  let created = 0
  let lastSkip = "NO_CONSUMERS"
  for (const row of consumers.rows) {
    if (!row.user_id) {
      lastSkip = "NO_PREFERRED_USER"
      continue
    }
    const result = await enqueueFromKeepaSignal({
      signal: input.signal,
      keepaFailureCount: input.keepaFailureCount,
      keepaOutage: outage,
      globalAsinId: input.globalAsinId,
      workspaceId: row.workspace_id,
      preferredUserId: row.user_id,
      catalogStateId: Number(row.catalog_state_id),
      asin: input.asin,
    })
    if (result.created) created++
    else lastSkip = result.code
    await afterEnqueueSync({
      workspaceId: row.workspace_id,
      catalogStateId: Number(row.catalog_state_id),
      asin: input.asin,
      created: result.created,
      status: result.status,
      taskId: result.taskId,
    })
  }
  return { created, skipped: created > 0 ? "OK" : lastSkip }
}

/** Per-listing Keepa radar → verify or apply confirmed accepted price. Stable matching price is a no-op. */
export async function dispatchKeepaRadarVerification(input: {
  globalAsinId: number
  asin: string
  fields: KeepaRadarProductFields
  previousFbaCount: number | null
  productReturned: boolean
  keepaFailureCount?: number
}): Promise<{ created: number; skipped: string }> {
  if (loadAmazonScanConfig().keepaRoutineActionsDisabled) {
    return { created: 0, skipped: "BROWSER_OWNS_ROUTINE" }
  }
  if (!keepaDirectMutationsEnabled()) {
    return { created: 0, skipped: "KEEPA_DIRECT_MUTATION_DISABLED" }
  }
  const cfg = loadAmazonVerificationConfig()
  const candidate = candidateFromRadarFields(input.fields)
  const outage = cfg.keepaDispatchEnabled ? await detectKeepaPlatformOutage() : false
  const consumers = await query<{
    workspace_id: string
    catalog_state_id: string
    user_id: string | null
    source_price: string | null
    last_verified_source_price: string | null
    last_verified_asin: string | null
    last_verified_decision: string | null
    registry_asin: string | null
    source_url: string | null
    internal_sku: string | null
  }>(
    `SELECT c.workspace_id::text AS workspace_id,
            c.catalog_state_id::text AS catalog_state_id,
            scs.source_price::text,
            scs.last_verified_source_price::text,
            scs.last_verified_asin,
            scs.last_verified_decision,
            ar.asin AS registry_asin,
            scs.source_url,
            scs.internal_sku,
            (
              SELECT wm.user_id::text
              FROM workspace_members wm
              WHERE wm.workspace_id = c.workspace_id
              ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, wm.created_at ASC
              LIMIT 1
            ) AS user_id
     FROM global_asin_consumers c
     JOIN store_catalog_state scs ON scs.id = c.catalog_state_id
     JOIN stores st ON st.id = c.store_id AND st.workspace_id = c.workspace_id
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE c.global_asin_id = $1::bigint
       AND ${GLOBAL_KEEPA_ACTIVE_CONSUMER_WHERE}`,
    [input.globalAsinId]
  )
  let created = 0
  let lastSkip = "NO_CONSUMERS"
  for (const row of consumers.rows) {
    if (!row.user_id) {
      lastSkip = "NO_PREFERRED_USER"
      continue
    }
    const currentAsin = resolveListingAsin({
      registryAsin: row.registry_asin,
      sourceUrl: row.source_url,
      internalSku: row.internal_sku?.trim() ?? "",
    })
    if (currentAsin && currentAsin !== input.asin) {
      lastSkip = "STALE_SOURCE_RESULT"
      continue
    }
    const trusted = resolveTrustedBaselinePrice({
      lastVerifiedPrice: row.last_verified_source_price != null ? Number(row.last_verified_source_price) : null,
      sourcePrice: row.source_price != null ? Number(row.source_price) : null,
      lastVerifiedAsin: row.last_verified_asin,
      currentSourceAsin: currentAsin ?? input.asin,
      lastVerifiedDecision: row.last_verified_decision,
    })
    const decision = shouldVerifyFromKeepaRadar({
      productReturned: input.productReturned,
      candidate: candidate.candidate,
      signalClass: candidate.signalClass,
      amazonPriceUsd: input.fields.amazonPriceUsd,
      newPriceUsd: input.fields.newPriceUsd,
      newFbaCount: input.fields.newFbaCount,
      newFbmCount: input.fields.newFbmCount,
      trustedBaselinePrice: trusted,
      previousFbaCount: input.previousFbaCount,
      keepaFailureCount: input.keepaFailureCount ?? 0,
    })
    if (!decision.verify) {
      if (decision.code === "CONFIRMED" && candidate.candidate != null) {
        try {
          await applyAcceptedSourcePrice({
            workspaceId: row.workspace_id,
            userId: row.user_id,
            catalogStateId: Number(row.catalog_state_id),
            asin: input.asin,
            confirmationSource: "KEEPA_CONFIRMED",
            logicalOperationId: `keepa:${row.catalog_state_id}:${Math.round(candidate.candidate * 100)}`,
            decision: keepaConfirmedSourceDecision(input.asin, candidate.candidate),
          })
        } catch (e) {
          console.warn(
            "[keepa-radar] confirmed price apply skipped:",
            e instanceof Error ? e.message : e
          )
        }
      }
      if (decision.code === "STABLE") {
        const accepted =
          candidate.candidate != null && candidate.candidate > 0 ? candidate.candidate : null
        if (accepted != null) {
          try {
            await applyAcceptedSourcePrice({
              workspaceId: row.workspace_id,
              userId: row.user_id,
              catalogStateId: Number(row.catalog_state_id),
              asin: input.asin,
              confirmationSource: "KEEPA_CONFIRMED",
              logicalOperationId: `keepa:${row.catalog_state_id}:${Math.round(accepted * 100)}`,
              decision: keepaConfirmedSourceDecision(input.asin, accepted),
            })
          } catch (e) {
            console.warn(
              "[keepa-radar] stable price apply skipped:",
              e instanceof Error ? e.message : e
            )
          }
        }
      }
      if (decision.code === "NO_VALID_SOURCE") {
        try {
          await applyConfirmedNoValidSource({
            workspaceId: row.workspace_id,
            userId: row.user_id,
            catalogStateId: Number(row.catalog_state_id),
            asin: input.asin,
            confirmationSource: "KEEPA_CONFIRMED",
            logicalOperationId: `keepa-zero:${row.catalog_state_id}:${input.asin}`,
            decision: keepaConfirmedNoValidSourceDecision(input.asin),
          })
        } catch (e) {
          console.warn(
            "[keepa-radar] confirmed no-valid-source apply skipped:",
            e instanceof Error ? e.message : e
          )
        }
      }
      lastSkip = decision.code
      continue
    }
    if (!cfg.keepaDispatchEnabled) {
      lastSkip = "DISPATCH_DISABLED"
      continue
    }
    const result = await enqueueFromKeepaSignal({
      signal: decision.signal,
      keepaFailureCount: input.keepaFailureCount ?? 0,
      keepaOutage: outage,
      globalAsinId: input.globalAsinId,
      workspaceId: row.workspace_id,
      preferredUserId: row.user_id,
      catalogStateId: Number(row.catalog_state_id),
      asin: input.asin,
    })
    if (result.created) created++
    else lastSkip = result.code
    await afterEnqueueSync({
      workspaceId: row.workspace_id,
      catalogStateId: Number(row.catalog_state_id),
      asin: input.asin,
      created: result.created,
      status: result.status,
      taskId: result.taskId,
    })
  }
  return { created, skipped: created > 0 ? "OK" : lastSkip }
}
