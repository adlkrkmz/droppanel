// ----------------------------------------------------------------
// extensionCaptureRoutes.ts
// ----------------------------------------------------------------

import type { AdminRequest, AdminResponse } from "../admin/adminTypes"
import {
  cancelExtensionCaptureCommand,
  claimNextCaptureItem,
  createExtensionCaptureCommand,
  failExtensionCaptureItem,
  getExtensionCaptureCommand,
  listActiveExtensionCaptureCommands,
  startExtensionCaptureItem,
  submitExtensionCaptureItem,
  retryExtensionCaptureItemPromotion,
} from "./extensionCaptureService"
import type {
  ClaimNextCaptureResponse,
  CreateExtensionCaptureRequest,
  CreateExtensionCaptureResponse,
  ExtensionCaptureCommandDetail,
  FailCaptureItemResponse,
  SubmitCapturePayloadResponse,
} from "./extensionCaptureTypes"

function getWorkspaceId(): string {
  const id = process.env.WORKSPACE_ID
  if (!id) throw new Error("WORKSPACE_ID is not defined in environment")
  return id
}

function bad(message: string): AdminResponse<never> {
  return { status: 400, body: { error: "BadRequest", message } }
}

function notFound(message: string): AdminResponse<never> {
  return { status: 404, body: { error: "NotFound", message } }
}

function err(message: string): AdminResponse<never> {
  return { status: 500, body: { error: "InternalServerError", message } }
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 1 ? n : null
}

