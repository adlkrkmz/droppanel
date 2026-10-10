// ----------------------------------------------------------------
// appRoutes.ts — user-scoped /app/* endpoints (Phase 2)
// ----------------------------------------------------------------

import type { Express, Request, Response } from "express"
import {
  requireAuth,
  requireActiveUser,
  type AuthedRequest,
} from "../auth/authMiddleware"
import { fetchEbayPolicies, getSettingsForStore } from "../settings/settingsService"
import {
  assertCatalogStateInUserWorkspaceStore,
  assertStockAlertInUserWorkspaceStore,
  assertStoreIdInUserWorkspace,
  assertStoreInUserWorkspace,
  getAuthenticatedWorkspaceId,
  type OwnedStore,
} from "./appOwnership"
import { getAppListings, getAppRecommendedPrice } from "./appListingsService"
import { appUpdateListingPrice, parseExplicitListingPrice } from "./appListingsPriceUpdateService"
import {
  appUpdateListingStockGuard,
  parseStockGuardEnabledBody,
} from "./appListingStockGuardService"
import {
  appBulkUpdateListingStockGuard,
  parseBulkCatalogStateIdsBody,
} from "./appListingBulkStockGuardService"
import {
  appBulkHideListings,
} from "./appListingBulkHideService"
import {
  appBulkEndListings,
  parseBulkEndCatalogStateIdsBody,
  parseBulkEndListingBody,
} from "./appListingBulkEndService"
import {
  appUpdateListingSourceAsin,
  parseAppSourceAsinBody,
} from "./appListingUpdateSourceAsinService"
import {
  appEndListing,
  parseEndListingBody,
} from "./appListingEndService"
import {
  appSetListingQuantity,
  appBulkSetListingQuantity,
  parseSetQuantityBody,
  parseBulkSetQuantityCatalogStateIdsBody,
} from "./appListingSetQuantityService"
import {
  appApplyListingPromotion,
  appBulkApplyListingPromotion,
  appRetryListingPromotion,
  appVerifyListingPromotion,
  parsePromotionBody,
  storeMarketingAccess,
} from "./appListingPromotionService"
import { parseAppListingsFilter, parseAppListingsSort } from "./appListingFilters"
import {
  parseAppStockAlertRisk,
  parseAppStockAlertSearch,
  parseAppStockAlertStatus,
} from "./appStockAlertFilters"
import { appSyncListings } from "./appListingsSyncService"
import { appImportMatchListings } from "./appListingsImportMatchService"
import { getAppImportStatus } from "./appImportStatusService"
import {
  buildAppEbayConnectUrl,
  buildAppEbayReconnectUrl,
  getAppEbayStatus,
  handleAppEbayCallback,
  userEbayErrorRedirectUrl,
} from "./appEbayService"
import {
  buildMailboxConnectUrl,
  assertWorkspaceMailboxAccount,
  disconnectWorkspaceMailbox,
  handleMailboxOAuthCallback,
  listWorkspaceMailboxes,
  mailboxErrorRedirect,
  mailboxSuccessRedirect,
} from "../mailbox/mailboxOAuthService"
import { ingestMailboxAccount } from "../mailbox/mailboxIngestService"
import { getStoreFinanceSummary } from "../mailbox/storeFinanceSummary"
import { getAppDashboard, getAppStores } from "./appService"
import { getAppDashboardOps } from "./appDashboardOpsService"
import { appRemoveStore } from "./appStoreLifecycleService"
import {
  getAppOrderAssist,
  getAppOrderDetail,
  getAppOrdersForAllStores,
  getAppOrdersForStore,
  patchAppOrderAssistAsin,
  patchAppOrderManual,
  refreshAppOrderEarnings,
  syncAppOrdersForAllStores,
  syncAppOrdersForStore,
} from "./appOrdersService"
import { getAppActivity } from "./appActivityService"
import {
  handleGetAppActivityFeed,
  handleGetAppActivityUnread,
  handlePostAppActivityRead,
} from "./appActivityFeedHandlers"
import {
  parseAppActivityActionFilter,
  parseAppActivitySearch,
} from "./appActivityFilters"
import { getAppStockAlerts } from "./appStockAlertsService"
import { appIgnoreStockAlert } from "./appStockAlertIgnoreService"
import {
  appBulkIgnoreStockAlerts,
  parseBulkAlertIdsBody,
} from "./appStockAlertBulkIgnoreService"
import {
  appBulkApproveZeroStockAlerts,
  parseBulkApproveZeroAlertIdsBody,
} from "./appStockAlertBulkApproveZeroService"
import {
  appApproveZeroStockAlert,
  validateApproveZeroRequestBody,
} from "./appStockAlertApproveZeroService"
import {
  getAppStockGuardSettings,
  updateAppStockGuardSettings,
  validateAppStockGuardSettingsBody,
} from "./appStockGuardSettingsService"
import { getAppStockGuardStatus } from "./appStockGuardStatusService"
import {
  getCustomerServicePage,
  saveAutomationSettings,
  saveMasterEnabled,
  saveThankYouSettings,
} from "../customerService/csThankYouService"
import {
  getBuyerConversation,
  listBuyerConversations,
  replyBuyerConversation,
} from "../customerService/csMessagesService"
import {
  ensureBuyerMessageNotifications,
  getBuyerMessageNotificationStatus,
} from "../customerService/csNotificationService"
import {
  appSaveAddress,
  appSaveMarkup,
  appSavePricing,
  parsePricingSettings,
  appSavePolicies,
  appSaveWarehouseBanner,
  parseMarkupPercent,
  parseStoreAddress,
  parseWarehouseBannerEnabled,
} from "./appSettingsService"
import { AppHttpError, type AppImportMatchRowInput } from "./appTypes"
import {
  isOperationStatus,
  type OrderManualUpdateInput,
} from "../orders/ordersTypes"
import { registerExtensionRoutes } from "./extensionRoutes"

