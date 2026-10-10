// ─────────────────────────────────────────────────────────────
// ebayOAuthService.ts
//
// eBay OAuth 2.0 Authorization Code flow
//
// Gerçek flow:
//   1. buildAuthUrl()     → kullanıcıyı eBay'e yönlendir
//   2. handleCallback()   → eBay code → access + refresh token al
//   3. refreshAccessToken() → süresi dolunca yenile
//   4. getAccountStatus() → token durumu
//
// simulationMode=true → gerçek HTTP atmaz, fake token üretir
// ─────────────────────────────────────────────────────────────

import { query }  from "../../db/client"
import crypto     from "crypto"
import { signLegacyAdminOAuthState, verifyUserOAuthState } from "./ebayOAuthState"
import { scheduleNewStoreDataBootstrap } from "../storeSync/storeSyncScheduleService"
import { alertTokenRefreshFailed } from "../notifications/telegramService"
import type {
  EbayAccountRow,
  EbayAccountStatus,
  EbayCallbackResult,
  EbayConnectUrlResponse,
  EbayTokenRefreshResult,
} from "./ebayOAuthTypes"

// ─── CONFIG ───────────────────────────────────────────────────

function getOAuthConfig(): {
  clientId:     string
  clientSecret: string
  redirectUri:  string
  sandbox:      boolean
} {
  return {
    clientId:     process.env.EBAY_CLIENT_ID     ?? "SIM_CLIENT_ID",
    clientSecret: process.env.EBAY_CLIENT_SECRET ?? "SIM_CLIENT_SECRET",
    redirectUri:  process.env.EBAY_REDIRECT_URI  ?? "http://localhost:4000/admin/ebay/callback",
    sandbox:      (process.env.EBAY_SANDBOX      ?? "true") !== "false",
  }
}

const EBAY_OAUTH_PROD    = "https://auth.ebay.com/oauth2/authorize"
const EBAY_OAUTH_SANDBOX = "https://auth.sandbox.ebay.com/oauth2/authorize"
const EBAY_TOKEN_PROD    = "https://api.ebay.com/identity/v1/oauth2/token"
const EBAY_TOKEN_SANDBOX = "https://api.sandbox.ebay.com/identity/v1/oauth2/token"

const EBAY_COMMERCE_IDENTITY_PROD    = "https://apiz.ebay.com/commerce/identity/v1/user/"
const EBAY_COMMERCE_IDENTITY_SANDBOX = "https://api.sandbox.ebay.com/commerce/identity/v1/user/"

/** Core scopes — always safe for refresh tokens granted before analytics was added. */
const EBAY_CORE_SCOPE_LIST = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.finances",
] as const

const EBAY_ANALYTICS_SCOPE_URL = "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly"
const EBAY_MARKETING_SCOPE_URL = "https://api.ebay.com/oauth/api_scope/sell.marketing"
const EBAY_MESSAGE_SCOPE_URL = "https://api.ebay.com/oauth/api_scope/commerce.message"

/** OAuth connect/reconnect only — includes analytics + marketing when app keyset supports them. */
export const EBAY_OAUTH_CONNECT_SCOPES = [
  ...EBAY_CORE_SCOPE_LIST,
  EBAY_ANALYTICS_SCOPE_URL,
  EBAY_MARKETING_SCOPE_URL,
  EBAY_MESSAGE_SCOPE_URL,
].join(" ")

/** @deprecated Use EBAY_OAUTH_CONNECT_SCOPES for new connects; refresh must not use this. */
export const EBAY_SCOPES = EBAY_OAUTH_CONNECT_SCOPES

export const EBAY_ANALYTICS_SCOPE = "sell.analytics.readonly"

function isInvalidScopeOAuthError(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes("invalid_scope") || m.includes("invalid scope")
}

function parseScopeFromTokenResponse(scope: string | string[] | undefined): string | null {
  if (Array.isArray(scope)) {
    const joined = scope.map(s => String(s).trim()).filter(Boolean).join(" ")
    return joined.length > 0 ? joined : null
  }
  const s = scope?.trim()
  return s && s.length > 0 ? s : null
}

export function tokenizeEbayScopes(scope: string | string[] | null | undefined): string[] {
  if (scope == null) return []
  if (Array.isArray(scope)) return scope.flatMap(item => tokenizeEbayScopes(item))
  return String(scope)
    .split(/[\s+,]+/)
    .map(part => part.trim())
    .filter(Boolean)
}

export function toMarketingAccess(scope: string | string[] | null | undefined): {
  granted: boolean
  code: "MARKETING_SCOPE_REQUIRED" | null
} {
  if (accountHasMarketingScope(scope)) return { granted: true, code: null }
  return { granted: false, code: "MARKETING_SCOPE_REQUIRED" }
}