export async function handlePostExtensionCaptureJobs(
  req: AdminRequest
): Promise<AdminResponse<CreateExtensionCaptureResponse>> {
  try {
    const body = req.body as Partial<CreateExtensionCaptureRequest>
    const operationType = body.operationType
    if (operationType !== "bulk_direct_list" && operationType !== "bulk_add_to_pool") {
      return bad("operationType must be bulk_direct_list or bulk_add_to_pool")
    }
    const storeCode = typeof body.storeCode === "string" ? body.storeCode.trim() : ""
    if (!storeCode) return bad("storeCode is required")
    const hasItems = Array.isArray(body.items) && body.items.length > 0
    const hasAsins = Array.isArray(body.asins) && body.asins.length > 0
    if (!hasItems && !hasAsins) {
      return bad("asins or items must be a non-empty array")
    }

    const result = await createExtensionCaptureCommand(getWorkspaceId(), {
      operationType,
      storeCode,
      asins: hasAsins ? body.asins!.map(String) : undefined,
      items: hasItems
        ? body.items!.map(i => ({
            asin:   String((i as { asin?: string }).asin ?? ""),
            poolId: typeof (i as { poolId?: number }).poolId === "number"
              ? (i as { poolId: number }).poolId
              : undefined,
          }))
        : undefined,
      titleMode: typeof body.titleMode === "string" ? body.titleMode : undefined,
      quantity:  typeof body.quantity === "number" ? body.quantity : undefined,
      delaySec:  typeof body.delaySec === "number" ? body.delaySec : undefined,
      publishCommandId: typeof body.publishCommandId === "number" ? body.publishCommandId : undefined,
      publishJobSeq:    typeof body.publishJobSeq === "number" ? body.publishJobSeq : undefined,
      metadata:         body.metadata && typeof body.metadata === "object"
        ? body.metadata as Record<string, unknown>
        : undefined,
      promotedEnabled: body.promotedEnabled,
      promotedAdRate: body.promotedAdRate,
    })
    return { status: 200, body: result }
  } catch (e) {
    console.error("[ExtensionCapture] create", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handleGetExtensionCaptureJob(
  req: AdminRequest
): Promise<AdminResponse<ExtensionCaptureCommandDetail>> {
  try {
    const commandId = parsePositiveInt(req.params.commandId ?? req.params.id)
    if (!commandId) return bad("Invalid command id")
    const detail = await getExtensionCaptureCommand(getWorkspaceId(), commandId)
    if (!detail) return notFound("Capture command not found")
    return { status: 200, body: detail }
  } catch (e) {
    console.error("[ExtensionCapture] get", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handleGetActiveExtensionCaptureJobs(
  _req: AdminRequest
): Promise<AdminResponse<{ commands: ExtensionCaptureCommandDetail[] }>> {
  try {
    const commands = await listActiveExtensionCaptureCommands(getWorkspaceId())
    return { status: 200, body: { commands } }
  } catch (e) {
    console.error("[ExtensionCapture] active", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostExtensionCaptureItemStart(
  req: AdminRequest
): Promise<AdminResponse<{ ok: true; item: NonNullable<Awaited<ReturnType<typeof startExtensionCaptureItem>>> }>> {
  try {
    const commandId = parsePositiveInt(req.params.commandId)
    const itemId = parsePositiveInt(req.params.itemId)
    if (!commandId || !itemId) return bad("Invalid commandId or itemId")
    const item = await startExtensionCaptureItem(getWorkspaceId(), commandId, itemId)
    if (!item) return notFound("Item not found or not capture_pending")
    return { status: 200, body: { ok: true, item } }
  } catch (e) {
    console.error("[ExtensionCapture] start-capture", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostExtensionCaptureClaimNext(
  req: AdminRequest
): Promise<AdminResponse<ClaimNextCaptureResponse>> {
  try {
    const body = req.body as { workerId?: string }
    const workerId = typeof body.workerId === "string" ? body.workerId.trim() : ""
    if (!workerId) return bad("workerId is required")
    const result = await claimNextCaptureItem(getWorkspaceId(), workerId)
    return { status: 200, body: result }
  } catch (e) {
    console.error("[ExtensionCapture] claim-next", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostExtensionCaptureItemFail(
  req: AdminRequest
): Promise<AdminResponse<FailCaptureItemResponse>> {
  try {
    const commandId = parsePositiveInt(req.params.commandId)
    const itemId = parsePositiveInt(req.params.itemId)
    if (!commandId || !itemId) return bad("Invalid commandId or itemId")
    const body = req.body as { errorCode?: string; errorMessage?: string; retryable?: boolean }
    const errorMessage = typeof body.errorMessage === "string" ? body.errorMessage.trim() : ""
    if (!errorMessage) return bad("errorMessage is required")
    const result = await failExtensionCaptureItem(getWorkspaceId(), commandId, itemId, {
      errorCode:   typeof body.errorCode === "string" ? body.errorCode.trim() : undefined,
      errorMessage,
      retryable:   body.retryable === true,
    })
    return { status: 200, body: result }
  } catch (e) {
    console.error("[ExtensionCapture] fail", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostExtensionCaptureItemSubmit(
  req: AdminRequest
): Promise<AdminResponse<SubmitCapturePayloadResponse>> {
  try {
    const commandId = parsePositiveInt(req.params.commandId)
    const itemId = parsePositiveInt(req.params.itemId)
    if (!commandId || !itemId) return bad("Invalid commandId or itemId")
    const body = req.body as { capturePayload?: Record<string, unknown> }
    if (!body.capturePayload || typeof body.capturePayload !== "object") {
      return bad("capturePayload is required")
    }
    const result = await submitExtensionCaptureItem(
      getWorkspaceId(),
      commandId,
      itemId,
      body.capturePayload
    )
    return { status: 200, body: result }
  } catch (e) {
    console.error("[ExtensionCapture] capture", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostExtensionCaptureItemPromotionRetry(
  req: AdminRequest
): Promise<AdminResponse<{ ok: true; listingId: string | null; promotion: unknown }>> {
  try {
    const commandId = parsePositiveInt(req.params.commandId)
    const itemId = parsePositiveInt(req.params.itemId)
    if (!commandId || !itemId) return bad("Invalid commandId or itemId")
    const result = await retryExtensionCaptureItemPromotion(getWorkspaceId(), commandId, itemId)
    return { status: 200, body: result }
  } catch (e) {
    console.error("[ExtensionCapture] promotion-retry", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePostExtensionCaptureJobCancel(
  req: AdminRequest
): Promise<AdminResponse<{ ok: true; commandId: number }>> {
  try {
    const commandId = parsePositiveInt(req.params.commandId)
    if (!commandId) return bad("Invalid command id")
    const result = await cancelExtensionCaptureCommand(getWorkspaceId(), commandId)
    return { status: 200, body: result }
  } catch (e) {
    console.error("[ExtensionCapture] cancel", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}
