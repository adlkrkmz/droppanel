import { query } from "../../db/client"
import {
  PRICE_UNCERTAIN_GENERIC,
  PRICE_UNCERTAIN_QUEUED,
  PRICE_UNCERTAIN_QUEUED_LEGACY,
  PRICE_UNCERTAIN_WAITING,
  PRICE_UNCERTAIN_WAITING_LEGACY,
  VERIFIED_SOURCE_UNCHANGED_IGNORE,
  VERIFICATION_FAILED_GENERIC,
  formatVerificationFailedReason,
  verificationEnqueueReason,
  canReplacePendingReviewWithUncertain,
  PROFIT_PROTECTION_NOOP_IGNORE,
} from "./stockAlertUserMessages"

type CatalogSnapshot = {
  storeId: number
  ebayItemId: string | null
  internalSku: string | null
  asin: string
  ebayTitle: string | null
  imageUrl: string | null
  ebayQuantity: number | null
  ebayPrice: number | null
}

async function loadCatalogSnapshot(
  workspaceId: string,
  catalogStateId: number
): Promise<CatalogSnapshot | null> {
  const res = await query<{
    store_id: string
    ebay_item_id: string | null
    internal_sku: string | null
    asin: string | null
    ebay_title: string | null
    image_url: string | null
    ebay_quantity: number | null
    ebay_price: string | null
  }>(
    `SELECT scs.store_id::text,
            scs.ebay_item_id,
            scs.internal_sku,
            COALESCE(scs.last_verified_asin, ar.asin) AS asin,
            scs.ebay_title,
            scs.image_url,
            scs.ebay_quantity,
            scs.ebay_price::text
     FROM store_catalog_state scs
     LEFT JOIN asin_registry ar
       ON ar.id = scs.asin_registry_id AND ar.workspace_id = scs.workspace_id
     WHERE scs.workspace_id = $1::uuid AND scs.id = $2::bigint
     LIMIT 1`,
    [workspaceId, catalogStateId]
  )
  const row = res.rows[0]
  if (!row) return null
  const asin = row.asin?.trim().toUpperCase() ?? ""
  return {
    storeId: Number(row.store_id),
    ebayItemId: row.ebay_item_id?.trim() || null,
    internalSku: row.internal_sku?.trim() || null,
    asin,
    ebayTitle: row.ebay_title?.trim() || null,
    imageUrl: row.image_url?.trim() || null,
    ebayQuantity: row.ebay_quantity ?? null,
    ebayPrice: row.ebay_price != null && row.ebay_price.trim() !== "" ? parseFloat(row.ebay_price) : null,
  }
}

async function findActiveReview(workspaceId: string, catalogStateId: number, operationKey?: string | null): Promise<{
  id: number
  sourceStatus: string | null
} | null> {
  const res = await query<{ id: number; source_status: string | null }>(
    `SELECT id, source_status
     FROM stock_review_items
     WHERE workspace_id = $1::uuid
       AND catalog_state_id = $2::bigint
       AND review_status IN ('pending', 'processing')
       AND ($3::text IS NULL OR operation_key = $3::text OR operation_key IS NULL)
     ORDER BY CASE review_status WHEN 'processing' THEN 0 ELSE 1 END, updated_at DESC
     LIMIT 1`,
    [workspaceId, catalogStateId, operationKey ?? null]
  )
  const row = res.rows[0]
  if (!row) return null
  return { id: Number(row.id), sourceStatus: row.source_status }
}

async function findActiveReviewId(
  workspaceId: string,
  catalogStateId: number,
  operationKey?: string | null
): Promise<number | null> {
  const active = await findActiveReview(workspaceId, catalogStateId, operationKey)
  return active?.id ?? null
}