/** authorization_code connect/reconnect — use requested scopes when eBay omits scope in token JSON. */
function resolveAuthorizationCodePersistedScope(tokenResponseScope: string | string[] | undefined): {
  scope: string
  tokenResponseHasScope: boolean
} {
  const parsed = parseScopeFromTokenResponse(tokenResponseScope)
  if (parsed) {
    return { scope: parsed, tokenResponseHasScope: true }
  }
  return {
    scope: EBAY_OAUTH_CONNECT_SCOPES,
    tokenResponseHasScope: false,
  }
}

async function resolveOAuthCallbackFlow(
  workspaceId: string,
  storeCode: string
): Promise<"connect" | "reconnect"> {
  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) return "connect"
  const account = await getAccountByStore(workspaceId, store.id)
  return account?.refreshToken ? "reconnect" : "connect"
}

export function accountHasAnalyticsScope(scope: string | null | undefined): boolean {
  const s = scope?.toLowerCase() ?? ""
  return s.includes("sell.analytics.readonly") || s.includes("sell.analytics")
}

export function accountHasMarketingScope(scope: string | string[] | null | undefined): boolean {
  const exact = EBAY_MARKETING_SCOPE_URL.toLowerCase()
  return tokenizeEbayScopes(scope).some(token => {
    const n = token.toLowerCase()
    return n === exact || n === "sell.marketing" || n.endsWith("/sell.marketing")
  })
}

export function accountHasMessageScope(scope: string | string[] | null | undefined): boolean {
  const exact = EBAY_MESSAGE_SCOPE_URL.toLowerCase()
  return tokenizeEbayScopes(scope).some(token => {
    const n = token.toLowerCase()
    return n === exact || n === "commerce.message" || n.endsWith("/commerce.message")
  })
}

/** Official Notification API user/app scope. Not added to first-connect OAuth. */
export const EBAY_NOTIFICATION_SUBSCRIPTION_SCOPE =
  "https://api.ebay.com/oauth/api_scope/commerce.notification.subscription"

export function accountHasNotificationSubscriptionScope(scope: string | string[] | null | undefined): boolean {
  const exact = EBAY_NOTIFICATION_SUBSCRIPTION_SCOPE.toLowerCase()
  return tokenizeEbayScopes(scope).some(token => {
    const n = token.toLowerCase()
    return n === exact || n.endsWith("/commerce.notification.subscription")
  })
}

export async function getEbayApplicationToken(scope: string): Promise<string> {
  const cfg = getOAuthConfig()
  const base = cfg.sandbox ? EBAY_TOKEN_SANDBOX : EBAY_TOKEN_PROD
  const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")
  const res = await fetch(base, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope,
    }).toString(),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`eBay application token failed: ${res.status} ${text.slice(0, 400)}`)
  }
  const data = JSON.parse(text) as { access_token?: string }
  const token = data.access_token?.trim()
  if (!token) throw new Error("eBay application token missing access_token")
  return token
}

// ─── DB HELPERS ───────────────────────────────────────────────

async function ensureTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS ebay_accounts (
      id            bigserial    PRIMARY KEY,
      workspace_id  uuid         NOT NULL REFERENCES workspaces(id),
      store_id      bigint       NOT NULL REFERENCES stores(id),
      ebay_user_id  text,
      access_token  text,
      refresh_token text,
      expires_at    timestamptz,
      scope         text,
      created_at    timestamptz  NOT NULL DEFAULT NOW(),
      updated_at    timestamptz  NOT NULL DEFAULT NOW(),
      UNIQUE(workspace_id, store_id)
    )
  `, [])
}

async function getAccountByStore(
  workspaceId: string,
  storeId:     number
): Promise<EbayAccountRow | null> {
  await ensureTable()
  const result = await query<{
    id:            number
    workspace_id:  string
    store_id:      number
    store_code:    string
    ebay_user_id:  string | null
    access_token:  string | null
    refresh_token: string | null
    expires_at:    string | null
    scope:         string | null
    created_at:    string
    updated_at:    string
  }>(
    `SELECT ea.*, s.store_code
     FROM ebay_accounts ea
     INNER JOIN stores s ON s.id = ea.store_id
     WHERE ea.workspace_id = $1 AND ea.store_id = $2
     LIMIT 1`,
    [workspaceId, storeId]
  )
  if (!result.rows[0]) return null
  const r = result.rows[0]
  return {
    id:           r.id,
    workspaceId:  r.workspace_id,
    storeId:      r.store_id,
    storeCode:    r.store_code,
    ebayUserId:   r.ebay_user_id,
    accessToken:  r.access_token,
    refreshToken: r.refresh_token,
    expiresAt:    r.expires_at,
    scope:        r.scope,
    connected:    !!(r.access_token && r.refresh_token),
    createdAt:    r.created_at,
    updatedAt:    r.updated_at,
  }
}

async function getStoreByCode(
  workspaceId: string,
  storeCode:   string
): Promise<{ id: number; name: string } | null> {
  const result = await query<{ id: number; name: string }>(
    `SELECT id, name FROM stores
     WHERE workspace_id = $1 AND store_code = $2 AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeCode]
  )
  return result.rows[0] ?? null
}

