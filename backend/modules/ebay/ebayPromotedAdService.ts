import { query } from "../../db/client"
import { getValidAccessToken, accountHasMarketingScope } from "../ebayOAuth/ebayOAuthService"
import { EbayMarketingApiClient } from "./ebayMarketingApiClient"
import { ensureStoreGeneralCpsCampaign } from "./ebayPromotedCampaignService"
import {
  EBAY_PROMOTED_MARKETPLACE,
  type PromotedListingStatus,
  type PromotionPublic,
  sanitizeMarketingError,
  toPromotionPublic,
} from "./ebayPromotedTypes"
import {
  parseCatalogStateId,
  raiseEbayPriceForPromotionRate,
} from "../listings/promotionPriceProtectionService"
import { adRatePercentForPricing } from "../pricing/promotionPricingContext"

const inFlight = new Set<string>()

function mutKey(storeId: number, listingId: string, op: string): string {
  return `${storeId}:${listingId}:${op}`
}

type PromoRow = {
  id: number
  catalog_state_id: number | null
  ebay_listing_id: string
  requested: boolean
  requested_rate: string | null
  effective_rate: string | null
  campaign_id: string | null
  ad_id: string | null
  status: PromotedListingStatus
  last_error_code: string | null
  last_error_message: string | null
  attempt_count?: number | string | null
}

function nRate(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function publicFromRow(row: PromoRow | null): PromotionPublic | null {
  if (!row) return null
  return toPromotionPublic({
    requested: row.requested,
    requestedRate: nRate(row.requested_rate),
    status: row.status,
    effectiveRate: nRate(row.effective_rate),
    campaignId: row.campaign_id,
    adId: row.ad_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
  })
}

async function loadPromo(
  workspaceId: string,
  storeId: number,
  listingId: string
): Promise<PromoRow | null> {
  const res = await query<PromoRow>(
    `SELECT id, catalog_state_id, ebay_listing_id, requested, requested_rate::text,
            effective_rate::text, campaign_id, ad_id, status, last_error_code, last_error_message,
            COALESCE(attempt_count, 0) AS attempt_count
     FROM ebay_listing_promotions
     WHERE workspace_id = $1::uuid AND store_id = $2 AND ebay_listing_id = $3
     LIMIT 1`,
    [workspaceId, storeId, listingId]
  )
  return res.rows[0] ?? null
}

export async function loadPromotionForCatalog(
  workspaceId: string,
  storeId: number,
  catalogStateId: number
): Promise<PromotionPublic | null> {
  const res = await query<PromoRow>(
    `SELECT id, catalog_state_id, ebay_listing_id, requested, requested_rate::text,
            effective_rate::text, campaign_id, ad_id, status, last_error_code, last_error_message,
            COALESCE(attempt_count, 0) AS attempt_count
     FROM ebay_listing_promotions
     WHERE workspace_id = $1::uuid AND store_id = $2 AND catalog_state_id = $3
     LIMIT 1`,
    [workspaceId, storeId, catalogStateId]
  )
  return publicFromRow(res.rows[0] ?? null)
}

async function upsertPromo(input: {
  workspaceId: string
  storeId: number
  catalogStateId: number | null
  listingId: string
  requested: boolean
  requestedRate: number | null
  effectiveRate: number | null
  campaignId: string | null
  adId: string | null
  status: PromotedListingStatus
  code: string | null
  message: string | null
}): Promise<PromoRow> {
  const res = await query<PromoRow>(
    `INSERT INTO ebay_listing_promotions (
       workspace_id, store_id, catalog_state_id, ebay_listing_id,
       requested, requested_rate, effective_rate, campaign_id, ad_id,
       status, last_error_code, last_error_message, last_verified_at
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       CASE WHEN $10 IN ('ACTIVE','OFF') THEN NOW() ELSE NULL END
     )
     ON CONFLICT (store_id, ebay_listing_id) DO UPDATE SET
       catalog_state_id = COALESCE(EXCLUDED.catalog_state_id, ebay_listing_promotions.catalog_state_id),
       requested = EXCLUDED.requested,
       requested_rate = EXCLUDED.requested_rate,
       effective_rate = EXCLUDED.effective_rate,
       campaign_id = EXCLUDED.campaign_id,
       ad_id = EXCLUDED.ad_id,
       status = EXCLUDED.status,
       last_error_code = EXCLUDED.last_error_code,
       last_error_message = EXCLUDED.last_error_message,
       last_verified_at = CASE
         WHEN EXCLUDED.status IN ('ACTIVE','OFF') THEN NOW()
         ELSE ebay_listing_promotions.last_verified_at
       END,
       updated_at = NOW()
     RETURNING id, catalog_state_id, ebay_listing_id, requested, requested_rate::text,
               effective_rate::text, campaign_id, ad_id, status, last_error_code, last_error_message,
               COALESCE(attempt_count, 0) AS attempt_count`,
    [
      input.workspaceId,
      input.storeId,
      input.catalogStateId,
      input.listingId,
      input.requested,
      input.requestedRate,
      input.effectiveRate,
      input.campaignId,
      input.adId,
      input.status,
      input.code,
      input.message,
    ]
  )
  return res.rows[0]
}

async function marketingClient(workspaceId: string, storeCode: string): Promise<{
  client: EbayMarketingApiClient
  simulation: boolean
}> {
  const simulation = (process.env.EBAY_SIMULATION ?? "true") !== "false"
  const sandbox = (process.env.EBAY_SANDBOX ?? "true") !== "false"
  const token = await getValidAccessToken(workspaceId, storeCode, simulation)
  return {
    client: new EbayMarketingApiClient({ oauthToken: token, sandbox, simulationMode: simulation }),
    simulation,
  }
}

async function requireMarketingScope(workspaceId: string, storeId: number): Promise<void> {
  const res = await query<{ scope: string | null }>(
    `SELECT scope FROM ebay_accounts WHERE workspace_id = $1::uuid AND store_id = $2 LIMIT 1`,
    [workspaceId, storeId]
  )
  if (!accountHasMarketingScope(res.rows[0]?.scope)) {
    const err = new Error("Bu mağazada reklam yetkisi yok. eBay bağlantısını yenileyin.") as Error & {
      code?: string
      retryable?: boolean
    }
    err.code = "MARKETING_SCOPE_REQUIRED"
    err.retryable = false
    throw err
  }
}

async function withMutation<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) {
    const err = new Error("Reklam işlemi zaten çalışıyor") as Error & { code?: string }
    err.code = "PROMO_IN_FLIGHT"
    throw err
  }
  inFlight.add(key)
  try {
    return await fn()
  } finally {
    inFlight.delete(key)
  }
}

