import type { NextFunction, Request, Response } from "express"
import { sessionCookieName } from "../auth/sessionToken"
import {
  authorizeOxylabsVerifyWorker,
  evaluateOxylabsBearerAuth,
  oxylabsVerifyWorkerAuthConfigured,
} from "./oxylabsVerifyAuth"

export const OXYLABS_VERIFY_RESULT_PATH = "/internal/oxylabs-verify/result"
export const OXYLABS_VERIFY_RESULT_JSON_LIMIT = "512kb"

export function isOxylabsVerifyResultPost(req: { method?: string; path?: string; originalUrl?: string }): boolean {
  if (String(req.method ?? "").toUpperCase() !== "POST") return false
  const raw = String(req.path || req.originalUrl || "").split("?")[0]
  return raw === OXYLABS_VERIFY_RESULT_PATH
}

function hasSessionCookie(req: Request): boolean {
  const name = sessionCookieName()
  const cookies = req.cookies as Record<string, unknown> | undefined
  return Boolean(cookies && typeof cookies[name] === "string" && String(cookies[name]).length > 0)
}

/** Bearer/cookie auth only. Does not read or buffer req.body. */
export function oxylabsVerifyResultAuthBeforeBody(req: Request, res: Response, next: NextFunction): void {
  const auth = authorizeOxylabsVerifyWorker(
    typeof req.headers.authorization === "string" ? req.headers.authorization : undefined
  )
  const decision = evaluateOxylabsBearerAuth({
    tokenConfigured: oxylabsVerifyWorkerAuthConfigured(),
    tokenOk: auth.ok === true,
    foreignToken: auth.ok === false && auth.foreign === true,
    hasSessionCookie: hasSessionCookie(req),
  })
  if (!("ok" in decision)) {
    res.status(decision.status).json({ ok: false, error: decision.error })
    return
  }
  next()
}

export function skipDefaultJsonForOxylabsResult(defaultJson: (req: Request, res: Response, next: NextFunction) => void) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isOxylabsVerifyResultPost(req)) {
      next()
      return
    }
    defaultJson(req, res, next)
  }
}

export function oxylabsJsonParseErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const e = err as { type?: string; status?: number; statusCode?: number }
  const status = Number(e?.status || e?.statusCode) || 0
  if (status === 413 || e?.type === "entity.too.large") {
    if (!res.headersSent) res.status(413).json({ ok: false, error: "PAYLOAD_TOO_LARGE" })
    return
  }
  if (isOxylabsVerifyResultPost(req) && (status === 400 || e?.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    if (!res.headersSent) res.status(400).json({ ok: false, error: "BAD_JSON" })
    return
  }
  next(err)
}