function parseAppOrderId(raw: string | undefined): number | null {
  if (!raw) return null
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 1 ? n : null
}

function sendAppError(res: Response, e: unknown): void {
  if (e instanceof AppHttpError) {
    res.status(e.status).json({ ok: false, error: e.message })
    return
  }
  console.error("[App]", e)
  res.status(500).json({
    ok:    false,
    error: process.env.NODE_ENV === "production" ? "INTERNAL_ERROR" : (e instanceof Error ? e.message : "Internal error"),
  })
}

async function withActiveUser(
  req: Request,
  res: Response,
  handler: (req: AuthedRequest) => Promise<void>
): Promise<void> {
  await requireAuth(req as AuthedRequest, res, async () => {
    await requireActiveUser(req as AuthedRequest, res, async () => {
      try {
        await handler(req as AuthedRequest)
      } catch (e) {
        sendAppError(res, e)
      }
    })
  })
}

function parsePagePagination(query: Record<string, unknown>): { page: number; limit: number } {
  const pageParam  = query["page"]
  const limitParam = query["limit"]
  const limit = limitParam !== undefined ? Math.max(1, Math.min(100, parseInt(String(limitParam), 10) || 50)) : 50
  const page  = pageParam !== undefined ? Math.max(1, parseInt(String(pageParam), 10) || 1) : 1
  return { page, limit }
}

function parseStoreCodeBody(body: Record<string, unknown>): string {
  const storeCode = String(body.storeCode ?? "").trim()
  if (!storeCode) throw new AppHttpError(400, "storeCode is required")
  return storeCode
}

/** Canonical identity for store-scoped mutations: exact numeric storeId. */
function parseStoreIdBody(body: Record<string, unknown>): number {
  const raw = body.storeId
  const n =
    typeof raw === "number" ? raw
    : typeof raw === "string" && raw.trim() !== "" ? Number(raw)
    : NaN
  if (!Number.isInteger(n) || n < 1) {
    throw new AppHttpError(400, "storeId is required")
  }
  return n
}

async function resolveListingStore(
  workspaceId: string,
  body: Record<string, unknown>
): Promise<OwnedStore> {
  if (body.storeId !== undefined && body.storeId !== null && String(body.storeId).trim() !== "") {
    return assertStoreIdInUserWorkspace(workspaceId, parseStoreIdBody(body))
  }
  return assertStoreInUserWorkspace(workspaceId, parseStoreCodeBody(body))
}

function parseImportMatchRowsBody(body: Record<string, unknown>): AppImportMatchRowInput[] {
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    throw new AppHttpError(400, "rows must be a non-empty array")
  }
  return body.rows.map(r => {
    const row = (r ?? {}) as Record<string, unknown>
    return {
      ebayItemId: String(row.ebayItemId ?? "").trim(),
      asin:       String(row.asin ?? "").trim(),
    }
  })
}

function getActorUserId(req: AuthedRequest): string {
  const userId = req.auth?.user?.id
  if (!userId) throw new AppHttpError(401, "Unauthorized")
  return userId
}

function parseCatalogStateIdBody(body: Record<string, unknown>): number {
  const raw = body.catalogStateId
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new AppHttpError(400, "catalogStateId is required")
  }
  const catalogStateId = Number(raw)
  if (!Number.isFinite(catalogStateId) || catalogStateId <= 0) {
    throw new AppHttpError(400, "catalogStateId is required")
  }
  return catalogStateId
}

function parseConfirmBody(body: Record<string, unknown>): void {
  if (body.confirm !== true) {
    throw new AppHttpError(400, "confirm must be true")
  }
}

function parseAlertIdBody(body: Record<string, unknown>): number {
  const raw = body.alertId
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new AppHttpError(400, "alertId is required")
  }
  const alertId = Number(raw)
  if (!Number.isFinite(alertId) || alertId <= 0) {
    throw new AppHttpError(400, "alertId is required")
  }
  return alertId
}

