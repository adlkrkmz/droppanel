// ----------------------------------------------------------------
// httpServer.ts
// ----------------------------------------------------------------

import express from "express"
import cors    from "cors"
import cookieParser from "cookie-parser"
import {
  handleGetSummary, handleGetQueue, handleGetHistory, handleGetStores,
  handleGetPool, handlePostPoolDispatch, handlePostListingRun, handleDeletePoolItems, handlePostPoolDeleteSelected, handlePostPoolRestore,
  handlePostSchedulePublish, handleGetScheduleCommands, handleGetScheduleCommandById,
  handleGetScheduleCommandJobs, handlePostScheduleCommandCancel,
  handlePostScheduleCommandPause, handlePostScheduleCommandResume,
  handlePostScheduleRunnerRunDue, handleGetScheduleRunnerStatus,
  handlePostScheduleRunnerRunLiveOne,
  handlePostDispatchRunCreate, handlePostDispatchJobClaimNext, handlePostDispatchJobReport,
  handleGetDispatchRunStatus, handleGetDispatchActiveRuns,
  handleGetEbayConnectUrl, handlePostEbayAuthUrl, handlePostEbayConnect, handleGetEbayCallback, handleGetEbayAccountStatus, handleGetEbayAccounts, handlePostEbayOAuthReconnect, handlePostEbayRefresh, handleGetMonitorListings, handlePostMonitorUpdatePrice, handlePostMonitorUpdateStock, handlePostMonitorBlind, handlePostMonitorUpdateSourceUrl, handlePostListingsImportMatch, handlePostListingsStockGuard, handlePostListingsRemoveFromList, handlePostListingsRestoreToList, handleGetListingsRecommendedPrice, handlePostListingsUpdateEbayPrice, handlePostListingsUpdateSourceAsin, handlePostListingsSourceStatus, handlePostListingsEnd, handlePostListingsSyncListings, handlePostStoreSyncQueueTick, handlePostListingsSync30dClicks, handlePostListingsSyncMetrics, handleGetListingsStoreDebug, handlePostAsinImport, handlePostProductExtract, handlePostAiListingGenerate, handlePostDispatch, handlePostPublishRun,
  handlePostCreateStore, handlePostEbayDisconnect, handlePostDispatchJobsCleanupStale,
  handleGetSettings, handlePostSettingsAddress, handleGetSettingsPolicies, handlePostSettingsPolicies, handlePostSettingsMarkup, handlePostSettingsPricing, handlePostSettingsWarehouseBanner,
  handleGetNotifications, handlePostNotificationsRead, handlePostNotificationsReadAll,
  handleGetStockAlerts, handlePostStockAlertsIgnore, handlePostStockAlertsApproveZero,
  handleGetOrders,
  handlePostOrdersSync,
  handleGetOrderDetail,
  handlePostOrderEarnings,
  handlePatchOrder,
  handleGetOrderAssist,
  handlePatchOrderAsin,
  handlePostExtensionCaptureJobs, handleGetExtensionCaptureJob, handleGetActiveExtensionCaptureJobs,
  handlePostExtensionCaptureClaimNext, handlePostExtensionCaptureItemStart,
  handlePostExtensionCaptureItemSubmit, handlePostExtensionCaptureItemFail, handlePostExtensionCaptureJobCancel,
} from "../admin/adminRoutes"
import {
  handleGetPoolCategoryPreferences,
  handlePutPoolCategoryPreferences,
} from "../pool/poolCategoryPreferencesRoutes"
import {
  handleGetKeepaStatus,
  handlePostKeepaCheckAsin,
  handlePostKeepaCheckAsins,
  handlePostKeepaScanStore,
  handlePostKeepaCreateReviewFromCurrentStatus,
} from "../keepa/keepaRoutes"
import {
  handleGetStockGuardStatus,
  handlePostStockGuardSchedulerTick,
  handlePostStockGuardRunNext,
  handlePostStockGuardRequeueJob,
  handleGetStockGuardSettings,
  handlePostStockGuardSettings,
  handlePostStockGuardCleanup,
} from "../stockGuard/stockGuardRoutes"
import {
  handlePostVariationExtract,
  handlePostVariationGenerateAi,
  handlePostVariationPublish,
  handleGetVariationList,
} from '../variation/variationRoutes'
import { createSlideshow, uploadVideoToEbay } from '../video/videoService'
import { getStoreByCode } from '../stores/storeRepository'
import { getValidAccessToken } from '../ebayOAuth/ebayOAuthService'
import { EbayApiClient } from '../ebay/ebayApiClient'
import { handleCallback as ebayHandleCallback } from "../ebayOAuth/ebayOAuthService"
import type { RouteDefinition, ServerConfig } from "./httpTypes"
import type { AdminRequest }                  from "../admin/adminTypes"
import { cleanupOld as cleanupOldNotifications } from "../notifications/notificationService"
import { query } from "../../db/client"
import { generateTraceId, createLogger } from "../logger/logger"
import { registerAuthRoutes } from "../auth/authRoutes"
import { registerAdminUserRoutes } from "../auth/adminUserRoutes"
import { registerAppRoutes } from "../app/appRoutes"
import { registerDesktopAgentRoutes } from "../desktopAgent/desktopAgentRoutes"
import { registerAmazonScanWorkerRoutes } from "../amazonScan/amazonScanWorkerHandlers"
import { registerOxylabsVerifyWorkerRoutes } from "../oxylabsVerify/oxylabsVerifyHandlers"
import {
  oxylabsJsonParseErrorHandler,
  skipDefaultJsonForOxylabsResult,
} from "../oxylabsVerify/oxylabsVerifyResultBody"
import { registerKeepaCollectorRoutes } from "../keepaSensor/keepaCollectorHandlers"
import {
  handleEbayNotificationChallenge,
} from "../customerService/csNotificationService"
import { handleEbayNotificationEvent } from "../customerService/ebayNotificationWebhook"
import { registerChatGptAppRoutes } from "../chatgptApp"
import { deleteExpiredSessions } from "../auth/sessionRepository"
import { sessionRetentionDays } from "../auth/sessionToken"
import { handlePostAutoRestockRunOnce } from "../orders/soldItemAutoRestockRoutes"
import { handleGetKeepaMonitorDashboard } from "../globalKeepa/keepaMonitorDashboard"
import { handleGetAmazonScanDashboard } from "../amazonScan/amazonScanAdminDashboard"
import {
  handleGetPlatformAmazonVerificationStatus,
  handlePostPlatformAmazonVerificationTestTask,
} from "../amazonVerification/amazonVerificationAdminStatus"
import {
  handleGetAmazonWorkerAdminStatus,
  handlePostAmazonWorkerPause,
  handlePostAmazonWorkerResetSecret,
  handlePostAmazonWorkerResume,
  handlePutAmazonWorkerAccount,
} from "../amazonBrowserWorker/amazonWorkerAdminHandlers"
import {
  createRateLimiter, csrfProtection, isAllowedBrowserOrigin, isInternalScraperApiPath,
  internalScraperRateLimitKey, publicInternalError, requireLegacyAdminAccess,
  secureHeaders,
} from "../security/httpSecurity"

