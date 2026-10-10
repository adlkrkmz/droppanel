import type { PoolClient } from "pg"
import { query, withTransaction } from "../../db/client"
import { resolveListingAsin } from "../monitor/monitorService"
import { syncGlobalAsinConsumerForCatalog } from "../globalKeepa/globalAsinConsumerSync"
import { afterSourceAsinRelinked } from "../stockGuard/stockGuardV2LifecycleHooks"
import { keepaCheckAsin } from "../keepa/keepaDecisionService"
import { keepaConfirmedSourceDecision } from "../globalKeepa/keepaRadarCandidate"
import { applyAcceptedSourcePrice } from "../stockGuard/acceptedSourcePricePipeline"
import { enqueueFromKeepaSignal } from "../amazonVerification/amazonVerificationQueue"
import {
  PRICE_UNCERTAIN_WAITING,
  verificationEnqueueReason,
} from "../stockAlerts/stockAlertUserMessages"
import type { UpdateSourceAsinResponse } from "./listingsUpdateSourceAsinTypes"
import type { KeepaVerificationSignal } from "../amazonVerification/amazonVerificationTypes"

const ASIN_REGEX = /^[A-Z0-9]{10}$/
export const SOURCE_ASIN_UPDATE_IGNORE_REASON = "Resolved by source ASIN update"

type StoreRow = { id: number; store_code: string }

type CatalogRow = {
  id: number
  internal_sku: string
  source_url: string | null
  registry_asin: string | null
  ebay_quantity: number | null
}

export function normalizeAsinInput(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
}

export function validateNewAsin(asin: string): void {
  if (!asin) throw new Error("ASIN is required")
  if (!ASIN_REGEX.test(asin)) throw new Error("ASIN must be 10 characters (A-Z, 0-9)")
}