/**
 * Admin listing/order/sync already operate only on stores that have live
 * ebay_accounts tokens (GET /admin/stores, storeSync due jobs).
 * After a later eBay reconnect, catalog rows can remain on an older store_code
 * that still shares the same eBay display name. Use that connected store's
 * existing OAuth row — never invent or copy tokens.
 */
async function resolveOAuthStore(
  workspaceId: string,
  storeCode: string
): Promise<{ id: number; name: string } | null> {
  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) return null
  const direct = await getAccountByStore(workspaceId, store.id)
  if (direct?.accessToken && direct.refreshToken) return store

  const displayName = store.name?.trim()
  if (!displayName) return store

  const alias = await query<{ id: number; name: string }>(
    `SELECT s.id, s.name
     FROM stores s
     INNER JOIN ebay_accounts ea
       ON ea.store_id = s.id AND ea.workspace_id = s.workspace_id
     WHERE s.workspace_id = $1::uuid
       AND s.status = 'active'
       AND s.id <> $2::bigint
       AND lower(btrim(s.name)) = lower(btrim($3::text))
       AND ea.access_token IS NOT NULL
       AND ea.refresh_token IS NOT NULL
     ORDER BY ea.updated_at DESC NULLS LAST
     LIMIT 1`,
    [workspaceId, store.id, displayName]
  )
  return alias.rows[0] ?? store
}

export function getUserOAuthRedirectUri(): string {
  return (
    process.env.EBAY_USER_REDIRECT_URI?.trim() ||
    "http://localhost:4000/app/ebay/callback"
  )
}

/** S1, S2, … sırasında workspace’te kullanılmayan ilk kod (boşlukları doldurur). */
export async function findNextAutoStoreCode(workspaceId: string): Promise<string> {
  const result = await query<{ store_code: string }>(
    `SELECT store_code FROM stores WHERE workspace_id = $1`,
    [workspaceId]
  )
  const used = new Set<number>()
  const re = /^S(\d+)$/i
  for (const row of result.rows) {
    const m = re.exec(String(row.store_code).trim())
    if (m) used.add(parseInt(m[1]!, 10))
  }
  let n = 1
  while (used.has(n)) n += 1
  return `S${n}`
}

/** Workspace-scoped alias used by /app eBay connect flow. */
export const findNextStoreCodeForWorkspace = findNextAutoStoreCode

async function ensureActiveStore(
  workspaceId: string,
  storeCode:   string,
  /** Yeni satır için mağaza adı (eBay username); mevcut mağazada dokunulmaz. */
  nameForNewStore?: string
): Promise<{ id: number; name: string }> {
  const existing = await getStoreByCode(workspaceId, storeCode)
  if (existing) return existing

  const displayName = (nameForNewStore?.trim() || "Store").slice(0, 512)
  try {
    const ins = await query<{ id: number; name: string }>(
      `INSERT INTO stores (workspace_id, name, store_code, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id, name`,
      [workspaceId, displayName, storeCode]
    )
    const row = ins.rows[0]
    if (!row) throw new Error(`Failed to create store "${displayName}"`)
    return row
  } catch {
    const again = await getStoreByCode(workspaceId, storeCode)
    if (again) return again
    throw new Error(`Failed to create store "${displayName}"`)
  }
}

async function upsertAccount(
  workspaceId:  string,
  storeId:      number,
  ebayUserId:   string | null,
  accessToken:  string,
  refreshToken: string,
  expiresAt:    Date,
  scope:        string
): Promise<void> {
  await ensureTable()
  await query(
    `INSERT INTO ebay_accounts (
       workspace_id, store_id, ebay_user_id,
       access_token, refresh_token, expires_at, scope,
       created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (workspace_id, store_id)
     DO UPDATE SET
       ebay_user_id  = EXCLUDED.ebay_user_id,
       access_token  = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at    = EXCLUDED.expires_at,
       scope         = EXCLUDED.scope,
       updated_at    = NOW()`,
    [workspaceId, storeId, ebayUserId, accessToken, refreshToken, expiresAt.toISOString(), scope]
  )
}

