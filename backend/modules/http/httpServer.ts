// ----------------------------------------------------------------
// httpServer.ts
// ----------------------------------------------------------------

import express from "express"
import cors    from "cors"
import {
  handleGetSummary, handleGetQueue, handleGetHistory, handleGetStores,
  handleGetPool, handlePostPoolDispatch, handlePostListingRun, handleDeletePoolItems,
  handlePostDispatchRunCreate, handlePostDispatchJobClaimNext, handlePostDispatchJobReport,
  handleGetDispatchRunStatus, handleGetDispatchActiveRuns,
  handleGetEbayConnectUrl, handleGetEbayCallback, handleGetEbayAccountStatus, handleGetEbayAccounts, handlePostEbayRefresh, handleGetMonitorListings, handlePostMonitorUpdatePrice, handlePostMonitorUpdateStock, handlePostMonitorBlind, handlePostAsinImport, handlePostProductExtract, handlePostAiListingGenerate, handlePostDispatch, handlePostPublishRun,
  handlePostCreateStore, handlePostEbayDisconnect, handlePostDispatchJobsCleanupStale,
  handleGetSettings, handlePostSettingsAddress, handleGetSettingsPolicies, handlePostSettingsPolicies, handlePostSettingsMarkup,
  handleGetNotifications, handlePostNotificationsRead, handlePostNotificationsReadAll,
} from "../admin/adminRoutes"
import { handleCallback as ebayHandleCallback } from "../ebayOAuth/ebayOAuthService"
import type { RouteDefinition, ServerConfig } from "./httpTypes"
import type { AdminRequest }                  from "../admin/adminTypes"
import { cleanupOld as cleanupOldNotifications } from "../notifications/notificationService"
import { db as pool } from "../../db/client"
import { generateTraceId, createLogger } from "../logger/logger"

function adapt(handler: (req: AdminRequest) => Promise<{ status: number; body: unknown }>) {
  return async (req: express.Request, res: express.Response): Promise<void> => {
    try {
      const result = await handler({
        query:  req.query  as Record<string, string | undefined>,
        params: req.params as Record<string, string | undefined>,
        body:   req.body,
      })
      res.status(result.status).json(result.body)
    } catch (e) {
      console.error("[HTTP] Unhandled:", e)
      res.status(500).json({ error: "InternalServerError", message: e instanceof Error ? e.message : "Unknown" })
    }
  }
}

function handleGetPoolWithLog(req: AdminRequest) {
  console.log("[Pool] query params:", req.query)
  return handleGetPool(req)
}

async function ebayCallbackHandler(req: express.Request, res: express.Response): Promise<void> {
  try {
    const workspaceId = process.env.WORKSPACE_ID ?? ""
    const code        = (req.query["code"]  as string) ?? ""
    const state       = (req.query["state"] as string) ?? ""
    const simulation  = (process.env.EBAY_SIMULATION ?? "true") !== "false"
    await ebayHandleCallback(workspaceId, code, state, simulation)
    res.redirect(302, "http://localhost:3000/stores")
  } catch (e) {
    console.error("[OAuth callback]", e)
    res.status(500).json({ error: "OAuthError", message: e instanceof Error ? e.message : "Unknown" })
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
  { method: "delete", path: "/admin/pool",               handler: adapt(handleDeletePoolItems) },
  { method: "post", path: "/admin/listing/run",            handler: adapt(handlePostListingRun)   },
  { method: "post", path: "/admin/dispatch-runs/create", handler: adapt(handlePostDispatchRunCreate) },
  { method: "post", path: "/admin/dispatch-jobs/claim-next", handler: adapt(handlePostDispatchJobClaimNext) },
  { method: "post", path: "/admin/dispatch-jobs/report",    handler: adapt(handlePostDispatchJobReport) },
  { method: "post", path: "/admin/dispatch-jobs/cleanup-stale", handler: adapt(handlePostDispatchJobsCleanupStale) },
  { method: "get",  path: "/admin/dispatch-runs/status",  handler: adapt(handleGetDispatchRunStatus) },
  { method: "get",  path: "/admin/dispatch-runs/active",  handler: adapt(handleGetDispatchActiveRuns) },
  { method: "get",  path: "/admin/ebay/connect-url",       handler: adapt(handleGetEbayConnectUrl)    },
  { method: "get",  path: "/admin/ebay/account-status",    handler: adapt(handleGetEbayAccountStatus) },
  { method: "get",  path: "/admin/ebay/accounts",          handler: adapt(handleGetEbayAccounts)      },
  { method: "post", path: "/admin/ebay/refresh",           handler: adapt(handlePostEbayRefresh)      },
  { method: "post", path: "/admin/ebay/disconnect",        handler: adapt(handlePostEbayDisconnect) },
  { method: "post", path: "/admin/monitor/update-price",   handler: adapt(handlePostMonitorUpdatePrice) },
  { method: "post", path: "/admin/monitor/update-stock",   handler: adapt(handlePostMonitorUpdateStock) },
  { method: "post", path: "/admin/monitor/blind",          handler: adapt(handlePostMonitorBlind)       },
  { method: "get",  path: "/admin/monitor/listings",       handler: adapt(handleGetMonitorListings) },
  { method: "post", path: "/admin/asins/import",           handler: adapt(handlePostAsinImport)   },
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
]

export function buildApp(config: ServerConfig): express.Application {
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))
  app.use(
    cors({
      origin: function (origin, callback) {
        const allowed = [
          "http://localhost:3000",
          "http://localhost:3001",
        ]
        // chrome extension ve null origin'e izin ver
        if (!origin || allowed.includes(origin) || String(origin).startsWith("chrome-extension://")) {
          callback(null, true)
        } else {
          callback(new Error("Not allowed by CORS"))
        }
      },
      credentials: true,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
    })
  )
  app.use((req, _res, next) => { console.log(`[HTTP] ${req.method} ${req.path}`); next() })
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
  app.get("/admin/ebay/callback", ebayCallbackHandler)
  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1")

      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        services: {
          db: "ok",
          api: "ok",
        },
      })
    } catch (err) {
      res.status(500).json({
        status: "error",
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
  app.use((_req, res) => res.status(404).json({ error: "NotFound", message: "Route not found" }))
  app.use((e: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: "InternalServerError", message: e.message })
  })
  return app
}

export function startServer(config: ServerConfig): void {
  const app = buildApp(config)
  app.listen(config.port, () => {
    const wid = process.env.WORKSPACE_ID ?? ""
    if (wid) void cleanupOldNotifications(wid)
    console.log("=".repeat(60))
    console.log(`  HTTP Server - port ${config.port}`)
    routes.forEach(r => console.log(`  ${r.method.toUpperCase().padEnd(5)} ${r.path}`))
    console.log(`  CORS: ${config.corsOrigins.join(", ")}`)
    console.log("=".repeat(60))
  })
}
