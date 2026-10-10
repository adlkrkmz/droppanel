import crypto from "crypto"
import type { Request } from "express"
import { findUserById, getWorkspaceIdForExtensionUser, hasPasswordCredentialRow } from "../auth/authRepository"
import { getProductAccessForUser } from "../auth/authService"
import { resolveAuthContext, type AuthedRequest } from "../auth/authMiddleware"
import type { AuthContext } from "../auth/authTypes"

export const EXTENSION_ID = "ncegpfpjfgemblbcpnbobeaobkannlfk"
const ISSUER = "listjetgo"
const AUDIENCE = "listjetgo-extension"
const PURPOSE = "extension_access"
const TTL_SECONDS = 20 * 60

function secret(): string {
  const value = process.env.EXTENSION_TOKEN_SECRET?.trim()
  if (!value || value.length < 32) throw new Error("EXTENSION_TOKEN_SECRET must be at least 32 characters")
  return value
}
function b64(value: string | Buffer): string { return Buffer.from(value).toString("base64url") }
function sign(input: string): string { return b64(crypto.createHmac("sha256", secret()).update(input).digest()) }
export function issueExtensionToken(userId: string): { accessToken: string; expiresAt: string } {
  const now = Math.floor(Date.now() / 1000)
  const payload = { sub: userId, iss: ISSUER, aud: AUDIENCE, purpose: PURPOSE, ext: EXTENSION_ID, iat: now, exp: now + TTL_SECONDS }
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const data = `${head}.${b64(JSON.stringify(payload))}`
  return { accessToken: `${data}.${sign(data)}`, expiresAt: new Date((now + TTL_SECONDS) * 1000).toISOString() }
}

export function localExtensionTestAuthAllowed(hostHeader?: string): boolean {
  if (process.env.NODE_ENV === "production") return false
  if ((process.env.LOCAL_EXTENSION_TEST_AUTH ?? "").trim().toLowerCase() !== "true") return false
  const dbUrl = process.env.DATABASE_URL ?? ""
  try {
    const host = new URL(dbUrl).hostname.toLowerCase()
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return false
  } catch {
    return false
  }
  if (hostHeader) {
    const h = hostHeader.split(":")[0].toLowerCase()
    if (h !== "localhost" && h !== "127.0.0.1") return false
  }
  return true
}

export function issueLocalUnpackedToken(): { accessToken: string; expiresAt: string } | null {
  const userId = process.env.LOCAL_EXTENSION_TEST_USER_ID?.trim() ?? ""
  if (!userId) return null
  return issueExtensionToken(userId)
}

export async function issueLocalExtensionTestToken(key: string): Promise<{ accessToken: string; expiresAt: string } | null> {
  const expected = process.env.LOCAL_EXTENSION_TEST_AUTH_KEY?.trim() ?? ""
  const userId = process.env.LOCAL_EXTENSION_TEST_USER_ID?.trim() ?? ""
  if (!expected || expected.length < 32 || !userId) return null
  const a = Buffer.from(String(key ?? ""))
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  return issueExtensionToken(userId)
}
function timingSafe(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y) }
export function verifyExtensionToken(token: string): { sub: string; exp: number } | null {
  const parts = token.trim().split("."); if (parts.length !== 3) return null
  const [head, body, mac] = parts
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>
    if (!timingSafe(sign(`${head}.${body}`), mac) || claims.iss !== ISSUER || claims.aud !== AUDIENCE || claims.purpose !== PURPOSE || claims.ext !== EXTENSION_ID || typeof claims.sub !== "string" || !Number.isInteger(claims.exp) || Number(claims.exp) <= Math.floor(Date.now() / 1000)) return null
    return { sub: claims.sub, exp: Number(claims.exp) }
  } catch { return null }
}
function hasActiveEbayAccess(access: Awaited<ReturnType<typeof getProductAccessForUser>>): boolean {
  if (access.length === 0) return true
  return access.some((x: any) =>
    String(x.product ?? x.productCode ?? "").toUpperCase() === "EBAY" &&
    String(x.status ?? "").toUpperCase() === "ACTIVE"
  )
}

/**
 * Mint existing extension JWT from canonical web session cookie (listjetgo_session).
 * Workspace is resolved server-side only; never trust client workspace identity.
 */
export async function issueExtensionTokenFromWebSession(
  req: Request
): Promise<{ accessToken: string; expiresAt: string } | null> {
  const ctx = await resolveAuthContext(req)
  if (!ctx || ctx.user.approvalStatus !== "active") return null
  const access = await getProductAccessForUser(ctx.user.id)
  if (!hasActiveEbayAccess(access)) return null
  const workspaceId = await getWorkspaceIdForExtensionUser(ctx.user.id)
  if (!workspaceId) return null
  return issueExtensionToken(ctx.user.id)
}

export async function resolveExtensionAuth(req: AuthedRequest): Promise<AuthContext | null> {
  const raw = req.headers.authorization
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return null
  const claims = verifyExtensionToken(raw.slice(7)); if (!claims) return null
  const user = await findUserById(claims.sub); if (!user || user.approvalStatus !== "active") return null
  const access = await getProductAccessForUser(user.id)
  if (!hasActiveEbayAccess(access)) return null
  const workspaceId = await getWorkspaceIdForExtensionUser(user.id); if (!workspaceId) return null
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
    session: undefined,
  }
}
