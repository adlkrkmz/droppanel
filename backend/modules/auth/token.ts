// ----------------------------------------------------------------
// token.ts — JWT + opaque token hashing
// ----------------------------------------------------------------

import crypto from "crypto"
import jwt from "jsonwebtoken"
import type { JwtPayload, UserRole, ApprovalStatus } from "./authTypes"

const JWT_EXPIRES_IN = "7d"

export function authCookieName(): string {
  return process.env.AUTH_COOKIE_NAME?.trim() || "listjetgo_session"
}

export function jwtSecret(): string {
  const s = process.env.AUTH_JWT_SECRET?.trim()
  if (s) return s
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      "[Auth] AUTH_JWT_SECRET missing — using dev fallback. Set AUTH_JWT_SECRET in production."
    )
    return "dev-insecure-jwt-secret-change-me"
  }
  throw new Error("AUTH_JWT_SECRET is not defined")
}

export function signSessionToken(input: {
  userId:          string
  email:           string
  role:            UserRole
  approvalStatus:  ApprovalStatus
  workspaceId:     string | null
}): string {
  const payload: JwtPayload = {
    sub:            input.userId,
    email:          input.email,
    role:           input.role,
    approvalStatus: input.approvalStatus,
    workspaceId:    input.workspaceId,
  }
  return jwt.sign(payload, jwtSecret(), { expiresIn: JWT_EXPIRES_IN })
}

export function verifySessionToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, jwtSecret()) as JwtPayload
    if (!decoded?.sub) return null
    return decoded
  } catch {
    return null
  }
}

export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString("hex")
}

export function hashOpaqueToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex")
}

export function verificationExpiresAt(hours = 24): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000)
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL?.trim() || "http://localhost:3000").replace(/\/$/, "")
}