export async function updateActiveReviewReason(input: {
  workspaceId: string
  catalogStateId: number
  reason: string
  sourceStatus?: string
  sourcePrice?: number | null
  oldSourcePrice?: number | null
  newSourcePrice?: number | null
  verificationSource?: string | null
  operationType?: "VERIFICATION" | "PRICE_PROTECTION" | "STOCK_PROTECTION" | null
  operationKey?: string | null
}): Promise<boolean> {
  const id = await findActiveReviewId(input.workspaceId, input.catalogStateId, input.operationKey)
  if (id == null) return false
  const res = await query(
    `UPDATE stock_review_items
     SET source_status_reason = $3,
         source_status = COALESCE($4::text, source_status),
         source_price = COALESCE($5::numeric, source_price),
         old_source_price = COALESCE($6::numeric, old_source_price),
         new_source_price = COALESCE($7::numeric, new_source_price),
         verification_source = COALESCE($9::text, verification_source),
         operation_type = COALESCE($10::text, operation_type),
         operation_key = COALESCE($11::text, operation_key),
         updated_at = NOW()
     WHERE id = $8
       AND workspace_id = $1::uuid
       AND catalog_state_id = $2::bigint
       AND review_status IN ('pending', 'processing')`,
    [
      input.workspaceId, input.catalogStateId, input.reason,
      input.sourceStatus ?? null, input.sourcePrice ?? null,
      input.oldSourcePrice ?? null, input.newSourcePrice ?? null, id,
      input.verificationSource ?? null, input.operationType ?? null,
      input.operationKey ?? null,
    ]
  )
  return (res.rowCount ?? 0) > 0
}

