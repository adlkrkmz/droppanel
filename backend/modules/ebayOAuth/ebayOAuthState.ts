// ----------------------------------------------------------------
// ebayOAuthState.ts — HMAC-signed OAuth state for user /app flow
// ----------------------------------------------------------------

import crypto from "crypto"
import { jwtSecret } from "../auth/token"

const STATE_TTL_MS = 15 * 60 * 1000

export type UserOAuthIntent = "connect" | "reconnect"

export type UserOAuthStatePayload = {
  flow:        "user" | "legacy_admin"
  intent:      UserOAuthIntent
  userId:      string
  workspaceId: string
  storeCode:   string
  /** Required for reconnect — never trust storeCode alone across workspaces. */
  storeId:     number | null
  nonce:       string
  createdAt:   number
}

function stateSecret(): string {
  return process.env.EBAY_OAUTH_STATE_SECRET?.trim() || jwtSecret()
}

function signOAuthState(input: {
  userId: string
  workspaceId: string
  storeCode: string
  flow: UserOAuthStatePayload["flow"]
  intent?: UserOAuthIntent
  storeId?: number | null
  createdAt?: number
}): string {
  const intent = input.intent ?? "connect"
  const storeId =
    intent === "reconnect"
      ? (typeof input.storeId === "number" && input.storeId >= 1 ? input.storeId : null)
      : (typeof input.storeId === "number" && input.storeId >= 1 ? input.storeId : null)

  if (intent === "reconnect" && storeId == null) {
    throw new Error("reconnect state requires storeId")
  }

  const payload: UserOAuthStatePayload = {
    flow:        input.flow,
    intent,
    userId:      input.userId,
    workspaceId: input.workspaceId,
    storeCode:   input.storeCode,
    storeId,
    nonce:       crypto.randomBytes(16).toString("hex"),
    createdAt:   input.createdAt ?? Date.now(),
  }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const sig  = crypto.createHmac("sha256", stateSecret()).update(body).digest("base64url")
  return `${body}.${sig}`
}

export function signUserOAuthState(input: {
  userId: string
  workspaceId: string
  storeCode: string
  intent?: UserOAuthIntent
  storeId?: number | null
}): string {
  return signOAuthState({ ...input, flow: "user", intent: input.intent ?? "connect" })
}

export function signLegacyAdminOAuthState(input: {
  workspaceId: string
  storeCode: string
}): string {
  return signOAuthState({
    ...input,
    userId: "legacy-admin",
    flow: "legacy_admin",
    intent: "connect",
    storeId: null,
  })
}

export function signOAuthStateForTest(input: {
  userId: string
  workspaceId: string
  storeCode: string
  flow: UserOAuthStatePayload["flow"]
  intent?: UserOAuthIntent
  storeId?: number | null
  createdAt: number
}): string {
  return signOAuthState(input)
}

export function verifyUserOAuthState(state: string): UserOAuthStatePayload {
  const dot = state.indexOf(".")
  if (dot <= 0) throw new Error("Invalid state")

  const body = state.slice(0, dot)
  const sig  = state.slice(dot + 1)
  if (!body || !sig) throw new Error("Invalid state")

  const expected = crypto.createHmac("sha256", stateSecret()).update(body).digest("base64url")
  const sigBuf     = Buffer.from(sig)
  const expectedBuf = Buffer.from(expected)
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error("Invalid state signature")
  }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    throw new Error("Invalid state")
  }

  const flow = raw.flow
  if (flow !== "user" && flow !== "legacy_admin") throw new Error("Invalid state flow")

  const userId = typeof raw.userId === "string" ? raw.userId.trim() : ""
  const workspaceId = typeof raw.workspaceId === "string" ? raw.workspaceId.trim() : ""
  const storeCode = typeof raw.storeCode === "string" ? raw.storeCode.trim() : ""
  if (!userId || !workspaceId || !storeCode) throw new Error("Invalid state payload")

  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : NaN
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > STATE_TTL_MS) {
    throw new Error("State expired")
  }

  // Backward compatible: older states omit intent/storeId → connect
  const intentRaw = raw.intent
  const intent: UserOAuthIntent =
    intentRaw === "reconnect" ? "reconnect" : "connect"

  let storeId: number | null = null
  if (typeof raw.storeId === "number" && Number.isInteger(raw.storeId) && raw.storeId >= 1) {
    storeId = raw.storeId
  } else if (typeof raw.storeId === "string" && /^\d+$/.test(raw.storeId.trim())) {
    const n = parseInt(raw.storeId.trim(), 10)
    if (n >= 1) storeId = n
  }

  if (intent === "reconnect" && storeId == null) {
    throw new Error("Invalid reconnect state")
  }

  return {
    flow,
    intent,
    userId,
    workspaceId,
    storeCode,
    storeId,
    nonce: typeof raw.nonce === "string" ? raw.nonce : "",
    createdAt,
  }
}

/** Legacy admin state uses `storeCode:workspaceId:nonce` (colons, no HMAC). */
export function isSignedUserOAuthState(state: string): boolean {
  return state.includes(".") && !/^[^:]+:[^:]+:/.test(state.split(".")[0] ?? "")
}