async function getStoreByCode(
  workspaceId: string,
  storeCode: string
): Promise<StoreRow | null> {
  const res = await query<StoreRow>(
    `SELECT id, store_code FROM stores
     WHERE workspace_id = $1::uuid AND store_code = $2 AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  return res.rows[0] ?? null
}

async function ensureAsinRegistryId(workspaceId: string, asin: string): Promise<number> {
  const ins = await query<{ id: number }>(
    `INSERT INTO asin_registry (workspace_id, asin, global_status, created_at, updated_at)
     VALUES ($1::uuid, $2, 'active', NOW(), NOW())
     ON CONFLICT (workspace_id, asin) DO NOTHING
     RETURNING id`,
    [workspaceId, asin]
  )
  if (ins.rows[0]?.id) return Number(ins.rows[0].id)

  const existing = await query<{ id: number }>(
    `SELECT id FROM asin_registry
     WHERE workspace_id = $1::uuid AND asin = $2
     LIMIT 1`,
    [workspaceId, asin]
  )
  const id = existing.rows[0]?.id
  if (!id) throw new Error(`Failed to resolve asin_registry for ${asin}`)
  return Number(id)
}

async function ignorePendingReviewsForCatalog(
  workspaceId: string,
  storeId: number,
  catalogStateId: number,
  client?: Pick<PoolClient, "query">
): Promise<number> {
  try {
    const exec = client ?? { query }
    const res = await exec.query(
      `UPDATE stock_review_items
       SET review_status = 'ignored',
           ignored_at = NOW(),
           action_error = $4::text,
           updated_at = NOW()
       WHERE workspace_id = $1::uuid
         AND store_id = $2::bigint
         AND catalog_state_id = $3::bigint
         AND review_status = 'pending'`,
      [workspaceId, storeId, catalogStateId, SOURCE_ASIN_UPDATE_IGNORE_REASON]
    )
    return res.rowCount ?? 0
  } catch {
    return 0
  }
}

async function preferredWorkspaceUserId(workspaceId: string): Promise<string | null> {
  const res = await query<{ user_id: string }>(
    `SELECT wm.user_id::text AS user_id
     FROM workspace_members wm
     WHERE wm.workspace_id = $1::uuid
     ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, wm.created_at ASC
     LIMIT 1`,
    [workspaceId]
  )
  return res.rows[0]?.user_id ?? null
}

async function setListingSourceStatus(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
  sourceStatus: string
  sourceStatusReason: string
}): Promise<void> {
  await query(
    `UPDATE store_catalog_state
     SET source_status = $1::text,
         source_status_reason = $2::text,
         source_checked_at = NOW(),
         updated_at = NOW()
     WHERE workspace_id = $3::uuid
       AND store_id = $4::bigint
       AND id = $5::bigint`,
    [
      input.sourceStatus,
      input.sourceStatusReason,
      input.workspaceId,
      input.storeId,
      input.catalogStateId,
    ]
  )
}

/**
 * After identity A→B is persisted: high-confidence Keepa → accepted pipeline;
 * PRICE_UNCERTAIN / technical Keepa errors never roll back the ASIN change.
 * Uncertain/tech → verification queue (existing worker lifecycle).
 */
async function afterAsinIdentityUpdated(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number
  newAsin: string
  globalAsinId: number
}): Promise<{ sourceStatus: string; sourcePrice: number | null }> {
  let keepa
  try {
    keepa = await keepaCheckAsin(input.newAsin, input.workspaceId)
  } catch (e) {
    console.warn(
      "[UpdateSourceAsin] Keepa check failed after identity update:",
      e instanceof Error ? e.message : e
    )
    keepa = {
      ok: true as const,
      asin: input.newAsin,
      sourceStatus: "CHECK_FAILED" as const,
      reason: e instanceof Error ? e.message : "Keepa check failed",
      price: null,
      primeOrFbaSignal: false,
      rawSignals: {
        hasPrice: false,
        hasNewPrice: false,
        hasBuyBox: false,
        hasOfferSignal: false,
        hasPrimeExclusivePrice: false,
      },
      selectedPriceSource: "NONE" as const,
      priceCandidates: {
        primeExclusiveCurrent: null,
        buyBoxCurrent: null,
        amazonCurrent: null,
        newCurrent: null,
        newFbaCurrent: null,
        listPrice: null,
        offerCurrent: null,
      },
      priceSelectionWarnings: [],
    }
  }

  const userId = await preferredWorkspaceUserId(input.workspaceId)

  if (
    keepa.sourceStatus === "AMAZON_OK" &&
    keepa.price != null &&
    Number.isFinite(keepa.price) &&
    keepa.price > 0 &&
    userId
  ) {
    try {
      await applyAcceptedSourcePrice({
        workspaceId: input.workspaceId,
        userId,
        catalogStateId: input.catalogStateId,
        asin: input.newAsin,
        confirmationSource: "KEEPA_CONFIRMED",
        logicalOperationId: `source-asin-update:${input.catalogStateId}:${input.newAsin}:${Math.round(keepa.price * 100)}`,
        decision: keepaConfirmedSourceDecision(input.newAsin, keepa.price),
      })
      return { sourceStatus: "AMAZON_OK", sourcePrice: keepa.price }
    } catch (e) {
      console.warn(
        "[UpdateSourceAsin] accepted price apply skipped:",
        e instanceof Error ? e.message : e
      )
    }
  }

  const needsVerification =
    keepa.sourceStatus === "PRICE_UNCERTAIN" ||
    keepa.sourceStatus === "CHECK_FAILED" ||
    keepa.sourceStatus === "NO_PRICE" ||
    keepa.sourceStatus === "REMOVED" ||
    keepa.sourceStatus === "UNAVAILABLE" ||
    !(keepa.sourceStatus === "AMAZON_OK" && keepa.price != null && keepa.price > 0)

  if (!needsVerification) {
    await setListingSourceStatus({
      workspaceId: input.workspaceId,
      storeId: input.storeId,
      catalogStateId: input.catalogStateId,
      sourceStatus: "AMAZON_OK",
      sourceStatusReason: "Amazon OK",
    })
    return { sourceStatus: "AMAZON_OK", sourcePrice: keepa.price }
  }

  const listingStatus =
    keepa.sourceStatus === "CHECK_FAILED" ? "CHECK_FAILED" : "PRICE_UNCERTAIN"
  const listingReason =
    keepa.sourceStatus === "CHECK_FAILED"
      ? keepa.reason?.trim() || "Keepa check failed"
      : PRICE_UNCERTAIN_WAITING

  await setListingSourceStatus({
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    catalogStateId: input.catalogStateId,
    sourceStatus: listingStatus,
    sourceStatusReason: listingReason,
  })

  if (!userId) {
    return { sourceStatus: listingStatus, sourcePrice: null }
  }

  // SOURCE_STALE / PRICE_AMBIGUOUS always create (policy). Do not use CHECK_FAILED /
  // PRODUCT_NOT_RETURNED here — those require retry exhaustion and would skip enqueue.
  const signal: KeepaVerificationSignal =
    keepa.sourceStatus === "PRICE_UNCERTAIN" || keepa.sourceStatus === "NO_PRICE"
      ? "PRICE_AMBIGUOUS"
      : "SOURCE_STALE"

  try {
    const enq = await enqueueFromKeepaSignal({
      signal,
      keepaFailureCount: 0,
      keepaOutage: false,
      globalAsinId: input.globalAsinId,
      workspaceId: input.workspaceId,
      preferredUserId: userId,
      catalogStateId: input.catalogStateId,
      asin: input.newAsin,
      amazonUrl: `https://www.amazon.com/dp/${input.newAsin}`,
    })
    if (enq.created || enq.duplicate) {
      await setListingSourceStatus({
        workspaceId: input.workspaceId,
        storeId: input.storeId,
        catalogStateId: input.catalogStateId,
        sourceStatus: "PRICE_UNCERTAIN",
        sourceStatusReason: verificationEnqueueReason(enq.status === "WAITING_FOR_WORKER"),
      })
      return { sourceStatus: "PRICE_UNCERTAIN", sourcePrice: null }
    }
  } catch (e) {
    console.warn(
      "[UpdateSourceAsin] verification enqueue skipped:",
      e instanceof Error ? e.message : e
    )
  }

  return { sourceStatus: listingStatus, sourcePrice: null }
}