export async function markActiveReviewActioned(input: {
  workspaceId: string
  catalogStateId: number
  reason: string
  ebayQuantity?: number | null
  sourceStatus?: string
  sourcePrice?: number | null
  oldSourcePrice?: number | null
  newSourcePrice?: number | null
  ebayPrice?: number | null
  verificationSource?: string | null
  operationType?: "VERIFICATION" | "PRICE_PROTECTION" | "STOCK_PROTECTION" | null
  operationKey?: string | null
}): Promise<number | null> {
  const updated = await query<{ id: number }>(
    `UPDATE stock_review_items
     SET review_status = 'actioned', actioned_at = NOW(), action_error = NULL,
         processing_job_id = NULL, source_status_reason = $3,
         ebay_quantity = COALESCE($4::int, ebay_quantity),
         source_status = COALESCE($5::text, source_status),
         source_price = COALESCE($6::numeric, source_price),
         old_source_price = COALESCE($7::numeric, old_source_price),
         new_source_price = COALESCE($8::numeric, new_source_price),
         ebay_price = COALESCE($9::numeric, ebay_price),
         verification_source = COALESCE($10::text, verification_source),
         operation_type = COALESCE($11::text, operation_type),
         operation_key = COALESCE($12::text, operation_key),
         mutation_attempted = true, feed_hidden_at = NULL, updated_at = NOW()
     WHERE workspace_id = $1::uuid AND catalog_state_id = $2::bigint
       AND (
         review_status IN ('pending', 'processing')
         OR (review_status = 'failed' AND $13::text IS NOT NULL AND operation_key = $13::text)
       )
       AND (
         $13::text IS NULL
         OR operation_key = $13::text
         OR operation_key IS NULL
         OR (operation_type = 'VERIFICATION' AND $11::text IN ('PRICE_PROTECTION', 'STOCK_PROTECTION'))
       )
     RETURNING id`,
    [
      input.workspaceId, input.catalogStateId, input.reason,
      input.ebayQuantity ?? null, input.sourceStatus ?? null,
      input.sourcePrice ?? null, input.oldSourcePrice ?? null,
      input.newSourcePrice ?? null, input.ebayPrice ?? null,
      input.verificationSource ?? null, input.operationType ?? null,
      input.operationKey ?? null, input.operationKey ?? null,
    ]
  )
  if (updated.rows[0]?.id) return Number(updated.rows[0].id)

  const recent = await query<{ id: number }>(
    `SELECT id FROM stock_review_items
     WHERE workspace_id = $1::uuid AND catalog_state_id = $2::bigint
       AND review_status = 'actioned' AND actioned_at >= NOW() - INTERVAL '24 hours'
       AND ($3::text IS NULL OR operation_key = $3::text)
     ORDER BY actioned_at DESC LIMIT 1`,
    [input.workspaceId, input.catalogStateId, input.operationKey ?? null]
  )
  if (recent.rows[0]?.id) {
    await query(
      `UPDATE stock_review_items
       SET source_status_reason = $3, ebay_quantity = COALESCE($4::int, ebay_quantity),
           source_status = COALESCE($5::text, source_status),
           source_price = COALESCE($6::numeric, source_price),
           old_source_price = COALESCE($7::numeric, old_source_price),
           new_source_price = COALESCE($8::numeric, new_source_price),
           ebay_price = COALESCE($9::numeric, ebay_price),
           verification_source = COALESCE($10::text, verification_source),
           operation_type = COALESCE($11::text, operation_type),
           operation_key = COALESCE($12::text, operation_key),
           mutation_attempted = true, feed_hidden_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2::uuid`,
      [recent.rows[0].id, input.workspaceId, input.reason,
       input.ebayQuantity ?? null, input.sourceStatus ?? null, input.sourcePrice ?? null,
       input.oldSourcePrice ?? null, input.newSourcePrice ?? null, input.ebayPrice ?? null,
       input.verificationSource ?? null, input.operationType ?? null, input.operationKey ?? null]
    )
    return Number(recent.rows[0].id)
  }

  const snap = await loadCatalogSnapshot(input.workspaceId, input.catalogStateId)
  if (!snap || !snap.asin) return null
  const inserted = await query<{ id: number }>(
    `INSERT INTO stock_review_items (
       workspace_id, store_id, catalog_state_id, ebay_item_id, internal_sku, asin,
       ebay_title, image_url, ebay_quantity, ebay_price, source_status, source_status_reason,
       source_price, verification_source, operation_type, operation_key, mutation_attempted,
       old_source_price, new_source_price, detected_at, review_status, actioned_at, created_at, updated_at
     ) VALUES ($1::uuid, $2::bigint, $3::bigint, $4, $5, $6, $7, $8, COALESCE($9::int, 0), $10,
       $11, $12, $13, $14, $15, $16, true, $17, $18, NOW(), 'actioned', NOW(), NOW(), NOW())
     RETURNING id`,
    [input.workspaceId, snap.storeId, input.catalogStateId, snap.ebayItemId, snap.internalSku,
     snap.asin, snap.ebayTitle, snap.imageUrl, input.ebayQuantity ?? snap.ebayQuantity,
     input.ebayPrice ?? snap.ebayPrice, input.sourceStatus ?? "PRICE_INCREASE", input.reason,
     input.sourcePrice ?? null, input.verificationSource ?? null, input.operationType ?? null,
     input.operationKey ?? null, input.oldSourcePrice ?? null, input.newSourcePrice ?? null]
  )
  return inserted.rows[0]?.id != null ? Number(inserted.rows[0].id) : null
}

export async function markActiveReviewIgnored(input: {
  workspaceId: string
  catalogStateId: number
  reason?: string
  sourceStatus?: string
  sourcePrice?: number | null
  oldSourcePrice?: number | null
  newSourcePrice?: number | null
  ebayPrice?: number | null
}): Promise<boolean> {
  const res = await query(
    `UPDATE stock_review_items
     SET review_status = 'ignored',
         ignored_at = NOW(),
         action_error = NULL,
         processing_job_id = NULL,
         source_status_reason = $3,
         source_status = COALESCE($4::text, source_status),
         source_price = COALESCE($5::numeric, source_price),
         old_source_price = COALESCE($6::numeric, old_source_price),
         new_source_price = COALESCE($7::numeric, new_source_price),
         ebay_price = COALESCE($8::numeric, ebay_price),
         updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND catalog_state_id = $2::bigint
       AND review_status IN ('pending', 'processing')`,
    [
      input.workspaceId,
      input.catalogStateId,
      input.reason ?? PROFIT_PROTECTION_NOOP_IGNORE,
      input.sourceStatus ?? null,
      input.sourcePrice ?? null,
      input.oldSourcePrice ?? null,
      input.newSourcePrice ?? null,
      input.ebayPrice ?? null,
    ]
  )
  return (res.rowCount ?? 0) > 0
}