/** Mağaza adı için username öncelikli; ebay_user_id sütunu için userId tercih edilir. */
async function fetchCommerceIdentityProfile(
  accessToken: string,
  sandbox:     boolean
): Promise<{ storeName: string; ebayUserId: string }> {
  const url = sandbox ? EBAY_COMMERCE_IDENTITY_SANDBOX : EBAY_COMMERCE_IDENTITY_PROD
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`eBay identity failed: ${res.status} ${text}`)
  }
  const data = await res.json() as { userId?: string; username?: string }
  const username = data.username != null ? String(data.username).trim() : ""
  const userId = data.userId != null ? String(data.userId).trim() : ""
  const storeName = username || userId
  if (!storeName) throw new Error("eBay identity response missing userId/username")
  const ebayUserId = userId || username
  return { storeName, ebayUserId }
}

async function updateStoreNameFromEbay(
  workspaceId: string,
  storeId:     number,
  displayName: string
): Promise<void> {
  const n = displayName.trim().slice(0, 512)
  if (!n) return
  await query(
    `UPDATE stores SET name = $1, updated_at = NOW()
     WHERE workspace_id = $2 AND id = $3`,
    [n, workspaceId, storeId]
  )
}

// ─── OAUTH FUNCTIONS ──────────────────────────────────────────

// 1. Auth URL üret
export type BuildAuthUrlOptions = {
  allowMissingStore?: boolean
  /** Reconnect / update permissions — never use simulation shortcut. */
  forceRealOAuth?: boolean
  /** Ask eBay to show sign-in/consent again (permission refresh). */
  promptLogin?: boolean
}

export async function buildAuthUrl(
  workspaceId: string,
  storeCode:      string,
  simulationMode: boolean,
  allowMissingStore = false,
  options: BuildAuthUrlOptions = {}
): Promise<EbayConnectUrlResponse> {
  const mayCreateStore = allowMissingStore || options.allowMissingStore === true
  if (!mayCreateStore) {
    const store = await getStoreByCode(workspaceId, storeCode)
    if (!store) throw new Error("Active store not found")
  }

  const stateParam = signLegacyAdminOAuthState({ storeCode, workspaceId })

  const useSimulationShortcut = simulationMode && !options.forceRealOAuth
  if (useSimulationShortcut) {
    return {
      storeCode,
      authUrl:  `http://localhost:4000/admin/ebay/callback?code=SIM_CODE&state=${encodeURIComponent(stateParam)}`,
      state:    stateParam,
    }
  }

  const cfg    = getOAuthConfig()
  const base   = cfg.sandbox ? EBAY_OAUTH_SANDBOX : EBAY_OAUTH_PROD
  const params = new URLSearchParams({
    client_id:     cfg.clientId,
    response_type: "code",
    redirect_uri:  cfg.redirectUri,
    scope:         EBAY_OAUTH_CONNECT_SCOPES,
    state:         stateParam,
  })
  if (options.promptLogin) {
    params.set("prompt", "login")
  }

  const authUrl = `${base}?${params.toString()}`
  console.log(
    `[OAuth] authUrl store=${storeCode} forceReal=${!!options.forceRealOAuth} ` +
      `scopes=${EBAY_OAUTH_CONNECT_SCOPES.split(" ").length} includesAnalytics=true includesMarketing=true`
  )

  return {
    storeCode,
    authUrl,
    state: stateParam,
  }
}

/** Always returns eBay authorize URL (no “already connected” shortcut). */
export async function buildReconnectAuthUrl(
  workspaceId: string,
  storeCode: string
): Promise<EbayConnectUrlResponse> {
  const simulation = (process.env.EBAY_SIMULATION ?? "true") !== "false"
  return buildAuthUrl(workspaceId, storeCode, simulation, false, {
    forceRealOAuth: true,
    promptLogin: true,
  })
}

function normalizeEbayIdentity(id: string | null | undefined): string {
  return (id ?? "").trim().toLowerCase()
}

/**
 * Reconnect OAuth for an EXISTING store row (same store_id / workspace).
 * Refuses to overwrite credentials when Commerce Identity user does not match
 * the stored ebay_user_id (when one already exists).
 */
