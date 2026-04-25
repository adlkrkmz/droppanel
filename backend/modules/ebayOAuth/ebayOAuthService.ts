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

const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
].join(" ")

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
export async function buildAuthUrl(
  workspaceId: string,
  storeCode:      string,
  simulationMode: boolean,
  allowMissingStore = false
): Promise<EbayConnectUrlResponse> {
  if (!allowMissingStore) {
    const store = await getStoreByCode(workspaceId, storeCode)
    if (!store) throw new Error("Active store not found")
  }

  const state   = crypto.randomBytes(16).toString("hex")
  const stateParam = `${storeCode}:${workspaceId}:${state}`

  if (simulationMode) {
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
    scope:         EBAY_SCOPES,
    state:         stateParam,
  })

  return {
    storeCode,
    authUrl:  `${base}?${params.toString()}`,
    state:    stateParam,
  }
}

// 2. Callback işle — code → tokens
export async function handleCallback(
  workspaceId:    string,
  code:           string,
  stateParam:     string,
  simulationMode: boolean
): Promise<EbayCallbackResult> {
  // state = "{storeCode}:{workspaceId}:{nonce}"
  const parts = stateParam.split(":")
  const storeCode = parts[0] ?? ""
  const stateWorkspaceId = parts[1] ?? ""
  if (!storeCode || !stateWorkspaceId) throw new Error("Invalid state parameter")
  if (stateWorkspaceId !== workspaceId) throw new Error("Invalid state (workspace mismatch)")

  let accessToken:  string
  let refreshToken: string
  let expiresAt:    Date
  let ebayUserId:   string | null = null
  let scope:        string
  let storeDisplayName: string
  const cfg0       = getOAuthConfig()

  if (simulationMode || code === "SIM_CODE") {
    // Simulation: fake tokens
    accessToken  = `SIM_ACCESS_${crypto.randomBytes(8).toString("hex").toUpperCase()}`
    refreshToken = `SIM_REFRESH_${crypto.randomBytes(8).toString("hex").toUpperCase()}`
    expiresAt    = new Date(Date.now() + 2 * 60 * 60 * 1000) // 2 saat
    ebayUserId   = `sim_user_${storeCode.toLowerCase()}`
    scope        = EBAY_SCOPES
    storeDisplayName = "eBay (simulation)"
  } else {
    const base   = cfg0.sandbox ? EBAY_TOKEN_SANDBOX : EBAY_TOKEN_PROD
    const creds  = Buffer.from(`${cfg0.clientId}:${cfg0.clientSecret}`).toString("base64")

    const res = await fetch(base, {
      method:  "POST",
      headers: {
        "Authorization":  `Basic ${creds}`,
        "Content-Type":   "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:   "authorization_code",
        code,
        redirect_uri: cfg0.redirectUri,
      }).toString(),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`eBay token exchange failed: ${res.status} ${text}`)
    }

    const data = await res.json() as {
      access_token:             string
      refresh_token:            string
      expires_in:               number
      refresh_token_expires_in: number
      scope:                    string
    }

    accessToken  = data.access_token
    refreshToken = data.refresh_token
    expiresAt    = new Date(Date.now() + data.expires_in * 1000)
    scope        = data.scope

    const profile = await fetchCommerceIdentityProfile(accessToken, cfg0.sandbox)
    ebayUserId = profile.ebayUserId
    storeDisplayName = profile.storeName
  }

  const store = await ensureActiveStore(workspaceId, storeCode, storeDisplayName)

  await upsertAccount(workspaceId, store.id, ebayUserId, accessToken, refreshToken, expiresAt, scope)
  await updateStoreNameFromEbay(workspaceId, store.id, storeDisplayName)

  return {
    storeCode,
    ebayUserId,
    accessToken,
    refreshToken,
    expiresAt:  expiresAt.toISOString(),
    scope,
    success:    true,
  }
}

// 3. Token yenile
export async function refreshAccessToken(
  workspaceId:    string,
  storeCode:      string,
  simulationMode: boolean
): Promise<EbayTokenRefreshResult> {
  const store = await getStoreByCode(workspaceId, storeCode)
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
          scope:         EBAY_SCOPES,
        }).toString(),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`Token refresh failed: ${res.status} ${text}`)
      }

      const data = await res.json() as {
        access_token: string
        expires_in:   number
      }

      accessToken  = data.access_token
      refreshToken = account.refreshToken
      expiresAt    = new Date(Date.now() + data.expires_in * 1000)
    } catch (err) {
      await alertTokenRefreshFailed(
        storeCode,
        err instanceof Error ? err.message : String(err)
      )
      throw err
    }
  }

  await upsertAccount(
    workspaceId, store.id,
    account.ebayUserId, accessToken, refreshToken, expiresAt, account.scope ?? EBAY_SCOPES
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

  return {
    storeCode,
    storeName:  store.name,
    connected:  account?.connected ?? false,
    ebayUserId: account?.ebayUserId ?? null,
    expiresAt:  account?.expiresAt ?? null,
    expiresIn,
    expired,
    scope:      account?.scope ?? null,
  }
}

// 5. Get valid access token (auto-refresh if needed)
export async function getValidAccessToken(
  workspaceId:    string,
  storeCode:      string,
  simulationMode: boolean
): Promise<string> {
  const store = await getStoreByCode(workspaceId, storeCode)
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