function adapt(handler: (req: AdminRequest) => Promise<{ status: number; body: unknown }>) {
  return async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const result = await handler({
        query:   req.query  as Record<string, string | undefined>,
        params:  req.params as Record<string, string | undefined>,
        body:    req.body,
        traceId: typeof req.headers["x-trace-id"] === "string" ? req.headers["x-trace-id"] : undefined,
      })
      if (result.status >= 500 && process.env.NODE_ENV === "production") {
        res.status(result.status).json(publicInternalError())
        return
      }
      res.status(result.status).json(result.body)
    } catch (e) {
      console.error("[HTTP] Unhandled:", e)
      res.status(500).json(publicInternalError())
    }
  }
}

function handleGetPoolWithLog(req: AdminRequest) {
  console.log("[Pool] query params:", req.query)
  return handleGetPool(req)
}

function getWorkspaceId(): string {
  const id = process.env.WORKSPACE_ID
  if (!id) throw new Error('WORKSPACE_ID is not defined')
  return id
}

async function handlePostVideoCreate(req: AdminRequest): Promise<{ status: number; body: unknown }> {
  const { asin, imageUrls, title, storeCode } = req.body as {
    asin: string
    imageUrls: string[]
    title: string
    storeCode: string
  }
  try {
    console.log('[Video] Creating slideshow for:', asin)
    const videoBuffer = await createSlideshow(imageUrls, asin)
    console.log('[Video] Slideshow created, size:', videoBuffer.length)

    const workspaceId = getWorkspaceId()
    const store = await getStoreByCode(workspaceId, storeCode)
    if (!store) {
      return { status: 400, body: { ok: false, error: 'Store bulunamadı' } }
    }
    const token = await getValidAccessToken(workspaceId, storeCode, false)
    const client = new EbayApiClient({
      oauthToken: token,
      sandbox: false,
      simulationMode: false,
    })

    const videoId = await uploadVideoToEbay(videoBuffer, title, client)
    return { status: 200, body: { ok: true, videoId } }
  } catch (e) {
    console.error('[Video] Error:', e)
    return { status: 500, body: { ok: false, error: String(e) } }
  }
}