export async function reconnectEbayStoreFromCode(input: {
  workspaceId:    string
  storeId:        number
  storeCode:      string
  code:           string
  simulationMode: boolean
  redirectUri:    string
}): Promise<EbayCallbackResult> {
  const { workspaceId, storeId, storeCode, code, simulationMode, redirectUri } = input

  const storeRes = await query<{ id: number; name: string; store_code: string; status: string }>(
    `SELECT id, name, store_code, status
     FROM stores
     WHERE workspace_id = $1::uuid
       AND id = $2
       AND store_code = $3
       AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeId, storeCode.trim()]
  )
  const store = storeRes.rows[0]
  if (!store) throw new Error("Store not found for reconnect")

  const existing = await getAccountByStore(workspaceId, store.id)

  let accessToken:  string
  let refreshToken: string
  let expiresAt:    Date
  let ebayUserId:   string | null = null
  let scope:        string
  let storeDisplayName: string
  const cfg0 = getOAuthConfig()

  if (simulationMode || code === "SIM_CODE") {
    accessToken  = `SIM_ACCESS_${crypto.randomBytes(8).toString("hex").toUpperCase()}`
    refreshToken = `SIM_REFRESH_${crypto.randomBytes(8).toString("hex").toUpperCase()}`
    expiresAt    = new Date(Date.now() + 2 * 60 * 60 * 1000)
    ebayUserId   = existing?.ebayUserId?.trim() || `sim_user_${storeCode.toLowerCase()}`
    scope        = EBAY_OAUTH_CONNECT_SCOPES
    storeDisplayName = store.name || "eBay (simulation)"
  } else {
    const base  = cfg0.sandbox ? EBAY_TOKEN_SANDBOX : EBAY_TOKEN_PROD
    const creds = Buffer.from(`${cfg0.clientId}:${cfg0.clientSecret}`).toString("base64")

    const res = await fetch(base, {
      method:  "POST",
      headers: {
        Authorization:  `Basic ${creds}`,
        "Content-Type":   "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:   "authorization_code",
        code,
        redirect_uri: redirectUri,
      }).toString(),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      if (isInvalidScopeOAuthError(text)) {
        throw new Error(
          "eBay OAuth invalid_scope: analytics or marketing scope may not be enabled on your eBay app keyset. " +
            "Reconnect using core scopes only, or enable sell.analytics.readonly and sell.marketing in the Developer Portal."
        )
      }
      throw new Error(`eBay token exchange failed: ${res.status} ${text}`)
    }

    const data = await res.json() as {
      access_token:             string
      refresh_token:            string
      expires_in:               number
      refresh_token_expires_in: number
      scope?:                   string | string[]
    }

    accessToken  = data.access_token
    refreshToken = data.refresh_token
    expiresAt    = new Date(Date.now() + data.expires_in * 1000)
    const scopeResolved = resolveAuthorizationCodePersistedScope(data.scope)
    scope = scopeResolved.scope

    const profile = await fetchCommerceIdentityProfile(accessToken, cfg0.sandbox)
    ebayUserId = profile.ebayUserId
    storeDisplayName = profile.storeName
  }

  const expected = normalizeEbayIdentity(existing?.ebayUserId)
  const actual   = normalizeEbayIdentity(ebayUserId)
  if (expected && actual && expected !== actual) {
    throw new Error(
      "EBAY_IDENTITY_MISMATCH: The authorized eBay account does not match this store. Credentials were not changed."
    )
  }

  await upsertAccount(workspaceId, store.id, ebayUserId, accessToken, refreshToken, expiresAt, scope)
  await updateStoreNameFromEbay(workspaceId, store.id, storeDisplayName)

  void scheduleNewStoreDataBootstrap({
    workspaceId,
    storeId:   store.id,
    storeCode: store.store_code,
    storeName: store.name || storeDisplayName,
  }).catch(e =>
    console.warn(`[OAuth] Data bootstrap queue failed for reconnect store_id=${store.id}:`, e)
  )

  console.log(
    `[OAuth] reconnect ok store_id=${store.id} storeCode=${store.store_code} seller=${ebayUserId ?? "unknown"}`
  )

  return {
    storeCode: store.store_code,
    ebayUserId,
    accessToken,
    refreshToken,
    expiresAt: expiresAt.toISOString(),
    scope,
    success:    true,
  }
}

// 2. Callback işle — code → tokens (admin legacy state: storeCode:workspaceId:nonce)
export async function connectEbayStoreFromCode(input: {
  workspaceId:    string
  storeCode:      string
  code:           string
  simulationMode: boolean
  redirectUri:    string
}): Promise<EbayCallbackResult> {
  const { workspaceId, storeCode, code, simulationMode, redirectUri } = input
  const oauthFlow = await resolveOAuthCallbackFlow(workspaceId, storeCode)

  let accessToken:  string
  let refreshToken: string
  let expiresAt:    Date
  let ebayUserId:   string | null = null
  let scope:        string
  let storeDisplayName: string
  const cfg0 = getOAuthConfig()

  if (simulationMode || code === "SIM_CODE") {
    accessToken  = `SIM_ACCESS_${crypto.randomBytes(8).toString("hex").toUpperCase()}`
    refreshToken = `SIM_REFRESH_${crypto.randomBytes(8).toString("hex").toUpperCase()}`
    expiresAt    = new Date(Date.now() + 2 * 60 * 60 * 1000)
    ebayUserId   = `sim_user_${storeCode.toLowerCase()}`
    scope        = EBAY_OAUTH_CONNECT_SCOPES
    storeDisplayName = "eBay (simulation)"
    console.log(
      `[OAuth] connect store=${storeCode} flow=${oauthFlow} tokenResponseHasScope=true ` +
        `persistedScopeIncludesAnalytics=${accountHasAnalyticsScope(scope)} (simulation)`
    )
  } else {
    const base  = cfg0.sandbox ? EBAY_TOKEN_SANDBOX : EBAY_TOKEN_PROD
    const creds = Buffer.from(`${cfg0.clientId}:${cfg0.clientSecret}`).toString("base64")

    const res = await fetch(base, {
      method:  "POST",
      headers: {
        Authorization:  `Basic ${creds}`,
        "Content-Type":   "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:   "authorization_code",
        code,
        redirect_uri: redirectUri,
      }).toString(),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      if (isInvalidScopeOAuthError(text)) {
        throw new Error(
          "eBay OAuth invalid_scope: analytics or marketing scope may not be enabled on your eBay app keyset. " +
            "Reconnect using core scopes only, or enable sell.analytics.readonly and sell.marketing in the Developer Portal."
        )
      }
      throw new Error(`eBay token exchange failed: ${res.status} ${text}`)
    }

    const data = await res.json() as {
      access_token:             string
      refresh_token:            string
      expires_in:               number
      refresh_token_expires_in: number
      scope?:                   string | string[]
    }

    accessToken  = data.access_token
    refreshToken = data.refresh_token
    expiresAt    = new Date(Date.now() + data.expires_in * 1000)
    const scopeResolved = resolveAuthorizationCodePersistedScope(data.scope)
    scope = scopeResolved.scope

    console.log(
      `[OAuth] connect store=${storeCode} flow=${oauthFlow} ` +
        `tokenResponseHasScope=${scopeResolved.tokenResponseHasScope} ` +
        `persistedScopeIncludesAnalytics=${accountHasAnalyticsScope(scope)}`
    )

    const profile = await fetchCommerceIdentityProfile(accessToken, cfg0.sandbox)
    ebayUserId = profile.ebayUserId
    storeDisplayName = profile.storeName
  }

  const store = await ensureActiveStore(workspaceId, storeCode, storeDisplayName)

  await upsertAccount(workspaceId, store.id, ebayUserId, accessToken, refreshToken, expiresAt, scope)
  await updateStoreNameFromEbay(workspaceId, store.id, storeDisplayName)

  void scheduleNewStoreDataBootstrap({
    workspaceId,
    storeId:   store.id,
    storeCode,
    storeName: store.name || storeDisplayName,
  }).catch(e =>
    console.warn(`[OAuth] Data bootstrap queue failed for store_id=${store.id}:`, e)
  )

  return {
    storeCode,
    ebayUserId,
    accessToken,
    refreshToken,
    expiresAt: expiresAt.toISOString(),
    scope,
    success:    true,
  }
}

export async function handleCallback(
  workspaceId:    string,
  code:           string,
  stateParam:     string,
  simulationMode: boolean
): Promise<EbayCallbackResult> {
  if (!stateParam?.trim()) throw new Error("Invalid state parameter")
  const state = verifyUserOAuthState(stateParam)
  if (state.flow !== "legacy_admin") throw new Error("Invalid state flow")
  const storeCode = state.storeCode
  const stateWorkspaceId = state.workspaceId
  if (stateWorkspaceId !== workspaceId) throw new Error("Invalid state (workspace mismatch)")

  return connectEbayStoreFromCode({
    workspaceId,
    storeCode,
    code,
    simulationMode,
    redirectUri: getOAuthConfig().redirectUri,
  })
}

// 3. Token yenile
export async function refreshAccessToken(
  workspaceId:    string,
  storeCode:      string,
  simulationMode: boolean
): Promise<EbayTokenRefreshResult> {
  const store = await resolveOAuthStore(workspaceId, storeCode)
  if (!store) throw new Error("Store not found")

  const account = await getAccountByStore(workspaceId, store.id)
  if (!account?.refreshToken) {
    throw new Error(`No refresh token for store "${store.name?.trim() || "Store"}"`)
  }

  let accessToken:  string
  let refreshToken: string
  let expiresAt:    Date

  if (simulationMode) {
    accessToken  = `SIM_ACCESS_${crypto.randomBytes(8).toString("hex").toUpperCase()}`
    refreshToken = account.refreshToken
    expiresAt    = new Date(Date.now() + 2 * 60 * 60 * 1000)
  } else {
    try {
      const cfg   = getOAuthConfig()
      const base  = cfg.sandbox ? EBAY_TOKEN_SANDBOX : EBAY_TOKEN_PROD
      const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")

      const res = await fetch(base, {
        method:  "POST",
        headers: {
          "Authorization": `Basic ${creds}`,
          "Content-Type":  "application/x-www-form-urlencoded",
        },
        // Do not send scope on refresh — eBay uses scopes granted with the refresh token.
        // Requesting new scopes (e.g. analytics) causes invalid_scope for existing tokens.
        body: new URLSearchParams({
          grant_type:    "refresh_token",
          refresh_token: account.refreshToken,
        }).toString(),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`Token refresh failed: ${res.status} ${text}`)
      }

      const data = await res.json() as {
        access_token: string
        expires_in:   number
        scope?:       string
      }

      accessToken  = data.access_token
      refreshToken = account.refreshToken
      expiresAt    = new Date(Date.now() + data.expires_in * 1000)
      const refreshedScope =
        parseScopeFromTokenResponse(data.scope) ?? account.scope ?? EBAY_CORE_SCOPE_LIST.join(" ")

      await upsertAccount(
        workspaceId,
        store.id,
        account.ebayUserId,
        accessToken,
        refreshToken,
        expiresAt,
        refreshedScope
      )

      return { accessToken, refreshToken, expiresAt: expiresAt.toISOString() }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const storeLabel = `${storeCode} · ${store.name?.trim() || "Store"} · store_id=${store.id}`
      if (!isInvalidScopeOAuthError(msg)) {
        await alertTokenRefreshFailed(storeLabel, msg)
      } else {
        console.warn(
          `[OAuth] Token refresh invalid_scope skipped alert store=${storeLabel} — reconnect to add analytics`
        )
      }
      throw err
    }
  }

  const persistedScope = account.scope ?? EBAY_CORE_SCOPE_LIST.join(" ")

  await upsertAccount(
    workspaceId, store.id,
    account.ebayUserId, accessToken, refreshToken, expiresAt, persistedScope
  )

  return { accessToken, refreshToken, expiresAt: expiresAt.toISOString() }
}

/** Refresh using exact store_id (never storeCode LIMIT 1). */
export async function refreshAccessTokenByStoreId(
  workspaceId:    string,
  storeId:        number,
  simulationMode: boolean
): Promise<EbayTokenRefreshResult> {
  if (!Number.isInteger(storeId) || storeId < 1) {
    throw new Error("storeId is required")
  }

  const storeRes = await query<{ id: number; name: string; store_code: string }>(
    `SELECT id, name, store_code
     FROM stores
     WHERE workspace_id = $1::uuid
       AND id = $2
       AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeId]
  )
  const store = storeRes.rows[0]
  if (!store) throw new Error("Store not found")

  const account = await getAccountByStore(workspaceId, store.id)
  if (!account?.refreshToken) {
    throw new Error(`No refresh token for store "${store.name?.trim() || "Store"}"`)
  }

  let accessToken:  string
  let refreshToken: string
  let expiresAt:    Date

  if (simulationMode) {
    accessToken  = `SIM_ACCESS_${crypto.randomBytes(8).toString("hex").toUpperCase()}`
    refreshToken = account.refreshToken
    expiresAt    = new Date(Date.now() + 2 * 60 * 60 * 1000)
  } else {
    try {
      const cfg   = getOAuthConfig()
      const base  = cfg.sandbox ? EBAY_TOKEN_SANDBOX : EBAY_TOKEN_PROD
      const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")

      const res = await fetch(base, {
        method:  "POST",
        headers: {
          "Authorization": `Basic ${creds}`,
          "Content-Type":  "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type:    "refresh_token",
          refresh_token: account.refreshToken,
        }).toString(),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`Token refresh failed: ${res.status} ${text}`)
      }

      const data = await res.json() as {
        access_token: string
        expires_in:   number
        scope?:       string
      }

      accessToken  = data.access_token
      refreshToken = account.refreshToken
      expiresAt    = new Date(Date.now() + data.expires_in * 1000)
      const refreshedScope =
        parseScopeFromTokenResponse(data.scope) ?? account.scope ?? EBAY_CORE_SCOPE_LIST.join(" ")

      await upsertAccount(
        workspaceId,
        store.id,
        account.ebayUserId,
        accessToken,
        refreshToken,
        expiresAt,
        refreshedScope
      )

      return { accessToken, refreshToken, expiresAt: expiresAt.toISOString() }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const storeLabel = `${store.store_code} · ${store.name?.trim() || "Store"} · store_id=${store.id}`
      if (!isInvalidScopeOAuthError(msg)) {
        await alertTokenRefreshFailed(storeLabel, msg)
      } else {
        console.warn(
          `[OAuth] Token refresh invalid_scope skipped alert store=${storeLabel} — reconnect to add analytics`
        )
      }
      throw err
    }
  }

  const persistedScope = account.scope ?? EBAY_CORE_SCOPE_LIST.join(" ")

  await upsertAccount(
    workspaceId, store.id,
    account.ebayUserId, accessToken, refreshToken, expiresAt, persistedScope
  )

  return { accessToken, refreshToken, expiresAt: expiresAt.toISOString() }
}

