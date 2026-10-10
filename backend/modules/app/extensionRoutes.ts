import type { Express, Request, Response } from "express"
import type { AuthedRequest } from "../auth/authMiddleware"
import {
  resolveExtensionAuth,
  localExtensionTestAuthAllowed,
  issueLocalExtensionTestToken,
  issueLocalUnpackedToken,
  issueExtensionTokenFromWebSession,
} from "./extensionAuth"
import { getAuthenticatedWorkspaceId, resolveOwnedStoreForExtension } from "./appOwnership"
import { AppHttpError } from "./appTypes"
import { getAdminStores, getPoolRows, dispatchSelectedPool, resolvePoolIdsFromAsins, parsePoolView } from "../admin/adminService"
import { extractAndSaveProduct } from "../productExtractor/productExtractorService"
import { runTimedPublishForStore } from "../publishQueue/publishQueueService"
import { splitEligiblePoolItems } from "../pool/poolEligibilityService"
import { parseTitleMode } from "../titleBot/titleBotService"
import {
  cancelExtensionCaptureCommand,
  getExtensionCaptureCommand,
  listActiveExtensionCaptureCommands,
  createExtensionCaptureCommand,
  startExtensionCaptureItem,
  submitExtensionCaptureItem,
  failExtensionCaptureItem,
  claimNextCaptureItem,
  retryExtensionCaptureItemPromotion,
} from "../extensionCapture/extensionCaptureService"
import {
  handleClaimNextVerification,
  handleExtensionWorkerHeartbeat,
  handleExtensionWorkerStatus,
  handleVerificationFail,
  handleVerificationResult,
  handleVerificationStart,
} from "../amazonVerification/amazonVerificationExtensionHandlers"

function sendError(res: Response, e: unknown): void {
  if (e instanceof AppHttpError) { res.status(e.status).json({ ok: false, error: e.message }); return }
  console.error("[ExtensionApp]", e); res.status(500).json({ ok: false, error: process.env.NODE_ENV === "production" ? "INTERNAL_ERROR" : String(e) })
}
async function active(req: Request, res: Response, fn: (r: AuthedRequest) => Promise<unknown>): Promise<void> {
  const authed = req as AuthedRequest
  try {
    const ctx = await resolveExtensionAuth(authed)
    if (!ctx) { res.status(401).json({ ok: false, error: "Extension authentication required" }); return }
    authed.auth = ctx
    await fn(authed)
  } catch (e) { sendError(res, e) }
}
const json = (req: Request) => (req.body ?? {}) as Record<string, any>
const id = (x: unknown) => { const n = Number(x); return Number.isInteger(n) && n > 0 ? n : null }

