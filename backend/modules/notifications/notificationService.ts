// Kalıcı bildirimler — sadece db/client; başka modül import edilmez (döngü önlenir).

import { query } from "../../db/client"

export type PersistedNotificationType = "success" | "error" | "warning" | "info"

export type PersistedNotificationRow = {
  id: number
  type: string
  title: string
  message: string
  read: boolean
  createdAt: string
}

export async function addNotification(
  workspaceId: string,
  type: PersistedNotificationType,
  title: string,
  message: string
): Promise<void> {
  try {
    if (!workspaceId) return
    await query(
      `INSERT INTO notifications (workspace_id, type, title, message, "read", created_at)
       VALUES ($1::uuid, $2, $3, $4, false, NOW())`,
      [workspaceId, type, title, message ?? ""]
    )
  } catch (e) {
    console.warn("[notifications] addNotification failed:", e instanceof Error ? e.message : e)
  }
}

export async function cleanupOld(workspaceId: string): Promise<void> {
  try {
    if (!workspaceId) return
    await query(
      `DELETE FROM notifications
       WHERE workspace_id = $1::uuid
         AND created_at < NOW() - INTERVAL '24 hours'`,
      [workspaceId]
    )
  } catch (e) {
    console.warn("[notifications] cleanupOld failed:", e instanceof Error ? e.message : e)
  }
}

export async function getNotifications(
  workspaceId: string,
  limit = 50
): Promise<PersistedNotificationRow[]> {
  await cleanupOld(workspaceId)
  const result = await query<{
    id: number
    type: string
    title: string
    message: string
    is_read: boolean
    created_at: string
  }>(
    `SELECT id, type, title, message, "read" AS is_read, created_at::text
     FROM notifications
     WHERE workspace_id = $1::uuid
       AND created_at > NOW() - INTERVAL '24 hours'
     ORDER BY created_at DESC
     LIMIT $2`,
    [workspaceId, limit]
  )
  return result.rows.map(r => ({
    id: r.id,
    type: r.type,
    title: r.title,
    message: r.message,
    read: r.is_read,
    createdAt: r.created_at,
  }))
}

export async function markAsRead(workspaceId: string, notificationIds: number[]): Promise<number> {
  if (!workspaceId || notificationIds.length === 0) return 0
  const res = await query(
    `UPDATE notifications
     SET "read" = true
     WHERE workspace_id = $1::uuid
       AND id = ANY($2::bigint[])`,
    [workspaceId, notificationIds]
  )
  return res.rowCount ?? 0
}

export async function markAllAsRead(workspaceId: string): Promise<number> {
  if (!workspaceId) return 0
  const res = await query(
    `UPDATE notifications
     SET "read" = true
     WHERE workspace_id = $1::uuid
       AND "read" = false`,
    [workspaceId]
  )
  return res.rowCount ?? 0
}