async function readbackAd(
  client: EbayMarketingApiClient,
  campaignId: string | null,
  listingId: string
): Promise<{ campaignId: string; adId: string; rate: number | null } | null> {
  const found = await client.findCampaignByListingId(listingId)
  const camp = found?.campaignId || campaignId
  if (!camp) return null
  const ad = await client.getAdByListingId(camp, listingId)
  if (ad?.adId) {
    return { campaignId: camp, adId: ad.adId, rate: ad.bidPercentage }
  }
  if (found?.adId) return { campaignId: camp, adId: found.adId, rate: null }
  return null
}

const VISIBILITY_RETRY_DELAYS_MS = [30_000, 120_000, 300_000]
const MAX_PROMOTION_ATTEMPTS = 3

function isVisibilityDelayCode(code: string | null | undefined): boolean {
  return code === "NEW_LISTING_MARKETING_VISIBILITY_DELAY"
}

async function markPromotionAttempt(input: {
  workspaceId: string
  storeId: number
  listingId: string
}): Promise<number> {
  const res = await query<{ attempt_count: number }>(
    `UPDATE ebay_listing_promotions
     SET attempt_count = COALESCE(attempt_count, 0) + 1,
         last_attempt_at = NOW(),
         updated_at = NOW()
     WHERE workspace_id = $1::uuid AND store_id = $2 AND ebay_listing_id = $3
     RETURNING attempt_count`,
    [input.workspaceId, input.storeId, input.listingId]
  )
  return Number(res.rows[0]?.attempt_count ?? 1)
}

