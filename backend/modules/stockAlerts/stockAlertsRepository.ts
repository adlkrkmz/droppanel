import { query } from "../../db/client"
import { isEligibleForStockGuardScan } from "../stockGuard/stockGuardScanEligibility"
import {
  PRICE_UNCERTAIN_QUEUED,
  PRICE_UNCERTAIN_QUEUED_LEGACY,
  PRICE_UNCERTAIN_WAITING,
  PRICE_UNCERTAIN_WAITING_LEGACY,
} from "./stockAlertUserMessages"

type StoreRow = { id: number; name: string }

export type ReviewUpsertInput = {
  workspaceId: string
  storeId:     number
  catalogStateId: number
  ebayItemId:  string | null
  internalSku: string | null
  asin:        string
  ebayTitle:   string | null
  imageUrl:    string | null
  ebayQuantity: number | null
  ebayPrice:    number | null
  sourceStatus: string
  sourceStatusReason: string | null
  sourcePrice: number | null
  oldSourcePrice?: number | null
  newSourcePrice?: number | null
  priceChangePercent?: number | null
  actionError?: string | null
  verificationSource?: string | null
  operationType?: "VERIFICATION" | "PRICE_PROTECTION" | "STOCK_PROTECTION" | null
  operationKey?: string | null
  mutationAttempted?: boolean
}

export async function getStoreByCode(
  workspaceId: string,
  storeCode:   string
): Promise<StoreRow | null> {
  const result = await query<StoreRow>(
    `SELECT id, name FROM stores
     WHERE workspace_id = $1 AND store_code = $2 AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  return result.rows[0] ?? null
}

export async function upsertPendingReviewItem(
  input: ReviewUpsertInput
): Promise<"created" | "updated" | null> {
  if (!isEligibleForStockGuardScan(input.ebayQuantity)) return null

  // A retry for the same protected target reopens the same operational record.
  // A changed target receives a new operation key and remains a separate attempt.
  // Queued verification is shown as: Extension doğrulamasına gönderildi.
  if (input.operationKey?.trim()) {
    const existing = await query(
      `UPDATE stock_review_items
       SET review_status = 'pending', ignored_at = NULL, actioned_at = NULL,
           feed_hidden_at = NULL,
           source_status = $3,
           action_error = $4::text,
           source_status_reason = $5, source_price = $6::numeric,
           old_source_price = $7::numeric, new_source_price = $8::numeric,
           verification_source = COALESCE($9::text, verification_source),
           operation_type = COALESCE($10::text, operation_type),
           mutation_attempted = false, updated_at = NOW()
       WHERE workspace_id = $1::uuid AND operation_key = $2::text
         AND review_status IN ('failed', 'pending', 'processing')
       RETURNING id`,
      [input.workspaceId, input.operationKey.trim(), input.sourceStatus,
       input.actionError ?? null, input.sourceStatusReason, input.sourcePrice ?? null,
       input.oldSourcePrice ?? null, input.newSourcePrice ?? null,
       input.verificationSource ?? null, input.operationType ?? null]
    )
    if (existing.rows[0]?.id) return "updated"
  }

  const res = await query(
    `INSERT INTO stock_review_items (
       workspace_id, store_id, catalog_state_id,
       ebay_item_id, internal_sku, asin, ebay_title, image_url, ebay_quantity, ebay_price,
       source_status, source_status_reason, source_price,
       old_source_price, new_source_price, price_change_percent,
       action_error, verification_source, operation_type, operation_key, mutation_attempted,
       detected_at, review_status, created_at, updated_at
     )
     VALUES (
       $1::uuid, $2::bigint, $3::bigint,
       $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13,
       $14, $15, $16,
       $17, $18, $19, $20, $21,
       NOW(), 'pending', NOW(), NOW()
     )
     ON CONFLICT (workspace_id, store_id, catalog_state_id, source_status)
     WHERE review_status = 'pending'
     DO UPDATE SET
       ebay_item_id = EXCLUDED.ebay_item_id,
       internal_sku = EXCLUDED.internal_sku,
       asin = EXCLUDED.asin,
       ebay_title = EXCLUDED.ebay_title,
       image_url = EXCLUDED.image_url,
       ebay_quantity = EXCLUDED.ebay_quantity,
       ebay_price = EXCLUDED.ebay_price,
       source_status_reason = CASE
         WHEN stock_review_items.source_status = 'PRICE_UNCERTAIN'
          AND EXCLUDED.source_status = 'PRICE_UNCERTAIN'
          AND stock_review_items.source_status_reason IN ($22::text, $23::text, $24::text, $25::text)
          AND NOT (EXCLUDED.source_status_reason = ANY (ARRAY[$22::text, $23::text, $24::text, $25::text]))
         THEN stock_review_items.source_status_reason
         ELSE EXCLUDED.source_status_reason
       END,
       source_price = EXCLUDED.source_price,
       old_source_price = EXCLUDED.old_source_price,
       new_source_price = EXCLUDED.new_source_price,
       price_change_percent = EXCLUDED.price_change_percent,
       verification_source = COALESCE(EXCLUDED.verification_source, stock_review_items.verification_source),
       operation_type = COALESCE(EXCLUDED.operation_type, stock_review_items.operation_type),
       operation_key = COALESCE(EXCLUDED.operation_key, stock_review_items.operation_key),
       mutation_attempted = EXCLUDED.mutation_attempted OR stock_review_items.mutation_attempted,
       feed_hidden_at = NULL,
       action_error = COALESCE(EXCLUDED.action_error, stock_review_items.action_error),
       detected_at = NOW(),
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      input.workspaceId,
      input.storeId,
      input.catalogStateId,
      input.ebayItemId,
      input.internalSku,
      input.asin,
      input.ebayTitle,
      input.imageUrl,
      input.ebayQuantity,
      input.ebayPrice,
      input.sourceStatus,
      input.sourceStatusReason,
      input.sourcePrice,
      input.oldSourcePrice ?? null,
      input.newSourcePrice ?? null,
      input.priceChangePercent ?? null,
      input.actionError ?? null,
      input.verificationSource ?? null,
      input.operationType ?? (input.sourceStatus === "PRICE_INCREASE" ? "PRICE_PROTECTION" : ["PRICE_UNCERTAIN", "CHECK_FAILED", "NO_PRICE"].includes(input.sourceStatus) ? "VERIFICATION" : "STOCK_PROTECTION"),
      input.operationKey ?? null,
      input.mutationAttempted === true,
      PRICE_UNCERTAIN_QUEUED,
      PRICE_UNCERTAIN_WAITING,
      PRICE_UNCERTAIN_QUEUED_LEGACY,
      PRICE_UNCERTAIN_WAITING_LEGACY,
    ]
  )
  const row = res.rows?.[0] as { inserted?: boolean } | undefined
  return row?.inserted ? "created" : "updated"
}
