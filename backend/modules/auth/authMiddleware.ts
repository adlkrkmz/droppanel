// ----------------------------------------------------------------
// authMiddleware.ts — Phase 1 foundation; not applied to all /admin routes.
// ----------------------------------------------------------------

import type { Request, Response, NextFunction } from "express"
import { findUserById, getPrimaryWorkspaceIdForUser, hasPasswordCredentialRow, storeBelongsToWorkspace } from "./authRepository"
import { findActiveSessionByTokenHash, touchSession } from "./sessionRepository"
import { hashSessionToken, sessionCookieName } from "./sessionToken"
import type { AuthContext } from "./authTypes"

export type AuthedRequest = Request & {
  auth?: AuthContext
}

export function extractSessionCookie(req: Request): string | null {
  const cookieName = sessionCookieName()
  const cookieHeader = req.headers.cookie ?? ""
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=")
    if (k === cookieName) return decodeURIComponent(rest.join("=")) || null
  }
  return null
}

export async function resolveAuthContext(req: Request): Promise<AuthContext | null> {
  const opaque = extractSessionCookie(req)
  if (opaque) {
    const session = await findActiveSessionByTokenHash(hashSessionToken(opaque))
    if (!session) return null
    const user = await findUserById(session.userId)
    if (!user || user.approvalStatus !== "active") return null
    const workspaceId = await getPrimaryWorkspaceIdForUser(user.id)
    if (!workspaceId) return null
    void touchSession(session.id).catch(e => console.warn("[Session] touch failed:", e instanceof Error ? e.message : String(e)))
    const needsPasswordSetup = !(await hasPasswordCredentialRow(user.id))
    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        approvalStatus: user.approvalStatus,
        emailVerifiedAt: user.emailVerifiedAt,
        workspaceId,
        needsPasswordSetup,
      },
      session: { id: session.id, createdAt: session.createdAt, expiresAt: session.expiresAt },
    }
  }

  return null
}

export function internalAdminApiKey(): string | null {
  const k = process.env.ADMIN_INTERNAL_API_KEY?.trim()
  return k || null
}

export function isInternalAdminRequest(req: Request): boolean {
  const key = internalAdminApiKey()
  if (!key) return false
  const header = req.headers["x-admin-internal-key"]
  return typeof header === "string" && header === key
}

export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const ctx = await resolveAuthContext(req)
  if (!ctx) {
    res.status(401).json({ error: "Unauthorized", message: "Authentication required" })
    return
  }
  req.auth = ctx
  next()
}

export async function requireActiveUser(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const ctx = await resolveAuthContext(req)
  if (!ctx) {
    res.status(401).json({ error: "Unauthorized", message: "Authentication required" })
    return
  }
  if (ctx.user.approvalStatus !== "active") {
    res.status(403).json({
      error:          "Forbidden",
      message:        "Account is not active",
      approvalStatus: ctx.user.approvalStatus,
    })
    return
  }
  req.auth = ctx
  next()
}

export async function requireAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (isInternalAdminRequest(req)) {
    next()
    return
  }

  const ctx = await resolveAuthContext(req)
  if (!ctx) {
    res.status(401).json({ error: "Unauthorized", message: "Admin authentication required" })
    return
  }
  if (ctx.user.role !== "admin" || ctx.user.approvalStatus !== "active") {
    res.status(403).json({ error: "Forbidden", message: "Admin role required" })
    return
  }
  req.auth = ctx
  next()
}

export async function getUserWorkspaceId(userId: string): Promise<string | null> {
  return getPrimaryWorkspaceIdForUser(userId)
}

export async function assertStoreOwnership(
  workspaceId: string,
  storeCode:   string
): Promise<boolean> {
  if (!workspaceId?.trim() || !storeCode?.trim()) return false
  return storeBelongsToWorkspace(workspaceId, storeCode)
}

/** Optional helper for handlers — throws-like pattern via return value. */
export async function assertStoreInWorkspace(
  workspaceId: string,
  storeCode:   string
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const owned = await assertStoreOwnership(workspaceId, storeCode)
  if (!owned) {
    return { ok: false, status: 403, message: "Store not found in your workspace" }
  }
  return { ok: true }
}