async function scheduleVisibilityRetry(input: {
  workspaceId: string
  storeId: number
  listingId: string
  attemptCount: number
}): Promise<void> {
  if (input.attemptCount >= MAX_PROMOTION_ATTEMPTS) {
    await query(
      `UPDATE ebay_listing_promotions
       SET next_attempt_at = NULL, updated_at = NOW()
       WHERE workspace_id = $1::uuid AND store_id = $2 AND ebay_listing_id = $3`,
      [input.workspaceId, input.storeId, input.listingId]
    )
    return
  }
  const delayMs = VISIBILITY_RETRY_DELAYS_MS[Math.max(0, input.attemptCount - 1)] ?? VISIBILITY_RETRY_DELAYS_MS[2]
  await query(
    `UPDATE ebay_listing_promotions
     SET next_attempt_at = NOW() + ($4::int * INTERVAL '1 millisecond'),
         updated_at = NOW()
     WHERE workspace_id = $1::uuid AND store_id = $2 AND ebay_listing_id = $3`,
    [input.workspaceId, input.storeId, input.listingId, delayMs]
  )
  try {
    const { wakeScheduledPublishLiveRunner } = await import(
      "../scheduledPublish/scheduledPublishLiveAutoRunnerService"
    )
    wakeScheduledPublishLiveRunner(delayMs)
  } catch {
    /* runner may not be started in scripts */
  }
}

async function clearPromotionRetry(input: {
  workspaceId: string
  storeId: number
  listingId: string
}): Promise<void> {
  await query(
    `UPDATE ebay_listing_promotions
     SET next_attempt_at = NULL, updated_at = NOW()
     WHERE workspace_id = $1::uuid AND store_id = $2 AND ebay_listing_id = $3`,
    [input.workspaceId, input.storeId, input.listingId]
  )
}

