// ─────────────────────────────────────────────────────────────
// httpTypes.ts
// ─────────────────────────────────────────────────────────────

import type { Request, Response, NextFunction } from "express"

export type AppRequest  = Request
export type AppResponse = Response
export type AppNext     = NextFunction

export type RouteDefinition = {
  method:  "get" | "post" | "put" | "delete" | "patch"
  path:    string
  handler: (req: AppRequest, res: AppResponse) => Promise<void>
}

export type ServerConfig = {
  port:        number
  corsOrigins: string[]
}
