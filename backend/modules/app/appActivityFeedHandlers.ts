import type { AuthedRequest } from "../auth/authMiddleware"
import { getAuthenticatedWorkspaceId } from "./appOwnership"
import { AppHttpError } from "./appTypes"
import {
  countUnreadActivity,
  listVisibleActivityFeed,
  markActivityRead,
  markAllActivityRead,
} from "../activity/activityEventService"

export async function handleGetAppActivityFeed(req: AuthedRequest, storeId: number | null) {
  const workspaceId = getAuthenticatedWorkspaceId(req)
  const items = await listVisibleActivityFeed({ workspaceId, storeId, limit: 40 })
  return { ok: true, items, windowHours: 24 }
}

export async function handleGetAppActivityUnread(req: AuthedRequest) {
  const workspaceId = getAuthenticatedWorkspaceId(req)
  const unread = await countUnreadActivity(workspaceId)
  return { ok: true, unread }
}

export async function handlePostAppActivityRead(req: AuthedRequest, body: Record<string, unknown>) {
  const workspaceId = getAuthenticatedWorkspaceId(req)
  if (body.all === true) {
    const n = await markAllActivityRead(workspaceId)
    return { ok: true, updated: n }
  }
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => Number.isFinite(n) && n > 0) : []
  if (ids.length === 0) throw new AppHttpError(400, "ids required")
  const n = await markActivityRead(workspaceId, ids)
  return { ok: true, updated: n }
}