export async function applyListingPromotion(input: {
  workspaceId: string
  storeId: number
  storeCode: string
  catalogStateId: number | null
  listingId: string
  enabled: boolean
  rate: number | null
  skipPriceProtection?: boolean
}): Promise<PromotionPublic> {
  const listingId = input.listingId.trim()
  if (!listingId) {
    return toPromotionPublic({
      requested: false,
      requestedRate: null,
      status: "FAILED",
      effectiveRate: null,
      campaignId: null,
      adId: null,
      lastErrorCode: "MISSING_LISTING_ID",
    })
  }
  const catalogStateId = parseCatalogStateId(input.catalogStateId)
  return withMutation(mutKey(input.storeId, listingId, "apply"), async () => {
    if (!input.enabled) {
      return turnOffListingPromotion({ ...input, catalogStateId })
    }
    const rate = input.rate
    if (rate == null) {
      const row = await upsertPromo({
        workspaceId: input.workspaceId,
        storeId: input.storeId,
        catalogStateId,
        listingId,
        requested: true,
        requestedRate: null,
        effectiveRate: null,
        campaignId: null,
        adId: null,
        status: "FAILED",
        code: "INVALID_AD_RATE",
        message: "Reklam oranı 2 ile 100 arasında olmalıdır",
      })
      return publicFromRow(row)!
    }

    const prior = await loadPromo(input.workspaceId, input.storeId, listingId)
    if (!input.skipPriceProtection) {
      const currentPricingRate = adRatePercentForPricing({
        status: prior?.status ?? null,
        requested: prior?.requested,
        requestedRate: nRate(prior?.requested_rate),
        effectiveRate: nRate(prior?.effective_rate),
      }) ?? 0
      const priceGuard = await raiseEbayPriceForPromotionRate({
        workspaceId: input.workspaceId,
        storeId: input.storeId,
        storeCode: input.storeCode,
        catalogStateId,
        nextAdRatePercent: rate,
        currentPricingRate,
      })
      if (priceGuard.ok === false) {
        const row = await upsertPromo({
          workspaceId: input.workspaceId,
          storeId: input.storeId,
          catalogStateId,
          listingId,
          requested: true,
          requestedRate: rate,
          effectiveRate: prior ? nRate(prior.effective_rate) : null,
          campaignId: prior?.campaign_id ?? null,
          adId: prior?.ad_id ?? null,
          status: "FAILED",
          code: priceGuard.code,
          message: priceGuard.message,
        })
        return publicFromRow(row)!
      }
    }

    await upsertPromo({
      workspaceId: input.workspaceId,
      storeId: input.storeId,
      catalogStateId,
      listingId,
      requested: true,
      requestedRate: rate,
      effectiveRate: prior ? nRate(prior.effective_rate) : null,
      campaignId: prior?.campaign_id ?? null,
      adId: prior?.ad_id ?? null,
      status: "PENDING",
      code: null,
      message: null,
    })

    let campaignId: string | null = null
    try {
      await requireMarketingScope(input.workspaceId, input.storeId)
      const { client } = await marketingClient(input.workspaceId, input.storeCode)
      const existing = await client.findCampaignByListingId(listingId)
      campaignId = existing?.campaignId ?? null
      if (!campaignId) {
        const camp = await ensureStoreGeneralCpsCampaign({
          workspaceId: input.workspaceId,
          storeId: input.storeId,
          storeCode: input.storeCode,
          client,
          marketplace: EBAY_PROMOTED_MARKETPLACE,
        })
        campaignId = camp.campaignId
      }
      const current = await readbackAd(client, campaignId, listingId)
      if (current && current.rate != null && Math.abs(current.rate - rate) < 0.05) {
        await clearPromotionRetry({ workspaceId: input.workspaceId, storeId: input.storeId, listingId })
        const row = await upsertPromo({
          workspaceId: input.workspaceId,
          storeId: input.storeId,
          catalogStateId,
          listingId,
          requested: true,
          requestedRate: rate,
          effectiveRate: current.rate,
          campaignId: current.campaignId,
          adId: current.adId,
          status: "ACTIVE",
          code: null,
          message: null,
        })
        return publicFromRow(row)!
      }
      if (current?.adId) {
        await markPromotionAttempt({ workspaceId: input.workspaceId, storeId: input.storeId, listingId })
        await client.updateAdBid({ campaignId: current.campaignId, listingId, bidPercentage: rate })
      } else {
        await markPromotionAttempt({ workspaceId: input.workspaceId, storeId: input.storeId, listingId })
        await client.createAdByListingId({ campaignId: campaignId!, listingId, bidPercentage: rate })
      }
      const verified = await readbackAd(client, campaignId, listingId)
      if (!verified) {
        const row = await upsertPromo({
          workspaceId: input.workspaceId,
          storeId: input.storeId,
          catalogStateId,
          listingId,
          requested: true,
          requestedRate: rate,
          effectiveRate: null,
          campaignId,
          adId: null,
          status: "UNKNOWN",
          code: "READBACK_MISMATCH",
          message: "Ürün yayınlandı, reklam bağlantısı tamamlanamadı",
        })
        return publicFromRow(row)!
      }
      await clearPromotionRetry({ workspaceId: input.workspaceId, storeId: input.storeId, listingId })
      const row = await upsertPromo({
        workspaceId: input.workspaceId,
        storeId: input.storeId,
        catalogStateId,
        listingId,
        requested: true,
        requestedRate: rate,
        effectiveRate: verified.rate ?? rate,
        campaignId: verified.campaignId,
        adId: verified.adId,
        status: "ACTIVE",
        code: null,
        message: null,
      })
      return publicFromRow(row)!
    } catch (e) {
      const thrownCode = String((e as { code?: string }).code ?? "")
      const numericId = /^\d+$/.test(thrownCode) ? Number(thrownCode) : null
      const safe = sanitizeMarketingError(e instanceof Error ? e.message : String(e), numericId)
      const code = thrownCode && !/^\d+$/.test(thrownCode) ? thrownCode : safe.code
      const visibility = isVisibilityDelayCode(code) || isVisibilityDelayCode(safe.code)
      const message = visibility
        ? "Ürün yayınlandı. Reklam bağlantısı eBay tarafından hazırlanıyor."
        : code === "MARKETING_SCOPE_REQUIRED"
          ? "Bu mağazada reklam yetkisi yok. eBay bağlantısını yenileyin."
          : safe.message
      const priorRow = await loadPromo(input.workspaceId, input.storeId, listingId)
      const attempts = Number((priorRow as PromoRow & { attempt_count?: number } | null)?.attempt_count ?? 0)
      const pendingRetry = visibility && attempts < MAX_PROMOTION_ATTEMPTS
      const row = await upsertPromo({
        workspaceId: input.workspaceId,
        storeId: input.storeId,
        catalogStateId,
        listingId,
        requested: true,
        requestedRate: rate,
        effectiveRate: priorRow ? nRate(priorRow.effective_rate) : null,
        campaignId: campaignId || priorRow?.campaign_id || null,
        adId: priorRow?.ad_id || null,
        status: pendingRetry ? "PENDING" : "FAILED",
        code: visibility ? "NEW_LISTING_MARKETING_VISIBILITY_DELAY" : code,
        message,
      })
      if (pendingRetry) {
        await scheduleVisibilityRetry({
          workspaceId: input.workspaceId,
          storeId: input.storeId,
          listingId,
          attemptCount: attempts,
        })
      } else {
        await clearPromotionRetry({ workspaceId: input.workspaceId, storeId: input.storeId, listingId })
      }
      return publicFromRow(row)!
    }
  })
}

