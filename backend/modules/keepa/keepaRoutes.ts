import type { AdminRequest, AdminResponse } from "../admin/adminTypes"
import { keepaCheckAsin, keepaCheckAsins } from "./keepaDecisionService"
import { loadKeepaConfig } from "./keepaClient"
import type {
  KeepaCheckAsinRequest,
  KeepaCheckAsinsRequest,
  KeepaCheckAsinResponse,
  KeepaCheckAsinsResponse,
  KeepaScanStoreRequest,
  KeepaScanStoreResponse,
  KeepaStatusResponse,
} from "./keepaTypes"
import { scanStoreSourcesWithKeepa } from "./keepaStoreScanService"
import { createReviewFromCurrentSourceStatus } from "../stockAlerts/stockAlertsService"

function ok<T>(body: T): AdminResponse<T> {
  return { status: 200, body }
}

function bad(message: string): AdminResponse<never> {
  return { status: 400, body: { error: "AdminError", message } }
}

export async function handleGetKeepaStatus(_req: AdminRequest): Promise<AdminResponse<KeepaStatusResponse>> {
  const cfg = loadKeepaConfig()
  return ok({
    ok: true,
    enabled: cfg.enabled,
    domain: cfg.domain,
    hasApiKey: Boolean(cfg.apiKey),
    dryRun: cfg.dryRun,
    offersEnabled: cfg.offersEnabled,
  })
}

export async function handlePostKeepaCheckAsin(
  req: AdminRequest
): Promise<AdminResponse<KeepaCheckAsinResponse>> {
  const body = req.body as Partial<KeepaCheckAsinRequest>
  const asin = String(body.asin ?? "").trim()
  if (!asin) return bad("asin is required")
  const workspaceId = process.env.WORKSPACE_ID?.trim()
  const result = await keepaCheckAsin(asin, workspaceId)
  return ok(result)
}

export async function handlePostKeepaCheckAsins(
  req: AdminRequest
): Promise<AdminResponse<KeepaCheckAsinsResponse>> {
  const body = req.body as Partial<KeepaCheckAsinsRequest>
  const asins = Array.isArray(body.asins) ? body.asins.map(a => String(a ?? "").trim()) : []
  if (asins.length === 0) return bad("asins is required")
  if (asins.length > 20) return bad("max 20 ASIN")

  const workspaceId = process.env.WORKSPACE_ID?.trim()
  const results = await keepaCheckAsins(asins, workspaceId)
  return ok({ ok: true, results })
}

export async function handlePostKeepaScanStore(
  req: AdminRequest
): Promise<AdminResponse<KeepaScanStoreResponse>> {
  const body = req.body as Partial<KeepaScanStoreRequest>
  const storeCode = String(body.storeCode ?? "").trim()
  const mode = String(body.mode ?? "").trim()
  if (!storeCode) return bad("storeCode is required")
  if (mode !== "all") return bad("mode must be all")

  const workspaceId = process.env.WORKSPACE_ID
  if (!workspaceId) return { status: 500, body: { error: "AdminError", message: "WORKSPACE_ID is not defined in environment" } }

  const result = await scanStoreSourcesWithKeepa(workspaceId, storeCode)
  return ok(result)
}

export async function handlePostKeepaCreateReviewFromCurrentStatus(
  req: AdminRequest
): Promise<AdminResponse<{ ok: true; created: number; updated: number; pending: number }>> {
  const body = req.body as { storeCode?: string }
  const storeCode = String(body.storeCode ?? "").trim()
  if (!storeCode) return bad("storeCode is required")

  const workspaceId = process.env.WORKSPACE_ID
  if (!workspaceId) return { status: 500, body: { error: "AdminError", message: "WORKSPACE_ID is not defined in environment" } }

  const result = await createReviewFromCurrentSourceStatus(workspaceId, storeCode)
  return ok(result)
}

