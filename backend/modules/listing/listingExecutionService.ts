import { PoolClient } from "pg"
import { db } from "../../db/client"
import {
  getPreparedListingPayloads,
  PreparedListingPayload
} from "./listingPreparationService"

export type ListingExecutionResultRow = {
  poolId: number
  asinRegistryId: number
  asin: string
  assignedStoreId: number
  storeCode: string
  storeName: string
  internalSku: string
  ebayItemId: string
  ebayOfferId: string
  poolStatus: "completed"
  poolListingStatus: "success"
  poolPipelineStage: "listed"
}

export type ListingExecutionResult = {
  processedCount: number
  rows: ListingExecutionResultRow[]
}

function buildFakeEbayItemId(poolId: number): string {
  return `TEST-EBAY-${poolId}`
}

function buildFakeEbayOfferId(poolId: number): string {
  return `TEST-OFFER-${poolId}`
}

async function markPoolAsListed(
  client: PoolClient,
  payload: PreparedListingPayload
) {
  const sql = `
    UPDATE asin_pool
    SET status = 'completed',
        listing_status = 'success',
        pipeline_stage = 'listed',
        updated_at = NOW()
    WHERE id = $1
    RETURNING id
  `

  await client.query(sql, [payload.poolId])
}

async function insertListingHistory(
  client: PoolClient,
  workspaceId: string,
  payload: PreparedListingPayload,
  ebayItemId: string,
  ebayOfferId: string
) {
  const sql = `
    INSERT INTO listing_history (
      workspace_id,
      store_id,
      asin_registry_id,
      internal_sku,
      ebay_item_id,
      ebay_offer_id,
      amazon_url_snapshot,
      title_snapshot,
      price_snapshot,
      status,
      listed_at,
      listing_job_ref,
      created_at,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      NULL, NULL, NULL,
      'live',
      NOW(),
      $7,
      NOW(),
      NOW()
    )
    RETURNING id
  `

  await client.query(sql, [
    workspaceId,
    payload.assignedStoreId,
    payload.asinRegistryId,
    payload.internalSku,
    ebayItemId,
    ebayOfferId,
    payload.poolId
  ])
}

async function upsertStoreCatalogState(
  client: PoolClient,
  workspaceId: string,
  payload: PreparedListingPayload,
  ebayItemId: string,
  ebayOfferId: string
) {
  const sql = `
    INSERT INTO store_catalog_state (
      workspace_id,
      store_id,
      asin_registry_id,
      internal_sku,
      ebay_item_id,
      ebay_offer_id,
      current_status,
      listed_at,
      last_seen_live_at,
      last_seen_ended_at,
      last_sync_at,
      source_of_truth,
      created_at,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      'live',
      NOW(),
      NOW(),
      NULL,
      NOW(),
      'simulation',
      NOW(),
      NOW()
    )
    ON CONFLICT (store_id, asin_registry_id)
    DO UPDATE SET
      internal_sku = EXCLUDED.internal_sku,
      ebay_item_id = EXCLUDED.ebay_item_id,
      ebay_offer_id = EXCLUDED.ebay_offer_id,
      current_status = 'live',
      listed_at = COALESCE(store_catalog_state.listed_at, EXCLUDED.listed_at),
      last_seen_live_at = NOW(),
      last_seen_ended_at = NULL,
      last_sync_at = NOW(),
      source_of_truth = 'simulation',
      updated_at = NOW()
    RETURNING id
  `

  await client.query(sql, [
    workspaceId,
    payload.assignedStoreId,
    payload.asinRegistryId,
    payload.internalSku,
    ebayItemId,
    ebayOfferId
  ])
}

export async function executePreparedListingsSimulation(
  workspaceId: string,
  limit = 100
): Promise<ListingExecutionResult> {
  const preparedRows = await getPreparedListingPayloads(workspaceId, limit)

  if (preparedRows.length === 0) {
    return {
      processedCount: 0,
      rows: []
    }
  }

  const client: PoolClient = await db.connect()

  try {
    await client.query("BEGIN")

    const results: ListingExecutionResultRow[] = []

    for (const payload of preparedRows) {
      const ebayItemId = buildFakeEbayItemId(payload.poolId)
      const ebayOfferId = buildFakeEbayOfferId(payload.poolId)

      await markPoolAsListed(client, payload)
      await insertListingHistory(client, workspaceId, payload, ebayItemId, ebayOfferId)
      await upsertStoreCatalogState(client, workspaceId, payload, ebayItemId, ebayOfferId)

      results.push({
        poolId: payload.poolId,
        asinRegistryId: payload.asinRegistryId,
        asin: payload.asin,
        assignedStoreId: payload.assignedStoreId,
        storeCode: payload.storeCode,
        storeName: payload.storeName,
        internalSku: payload.internalSku,
        ebayItemId,
        ebayOfferId,
        poolStatus: "completed",
        poolListingStatus: "success",
        poolPipelineStage: "listed"
      })
    }

    await client.query("COMMIT")

    return {
      processedCount: results.length,
      rows: results
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}