async function turnOffListingPromotion(input: {
  workspaceId: string
  storeId: number
  storeCode: string
  catalogStateId: number | null
  listingId: string
}): Promise<PromotionPublic> {
  const listingId = input.listingId.trim()
  const catalogStateId = parseCatalogStateId(input.catalogStateId)
  try {
    await requireMarketingScope(input.workspaceId, input.storeId)
    const { client } = await marketingClient(input.workspaceId, input.storeCode)
    const found = await readbackAd(client, null, listingId)
    if (found?.adId) {
      await client.deleteAd(found.campaignId, found.adId)
    }
    const still = await readbackAd(client, found?.campaignId ?? null, listingId)
    if (still) {
      const row = await upsertPromo({
        workspaceId: input.workspaceId,
        storeId: input.storeId,
        catalogStateId,
        listingId,
        requested: false,
        requestedRate: null,
        effectiveRate: still.rate,
        campaignId: still.campaignId,
        adId: still.adId,
        status: "UNKNOWN",
        code: "READBACK_MISMATCH",
        message: "Reklam kapatma doğrulanamadı",
      })
      return publicFromRow(row)!
    }
    const row = await upsertPromo({
      workspaceId: input.workspaceId,
      storeId: input.storeId,
      catalogStateId,
      listingId,
      requested: false,
      requestedRate: null,
      effectiveRate: null,
      campaignId: found?.campaignId ?? null,
      adId: null,
      status: "OFF",
      code: null,
      message: null,
    })
    return publicFromRow(row)!
  } catch (e) {
    const safe = sanitizeMarketingError(e instanceof Error ? e.message : String(e))
    const row = await upsertPromo({
      workspaceId: input.workspaceId,
      storeId: input.storeId,
      catalogStateId,
      listingId,
      requested: false,
      requestedRate: null,
      effectiveRate: null,
      campaignId: null,
      adId: null,
      status: "FAILED",
      code: (e as { code?: string }).code ?? safe.code,
      message: safe.message,
    })
    return publicFromRow(row)!
  }
}

