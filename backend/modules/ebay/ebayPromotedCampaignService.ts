import { db, query } from "../../db/client"
import { EbayMarketingApiClient } from "./ebayMarketingApiClient"
import {
  EBAY_PROMOTED_FUNDING,
  EBAY_PROMOTED_MARKETPLACE,
  EBAY_PROMOTED_STRATEGY,
} from "./ebayPromotedTypes"

function campaignLockKey(storeId: number): number {
  return 810_000_000 + (storeId % 1_000_000)
}

export type StoredPromotedCampaign = {
  id: number
  storeId: number
  marketplace: string
  campaignId: string
  campaignName: string
  status: string
}

export async function ensureStoreGeneralCpsCampaign(input: {
  workspaceId: string
  storeId: number
  storeCode: string
  client: EbayMarketingApiClient
  marketplace?: string
}): Promise<StoredPromotedCampaign> {
  const marketplace = input.marketplace ?? EBAY_PROMOTED_MARKETPLACE
  const name = `ListJetGo General - ${input.storeCode}`
  const clientPg = await db.connect()
  try {
    await clientPg.query("BEGIN")
    await clientPg.query("SELECT pg_advisory_xact_lock($1)", [campaignLockKey(input.storeId)])
    const existing = await clientPg.query<{
      id: number
      store_id: number
      marketplace: string
      campaign_id: string
      campaign_name: string
      status: string
    }>(
      `SELECT id, store_id, marketplace, campaign_id, campaign_name, status
       FROM ebay_promoted_campaigns
       WHERE workspace_id = $1::uuid AND store_id = $2 AND marketplace = $3
       LIMIT 1`,
      [input.workspaceId, input.storeId, marketplace]
    )
    const row = existing.rows[0]
    if (row?.campaign_id) {
      const live = await input.client.getCampaign(row.campaign_id)
      const ok =
        live &&
        /RUNNING|ACTIVE|PENDING/i.test(live.campaignStatus) &&
        (live.fundingModel == null || live.fundingModel === EBAY_PROMOTED_FUNDING)
      if (ok) {
        await clientPg.query(
          `UPDATE ebay_promoted_campaigns
           SET last_verified_at = NOW(), last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
           WHERE id = $1`,
          [row.id]
        )
        await clientPg.query("COMMIT")
        return {
          id: row.id,
          storeId: row.store_id,
          marketplace: row.marketplace,
          campaignId: row.campaign_id,
          campaignName: row.campaign_name,
          status: row.status,
        }
      }
    }

    const named = await input.client.findCampaignByName(name)
    const reusable =
      named &&
      String(named.campaignId || "").trim() &&
      /RUNNING|ACTIVE|PENDING/i.test(named.campaignStatus) &&
      (named.fundingModel == null || named.fundingModel === EBAY_PROMOTED_FUNDING)
        ? named
        : null
    const created = reusable ?? await input.client.createGeneralCpsCampaign({ name, marketplaceId: marketplace })
    const upsert = await clientPg.query<{
      id: number
      store_id: number
      marketplace: string
      campaign_id: string
      campaign_name: string
      status: string
    }>(
      `INSERT INTO ebay_promoted_campaigns (
         workspace_id, store_id, marketplace, campaign_id, campaign_name,
         strategy, funding_model, status, last_verified_at
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'ACTIVE', NOW())
       ON CONFLICT (workspace_id, store_id, marketplace)
       DO UPDATE SET
         campaign_id = EXCLUDED.campaign_id,
         campaign_name = EXCLUDED.campaign_name,
         strategy = EXCLUDED.strategy,
         funding_model = EXCLUDED.funding_model,
         status = 'ACTIVE',
         last_verified_at = NOW(),
         last_error_code = NULL,
         last_error_message = NULL,
         updated_at = NOW()
       RETURNING id, store_id, marketplace, campaign_id, campaign_name, status`,
      [
        input.workspaceId,
        input.storeId,
        marketplace,
        created.campaignId,
        created.campaignName,
        EBAY_PROMOTED_STRATEGY,
        EBAY_PROMOTED_FUNDING,
      ]
    )
    await clientPg.query("COMMIT")
    const saved = upsert.rows[0]
    return {
      id: saved.id,
      storeId: saved.store_id,
      marketplace: saved.marketplace,
      campaignId: saved.campaign_id,
      campaignName: saved.campaign_name,
      status: saved.status,
    }
  } catch (e) {
    await clientPg.query("ROLLBACK")
    throw e
  } finally {
    clientPg.release()
  }
}

export async function loadStorePromotedCampaign(
  workspaceId: string,
  storeId: number
): Promise<StoredPromotedCampaign | null> {
  const res = await query<{
    id: number
    store_id: number
    marketplace: string
    campaign_id: string
    campaign_name: string
    status: string
  }>(
    `SELECT id, store_id, marketplace, campaign_id, campaign_name, status
     FROM ebay_promoted_campaigns
     WHERE workspace_id = $1::uuid AND store_id = $2 AND marketplace = $3
     LIMIT 1`,
    [workspaceId, storeId, EBAY_PROMOTED_MARKETPLACE]
  )
  const r = res.rows[0]
  if (!r) return null
  return {
    id: r.id,
    storeId: r.store_id,
    marketplace: r.marketplace,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    status: r.status,
  }
}
