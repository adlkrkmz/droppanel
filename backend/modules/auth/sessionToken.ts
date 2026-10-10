import crypto from "crypto"
import type { CookieOptions } from "express"

export function sessionCookieName(): string { return process.env.SESSION_COOKIE_NAME?.trim() || "listjetgo_session" }
export function sessionTtlDays(): number {
  const n=Number.parseInt(process.env.SESSION_TTL_DAYS ?? "7",10)
  if (!Number.isInteger(n) || n<1 || n>90) throw new Error("SESSION_TTL_DAYS must be between 1 and 90")
  return n
}
export function sessionRetentionDays(): number {
  const n=Number.parseInt(process.env.SESSION_RETENTION_DAYS ?? "30",10)
  return Number.isInteger(n) && n>=1 && n<=365 ? n : 30
}
export function generateSessionToken(): string { return crypto.randomBytes(32).toString("base64url") }
export function hashSessionToken(raw:string): string { return crypto.createHash("sha256").update(raw).digest("hex") }
export function sessionCookieOptions(isProduction=process.env.NODE_ENV==="production"): CookieOptions {
  return { httpOnly:true, secure:isProduction, sameSite:isProduction?"none":"lax", path:"/", maxAge:sessionTtlDays()*86400000 }
}