// 4. Account status
export async function getAccountStatus(
  workspaceId: string,
  storeCode:   string
): Promise<EbayAccountStatus> {
  const store = await getStoreByCode(workspaceId, storeCode)
  if (!store) throw new Error("Store not found")

  const account = await getAccountByStore(workspaceId, store.id)

  const now       = Date.now()
  const expiresAt = account?.expiresAt ? new Date(account.expiresAt).getTime() : null
  const expiresIn = expiresAt ? Math.round((expiresAt - now) / 1000) : null
  const expired   = expiresAt ? expiresAt < now : false

  const scope = account?.scope ?? null

  return {
    storeCode,
    storeName:  store.name,
    connected:  account?.connected ?? false,
    ebayUserId: account?.ebayUserId ?? null,
    expiresAt:  account?.expiresAt ?? null,
    expiresIn,
    expired,
    scope,
    hasAnalyticsScope: accountHasAnalyticsScope(scope),
    hasMarketingScope: accountHasMarketingScope(scope),
  }
}

// 5. Get valid access token (auto-refresh if needed)
export async function getValidAccessToken(
  workspaceId:    string,
  storeCode:      string,
  simulationMode: boolean
): Promise<string> {
  const store = await resolveOAuthStore(workspaceId, storeCode)
  if (!store) throw new Error("Store not found")

  if (simulationMode) return "SIM_TOKEN"

  const account = await getAccountByStore(workspaceId, store.id)
  if (!account?.accessToken) {
    throw new Error(`Store "${store.name?.trim() || "Store"}" is not connected to eBay`)
  }

  // 5 dk kala yenile
  const expiresAt = account.expiresAt ? new Date(account.expiresAt).getTime() : 0
  const tooSoon   = expiresAt < Date.now() + 5 * 60 * 1000

  if (tooSoon && account.refreshToken) {
    console.log(`[OAuth] Token expiring soon for ${storeCode}, refreshing...`)
    const refreshed = await refreshAccessToken(workspaceId, storeCode, simulationMode)
    return refreshed.accessToken
  }

  return account.accessToken
}