export function registerAppRoutes(app: Express): void {
  registerExtensionRoutes(app)
  app.get("/app/dashboard", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const body = await getAppDashboard(workspaceId)
      res.status(200).json(body)
    })
  )

  app.get("/app/dashboard/ops", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const period = String(req.query["period"] ?? "today").trim()
      if (period !== "today" && period !== "week" && period !== "month") {
        throw new AppHttpError(400, "period must be today, week, or month")
      }
      const allStores = String(req.query["allStores"] ?? "").trim() === "true"
      if (allStores) {
        const body = await getAppDashboardOps(workspaceId, null, period)
        res.status(200).json(body)
        return
      }
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const body = await getAppDashboardOps(workspaceId, { id: store.id, storeCode: store.storeCode }, period)
      res.status(200).json(body)
    })
  )

  app.get("/app/stores", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const body = await getAppStores(workspaceId)
      res.status(200).json(body)
    })
  )

  app.get("/app/orders", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const allStores = String(req.query["allStores"] ?? "").trim() === "true"

      if (allStores) {
        const body = await getAppOrdersForAllStores(workspaceId)
        res.status(200).json(body)
        return
      }

      const storeCode = String(req.query["storeCode"] ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const body = await getAppOrdersForStore(workspaceId, store)
      res.status(200).json(body)
    })
  )

  app.post("/app/orders/sync", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const bodyIn = (req.body ?? {}) as { storeCode?: string; allStores?: boolean }
      const allStores = bodyIn.allStores === true

      if (allStores) {
        const body = await syncAppOrdersForAllStores(workspaceId)
        res.status(200).json(body)
        return
      }

      const storeCode = String(bodyIn.storeCode ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const body = await syncAppOrdersForStore(workspaceId, store)
      res.status(200).json(body)
    })
  )

  app.get("/app/orders/:orderId", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const orderId = parseAppOrderId(req.params["orderId"])
      if (!orderId) throw new AppHttpError(400, "Invalid order id")
      const detail = await getAppOrderDetail(workspaceId, orderId)
      res.status(200).json(detail)
    })
  )

  app.patch("/app/orders/:orderId", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const orderId = parseAppOrderId(req.params["orderId"])
      if (!orderId) throw new AppHttpError(400, "Invalid order id")

      const body = (req.body ?? {}) as Record<string, unknown>
      const input: OrderManualUpdateInput = {}
      const normStr = (v: unknown): string | null => {
        if (v === null) return null
        if (typeof v !== "string") return null
        const t = v.trim()
        return t.length > 0 ? t : null
      }
      if ("notes" in body) input.notes = normStr(body["notes"])
      if ("amazonOrderNumber" in body) input.amazonOrderNumber = normStr(body["amazonOrderNumber"])
      if ("amazonOrderUrl" in body) input.amazonOrderUrl = normStr(body["amazonOrderUrl"])
      if ("amazonPurchasePrice" in body) {
        const raw = body["amazonPurchasePrice"]
        if (raw === null || raw === "") {
          input.amazonPurchasePrice = null
        } else {
          const n = typeof raw === "number" ? raw : parseFloat(String(raw))
          input.amazonPurchasePrice = Number.isFinite(n) ? n : null
        }
      }
      if ("operationStatus" in body) {
        const raw = body["operationStatus"]
        if (!isOperationStatus(raw)) throw new AppHttpError(400, "Geçersiz operasyon durumu")
        input.operationStatus = raw
      }

      const detail = await patchAppOrderManual(workspaceId, orderId, input)
      res.status(200).json(detail)
    })
  )

  app.post("/app/orders/:orderId/earnings", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const orderId = parseAppOrderId(req.params["orderId"])
      if (!orderId) throw new AppHttpError(400, "Invalid order id")
      const detail = await refreshAppOrderEarnings(workspaceId, orderId)
      res.status(200).json(detail)
    })
  )

  app.get("/app/orders/:orderId/assist", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const orderId = parseAppOrderId(req.params["orderId"])
      if (!orderId) throw new AppHttpError(400, "Invalid order id")
      const autoRun = String(req.query["autoRun"] ?? "") === "1"
      const packet = await getAppOrderAssist(workspaceId, orderId, autoRun)
      res.status(200).json(packet)
    })
  )

  app.patch("/app/orders/:orderId/assist-asin", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const orderId = parseAppOrderId(req.params["orderId"])
      if (!orderId) throw new AppHttpError(400, "Invalid order id")
      const asin = typeof (req.body as { asin?: unknown })?.asin === "string"
        ? (req.body as { asin: string }).asin
        : ""
      if (!asin.trim()) throw new AppHttpError(400, "ASIN gerekli")
      const result = await patchAppOrderAssistAsin(workspaceId, orderId, asin)
      res.status(200).json(result)
    })
  )

  app.get("/app/activity", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const queryParams = (req.query ?? {}) as Record<string, unknown>
      const { page, limit } = parsePagePagination(queryParams)
      const action = parseAppActivityActionFilter(queryParams["action"])
      const q = parseAppActivitySearch(queryParams["q"])

      const storeCodeRaw = String(queryParams["storeCode"] ?? "").trim()
      let storeCode: string | null = null
      if (storeCodeRaw) {
        await assertStoreInUserWorkspace(workspaceId, storeCodeRaw)
        storeCode = storeCodeRaw
      }

      const body = await getAppActivity({
        workspaceId,
        storeCode,
        action,
        q,
        page,
        limit,
      })
      res.status(200).json(body)
    })
  )

  app.get("/app/activity-feed", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      let storeId: number | null = null
      if (storeCode) {
        const workspaceId = getAuthenticatedWorkspaceId(authedReq)
        const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
        storeId = store.id
      }
      res.status(200).json(await handleGetAppActivityFeed(authedReq, storeId))
    })
  )

  app.get("/app/activity-feed/unread", (req, res) =>
    withActiveUser(req, res, async authedReq => {
      res.status(200).json(await handleGetAppActivityUnread(authedReq))
    })
  )

  app.post("/app/activity-feed/read", (req, res) =>
    withActiveUser(req, res, async authedReq => {
      res.status(200).json(await handlePostAppActivityRead(authedReq, (req.body ?? {}) as Record<string, unknown>))
    })
  )

  app.get("/app/settings", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      await assertStoreInUserWorkspace(workspaceId, storeCode)
      const settings = await getSettingsForStore(workspaceId, storeCode)
      if (!settings) throw new AppHttpError(404, "Store not found")
      res.status(200).json({ ok: true, settings })
    })
  )

  app.get("/app/settings/policies", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      await assertStoreInUserWorkspace(workspaceId, storeCode)
      try {
        const policies = await fetchEbayPolicies(workspaceId, storeCode)
        res.status(200).json({ ok: true, policies })
      } catch {
        throw new AppHttpError(502, "eBay business policies could not be loaded. Reconnect eBay or try again later.")
      }
    })
  )

  app.post("/app/settings/markup", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const markupPercent = parseMarkupPercent(body.markupPercent)
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const result = await appSaveMarkup({ workspaceId, actorUserId, store, markupPercent })
      res.status(200).json(result)
    })
  )

  app.post("/app/settings/pricing", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const pricing = parsePricingSettings(body)
      const settings = await appSavePricing({ workspaceId, actorUserId, store, ...pricing })
      res.status(200).json({ ok: true, settings })
    })
  )

  app.post("/app/settings/address", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const address = parseStoreAddress(body)
      const registrationCountry =
        body.registrationCountry !== undefined
          ? String(body.registrationCountry ?? "").trim() || null
          : undefined
      const countryOrRegion =
        body.countryOrRegion !== undefined
          ? String(body.countryOrRegion ?? "").trim() || null
          : undefined
      const cityState =
        body.cityState !== undefined
          ? String(body.cityState ?? "").trim() || null
          : undefined

      const result = await appSaveAddress({
        workspaceId,
        actorUserId,
        store,
        address,
        registrationCountry,
        countryOrRegion,
        cityState,
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/settings/policies", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)

      const result = await appSavePolicies({
        workspaceId,
        actorUserId,
        store,
        policies: {
          fulfillmentPolicyId:
            body.fulfillmentPolicyId !== undefined
              ? String(body.fulfillmentPolicyId ?? "").trim() || null
              : null,
          paymentPolicyId:
            body.paymentPolicyId !== undefined
              ? String(body.paymentPolicyId ?? "").trim() || null
              : null,
          returnPolicyId:
            body.returnPolicyId !== undefined
              ? String(body.returnPolicyId ?? "").trim() || null
              : null,
        },
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/settings/warehouse-banner", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const enabled = parseWarehouseBannerEnabled(body.warehouseShippingBannerEnabled)
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const result = await appSaveWarehouseBanner({
        workspaceId,
        actorUserId,
        store,
        enabled,
      })
      res.status(200).json(result)
    })
  )

  app.get("/app/listings", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const storeIdRaw = String(req.query["storeId"] ?? "").trim()
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      const store = storeIdRaw
        ? await assertStoreIdInUserWorkspace(workspaceId, Number(storeIdRaw))
        : await (async () => {
            if (!storeCode) throw new AppHttpError(400, "storeCode is required")
            return assertStoreInUserWorkspace(workspaceId, storeCode)
          })()
      const { page, limit } = parsePagePagination(req.query as Record<string, unknown>)
      const filter = parseAppListingsFilter(req.query["filter"])
      const sort = parseAppListingsSort(req.query["sort"])
      const direction = String(req.query["direction"] ?? "desc")
      const q = String(req.query["q"] ?? "").trim().slice(0, 120)
      const body = await getAppListings({ workspaceId, store, page, limit, filter, sort, direction, q })
      const marketingAccess = await storeMarketingAccess(workspaceId, store.id)
      res.status(200).json({
        ...body,
        storeId: store.id,
        hasMarketingScope: marketingAccess.granted,
        marketingAccess,
      })
    })
  )

  app.post("/app/listings/sync", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeId = parseStoreIdBody(body)
      const store = await assertStoreIdInUserWorkspace(workspaceId, storeId)
      const result = await appSyncListings({ workspaceId, actorUserId, store })
      res.status(202).json(result)
    })
  )

  app.get("/app/import/status", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const storeIdRaw = String(req.query["storeId"] ?? "").trim()
      const storeCodeRaw = String(req.query["storeCode"] ?? "").trim()
      let store
      if (storeIdRaw) {
        const storeId = Number(storeIdRaw)
        if (!Number.isInteger(storeId) || storeId < 1) {
          throw new AppHttpError(400, "storeId is required")
        }
        store = await assertStoreIdInUserWorkspace(workspaceId, storeId)
      } else if (storeCodeRaw) {
        store = await assertStoreInUserWorkspace(workspaceId, storeCodeRaw)
      } else {
        throw new AppHttpError(400, "storeId is required")
      }
      const body = await getAppImportStatus({ workspaceId, store })
      res.status(200).json(body)
    })
  )

  app.post("/app/listings/import-match", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const rows = parseImportMatchRowsBody(body)
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const result = await appImportMatchListings({
        workspaceId,
        actorUserId,
        store,
        rows,
      })
      res.status(200).json(result)
    })
  )

  app.get("/app/listings/recommended-price", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      const catalogStateIdRaw = String(req.query["catalogStateId"] ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      if (!catalogStateIdRaw) throw new AppHttpError(400, "catalogStateId is required")
      const catalogStateId = Number(catalogStateIdRaw)
      if (!Number.isFinite(catalogStateId) || catalogStateId <= 0) {
        throw new AppHttpError(400, "catalogStateId is required")
      }

      await assertStoreInUserWorkspace(workspaceId, storeCode)
      await assertCatalogStateInUserWorkspaceStore(workspaceId, storeCode, catalogStateId)

      const body = await getAppRecommendedPrice({ workspaceId, storeCode, catalogStateId })
      res.status(200).json(body)
    })
  )

  app.post("/app/listings/update-price", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const catalogStateId = parseCatalogStateIdBody(body)
      parseConfirmBody(body)
      const explicitPrice = body.price === undefined ? undefined : parseExplicitListingPrice(body.price)

      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      await assertCatalogStateInUserWorkspaceStore(workspaceId, storeCode, catalogStateId)

      const result = await appUpdateListingPrice({
        workspaceId,
        actorUserId,
        store,
        catalogStateId,
        explicitPrice,
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/listings/stock-guard", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const catalogStateId = parseCatalogStateIdBody(body)
      const enabled = parseStockGuardEnabledBody(body)
      parseConfirmBody(body)

      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      await assertCatalogStateInUserWorkspaceStore(workspaceId, storeCode, catalogStateId)

      const result = await appUpdateListingStockGuard({
        workspaceId,
        actorUserId,
        store,
        catalogStateId,
        enabled,
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/listings/bulk-stock-guard", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const catalogStateIds = parseBulkCatalogStateIdsBody(body)
      const enabled = parseStockGuardEnabledBody(body)
      parseConfirmBody(body)

      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)

      const result = await appBulkUpdateListingStockGuard({
        workspaceId,
        actorUserId,
        store,
        catalogStateIds,
        enabled,
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/listings/bulk-hide", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const catalogStateIds = parseBulkCatalogStateIdsBody(body)
      parseConfirmBody(body)

      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)

      const result = await appBulkHideListings({
        workspaceId,
        actorUserId,
        store,
        catalogStateIds,
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/listings/bulk-end", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const catalogStateIds = parseBulkEndCatalogStateIdsBody(body)
      parseBulkEndListingBody(body)

      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)

      const result = await appBulkEndListings({
        workspaceId,
        actorUserId,
        store,
        catalogStateIds,
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/listings/set-quantity", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const store = body.storeId !== undefined
        ? await assertStoreIdInUserWorkspace(workspaceId, parseStoreIdBody(body))
        : await assertStoreInUserWorkspace(workspaceId, parseStoreCodeBody(body))

      const catalogStateId = parseCatalogStateIdBody(body)
      const quantity = parseSetQuantityBody(body)



      const result = await appSetListingQuantity({
        workspaceId,
        actorUserId,
        store,
        catalogStateId,
        quantity,
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/listings/bulk-set-quantity", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const store = body.storeId !== undefined
        ? await assertStoreIdInUserWorkspace(workspaceId, parseStoreIdBody(body))
        : await assertStoreInUserWorkspace(workspaceId, parseStoreCodeBody(body))

      const catalogStateIds = parseBulkSetQuantityCatalogStateIdsBody(body)
      const quantity = parseSetQuantityBody(body)



      const result = await appBulkSetListingQuantity({
        workspaceId,
        actorUserId,
        store,
        catalogStateIds,
        quantity,
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/listings/update-source-asin", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const catalogStateId = parseCatalogStateIdBody(body)
      const asin = parseAppSourceAsinBody(body)
      parseConfirmBody(body)

      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      await assertCatalogStateInUserWorkspaceStore(workspaceId, storeCode, catalogStateId)

      const result = await appUpdateListingSourceAsin({
        workspaceId,
        actorUserId,
        store,
        catalogStateId,
        asin,
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/listings/end", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const catalogStateId = parseCatalogStateIdBody(body)
      parseEndListingBody(body)

      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      await assertCatalogStateInUserWorkspaceStore(workspaceId, storeCode, catalogStateId)

      const result = await appEndListing({
        workspaceId,
        actorUserId,
        store,
        catalogStateId,
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/listings/promotion", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const catalogStateId = parseCatalogStateIdBody(body)
      const promo = parsePromotionBody(body)
      const store = await resolveListingStore(workspaceId, body)
      await assertCatalogStateInUserWorkspaceStore(workspaceId, store.storeCode, catalogStateId)
      res.status(200).json(await appApplyListingPromotion({
        workspaceId,
        store,
        catalogStateId,
        enabled: promo.enabled,
        rate: promo.rate,
      }))
    })
  )

  app.post("/app/listings/promotion/verify", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const catalogStateId = parseCatalogStateIdBody(body)
      const store = await resolveListingStore(workspaceId, body)
      await assertCatalogStateInUserWorkspaceStore(workspaceId, store.storeCode, catalogStateId)
      res.status(200).json(await appVerifyListingPromotion({ workspaceId, store, catalogStateId }))
    })
  )

  app.post("/app/listings/promotion/retry", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const catalogStateId = parseCatalogStateIdBody(body)
      const store = await resolveListingStore(workspaceId, body)
      await assertCatalogStateInUserWorkspaceStore(workspaceId, store.storeCode, catalogStateId)
      res.status(200).json(await appRetryListingPromotion({ workspaceId, store, catalogStateId }))
    })
  )

  app.post("/app/listings/bulk-promotion", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const ids = parseBulkCatalogStateIdsBody(body)
      const promo = parsePromotionBody(body)
      const store = await resolveListingStore(workspaceId, body)
      res.status(200).json(await appBulkApplyListingPromotion({
        workspaceId,
        store,
        catalogStateIds: ids,
        enabled: promo.enabled,
        rate: promo.rate,
      }))
    })
  )

  app.get("/app/stock-alerts", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)

      const status = parseAppStockAlertStatus(req.query["status"])
      const risk = parseAppStockAlertRisk(req.query["risk"])
      const search = parseAppStockAlertSearch(req.query["q"])

      const { page, limit } = parsePagePagination(req.query as Record<string, unknown>)
      const body = await getAppStockAlerts({
        workspaceId,
        store,
        status,
        risk,
        search,
        page,
        limit,
      })
      res.status(200).json(body)
    })
  )

  app.post("/app/stock-alerts/ignore", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const alertId = parseAlertIdBody(body)
      parseConfirmBody(body)

      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const alert = await assertStockAlertInUserWorkspaceStore(workspaceId, storeCode, alertId)

      const result = await appIgnoreStockAlert({
        workspaceId,
        actorUserId,
        store,
        alert,
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/stock-alerts/bulk-ignore", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const alertIds = parseBulkAlertIdsBody(body)
      parseConfirmBody(body)

      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)

      const result = await appBulkIgnoreStockAlerts({
        workspaceId,
        actorUserId,
        store,
        alertIds,
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/stock-alerts/approve-zero", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const alertId = parseAlertIdBody(body)
      validateApproveZeroRequestBody(body)

      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const alert = await assertStockAlertInUserWorkspaceStore(workspaceId, storeCode, alertId)

      const result = await appApproveZeroStockAlert({
        workspaceId,
        actorUserId,
        store,
        alert,
      })
      res.status(200).json(result)
    })
  )

  app.post("/app/stock-alerts/bulk-approve-zero", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const alertIds = parseBulkApproveZeroAlertIdsBody(body)
      validateApproveZeroRequestBody(body)

      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)

      const result = await appBulkApproveZeroStockAlerts({
        workspaceId,
        actorUserId,
        store,
        alertIds,
      })
      res.status(200).json(result)
    })
  )

  app.get("/app/stock-guard/settings", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const body = await getAppStockGuardSettings(workspaceId, store)
      res.status(200).json(body)
    })
  )

  app.get("/app/stock-guard/status", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const body = await getAppStockGuardStatus(workspaceId, store)
      res.status(200).json(body)
    })
  )

  app.post("/app/stock-guard/settings", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const actorUserId = getActorUserId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const patch = validateAppStockGuardSettingsBody(body)
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const result = await updateAppStockGuardSettings({
        workspaceId,
        actorUserId,
        store,
        patch,
      })
      res.status(200).json(result)
    })
  )

  app.get("/app/customer-service", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const body = await getCustomerServicePage(workspaceId, store)
      res.status(200).json(body)
    })
  )

  app.post("/app/customer-service/automations", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const typeRaw = String(body.type ?? body.automationType ?? "").trim().toUpperCase()
      const allowed = new Set(["THANK_YOU", "SHIPPED", "DELAYED", "DELIVERED"])
      if (!allowed.has(typeRaw)) throw new AppHttpError(400, "type is required")
      const templateBody = typeof body.template === "string" ? body.template : undefined
      try {
        const automation = await saveAutomationSettings({
          workspaceId,
          storeId: store.id,
          automationType: typeRaw as "THANK_YOU" | "SHIPPED" | "DELAYED" | "DELIVERED",
          templateBody,
        })
        const page = await getCustomerServicePage(workspaceId, store)
        res.status(200).json({
          ok: true,
          storeCode: store.storeCode,
          automation: {
            type: automation.automationType,
            enabled: automation.enabled,
            template: automation.templateBody,
          },
          ebayMessage: page.ebayMessage,
        })
      } catch (e) {
        const status = (e as { status?: number }).status
        if (e instanceof Error && status === 400) throw new AppHttpError(400, e.message)
        throw e
      }
    })
  )

  app.post("/app/customer-service/master", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      if (typeof body.enabled !== "boolean") throw new AppHttpError(400, "enabled is required")
      const master = await saveMasterEnabled({
        workspaceId,
        storeId: store.id,
        enabled: body.enabled,
      })
      const page = await getCustomerServicePage(workspaceId, store)
      res.status(200).json({
        ok: true,
        storeCode: store.storeCode,
        masterEnabled: master.enabled,
        ebayMessage: page.ebayMessage,
      })
    })
  )

  app.post("/app/customer-service/thank-you", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined
      const templateBody = typeof body.template === "string" ? body.template : undefined
      try {
        const automation = await saveThankYouSettings({
          workspaceId,
          storeId: store.id,
          enabled,
          templateBody,
        })
        const page = await getCustomerServicePage(workspaceId, store)
        res.status(200).json({
          ok: true,
          storeCode: store.storeCode,
          thankYou: {
            enabled: automation.enabled,
            template: automation.templateBody,
          },
          ebayMessage: page.ebayMessage,
        })
      } catch (e) {
        const status = (e as { status?: number }).status
        if (e instanceof Error && status === 400) throw new AppHttpError(400, e.message)
        throw e
      }
    })
  )

  app.get("/app/customer-service/message-notifications", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const body = await getBuyerMessageNotificationStatus({ workspaceId, store })
      res.status(200).json(body)
    })
  )

  app.post("/app/customer-service/message-notifications/ensure", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const result = await ensureBuyerMessageNotifications({ workspaceId, store })
      res.status(200).json(result)
    })
  )

  app.get("/app/customer-service/conversations", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const limit = Number.parseInt(String(req.query["limit"] ?? "25"), 10)
      const offset = Number.parseInt(String(req.query["offset"] ?? "0"), 10)
      const body = await listBuyerConversations({
        workspaceId,
        store,
        limit: Number.isFinite(limit) ? limit : 25,
        offset: Number.isFinite(offset) ? offset : 0,
      })
      res.status(200).json(body)
    })
  )

  app.post("/app/customer-service/conversations/reply", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const body = (req.body ?? {}) as Record<string, unknown>
      const storeCode = parseStoreCodeBody(body)
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const result = await replyBuyerConversation({
        workspaceId,
        store,
        conversationId: String(body.conversationId ?? ""),
        messageText: String(body.messageText ?? ""),
      })
      res.status(200).json(result)
    })
  )

  app.get("/app/customer-service/conversations/:conversationId", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const conversationTypeRaw = String(req.query["conversationType"] ?? "FROM_MEMBERS").trim()
      const conversationType = conversationTypeRaw === "FROM_EBAY" ? "FROM_EBAY" as const : "FROM_MEMBERS" as const
      const body = await getBuyerConversation({
        workspaceId,
        store,
        conversationId: String(req.params.conversationId ?? ""),
        conversationType,
      })
      res.status(200).json(body)
    })
  )

  app.get("/app/ebay/status", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const body = await getAppEbayStatus(workspaceId)
      res.status(200).json(body)
    })
  )

  app.get("/app/ebay/connect", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const userId = authedReq.auth?.user?.id
      if (!userId) throw new AppHttpError(401, "Unauthorized")
      const body = await buildAppEbayConnectUrl({ userId, workspaceId })
      res.status(200).json(body)
    })
  )

  app.post("/app/ebay/reconnect", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const userId = authedReq.auth?.user?.id
      if (!userId) throw new AppHttpError(401, "Unauthorized")

      const bodyIn = (req.body ?? {}) as { storeId?: unknown }
      const storeIdRaw = bodyIn.storeId
      const storeId =
        typeof storeIdRaw === "number"
          ? storeIdRaw
          : typeof storeIdRaw === "string"
            ? parseInt(storeIdRaw, 10)
            : NaN
      if (!Number.isInteger(storeId) || storeId < 1) {
        throw new AppHttpError(400, "storeId is required")
      }

      const store = await assertStoreIdInUserWorkspace(workspaceId, storeId)
      const body = await buildAppEbayReconnectUrl({ userId, workspaceId, store })
      res.status(200).json(body)
    })
  )

  app.post("/app/stores/remove", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const userId = authedReq.auth?.user?.id
      if (!userId) throw new AppHttpError(401, "Unauthorized")

      const bodyIn = (req.body ?? {}) as { storeId?: unknown; confirm?: unknown }
      const storeIdRaw = bodyIn.storeId
      const storeId =
        typeof storeIdRaw === "number"
          ? storeIdRaw
          : typeof storeIdRaw === "string"
            ? parseInt(storeIdRaw, 10)
            : NaN
      if (!Number.isInteger(storeId) || storeId < 1) {
        throw new AppHttpError(400, "storeId is required")
      }
      if (bodyIn.confirm !== true) {
        throw new AppHttpError(400, "confirm must be true")
      }

      const store = await assertStoreIdInUserWorkspace(workspaceId, storeId)
      const body = await appRemoveStore({
        workspaceId,
        actorUserId: userId,
        store,
        confirm: true,
      })
      res.status(200).json(body)
    })
  )

  app.get("/app/ebay/callback", async (req, res) => {
    const ebayError = String(req.query["error"] ?? "").trim()
    if (ebayError) {
      res.redirect(302, userEbayErrorRedirectUrl(ebayError))
      return
    }

    try {
      const code  = String(req.query["code"] ?? "")
      const state = String(req.query["state"] ?? "")
      const result = await handleAppEbayCallback({ code, state })
      res.redirect(302, result.redirectUrl)
    } catch (e) {
      if (e instanceof AppHttpError) {
        console.warn(`[eBayOAuthUser] callback failed: ${e.message}`)
        res.redirect(302, userEbayErrorRedirectUrl(e.message))
        return
      }
      console.error("[eBayOAuthUser] callback error:", e)
      res.redirect(302, userEbayErrorRedirectUrl("OAuth connection failed"))
    }
  })

  app.get("/app/mailbox/status", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const accounts = await listWorkspaceMailboxes(workspaceId)
      res.status(200).json({ ok: true, accounts })
    })
  )

  app.get("/app/mailbox/connect", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const userId = authedReq.auth?.user?.id
      if (!userId) throw new AppHttpError(401, "Unauthorized")
      const body = await buildMailboxConnectUrl({ userId, workspaceId })
      res.status(200).json(body)
    })
  )

  app.post("/app/mailbox/sync", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const accountId = Number((req.body as { accountId?: unknown })?.accountId)
      if (!Number.isInteger(accountId) || accountId < 1) throw new AppHttpError(400, "accountId is required")
      await assertWorkspaceMailboxAccount(workspaceId, accountId)
      console.warn("[mailbox] sync start", { workspaceId, accountId })
      const result = await ingestMailboxAccount(accountId)
      console.warn("[mailbox] sync done", { workspaceId, accountId, ...result })
      res.status(200).json({ ok: true, ...result })
    })
  )

  app.post("/app/mailbox/disconnect", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const accountId = Number((req.body as { accountId?: unknown })?.accountId)
      if (!Number.isInteger(accountId) || accountId < 1) throw new AppHttpError(400, "accountId is required")
      await disconnectWorkspaceMailbox(workspaceId, accountId)
      res.status(200).json({ ok: true })
    })
  )

  app.get("/app/finance/summary", (req, res) =>
    withActiveUser(req, res, async (authedReq) => {
      const workspaceId = getAuthenticatedWorkspaceId(authedReq)
      const storeCode = String(req.query["storeCode"] ?? "").trim()
      if (!storeCode) throw new AppHttpError(400, "storeCode is required")
      const store = await assertStoreInUserWorkspace(workspaceId, storeCode)
      const body = await getStoreFinanceSummary(workspaceId, store.id, store.storeCode)
      res.status(200).json({ ok: true, ...body })
    })
  )

  app.get("/app/mailbox/callback", async (req, res) => {
    const qParam = (v: unknown): string => {
      if (Array.isArray(v)) return String(v[0] ?? "").trim()
      return String(v ?? "").trim()
    }
    const err = qParam(req.query["error"])
    const code = qParam(req.query["code"])
    const state = qParam(req.query["state"])
    console.warn("[mailbox] callback hit", {
      hasError: Boolean(err),
      googleError: err || undefined,
      hasCode: Boolean(code),
      codeLen: code.length,
      hasState: Boolean(state),
      stateLen: state.length,
    })
    if (err) {
      res.redirect(302, mailboxErrorRedirect(err))
      return
    }
    try {
      const result = await handleMailboxOAuthCallback(code, state)
      void ingestMailboxAccount(result.accountId).catch(e =>
        console.warn("[mailbox] initial ingest failed", e instanceof Error ? e.message : e)
      )
      res.redirect(302, mailboxSuccessRedirect())
    } catch (e) {
      const msg = e instanceof AppHttpError
        ? e.message
        : e instanceof Error ? e.message : "mailbox_oauth_failed"
      console.warn("[mailbox] callback failed:", msg)
      res.redirect(302, mailboxErrorRedirect(msg))
    }
  })
}