export async function verifyListingPromotion(input: {
  workspaceId: string
  storeId: number
  storeCode: string
  catalogStateId: number | null
  listingId: string
}): Promise<PromotionPublic> {
  const listingId = input.listingId.trim()
  const catalogStateId = parseCatalogStateId(input.catalogStateId)
  return withMutation(mutKey(input.storeId, listingId, "verify"), async () => {
    try {
      await requireMarketingScope(input.workspaceId, input.storeId)
      const { client } = await marketingClient(input.workspaceId, input.storeCode)
      const found = await readbackAd(client, null, listingId)
      if (!found) {
        const prev = await loadPromo(input.workspaceId, input.storeId, listingId)
        const row = await upsertPromo({
          workspaceId: input.workspaceId,
          storeId: input.storeId,
          catalogStateId,
          listingId,
          requested: prev?.requested ?? false,
          requestedRate: nRate(prev?.requested_rate),
          effectiveRate: null,
          campaignId: null,
          adId: null,
          status: prev?.requested ? "OFF" : "OFF",
          code: null,
          message: null,
        })
        if (!prev) {
          const unknown = await upsertPromo({
            workspaceId: input.workspaceId,
            storeId: input.storeId,
            catalogStateId,
            listingId,
            requested: false,
            requestedRate: null,
            effectiveRate: null,
            campaignId: null,
            adId: null,
            status: "OFF",
            code: null,
            message: null,
          })
          return publicFromRow(unknown)!
        }
        return publicFromRow(row)!
      }
      const row = await upsertPromo({
        workspaceId: input.workspaceId,
        storeId: input.storeId,
        catalogStateId,
        listingId,
        requested: true,
        requestedRate: found.rate,
        effectiveRate: found.rate,
        campaignId: found.campaignId,
        adId: found.adId,
        status: "ACTIVE",
        code: null,
        message: null,
      })
      return publicFromRow(row)!
    } catch (e) {
      const safe = sanitizeMarketingError(e instanceof Error ? e.message : String(e))
      const row = await upsertPromo({
        workspaceId: input.workspaceId,
        storeId: input.storeId,
        catalogStateId,
        listingId,
        requested: true,
        requestedRate: null,
        effectiveRate: null,
        campaignId: null,
        adId: null,
        status: "UNKNOWN",
        code: (e as { code?: string }).code ?? safe.code,
        message: safe.message,
      })
      return publicFromRow(row)!
    }
  })
}

export async function attachPromotionAfterPublish(input: {
  workspaceId: string
  storeId: number
  storeCode: string
  catalogStateId: number | null
  listingId: string
  enabled: boolean
  rate: number | null
}): Promise<PromotionPublic | null> {
  if (!input.enabled) return null
  return applyListingPromotion({ ...input, skipPriceProtection: true })
}

export async function processDuePromotionRetries(limit = 3): Promise<number> {
  const due = await query<{
    workspace_id: string
    store_id: number
    store_code: string
    catalog_state_id: string | number | null
    ebay_listing_id: string
    requested_rate: string | null
    attempt_count: string | number | null
  }>(
    `SELECT p.workspace_id::text AS workspace_id,
            p.store_id,
            s.store_code,
            p.catalog_state_id,
            p.ebay_listing_id,
            p.requested_rate::text,
            COALESCE(p.attempt_count, 0) AS attempt_count
     FROM ebay_listing_promotions p
     INNER JOIN stores s ON s.id = p.store_id AND s.workspace_id = p.workspace_id
     WHERE p.status = 'PENDING'
       AND p.requested = TRUE
       AND p.last_error_code = 'NEW_LISTING_MARKETING_VISIBILITY_DELAY'
       AND p.next_attempt_at IS NOT NULL
       AND p.next_attempt_at <= NOW()
     ORDER BY p.next_attempt_at ASC
     LIMIT $1`,
    [limit]
  )
  let n = 0
  for (const row of due.rows) {
    const rate = nRate(row.requested_rate)
    await applyListingPromotion({
      workspaceId: row.workspace_id,
      storeId: Number(row.store_id),
      storeCode: row.store_code,
      catalogStateId: parseCatalogStateId(row.catalog_state_id),
      listingId: row.ebay_listing_id,
      enabled: true,
      rate,
      skipPriceProtection: true,
    })
    n += 1
  }
  return n
}

export function unknownPromotionPublic(): PromotionPublic {
  return toPromotionPublic({
    requested: false,
    requestedRate: null,
    status: "UNKNOWN",
    effectiveRate: null,
    campaignId: null,
    adId: null,
    lastErrorCode: null,
  })
}