export function registerExtensionRoutes(app: Express): void {
  app.post("/app/extension/local-test-token", async (req, res) => {
    const host = typeof req.headers.host === "string" ? req.headers.host : ""
    if (!localExtensionTestAuthAllowed(host)) {
      res.status(404).json({ ok: false, error: "Not found" })
      return
    }
    const key = String((req.body as { key?: unknown } | undefined)?.key ?? "")
    const issued = await issueLocalExtensionTestToken(key)
    if (!issued) {
      res.status(401).json({ ok: false, error: "Extension authentication required" })
      return
    }
    res.json({ ok: true, accessToken: issued.accessToken, expiresAt: issued.expiresAt })
  })
  app.post("/app/extension/local-unpacked-token", async (req, res) => {
    const host = typeof req.headers.host === "string" ? req.headers.host : ""
    if (!localExtensionTestAuthAllowed(host)) {
      res.status(404).json({ ok: false, error: "Not found" })
      return
    }
    const issued = issueLocalUnpackedToken()
    if (!issued) {
      res.status(401).json({ ok: false, error: "Extension authentication required" })
      return
    }
    res.json({ ok: true, accessToken: issued.accessToken, expiresAt: issued.expiresAt })
  })
  /** Canonical web session (listjetgo_session) → existing extension JWT. */
  app.post("/app/extension/session", async (req, res) => {
    try {
      const issued = await issueExtensionTokenFromWebSession(req)
      if (!issued) {
        res.status(401).json({ ok: false, error: "Authentication required" })
        return
      }
      res.json({ ok: true, accessToken: issued.accessToken, expiresAt: issued.expiresAt })
    } catch (e) {
      sendError(res, e)
    }
  })
  app.get("/app/extension/stores", (q, s) => active(q, s, async r => s.json(await getAdminStores(getAuthenticatedWorkspaceId(r)))))
  app.get("/app/extension/pool", (q, s) => active(q, s, async r => { const x = q.query as Record<string, string>; s.json(await getPoolRows(getAuthenticatedWorkspaceId(r), { view: parsePoolView(x.view), asin: x.asin || null, storeCode: x.storeCode || null, limit: x.limit ? Number(x.limit) : undefined })) }))
  app.post("/app/extension/product/extract", (q, s) => active(q, s, async r => { const b = json(q); if (!b.asin) throw new AppHttpError(400, "asin is required"); s.json(await extractAndSaveProduct(getAuthenticatedWorkspaceId(r), { ...b, source: b.source || "amazon", external_id: b.external_id ?? null } as any)) }))
  app.post("/app/extension/pool/dispatch-selected", (q, s) => active(q, s, async r => {
    const b = json(q)
    const w = getAuthenticatedWorkspaceId(r)
    const store = await resolveOwnedStoreForExtension(w, b)
    const ids = Array.isArray(b.poolIds) ? b.poolIds.map(id).filter((x): x is number => x !== null) : []
    const asins = Array.isArray(b.asins) ? b.asins.map(String).map(x => x.trim().toUpperCase()).filter(Boolean) : []
    if (!ids.length && !asins.length) throw new AppHttpError(400, "poolIds or asins must be provided")
    const resolved = asins.length ? await resolvePoolIdsFromAsins(w, asins) : { poolIds: [], skipDetails: [] }
    s.json(await dispatchSelectedPool(w, [...new Set([...ids, ...resolved.poolIds])], store.storeCode, resolved.skipDetails, store.id))
  }))
  app.post("/app/extension/publish/run", (q, s) => active(q, s, async r => {
    const b = json(q)
    const w = getAuthenticatedWorkspaceId(r)
    const store = await resolveOwnedStoreForExtension(w, b)
    const ids = Array.isArray(b.poolIds) ? b.poolIds.map(id).filter((x): x is number => x !== null) : []
    const target = ids.length ? (await splitEligiblePoolItems(w, ids)).eligibleIds : undefined
    const result = await runTimedPublishForStore({
      workspaceId: w,
      storeCode: store.storeCode,
      storeId: store.id,
      delaySeconds: Number(b.delaySeconds ?? 0),
      limit: Number(b.limit ?? 1),
      dryRun: b.dryRun === true,
      simulationMode: b.simulationMode === true,
      quantity: Number(b.quantity ?? 1),
      ebayOauthToken: process.env.EBAY_OAUTH_TOKEN ?? "SIM_TOKEN",
      ebaySandbox: (process.env.EBAY_SANDBOX ?? "true") !== "false",
      targetPoolIds: target,
      titleMode: parseTitleMode(undefined, undefined),
    })
    s.json({ ok: true, publish: result, poolIds: target ?? [] })
  }))
  app.post("/app/extension/capture-jobs", (q, s) => active(q, s, async r => {
    const b = json(q)
    const w = getAuthenticatedWorkspaceId(r)
    const store = await resolveOwnedStoreForExtension(w, b)
    const { parsePromotedRequest } = await import("../ebay/ebayPromotedTypes")
    const promo = parsePromotedRequest(b)
    if (!promo.ok) throw new AppHttpError(400, promo.message)
    s.json(await createExtensionCaptureCommand(w, { ...b, storeCode: store.storeCode, storeId: store.id } as any))
  }))
  app.get("/app/extension/capture-jobs/active", (q, s) => active(q, s, async r => s.json({ commands: await listActiveExtensionCaptureCommands(getAuthenticatedWorkspaceId(r)) })))
  app.post("/app/extension/capture-jobs/claim-next", (q, s) => active(q, s, async r => { const workerId = String(json(q).workerId || "").trim(); if (!workerId) throw new AppHttpError(400, "workerId is required"); s.json(await claimNextCaptureItem(getAuthenticatedWorkspaceId(r), workerId)) }))
  app.get("/app/extension/capture-jobs/:commandId", (q, s) => active(q, s, async r => s.json(await getExtensionCaptureCommand(getAuthenticatedWorkspaceId(r), Number(q.params.commandId)))))
  app.post("/app/extension/capture-jobs/:commandId/cancel", (q, s) => active(q, s, async r => s.json(await cancelExtensionCaptureCommand(getAuthenticatedWorkspaceId(r), Number(q.params.commandId)))))
  app.post("/app/extension/capture-jobs/:commandId/items/:itemId/start-capture", (q, s) => active(q, s, async r => s.json(await startExtensionCaptureItem(getAuthenticatedWorkspaceId(r), Number(q.params.commandId), Number(q.params.itemId)))))
  app.post("/app/extension/capture-jobs/:commandId/items/:itemId/capture", (q, s) => active(q, s, async r => s.json(await submitExtensionCaptureItem(getAuthenticatedWorkspaceId(r), Number(q.params.commandId), Number(q.params.itemId), json(q).capturePayload))))
  app.post("/app/extension/capture-jobs/:commandId/items/:itemId/fail", (q, s) => active(q, s, async r => s.json(await failExtensionCaptureItem(getAuthenticatedWorkspaceId(r), Number(q.params.commandId), Number(q.params.itemId), json(q) as any))))
  app.post("/app/extension/capture-jobs/:commandId/items/:itemId/promotion/retry", (q, s) => active(q, s, async r => {
    const result = await retryExtensionCaptureItemPromotion(getAuthenticatedWorkspaceId(r), Number(q.params.commandId), Number(q.params.itemId))
    s.json({ ok: true, listingId: result.listingId, promotion: result.promotion })
  }))
  app.post("/app/extension/worker/heartbeat", (q, s) => active(q, s, async r => s.json(await handleExtensionWorkerHeartbeat(r, json(q)))))
  app.get("/app/extension/worker/status", (q, s) => active(q, s, async r => s.json(await handleExtensionWorkerStatus(r))))
  app.post("/app/extension/verification/claim-next", (q, s) => active(q, s, async r => s.json(await handleClaimNextVerification(r, json(q)))))
  app.post("/app/extension/verification/:taskId/start", (q, s) => active(q, s, async r => s.json(await handleVerificationStart(r, String(q.params.taskId), json(q)))))
  app.post("/app/extension/verification/:taskId/result", (q, s) => active(q, s, async r => s.json(await handleVerificationResult(r, String(q.params.taskId), json(q)))))
  app.post("/app/extension/verification/:taskId/fail", (q, s) => active(q, s, async r => s.json(await handleVerificationFail(r, String(q.params.taskId), json(q)))))
}
