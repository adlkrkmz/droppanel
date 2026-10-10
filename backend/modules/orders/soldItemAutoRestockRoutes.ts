import type { AdminRequest, AdminResponse } from "../admin/adminTypes"
import { runSoldItemAutoRestockOnce } from "./soldItemAutoRestockScheduler"
import type { RestockRunResult } from "./soldItemAutoRestockService"

function getWorkspaceId(): string {
  const id = process.env.WORKSPACE_ID
  if (!id) throw new Error("WORKSPACE_ID is not defined in environment")
  return id
}

function err(message: string, status = 500): AdminResponse<{ ok: false; error: string }> {
  return { status, body: { ok: false, error: message } }
}

export async function handlePostAutoRestockRunOnce(
  req: AdminRequest
): Promise<AdminResponse<{ ok: true } & RestockRunResult | { ok: false; error: string }>> {
  try {
    const workspaceId = getWorkspaceId()
    const body = (req.body ?? {}) as { storeCode?: string }
    const storeCode = String(body.storeCode ?? "").trim() || undefined
    const result = await runSoldItemAutoRestockOnce(workspaceId, storeCode)
    return { status: 200, body: { ok: true, ...result } }
  } catch (e) {
    console.error("[ADMIN][AutoRestock]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}