function ebayOAuthReturnUrl(): string {
  return (
    process.env.EBAY_OAUTH_RETURN_URL?.trim() ||
    "http://localhost:3000/settings?ebay_oauth=1"
  )
}

async function ebayCallbackHandler(req: express.Request, res: express.Response): Promise<void> {
  try {
    const workspaceId = process.env.WORKSPACE_ID ?? ""
    const code        = (req.query["code"]  as string) ?? ""
    const state       = (req.query["state"] as string) ?? ""
    const simulation  = (process.env.EBAY_SIMULATION ?? "true") !== "false"
    await ebayHandleCallback(workspaceId, code, state, simulation)
    res.redirect(302, ebayOAuthReturnUrl())
  } catch (e) {
    console.error("[OAuth callback]", e)
    res.status(500).json({ error: "OAuthError", message: "OAuth callback failed" })
  }
}

const routes: RouteDefinition[] = [
  { method: "get",  path: "/admin/summary",                handler: adapt(handleGetSummary)       },
  { method: "get",  path: "/admin/queue",                  handler: adapt(handleGetQueue)         },
  { method: "get",  path: "/admin/history",                handler: adapt(handleGetHistory)       },
  { method: "get",  path: "/admin/stores",                 handler: adapt(handleGetStores)        },
  { method: "get",  path: "/admin/notifications",          handler: adapt(handleGetNotifications) },
  { method: "post", path: "/admin/notifications/read",     handler: adapt(handlePostNotificationsRead) },
  { method: "post", path: "/admin/notifications/read-all", handler: adapt(handlePostNotificationsReadAll) },
  { method: "post", path: "/admin/stores/create",        handler: adapt(handlePostCreateStore) },
  { method: "get",  path: "/admin/pool",                   handler: adapt(handleGetPoolWithLog) },
  { method: "post", path: "/admin/pool/dispatch-selected", handler: adapt(handlePostPoolDispatch) },
  { method: "post", path: "/admin/pool/delete-selected", handler: adapt(handlePostPoolDeleteSelected) },
  { method: "delete", path: "/admin/pool",               handler: adapt(handleDeletePoolItems) },
  { method: "post",   path: "/admin/pool/restore",       handler: adapt(handlePostPoolRestore) },
  { method: "post",   path: "/admin/pool/schedule-publish", handler: adapt(handlePostSchedulePublish) },
  { method: "get",    path: "/admin/pool/schedule-commands", handler: adapt(handleGetScheduleCommands) },
  { method: "get",    path: "/admin/pool/schedule-commands/:id", handler: adapt(handleGetScheduleCommandById) },
  { method: "get",    path: "/admin/pool/schedule-commands/:id/jobs", handler: adapt(handleGetScheduleCommandJobs) },
  { method: "post",   path: "/admin/pool/schedule-commands/:id/cancel", handler: adapt(handlePostScheduleCommandCancel) },
  { method: "post",   path: "/admin/pool/schedule-commands/:id/pause", handler: adapt(handlePostScheduleCommandPause) },
  { method: "post",   path: "/admin/pool/schedule-commands/:id/resume", handler: adapt(handlePostScheduleCommandResume) },
  { method: "post",   path: "/admin/pool/schedule-runner/run-due", handler: adapt(handlePostScheduleRunnerRunDue) },
  { method: "get",    path: "/admin/pool/schedule-runner/status", handler: adapt(handleGetScheduleRunnerStatus) },
  { method: "post",   path: "/admin/pool/schedule-runner/run-live-one", handler: adapt(handlePostScheduleRunnerRunLiveOne) },
  { method: "get",    path: "/admin/pool/category-preferences", handler: adapt(handleGetPoolCategoryPreferences) },
  { method: "put",    path: "/admin/pool/category-preferences", handler: adapt(handlePutPoolCategoryPreferences) },
  { method: "post", path: "/admin/listing/run",            handler: adapt(handlePostListingRun)   },
  { method: "post", path: "/admin/dispatch-runs/create", handler: adapt(handlePostDispatchRunCreate) },
  { method: "post", path: "/admin/dispatch-jobs/claim-next", handler: adapt(handlePostDispatchJobClaimNext) },
  { method: "post", path: "/admin/dispatch-jobs/report",    handler: adapt(handlePostDispatchJobReport) },
  { method: "post", path: "/admin/dispatch-jobs/cleanup-stale", handler: adapt(handlePostDispatchJobsCleanupStale) },
  { method: "get",  path: "/admin/dispatch-runs/status",  handler: adapt(handleGetDispatchRunStatus) },
  { method: "get",  path: "/admin/dispatch-runs/active",  handler: adapt(handleGetDispatchActiveRuns) },
  { method: "get",  path: "/admin/ebay/connect-url",       handler: adapt(handleGetEbayConnectUrl)    },
  { method: "post", path: "/admin/ebay/auth-url", handler: adapt(handlePostEbayAuthUrl)     },
  { method: "post", path: "/admin/ebay/connect", handler: adapt(handlePostEbayConnect)     },
  { method: "get",  path: "/admin/ebay/account-status",    handler: adapt(handleGetEbayAccountStatus) },
  { method: "get",  path: "/admin/ebay/accounts",          handler: adapt(handleGetEbayAccounts)      },
  { method: "post", path: "/admin/ebay/oauth/reconnect", handler: adapt(handlePostEbayOAuthReconnect) },
  { method: "post", path: "/admin/ebay/refresh",           handler: adapt(handlePostEbayRefresh)      },
  { method: "post", path: "/admin/ebay/disconnect",        handler: adapt(handlePostEbayDisconnect) },
  { method: "post", path: "/admin/monitor/update-price",   handler: adapt(handlePostMonitorUpdatePrice) },
  { method: "post", path: "/admin/monitor/update-stock",   handler: adapt(handlePostMonitorUpdateStock) },
  { method: "post", path: "/admin/monitor/blind",          handler: adapt(handlePostMonitorBlind)       },
  { method: "post", path: "/admin/monitor/update-source-url", handler: adapt(handlePostMonitorUpdateSourceUrl) },
  { method: "post", path: "/admin/listings/import-match",   handler: adapt(handlePostListingsImportMatch) },
  { method: "post", path: "/admin/listings/stock-guard",      handler: adapt(handlePostListingsStockGuard) },
  { method: "post", path: "/admin/listings/remove-from-list", handler: adapt(handlePostListingsRemoveFromList) },
  { method: "post", path: "/admin/listings/restore-to-list",  handler: adapt(handlePostListingsRestoreToList) },
  { method: "get",  path: "/admin/listings/recommended-price", handler: adapt(handleGetListingsRecommendedPrice) },
  { method: "post", path: "/admin/listings/update-ebay-price", handler: adapt(handlePostListingsUpdateEbayPrice) },
  { method: "post", path: "/admin/listings/update-source-asin", handler: adapt(handlePostListingsUpdateSourceAsin) },
  { method: "post", path: "/admin/listings/source-status",    handler: adapt(handlePostListingsSourceStatus) },
  { method: "post", path: "/admin/listings/end",              handler: adapt(handlePostListingsEnd) },
  { method: "post", path: "/admin/listings/sync-listings",        handler: adapt(handlePostListingsSyncListings) },
  { method: "post", path: "/admin/store-sync/queue-tick",      handler: adapt(handlePostStoreSyncQueueTick) },
  { method: "post", path: "/admin/listings/sync-30d-clicks",    handler: adapt(handlePostListingsSync30dClicks) },
  { method: "post", path: "/admin/listings/sync-metrics",       handler: adapt(handlePostListingsSyncMetrics) },
  { method: "get",  path: "/admin/keepa/status",               handler: adapt(handleGetKeepaStatus) },
  { method: "post", path: "/admin/keepa/check-asin",           handler: adapt(handlePostKeepaCheckAsin) },
  { method: "post", path: "/admin/keepa/check-asins",          handler: adapt(handlePostKeepaCheckAsins) },
  { method: "post", path: "/admin/keepa/scan-store",           handler: adapt(handlePostKeepaScanStore) },
  { method: "post", path: "/admin/keepa/create-review-from-current-status", handler: adapt(handlePostKeepaCreateReviewFromCurrentStatus) },
  { method: "get",  path: "/admin/listings/store-debug",          handler: adapt(handleGetListingsStoreDebug) },
  { method: "get",  path: "/admin/monitor/listings",       handler: adapt(handleGetMonitorListings) },
  { method: "post", path: "/admin/asins/import",           handler: adapt(handlePostAsinImport)   },
  { method: "post", path: "/admin/extension-capture-jobs", handler: adapt(handlePostExtensionCaptureJobs) },
  { method: "post", path: "/admin/extension-capture-jobs/claim-next", handler: adapt(handlePostExtensionCaptureClaimNext) },
  { method: "get",  path: "/admin/extension-capture-jobs/active", handler: adapt(handleGetActiveExtensionCaptureJobs) },
  { method: "get",  path: "/admin/extension-capture-jobs/:commandId", handler: adapt(handleGetExtensionCaptureJob) },
  { method: "post", path: "/admin/extension-capture-jobs/:commandId/cancel", handler: adapt(handlePostExtensionCaptureJobCancel) },
  { method: "post", path: "/admin/extension-capture-jobs/:commandId/items/:itemId/start-capture", handler: adapt(handlePostExtensionCaptureItemStart) },
  { method: "post", path: "/admin/extension-capture-jobs/:commandId/items/:itemId/capture", handler: adapt(handlePostExtensionCaptureItemSubmit) },
  { method: "post", path: "/admin/extension-capture-jobs/:commandId/items/:itemId/fail", handler: adapt(handlePostExtensionCaptureItemFail) },
  { method: "post", path: "/admin/product/extract",        handler: adapt(handlePostProductExtract) },
  { method: "post", path: "/admin/ai-listing/generate",      handler: adapt(handlePostAiListingGenerate) },
  { method: "post", path: "/admin/dispatch",               handler: adapt(handlePostDispatch)     },
  { method: "post", path: "/admin/publish/run",            handler: adapt(handlePostPublishRun)   },
  // Settings (panel /settings)
  { method: "get",  path: "/admin/settings",               handler: adapt(handleGetSettings)            },
  { method: "post", path: "/admin/settings/address",       handler: adapt(handlePostSettingsAddress)    },
  { method: "get",  path: "/admin/settings/policies",      handler: adapt(handleGetSettingsPolicies)    },
  { method: "post", path: "/admin/settings/policies",      handler: adapt(handlePostSettingsPolicies)   },
  { method: "post", path: "/admin/settings/markup",        handler: adapt(handlePostSettingsMarkup)     },
  { method: "post", path: "/admin/settings/pricing",       handler: adapt(handlePostSettingsPricing)    },
  { method: "post", path: "/admin/settings/warehouse-banner", handler: adapt(handlePostSettingsWarehouseBanner) },
  { method: "post", path: "/admin/variation/extract",      handler: adapt(handlePostVariationExtract) },
  { method: "post", path: "/admin/variation/generate-ai",  handler: adapt(handlePostVariationGenerateAi) },
  { method: "post", path: "/admin/variation/publish",      handler: adapt(handlePostVariationPublish) },
  { method: "get",  path: "/admin/variation/list",         handler: adapt(handleGetVariationList) },
  { method: "post", path: "/admin/video/create-and-upload", handler: adapt(handlePostVideoCreate) },
  { method: "get",  path: "/admin/orders",                  handler: adapt(handleGetOrders) },
  { method: "post", path: "/admin/orders/sync",             handler: adapt(handlePostOrdersSync) },
  { method: "post", path: "/admin/orders/auto-restock/run-once", handler: adapt(handlePostAutoRestockRunOnce) },
  { method: "get",  path: "/admin/orders/:orderId/assist",  handler: adapt(handleGetOrderAssist) },
  { method: "patch", path: "/admin/orders/:orderId/assist-asin", handler: adapt(handlePatchOrderAsin) },
  { method: "post", path: "/admin/orders/:orderId/earnings", handler: adapt(handlePostOrderEarnings) },
  { method: "get",  path: "/admin/orders/:orderId",         handler: adapt(handleGetOrderDetail) },
  { method: "patch", path: "/admin/orders/:orderId",        handler: adapt(handlePatchOrder) },
  { method: "get",  path: "/admin/stock-alerts",            handler: adapt(handleGetStockAlerts) },
  { method: "post", path: "/admin/stock-alerts/ignore",     handler: adapt(handlePostStockAlertsIgnore) },
  { method: "post", path: "/admin/stock-alerts/approve-zero", handler: adapt(handlePostStockAlertsApproveZero) },
  { method: "get",  path: "/admin/stock-guard/status",           handler: adapt(handleGetStockGuardStatus) },
  { method: "post", path: "/admin/stock-guard/scheduler/tick",    handler: adapt(handlePostStockGuardSchedulerTick) },
  { method: "post", path: "/admin/stock-guard/scheduler-tick",   handler: adapt(handlePostStockGuardSchedulerTick) },
  { method: "post", path: "/admin/stock-guard/jobs/run-next",    handler: adapt(handlePostStockGuardRunNext) },
  { method: "post", path: "/admin/stock-guard/jobs/requeue",     handler: adapt(handlePostStockGuardRequeueJob) },
  { method: "get",  path: "/admin/stock-guard/settings",         handler: adapt(handleGetStockGuardSettings) },
  { method: "post", path: "/admin/stock-guard/settings",         handler: adapt(handlePostStockGuardSettings) },
  { method: "post", path: "/admin/stock-guard/cleanup",          handler: adapt(handlePostStockGuardCleanup) },
  { method: "get",  path: "/admin/platform/keepa-monitor/status", handler: adapt(async () => handleGetKeepaMonitorDashboard()) },
  { method: "get",  path: "/admin/platform/amazon-scan/dashboard", handler: adapt(async () => handleGetAmazonScanDashboard()) },
  { method: "get",  path: "/admin/platform/amazon-verification/status", handler: adapt(async () => handleGetPlatformAmazonVerificationStatus()) },
  { method: "post", path: "/admin/platform/amazon-verification/test-task", handler: adapt(async req => handlePostPlatformAmazonVerificationTestTask((req.body ?? {}) as Record<string, unknown>)) },
  { method: "get",  path: "/admin/platform/amazon-worker", handler: adapt(async () => handleGetAmazonWorkerAdminStatus()) },
  { method: "put",  path: "/admin/platform/amazon-worker", handler: adapt(async req => handlePutAmazonWorkerAccount((req.body ?? {}) as Record<string, unknown>)) },
  { method: "post", path: "/admin/platform/amazon-worker/pause", handler: adapt(async () => handlePostAmazonWorkerPause()) },
  { method: "post", path: "/admin/platform/amazon-worker/resume", handler: adapt(async () => handlePostAmazonWorkerResume()) },
  { method: "post", path: "/admin/platform/amazon-worker/reset-secret", handler: adapt(async req => handlePostAmazonWorkerResetSecret((req.body ?? {}) as Record<string, unknown>)) },
]