export async function supersedeReviewsForGuardDisabled(input: {
  workspaceId: string
  catalogStateIds?: number[]
  ebayItemIds?: string[]
}): Promise<number> {
  const catalogStateIds = (input.catalogStateIds ?? []).filter(id => Number.isFinite(id) && id > 0)
  const ebayItemIds = (input.ebayItemIds ?? []).map(id => String(id).trim()).filter(Boolean)
  if (catalogStateIds.length === 0 && ebayItemIds.length === 0) return 0
  const res = await query(
    `UPDATE stock_review_items
     SET review_status = 'ignored',
         ignored_at = NOW(),
         action_error = 'Guard disabled',
         processing_job_id = NULL,
         source_status_reason = 'Guard disabled',
         updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND EXISTS (
         SELECT 1
         FROM store_catalog_state scs
         WHERE scs.workspace_id = stock_review_items.workspace_id
           AND scs.id = stock_review_items.catalog_state_id
           AND (
             (cardinality($2::bigint[]) > 0 AND scs.id = ANY($2::bigint[]))
             OR (cardinality($3::text[]) > 0 AND trim(scs.ebay_item_id) = ANY($3::text[]))
           )
       )
       AND review_status IN ('pending', 'processing')`,
    [input.workspaceId, catalogStateIds, ebayItemIds]
  )
  return res.rowCount ?? 0
}

export async function markFailedReviewReconciled(input: {
  workspaceId: string
  catalogStateId: number
  reason: string
  ebayQuantity?: number | null
  sourceStatus?: string
  sourcePrice?: number | null
  oldSourcePrice?: number | null
  newSourcePrice?: number | null
  ebayPrice?: number | null
  verificationSource?: string | null
  operationType?: "VERIFICATION" | "PRICE_PROTECTION" | "STOCK_PROTECTION" | null
  operationKey: string
}): Promise<number | null> {
  const updated = await query<{ id: number }>(
    `UPDATE stock_review_items
     SET review_status = 'actioned', actioned_at = NOW(), action_error = NULL,
         processing_job_id = NULL, source_status_reason = $3,
         ebay_quantity = COALESCE($4::int, ebay_quantity),
         source_status = COALESCE($5::text, source_status),
         source_price = COALESCE($6::numeric, source_price),
         old_source_price = COALESCE($7::numeric, old_source_price),
         new_source_price = COALESCE($8::numeric, new_source_price),
         ebay_price = COALESCE($9::numeric, ebay_price),
         verification_source = COALESCE($10::text, verification_source),
         operation_type = COALESCE($11::text, operation_type),
         operation_key = COALESCE($12::text, operation_key),
         mutation_attempted = true, feed_hidden_at = NULL, updated_at = NOW()
     WHERE workspace_id = $1::uuid AND catalog_state_id = $2::bigint
       AND review_status = 'failed' AND operation_key = $13::text
     RETURNING id`,
    [
      input.workspaceId, input.catalogStateId, input.reason,
      input.ebayQuantity ?? null, input.sourceStatus ?? null,
      input.sourcePrice ?? null, input.oldSourcePrice ?? null,
      input.newSourcePrice ?? null, input.ebayPrice ?? null,
      input.verificationSource ?? null, input.operationType ?? null,
      input.operationKey, input.operationKey,
    ]
  )
  return updated.rows[0]?.id != null ? Number(updated.rows[0].id) : null
}