export async function updateListingSourceAsin(input: {
  workspaceId: string
  storeCode: string
  catalogStateId: number
  newAsinRaw: string
}): Promise<UpdateSourceAsinResponse> {
  const storeCode = input.storeCode.trim()
  if (!storeCode) throw new Error("storeCode is required")

  const catalogStateId = Number(input.catalogStateId)
  if (!Number.isFinite(catalogStateId) || catalogStateId <= 0) {
    throw new Error("catalogStateId is required")
  }

  const newAsin = normalizeAsinInput(input.newAsinRaw)
  validateNewAsin(newAsin)

  const store = await getStoreByCode(input.workspaceId, storeCode)
  if (!store) throw new Error("Active store not found")

  const catRes = await query<CatalogRow>(
    `SELECT scs.id,
            scs.internal_sku,
            scs.source_url,
            ar.asin AS registry_asin,
            scs.ebay_quantity
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid
       AND scs.store_id = $2::bigint
       AND scs.id = $3::bigint
     LIMIT 1`,
    [input.workspaceId, store.id, catalogStateId]
  )
  const catalog = catRes.rows[0]
  if (!catalog) throw new Error("Listing not found for this store")

  const previousAsin = resolveListingAsin({
    registryAsin: catalog.registry_asin,
    sourceUrl: catalog.source_url,
    internalSku: catalog.internal_sku?.trim() ?? "",
  })

  if (previousAsin === newAsin) {
    throw new Error("New ASIN must be different from the current ASIN")
  }

  const registryId = await ensureAsinRegistryId(input.workspaceId, newAsin)
  const sourceUrl = `https://www.amazon.com/dp/${newAsin}`
  const qtyPositive = (Number(catalog.ebay_quantity ?? 0) || 0) > 0

  const { pendingAlertsIgnored, globalAsinId } = await withTransaction(async client => {
    await client.query(
      `UPDATE store_catalog_state
       SET asin_registry_id = $1::bigint,
           source_url = $2::text,
           source_status = NULL,
           source_status_reason = 'Source ASIN updated',
           source_price = NULL,
           source_checked_at = NOW(),
           source_previous_price = NULL,
           source_last_price = NULL,
           source_last_status = NULL,
           source_price_changed_at = NULL,
           source_risk_seen_count = 0,
           source_check_priority = 'normal',
           source_next_check_at = CASE WHEN $6::boolean THEN NOW() ELSE source_next_check_at END,
           last_verified_source_price = NULL,
           last_verified_at = NULL,
           last_verified_decision = NULL,
           last_verified_asin = NULL,
           updated_at = NOW()
       WHERE workspace_id = $3::uuid
         AND store_id = $4::bigint
         AND id = $5::bigint`,
      [
        registryId,
        sourceUrl,
        input.workspaceId,
        store.id,
        catalogStateId,
        qtyPositive,
      ]
    )

    const ignored = await ignorePendingReviewsForCatalog(
      input.workspaceId,
      store.id,
      catalogStateId,
      client
    )

    const gid = await syncGlobalAsinConsumerForCatalog({
      workspaceId: input.workspaceId,
      storeId: store.id,
      catalogStateId,
      asin: newAsin,
      client,
    })
    if (gid == null) {
      throw new Error("Failed to relink global ASIN consumer")
    }

    await afterSourceAsinRelinked({
      workspaceId: input.workspaceId,
      catalogStateId,
      newAsin,
      globalAsinId: gid,
      immediatelyDue: qtyPositive,
      client,
    })

    return { pendingAlertsIgnored: ignored, globalAsinId: gid }
  })

  try {
    const { emitKeepaAsinSyncForCatalog } = await import("../keepaSensor/keepaAsinSyncOutbox")
    await emitKeepaAsinSyncForCatalog({
      workspaceId: input.workspaceId,
      storeId: store.id,
      catalogStateId,
      previousAsins: [previousAsin],
    })
  } catch (e) {
    console.warn("[keepa-asin-sync] emit failed:", e instanceof Error ? e.message : e)
  }

  let sourceStatus = "UPDATED"
  let sourcePrice: number | null = null
  try {
    const post = await afterAsinIdentityUpdated({
      workspaceId: input.workspaceId,
      storeId: store.id,
      catalogStateId,
      newAsin,
      globalAsinId,
    })
    sourceStatus = post.sourceStatus
    sourcePrice = post.sourcePrice
  } catch (e) {
    console.warn(
      "[UpdateSourceAsin] post-identity Keepa/verification skipped:",
      e instanceof Error ? e.message : e
    )
  }

  console.log(
    `[UpdateSourceAsin] store=${storeCode} catalogStateId=${catalogStateId} ${previousAsin ?? "none"} -> ${newAsin} status=${sourceStatus} ignoredPending=${pendingAlertsIgnored}`
  )

  return {
    ok: true,
    catalogStateId,
    newAsin,
    previousAsin,
    sourceStatus,
    sourcePrice,
    pendingAlertsIgnored,
  }
}
