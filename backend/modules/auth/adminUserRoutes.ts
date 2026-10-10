// ----------------------------------------------------------------
// adminUserRoutes.ts — user approval (requireAdmin)
// ----------------------------------------------------------------

import type { Express, Response } from "express"
import {
  approveUserByAdmin,
  AuthHttpError,
  getPendingUsersForAdmin,
  getUserDetailForAdmin,
  rejectUserByAdmin,
  suspendUserByAdmin,
} from "./authService"
import type { AuthedRequest } from "./authMiddleware"
import { requireAdmin } from "./authMiddleware"

function sendError(res: Response, e: unknown): void {
  if (e instanceof AuthHttpError) {
    res.status(e.status).json({ ok: false, error: e.message })
    return
  }
  console.error("[AdminUsers]", e)
  res.status(500).json({ ok: false, error: process.env.NODE_ENV === "production" ? "INTERNAL_ERROR" : (e instanceof Error ? e.message : "Internal error") })
}

function actorId(req: AuthedRequest): string | null {
  return req.auth?.user.id ?? null
}

export function registerAdminUserRoutes(app: Express): void {
  app.get(
    "/admin/users/pending",
    (req, res, next) => { void requireAdmin(req as AuthedRequest, res, next) },
    async (req: AuthedRequest, res: Response) => {
      try {
        const rows = await getPendingUsersForAdmin()
        res.status(200).json({ ok: true, rows })
      } catch (e) {
        sendError(res, e)
      }
    }
  )

  app.get(
    "/admin/users/:userId",
    (req, res, next) => { void requireAdmin(req as AuthedRequest, res, next) },
    async (req: AuthedRequest, res: Response) => {
      try {
        const userId = String(req.params.userId ?? "")
        const detail = await getUserDetailForAdmin(userId)
        res.status(200).json({ ok: true, ...detail })
      } catch (e) {
        sendError(res, e)
      }
    }
  )

  app.post(
    "/admin/users/:userId/approve",
    (req, res, next) => { void requireAdmin(req as AuthedRequest, res, next) },
    async (req: AuthedRequest, res: Response) => {
      try {
        const userId = String(req.params.userId ?? "")
        await approveUserByAdmin(userId, actorId(req))
        res.status(200).json({ ok: true, userId, approvalStatus: "active" })
      } catch (e) {
        sendError(res, e)
      }
    }
  )

  app.post(
    "/admin/users/:userId/reject",
    (req, res, next) => { void requireAdmin(req as AuthedRequest, res, next) },
    async (req: AuthedRequest, res: Response) => {
      try {
        const userId = String(req.params.userId ?? "")
        await rejectUserByAdmin(userId, actorId(req))
        res.status(200).json({ ok: true, userId, approvalStatus: "rejected" })
      } catch (e) {
        sendError(res, e)
      }
    }
  )

  app.post(
    "/admin/users/:userId/suspend",
    (req, res, next) => { void requireAdmin(req as AuthedRequest, res, next) },
    async (req: AuthedRequest, res: Response) => {
      try {
        const userId = String(req.params.userId ?? "")
        await suspendUserByAdmin(userId, actorId(req))
        res.status(200).json({ ok: true, userId, approvalStatus: "suspended" })
      } catch (e) {
        sendError(res, e)
      }
    }
  )
}
