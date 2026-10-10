import crypto from "crypto"
import type { NextFunction, Request, Response } from "express"
import { sessionCookieName } from "../auth/sessionToken"

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"])
const buckets = new Map<string, { count: number; resetAt: number }>()

export function isLoopbackAddress(value: string | undefined): boolean {
  const v = (value ?? "").replace(/^::ffff:/, "")
  return v === "127.0.0.1" || v === "::1"
}

export function isTrustedInternalRequest(req: Request): boolean {
  const configured = process.env.ADMIN_INTERNAL_API_KEY?.trim()
  const supplied = req.headers["x-admin-internal-key"]
  const secretMatches = Boolean(configured && typeof supplied === "string" && supplied.length === configured.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(configured)))
  if (secretMatches) return true
  return process.env.NODE_ENV !== "production" && isLoopbackAddress(req.socket.remoteAddress)
}

export async function requireLegacyAdminAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (isTrustedInternalRequest(req)) return next()
  const { requireAdmin } = await import("../auth/authMiddleware")
  await requireAdmin(req, res, next)
}

export function configuredBrowserOrigins(): Set<string> {
  const configured = (process.env.CORS_ORIGINS ?? "").split(",").map(v => v.trim()).filter(Boolean)
  const extensionOrigins = (process.env.CHROME_EXTENSION_IDS ?? "")
    .split(",").map(v => v.trim()).filter(Boolean).map(v => `chrome-extension://${v}`)
  // Canonical app surface is required for cookie-based extension session mint.
  const production = ["https://panel.listjetgo.com", "https://api.listjetgo.com", "https://app.listjetgo.com"]
  const development = ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3001", "http://localhost:3010"]
  return new Set([...configured, ...production, ...extensionOrigins, ...(process.env.NODE_ENV === "production" ? [] : development)])
}

export function isAllowedBrowserOrigin(origin: string): boolean {
  if (configuredBrowserOrigins().has(origin)) return true
  // Unpacked local extensions have a generated ID and send Origin: chrome-extension://...
  // CHROME_EXTENSION_IDS is the production allowlist; local/admin does not require it.
  return process.env.NODE_ENV !== "production" && origin.startsWith("chrome-extension://")
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING.has(req.method) || isTrustedInternalRequest(req)) return next()
  if (req.headers.authorization?.startsWith("Bearer ") || !req.cookies?.[sessionCookieName()]) return next()
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : ""
  if (origin && isAllowedBrowserOrigin(origin)) return next()
  res.status(403).json({ error: "CSRF_REJECTED", message: "Request origin is not allowed" })
}

export function secureHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
  next()
}

export function rateLimitKey(req: Request, includeEmail = false): string {
  const email = includeEmail ? String(req.body?.email ?? "").trim().toLowerCase() : ""
  return crypto.createHash("sha256").update(`${req.ip || req.socket.remoteAddress || "unknown"}|${email}`).digest("hex")
}

export function isInternalScraperApiPath(pathName: string): boolean {
  const p = pathName.split("?")[0] || ""
  return (
    p.startsWith("/internal/keepa-collector") ||
    p.startsWith("/internal/amazon-scan") ||
    p.startsWith("/internal/oxylabs-verify")
  )
}

/** SHA-256 of Bearer token or IP-missing marker. Never returns the raw token. */
export function hashedAuthorizationSubject(authorization: string | undefined, fallbackIp = "unknown"): string {
  const raw = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : ""
  const material = raw.length > 0 ? `tok:${raw}` : `none:${fallbackIp}`
  return crypto.createHash("sha256").update(material, "utf8").digest("hex")
}

export function internalScraperRateLimitKey(req: Request, extra = ""): string {
  const ip = String(req.ip || req.socket.remoteAddress || "unknown")
  const subject = hashedAuthorizationSubject(
    typeof req.headers?.authorization === "string" ? req.headers.authorization : undefined,
    ip
  )
  const worker = String(extra ?? "").trim().slice(0, 80)
  return crypto.createHash("sha256").update(`${subject}|${worker}`, "utf8").digest("hex")
}

let limiterSeq = 0

function consumeBucket(input: {
  bucketKey: string
  windowMs: number
  max: number
}): { allowed: boolean; remaining: number; retryAfterSec: number; limit: number } {
  const now = Date.now()
  const old = buckets.get(input.bucketKey)
  const entry = !old || old.resetAt <= now ? { count: 0, resetAt: now + input.windowMs } : old
  entry.count += 1
  buckets.set(input.bucketKey, entry)
  const remaining = Math.max(0, input.max - entry.count)
  const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
  return {
    allowed: entry.count <= input.max,
    remaining,
    retryAfterSec,
    limit: input.max,
  }
}

/**
 * Each limiter instance gets an isolated bucket namespace.
 * Without this, all createRateLimiter() calls shared one IP key in a global Map
 * and panel traffic (generalLimiter) falsely tripped pairing/create.
 */
export function createRateLimiter(options: {
  windowMs: number
  max: number
  includeEmail?: boolean
  /** Stable name preferred; auto-seq used if omitted (still isolates instances). */
  name?: string
  keyFn?: (req: Request) => string
}) {
  const bucketNs = options.name?.trim() || `limiter:${++limiterSeq}`
  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = options.keyFn
      ? options.keyFn(req)
      : rateLimitKey(req, options.includeEmail)
    const bucketKey = `${bucketNs}|${identity}`
    const result = consumeBucket({
      bucketKey,
      windowMs: options.windowMs,
      max: options.max,
    })
    res.setHeader("RateLimit-Limit", String(result.limit))
    res.setHeader("RateLimit-Remaining", String(result.remaining))
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSec))
      res.status(429).json({ error: "RATE_LIMITED", message: "Too many requests" })
      return
    }
    next()
  }
}

/** Programmatic consume after auth (e.g. user_id + workspace_id). */
export function consumeNamedRateLimit(input: {
  name: string
  key: string
  windowMs: number
  max: number
}): { allowed: boolean; remaining: number; retryAfterSec: number; limit: number } {
  const identity = crypto.createHash("sha256").update(input.key, "utf8").digest("hex")
  return consumeBucket({
    bucketKey: `${input.name}|${identity}`,
    windowMs: input.windowMs,
    max: input.max,
  })
}

export function resetRateLimitBucketsForTests(): void { buckets.clear() }
export function publicInternalError(): { error: string; message: string } {
  return { error: "INTERNAL_ERROR", message: "An internal error occurred" }
}