export function buildApp(config: ServerConfig): express.Application {
  const app = express()
  const proxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "0", 10)
  if (Number.isInteger(proxyHops) && proxyHops > 0) app.set("trust proxy", proxyHops)
  app.use(cookieParser())
  app.use(skipDefaultJsonForOxylabsResult(express.json()))
  app.use(express.urlencoded({ extended: false }))
  app.use(secureHeaders)
  // Mount before restrictive panel CORS so ChatGPT tunnel clients can reach /mcp.
  // No-op unless CHATGPT_APP_MCP_ENABLED=true (and not production).
  registerChatGptAppRoutes(app)
  const configuredOrigins = (config.corsOrigins ?? []).map((o) => o.trim()).filter(Boolean)
  const extensionOrigins = (process.env.CHROME_EXTENSION_IDS ?? "")
    .split(",").map(id => id.trim()).filter(Boolean).map(id => `chrome-extension://${id}`)
  const allowedOrigins: string[] = [
    ...configuredOrigins,
    "https://panel.listjetgo.com",
    "https://api.listjetgo.com",
    "https://app.listjetgo.com",
    ...(process.env.NODE_ENV === "production" ? [] : [
      "http://localhost:3000", "http://127.0.0.1:3000",
      "http://localhost:3001", "http://localhost:3010",
    ]),
    ...extensionOrigins,
  ]
  const allowedOriginSet = new Set(allowedOrigins)
  app.use(
    cors({
      origin: function (origin, callback) {
        // No Origin (curl/server proxy) or allowlisted browser origin.
        // Unknown origins must not throw: cors treats Error as a 500 INTERNAL_ERROR.
        if (!origin || allowedOriginSet.has(origin) || isAllowedBrowserOrigin(origin)) {
          callback(null, true)
        } else {
          callback(null, false)
        }
      },
      credentials: true,
      preflightContinue: false,
      optionsSuccessStatus: 204,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Accept",
        "X-Requested-With",
        "X-Trace-Id",
        "X-Workspace-Id",
      ],
    })
  )
  app.use(csrfProtection)
  const generalLimiter = createRateLimiter({ name: "general", windowMs: 60_000, max: 300 })
  const loginLimiter = createRateLimiter({ name: "auth-login", windowMs: 15 * 60_000, max: 10, includeEmail: true })
  const authLimiter = createRateLimiter({ name: "auth-register", windowMs: 15 * 60_000, max: 30 })
  const keepaCollectorObservationsLimiter = createRateLimiter({
    name: "keepa-collector-observations",
    windowMs: 60_000,
    max: 4000,
    keyFn: req => internalScraperRateLimitKey(req),
  })
  const keepaCollectorControlLimiter = createRateLimiter({
    name: "keepa-collector-control",
    windowMs: 60_000,
    max: 300,
    keyFn: req => internalScraperRateLimitKey(req),
  })
  const amazonScanWorkerLimiter = createRateLimiter({
    name: "amazon-scan-worker",
    windowMs: 60_000,
    max: 180,
    keyFn: req => internalScraperRateLimitKey(req, String((req.body as { workerId?: unknown } | undefined)?.workerId ?? "")),
  })
  const oxylabsVerifyWorkerLimiter = createRateLimiter({
    name: "oxylabs-verify-worker",
    windowMs: 60_000,
    max: 180,
    keyFn: req => internalScraperRateLimitKey(req, String((req.body as { workerId?: unknown } | undefined)?.workerId ?? "")),
  })
  app.use((req, res, next) => {
    if (isInternalScraperApiPath(req.path)) return next()
    if (req.path === "/webhooks/ebay-notifications") return next()
    if (req.path.startsWith("/admin/") && req.path !== "/admin/ebay/callback") return next()
    generalLimiter(req, res, next)
  })
  app.use("/internal/keepa-collector/observations", keepaCollectorObservationsLimiter)
  app.use("/internal/keepa-collector", (req, res, next) => {
    const pathName = String(req.originalUrl || req.path || "").split("?")[0]
    if (pathName.startsWith("/internal/keepa-collector/observations")) return next()
    keepaCollectorControlLimiter(req, res, next)
  })
  app.use("/internal/amazon-scan", amazonScanWorkerLimiter)
  app.use("/internal/oxylabs-verify", oxylabsVerifyWorkerLimiter)
  app.use("/auth/login", loginLimiter)
  app.use("/auth/google/credential", createRateLimiter({ name: "auth-google", windowMs: 15 * 60_000, max: 20 }))
  app.use(["/auth/register", "/auth/verify-email"], authLimiter)
  // Claim stays IP-scoped and isolated; create is rate-limited after auth (user+workspace) in routes.
  app.use(
    "/api/desktop-agent/pairing/claim",
    createRateLimiter({ name: "desktop-agent-pairing-claim", windowMs: 15 * 60_000, max: 20 })
  )
  app.use((req, res, next) => {
    if (!req.path.startsWith("/admin/") || req.path === "/admin/ebay/callback") return next()
    void requireLegacyAdminAccess(req, res, next)
  })
  app.use((req, _res, next) => { console.log(`[HTTP] ${req.method} ${req.path}`); next() })
  app.use((req, res, next) => {
    if (req.path === "/app/listings/set-quantity" || req.path === "/app/listings/bulk-set-quantity") {
      const startedAt = Date.now()
      res.once("finish", () => {
        console.log(`[HTTP] complete ${req.method} ${req.path} status=${res.statusCode} durationMs=${Date.now() - startedAt}`)
      })
    }
    next()
  })
  // Her request'e traceId ekle
  app.use((req, res, next) => {
    const traceId = generateTraceId()
    req.headers["x-trace-id"] = traceId
    res.setHeader("x-trace-id", traceId)

    const logger = createLogger("api", traceId)
    logger.info(`${req.method} ${req.path}`, {
      asin:    req.body?.asin || req.query?.asin as string || undefined,
      storeId: req.body?.storeCode || req.query?.storeCode as string || undefined,
    })

    next()
  })
  for (const r of routes) {
    const method = r.method.toLowerCase() as "get" | "post" | "put" | "delete" | "patch"
    app[method](r.path, r.handler)
  }
  registerAuthRoutes(app)
  registerAdminUserRoutes(app)
  registerAppRoutes(app)
  registerDesktopAgentRoutes(app)
  registerAmazonScanWorkerRoutes(app)
  registerOxylabsVerifyWorkerRoutes(app)
  registerKeepaCollectorRoutes(app)
  app.get("/admin/ebay/callback", ebayCallbackHandler)
  app.get("/webhooks/ebay-notifications", (req, res) => {
    void handleEbayNotificationChallenge(String(req.query.challenge_code ?? "")).then(result => {
      res.status(result.status).json(result.body)
    }).catch(() => {
      res.status(500).json({ error: "challenge failed" })
    })
  })
  app.post("/webhooks/ebay-notifications", (req, res) => {
    void handleEbayNotificationEvent(req, res).catch(() => {
      if (!res.headersSent) res.status(500).json({ error: "notification handling failed" })
    })
  })
  app.get("/health", async (_req, res) => {
    try {
      await query("SELECT 1")

      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        services: {
          db: "ok",
          api: "ok",
        },
      })
    } catch (err) {
      console.error("[Health] database check failed:", err)
      res.status(500).json({
        status: "degraded",
        timestamp: new Date().toISOString(),
      })
    }
  })
  app.use(oxylabsJsonParseErrorHandler)
  app.use((_req, res) => res.status(404).json({ error: "NotFound", message: "Route not found" }))
  app.use((e: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    console.error("[HTTP] Unhandled middleware error:", e)
    res.status(500).json(publicInternalError())
  })
  return app
}

export function startServer(config: ServerConfig): void {
  const app = buildApp(config)
  app.listen(config.port, () => {
    const wid = process.env.WORKSPACE_ID ?? ""
    if (wid) void cleanupOldNotifications(wid)
    void deleteExpiredSessions(sessionRetentionDays()).catch(error => console.warn("[Session] cleanup failed:", error instanceof Error ? error.message : String(error)))
    console.log("=".repeat(60))
    console.log(`  HTTP Server - port ${config.port}`)
    routes.forEach(r => console.log(`  ${r.method.toUpperCase().padEnd(5)} ${r.path}`))
    console.log(`  CORS: ${config.corsOrigins.join(", ")}`)
    console.log("=".repeat(60))
  })
}