export async function markActiveReviewFailed(input: {
  workspaceId: string
  catalogStateId: number
  reason: string
  actionError: string
  sourceStatus?: string
  sourcePrice?: number | null
  oldSourcePrice?: number | null
  newSourcePrice?: number | null
  verificationSource?: string | null
  operationType?: "VERIFICATION" | "PRICE_PROTECTION" | "STOCK_PROTECTION" | null
  operationKey?: string | null
}): Promise<boolean> {
  const res = await query(
    `UPDATE stock_review_items
     SET review_status = 'failed', action_error = $4, source_status_reason = $3,
         source_status = COALESCE($5::text, source_status),
         source_price = COALESCE($6::numeric, source_price),
         old_source_price = COALESCE($7::numeric, old_source_price),
         new_source_price = COALESCE($8::numeric, new_source_price),
         verification_source = COALESCE($9::text, verification_source),
         operation_type = COALESCE($10::text, operation_type),
         operation_key = COALESCE($11::text, operation_key), mutation_attempted = true,
         processing_job_id = NULL, updated_at = NOW()
     WHERE workspace_id = $1::uuid AND catalog_state_id = $2::bigint
       AND review_status IN ('pending', 'processing')
       AND ($12::text IS NULL OR operation_key = $12::text OR operation_key IS NULL)`,
    [input.workspaceId, input.catalogStateId, input.reason, input.actionError.slice(0, 500),
     input.sourceStatus ?? null, input.sourcePrice ?? null, input.oldSourcePrice ?? null,
     input.newSourcePrice ?? null, input.verificationSource ?? null, input.operationType ?? null,
     input.operationKey ?? null, input.operationKey ?? null]
  )
  if ((res.rowCount ?? 0) > 0) return true

  const snap = await loadCatalogSnapshot(input.workspaceId, input.catalogStateId)
  if (!snap || !snap.asin) return false
  await query(
    `INSERT INTO stock_review_items (
       workspace_id, store_id, catalog_state_id, ebay_item_id, internal_sku, asin,
       ebay_title, image_url, ebay_quantity, ebay_price, source_status, source_status_reason,
       source_price, old_source_price, new_source_price, action_error, verification_source,
       operation_type, operation_key, mutation_attempted, detected_at, review_status, created_at, updated_at
     ) VALUES ($1::uuid, $2::bigint, $3::bigint, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, true, NOW(), 'failed', NOW(), NOW())`,
    [input.workspaceId, snap.storeId, input.catalogStateId, snap.ebayItemId, snap.internalSku,
     snap.asin, snap.ebayTitle, snap.imageUrl, snap.ebayQuantity, snap.ebayPrice,
     input.sourceStatus ?? "CHECK_FAILED", input.reason, input.sourcePrice ?? null,
     input.oldSourcePrice ?? null, input.newSourcePrice ?? null, input.actionError.slice(0, 500),
     input.verificationSource ?? null, input.operationType ?? null, input.operationKey ?? null]
  )
  return true
}

export async function ignoreUncertainReviewIfUnchanged(input: {
  workspaceId: string
  catalogStateId: number
}): Promise<void> {
  await query(
    `UPDATE stock_review_items
     SET review_status = 'ignored',
         ignored_at = NOW(),
         action_error = $3,
         updated_at = NOW()
     WHERE workspace_id = $1::uuid
       AND catalog_state_id = $2::bigint
       AND review_status IN ('pending', 'processing')
       AND source_status IN ('PRICE_UNCERTAIN', 'CHECK_FAILED', 'NO_PRICE')`,
    [input.workspaceId, input.catalogStateId, VERIFIED_SOURCE_UNCHANGED_IGNORE]
  )
}

