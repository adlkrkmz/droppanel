// ----------------------------------------------------------------
// poolCategoryPreferencesRoutes.ts — admin HTTP handlers
// ----------------------------------------------------------------

import type { AdminRequest, AdminResponse } from "../admin/adminTypes"
import {
  getPoolCategoryPreferences,
  savePoolCategoryPreferences,
  type PoolCategoryPreferences,
} from "./poolCategoryPreferencesService"

function getWorkspaceId(): string {
  const id = process.env.WORKSPACE_ID
  if (!id) throw new Error("WORKSPACE_ID is not defined in environment")
  return id
}

function err(message: string): AdminResponse<never> {
  return { status: 500, body: { error: "InternalServerError", message } }
}

export async function handleGetPoolCategoryPreferences(
  _req: AdminRequest
): Promise<AdminResponse<PoolCategoryPreferences>> {
  try {
    const body = await getPoolCategoryPreferences(getWorkspaceId())
    return { status: 200, body }
  } catch (e) {
    console.error("[ADMIN pool/category-preferences GET]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}

export async function handlePutPoolCategoryPreferences(
  req: AdminRequest
): Promise<AdminResponse<PoolCategoryPreferences>> {
  try {
    const body = req.body as Record<string, unknown>
    const prefs = await savePoolCategoryPreferences(getWorkspaceId(), {
      categories: body.categories,
      note:       body.note,
    } as Partial<PoolCategoryPreferences>)
    return { status: 200, body: prefs }
  } catch (e) {
    console.error("[ADMIN pool/category-preferences PUT]", e)
    return err(e instanceof Error ? e.message : String(e))
  }
}