/** Exact store_id OAuth — never resolve by storeCode alone (S1 is not unique). */
export async function getValidAccessTokenByStoreId(
  workspaceId:    string,
  storeId:        number,
  simulationMode: boolean
): Promise<string> {
  if (!Number.isInteger(storeId) || storeId < 1) {
    throw new Error("storeId is required")
  }

  const storeRes = await query<{ id: number; name: string; store_code: string }>(
    `SELECT id, name, store_code
     FROM stores
     WHERE workspace_id = $1::uuid
       AND id = $2
       AND status = 'active'
     LIMIT 1`,
    [workspaceId, storeId]
  )
  const store = storeRes.rows[0]
  if (!store) throw new Error("Store not found")

  if (simulationMode) return "SIM_TOKEN"

  const account = await getAccountByStore(workspaceId, store.id)
  if (!account?.accessToken) {
    throw new Error(`Store "${store.name?.trim() || "Store"}" is not connected to eBay`)
  }

  const expiresAt = account.expiresAt ? new Date(account.expiresAt).getTime() : 0
  const tooSoon   = expiresAt < Date.now() + 5 * 60 * 1000

  if (tooSoon && account.refreshToken) {
    console.log(
      `[OAuth] Token expiring soon for store_id=${store.id} storeCode=${store.store_code}, refreshing...`
    )
    const refreshed = await refreshAccessTokenByStoreId(workspaceId, store.id, simulationMode)
    return refreshed.accessToken
  }

  return account.accessToken
}

// 6. All accounts in workspace
export async function getAllAccounts(
  workspaceId: string
): Promise<EbayAccountRow[]> {
  await ensureTable()
  const result = await query<{
    id:            number
    workspace_id:  string
    store_id:      number
    store_code:    string
    ebay_user_id:  string | null
    access_token:  string | null
    refresh_token: string | null
    expires_at:    string | null
    scope:         string | null
    created_at:    string
    updated_at:    string
  }>(
    `SELECT ea.*, s.store_code
     FROM ebay_accounts ea
     INNER JOIN stores s ON s.id = ea.store_id
     WHERE ea.workspace_id = $1
     ORDER BY ea.store_id ASC`,
    [workspaceId]
  )
  return result.rows.map(r => ({
    id:           r.id,
    workspaceId:  r.workspace_id,
    storeId:      r.store_id,
    storeCode:    r.store_code,
    ebayUserId:   r.ebay_user_id,
    accessToken:  r.access_token ? "[REDACTED]" : null,
    refreshToken: r.refresh_token ? "[REDACTED]" : null,
    expiresAt:    r.expires_at,
    scope:        r.scope,
    connected:    !!(r.access_token && r.refresh_token),
    createdAt:    r.created_at,
    updatedAt:    r.updated_at,
  }))
}