export async function syncReviewAfterVerificationEnqueue(input: {
  workspaceId: string
  catalogStateId: number
  asin: string
  waitingForWorker: boolean
  verificationSource?: "SERVER" | "DESKTOP_AGENT"
  emitEvent?: (payload: {
    workspaceId: string
    storeId: number
    catalogStateId: number
    asin: string
    ebayItemId: string | null
    reason: string
  }) => Promise<unknown>
}): Promise<{ reason: string; createdReview: boolean }> {
  if (input.verificationSource === "DESKTOP_AGENT") {
    return { reason: verificationEnqueueReason(input.waitingForWorker), createdReview: false }
  }
  const reason = verificationEnqueueReason(input.waitingForWorker)
  const active = await findActiveReview(input.workspaceId, input.catalogStateId)
  if (active && !canReplacePendingReviewWithUncertain(active.sourceStatus)) {
    const snap = await loadCatalogSnapshot(input.workspaceId, input.catalogStateId)
    if (input.emitEvent && snap) {
      await input.emitEvent({
        workspaceId: input.workspaceId,
        storeId: snap.storeId,
        catalogStateId: input.catalogStateId,
        asin: input.asin || snap.asin,
        ebayItemId: snap.ebayItemId,
        reason,
      })
    }
    return { reason, createdReview: false }
  }
  const updated = await updateActiveReviewReason({
    workspaceId: input.workspaceId,
    catalogStateId: input.catalogStateId,
    reason,
    sourceStatus: "PRICE_UNCERTAIN",
    verificationSource: input.verificationSource ?? "SERVER",
    operationType: "VERIFICATION",
    operationKey: `v2:verification:${input.catalogStateId}`,
  })
  const snap = await loadCatalogSnapshot(input.workspaceId, input.catalogStateId)
  if (!updated && snap) {
    const { upsertPendingReviewItem } = await import("./stockAlertsRepository")
    await upsertPendingReviewItem({
      workspaceId: input.workspaceId,
      storeId: snap.storeId,
      catalogStateId: input.catalogStateId,
      ebayItemId: snap.ebayItemId,
      internalSku: snap.internalSku,
      asin: input.asin || snap.asin,
      ebayTitle: snap.ebayTitle,
      imageUrl: snap.imageUrl,
      ebayQuantity: snap.ebayQuantity,
      ebayPrice: snap.ebayPrice,
      sourceStatus: "PRICE_UNCERTAIN",
      sourceStatusReason: reason,
      sourcePrice: null,
      verificationSource: input.verificationSource ?? "SERVER",
      operationType: "VERIFICATION",
      operationKey: `v2:verification:${input.catalogStateId}`,
    })
  }
  if (input.emitEvent && snap) {
    await input.emitEvent({
      workspaceId: input.workspaceId,
      storeId: snap.storeId,
      catalogStateId: input.catalogStateId,
      asin: input.asin || snap.asin,
      ebayItemId: snap.ebayItemId,
      reason,
    })
  }
  return { reason, createdReview: !updated }
}

export async function syncReviewAfterVerificationFailure(input: {
  workspaceId: string
  catalogStateId: number
  terminal: boolean
  code: string
  message: string
}): Promise<void> {
  if (!input.terminal) {
    await updateActiveReviewReason({
      workspaceId: input.workspaceId,
      catalogStateId: input.catalogStateId,
      reason: PRICE_UNCERTAIN_WAITING,
      sourceStatus: "PRICE_UNCERTAIN",
    }).catch(() => undefined)
    return
  }
  await markActiveReviewFailed({
    workspaceId: input.workspaceId,
    catalogStateId: input.catalogStateId,
    reason: formatVerificationFailedReason(input.code, input.message),
    actionError: (input.message || input.code).slice(0, 500),
    sourceStatus: "CHECK_FAILED",
    operationType: "VERIFICATION",
    operationKey: `v2:verification:${input.catalogStateId}`,
  }).catch(() => undefined)
}

const WAITING_REVIEW_REASONS = [
  PRICE_UNCERTAIN_WAITING,
  PRICE_UNCERTAIN_QUEUED,
  PRICE_UNCERTAIN_QUEUED_LEGACY,
  PRICE_UNCERTAIN_WAITING_LEGACY,
  PRICE_UNCERTAIN_GENERIC,
]

export async function reconcileVerificationWaitingReviews(workspaceId: string): Promise<void> {
  await query(
    `UPDATE stock_review_items sri
     SET source_status_reason = $2,
         updated_at = NOW()
     WHERE sri.workspace_id = $1::uuid
       AND sri.review_status IN ('pending', 'processing')
       AND sri.source_status = 'PRICE_UNCERTAIN'
       AND sri.source_status_reason IN ($3::text, $4::text)
       AND EXISTS (
         SELECT 1
         FROM amazon_price_verification_tasks t
         WHERE t.workspace_id = sri.workspace_id
           AND t.catalog_state_id = sri.catalog_state_id
           AND t.status IN ('PENDING', 'WAITING_FOR_WORKER', 'RETRYABLE')
           AND t.id = (
             SELECT t2.id
             FROM amazon_price_verification_tasks t2
             WHERE t2.workspace_id = sri.workspace_id
               AND t2.catalog_state_id = sri.catalog_state_id
             ORDER BY t2.updated_at DESC
             LIMIT 1
           )
       )`,
    [
      workspaceId,
      PRICE_UNCERTAIN_WAITING,
      PRICE_UNCERTAIN_QUEUED_LEGACY,
      PRICE_UNCERTAIN_WAITING_LEGACY,
    ]
  ).catch(() => undefined)

  await query(
    `UPDATE stock_review_items sri
     SET review_status = 'ignored',
         ignored_at = NOW(),
         action_error = $2,
         updated_at = NOW()
     FROM store_catalog_state scs
     WHERE sri.workspace_id = $1::uuid
       AND sri.catalog_state_id = scs.id
       AND sri.workspace_id = scs.workspace_id
       AND sri.review_status IN ('pending', 'processing')
       AND sri.source_status IN ('PRICE_UNCERTAIN', 'CHECK_FAILED', 'NO_PRICE')
       AND sri.source_status_reason = ANY($3::text[])
       AND sri.mutation_attempted = false
       AND EXISTS (
         SELECT 1
         FROM amazon_price_verification_tasks t
         WHERE t.workspace_id = sri.workspace_id
           AND t.catalog_state_id = sri.catalog_state_id
           AND t.status = 'COMPLETED'
           AND t.result_price IS NOT NULL
           AND scs.last_verified_source_price IS NOT NULL
           AND t.result_price = scs.last_verified_source_price
           AND t.id = (
             SELECT t2.id
             FROM amazon_price_verification_tasks t2
             WHERE t2.workspace_id = sri.workspace_id
               AND t2.catalog_state_id = sri.catalog_state_id
             ORDER BY t2.updated_at DESC
             LIMIT 1
           )
       )`,
    [workspaceId, VERIFIED_SOURCE_UNCHANGED_IGNORE, WAITING_REVIEW_REASONS]
  ).catch(() => undefined)

  const failed = await query<{ catalog_state_id: string; failure_code: string | null; failure_message: string | null }>(
    `SELECT t.catalog_state_id::text, t.failure_code, t.failure_message
     FROM amazon_price_verification_tasks t
     JOIN stock_review_items sri
       ON sri.workspace_id = t.workspace_id
      AND sri.catalog_state_id = t.catalog_state_id
      AND sri.review_status IN ('pending', 'processing')
      AND sri.source_status IN ('PRICE_UNCERTAIN', 'CHECK_FAILED', 'NO_PRICE')
     WHERE t.workspace_id = $1::uuid
       AND t.status = 'FAILED'
       AND t.id = (
         SELECT t2.id
         FROM amazon_price_verification_tasks t2
         WHERE t2.workspace_id = t.workspace_id
           AND t2.catalog_state_id = t.catalog_state_id
         ORDER BY t2.updated_at DESC
         LIMIT 1
       )
     LIMIT 20`,
    [workspaceId]
  ).catch(() => ({ rows: [] as Array<{ catalog_state_id: string; failure_code: string | null; failure_message: string | null }> }))

  for (const row of failed.rows) {
    await syncReviewAfterVerificationFailure({
      workspaceId,
      catalogStateId: Number(row.catalog_state_id),
      terminal: true,
      code: row.failure_code || "FAILED",
      message: row.failure_message || VERIFICATION_FAILED_GENERIC,
    })
  }

  const pendingApply = await query<{
    id: string
    preferred_user_id: string
    asin: string
    result_price: string | null
    result_condition: string | null
    result_is_prime: boolean | null
    result_is_fba: boolean | null
    result_ships_from_amazon: boolean | null
    result_purchasable: string | null
    result_metadata: Record<string, unknown> | null
    claimed_by_source: string | null
  }>(
    `SELECT t.id::text, t.preferred_user_id::text, t.asin,
            t.result_price::text, t.result_condition, t.result_is_prime, t.result_is_fba,
            t.result_ships_from_amazon, t.result_purchasable, t.result_metadata,
            t.claimed_by_source
     FROM amazon_price_verification_tasks t
     JOIN stock_review_items sri
       ON sri.workspace_id = t.workspace_id
      AND sri.catalog_state_id = t.catalog_state_id
      AND sri.review_status IN ('pending', 'processing')
      AND sri.source_status = 'PRICE_UNCERTAIN'
      AND sri.source_status_reason = ANY($2::text[])
     JOIN store_catalog_state scs
       ON scs.id = t.catalog_state_id AND scs.workspace_id = t.workspace_id
     WHERE t.workspace_id = $1::uuid
       AND t.status = 'COMPLETED'
       AND sri.mutation_attempted = false
       AND COALESCE(t.claimed_by_source, '') <> 'DESKTOP_AGENT'
       AND t.id = (
         SELECT t2.id
         FROM amazon_price_verification_tasks t2
         WHERE t2.workspace_id = t.workspace_id
           AND t2.catalog_state_id = t.catalog_state_id
         ORDER BY t2.updated_at DESC
         LIMIT 1
       )
     ORDER BY t.completed_at ASC
     LIMIT 8`,
    [workspaceId, WAITING_REVIEW_REASONS]
  ).catch(() => ({ rows: [] as Array<{
    id: string
    preferred_user_id: string
    asin: string
    result_price: string | null
    result_condition: string | null
    result_is_prime: boolean | null
    result_is_fba: boolean | null
    result_ships_from_amazon: boolean | null
    result_purchasable: string | null
    result_metadata: Record<string, unknown> | null
    claimed_by_source: string | null
  }> }))

  if (pendingApply.rows.length === 0) return
  const { applyVerifiedSourceResult } = await import("../stockGuard/verifiedStockActionService")
  for (const row of pendingApply.rows) {
    const meta = row.result_metadata && typeof row.result_metadata === "object" ? row.result_metadata : {}
    const confirmationSource =
      row.claimed_by_source === "SERVER_BROWSER_AUTH"
        ? "SERVER_BROWSER_AUTH"
        : row.claimed_by_source === "SERVER_BROWSER"
          ? "SERVER_BROWSER_PUBLIC"
          : "KEEPA_CONFIRMED"
    const purchasable =
      row.result_purchasable === "TRUE" || row.result_purchasable === "FALSE" || row.result_purchasable === "UNKNOWN"
        ? row.result_purchasable
        : null
    await applyVerifiedSourceResult({
      workspaceId,
      userId: row.preferred_user_id,
      taskId: Number(row.id),
      confirmationSource,
      payload: {
        requestedAsin: row.asin,
        finalAsin: typeof meta.finalAsin === "string" ? meta.finalAsin : undefined,
        displayedPrice: row.result_price != null ? Number(row.result_price) : null,
        condition: row.result_condition,
        isPrime: row.result_is_prime,
        isFba: row.result_is_fba,
        shipsFromAmazon: row.result_ships_from_amazon,
        purchasable,
        stockStatus: typeof meta.stockStatus === "string" ? meta.stockStatus : null,
        availabilityText: typeof meta.availabilityText === "string" ? meta.availabilityText : null,
        pageUnavailable: meta.pageUnavailable === true,
        redirected: meta.redirected === true,
        captcha: meta.captcha === true,
        loginRequired: meta.loginRequired === true,
        offerPageHealthy: meta.offerPageHealthy === true,
      },
    }).catch(e =>
      console.warn(
        "[stock-alerts] reconcile apply skipped:",
        e instanceof Error ? e.message : e
      )
    )
  }
}

export const verificationReasonConstants = {
  PRICE_UNCERTAIN_GENERIC,
  PRICE_UNCERTAIN_QUEUED,
  PRICE_UNCERTAIN_WAITING,
}
