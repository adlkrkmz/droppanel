// ----------------------------------------------------------------
// appEbayService.ts — user-scoped eBay OAuth connect + reconnect
// ----------------------------------------------------------------

import { query } from "../../db/client"
import { findUserById, userIsActiveMemberOfWorkspace } from "../auth/authRepository"
import { appBaseUrl } from "../auth/token"
import {
  connectEbayStoreFromCode,
  reconnectEbayStoreFromCode,
  EBAY_OAUTH_CONNECT_SCOPES,
  findNextStoreCodeForWorkspace,
  getUserOAuthRedirectUri,
} from "../ebayOAuth/ebayOAuthService"
import { signUserOAuthState, verifyUserOAuthState } from "../ebayOAuth/ebayOAuthState"
import type {
  AppEbayConnectResponse,
  AppEbayStatusResponse,
  AppEbayStoreStatus,
} from "./appTypes"
import { AppHttpError } from "./appTypes"
import type { OwnedStore } from "./appOwnership"

const EBAY_OAUTH_PROD    = "https://auth.ebay.com/oauth2/authorize"
const EBAY_OAUTH_SANDBOX = "https://auth.sandbox.ebay.com/oauth2/authorize"

function ebaySandbox(): boolean {
  return (process.env.EBAY_SANDBOX ?? "true") !== "false"
}

function ebaySimulation(): boolean {
  return (process.env.EBAY_SIMULATION ?? "true") !== "false"
}

function oauthClientId(): string {
  return process.env.EBAY_CLIENT_ID?.trim() || "SIM_CLIENT_ID"
}

export function userEbaySuccessRedirectUrl(opts?: { reconnected?: boolean }): string {
  if (opts?.reconnected) {
    return `${appBaseUrl()}/app/settings?ebayReconnected=1`
  }
  return `${appBaseUrl()}/app/dashboard?ebayConnected=1`
}

export function userEbayErrorRedirectUrl(errorCode: string): string {
  const code = encodeURIComponent(errorCode.slice(0, 120))
  return `${appBaseUrl()}/app/settings?ebayError=${code}`
}

export async function getAppEbayStatus(workspaceId: string): Promise<AppEbayStatusResponse> {
  const res = await query<{
    store_code: string
    name: string
    status: string
    has_ebay: boolean
  }>(
    `SELECT
       s.store_code,
       s.name,
       s.status,
       EXISTS (
         SELECT 1 FROM ebay_accounts ea
         WHERE ea.store_id = s.id
           AND ea.workspace_id = s.workspace_id
           AND ea.access_token IS NOT NULL
           AND ea.refresh_token IS NOT NULL
       ) AS has_ebay
     FROM stores s
     WHERE s.workspace_id = $1::uuid
       AND s.status = 'active'
     ORDER BY s.created_at ASC`,
    [workspaceId]
  )

  const stores: AppEbayStoreStatus[] = res.rows.map(r => ({
    storeCode: r.store_code,
    name:      r.name,
    status:    r.status,
    connected: r.has_ebay === true,
  }))

  return {
    ok:        true,
    connected: stores.some(s => s.connected),
    stores,
  }
}

function buildAuthorizeUrl(state: string, opts?: { promptLogin?: boolean }): AppEbayConnectResponse {
  const callbackUri = getUserOAuthRedirectUri()
  const redirectUri = process.env.EBAY_RUNAME?.trim()

  if (!redirectUri) {
    throw new AppHttpError(500, "eBay OAuth RuName is not configured")
  }

  if (ebaySimulation()) {
    return {
      ok:      true,
      authUrl: `${callbackUri}?code=SIM_CODE&state=${encodeURIComponent(state)}`,
    }
  }

  const base   = ebaySandbox() ? EBAY_OAUTH_SANDBOX : EBAY_OAUTH_PROD
  const params = new URLSearchParams({
    client_id:     oauthClientId(),
    response_type: "code",
    redirect_uri:  redirectUri,
    scope:         EBAY_OAUTH_CONNECT_SCOPES,
    state,
  })
  if (opts?.promptLogin) {
    params.set("prompt", "login")
  }

  return {
    ok:      true,
    authUrl: `${base}?${params.toString()}`,
  }
}

export async function buildAppEbayConnectUrl(input: {
  userId:      string
  workspaceId: string
}): Promise<AppEbayConnectResponse> {
  const storeCode = await findNextStoreCodeForWorkspace(input.workspaceId)
  const state     = signUserOAuthState({
    userId:      input.userId,
    workspaceId: input.workspaceId,
    storeCode,
    intent:      "connect",
  })

  console.log(
    `[eBayOAuthUser] started userId=${input.userId} workspaceId=${input.workspaceId} storeCode=${storeCode}`
  )

  return buildAuthorizeUrl(state)
}

/** Reconnect OAuth for an existing owned store (same store_id). */
export async function buildAppEbayReconnectUrl(input: {
  userId:      string
  workspaceId: string
  store:       OwnedStore
}): Promise<AppEbayConnectResponse> {
  const state = signUserOAuthState({
    userId:      input.userId,
    workspaceId: input.workspaceId,
    storeCode:   input.store.storeCode,
    storeId:     input.store.id,
    intent:      "reconnect",
  })

  console.log(
    `[eBayOAuthUser] reconnect started userId=${input.userId} workspaceId=${input.workspaceId} ` +
      `storeId=${input.store.id} storeCode=${input.store.storeCode}`
  )

  return buildAuthorizeUrl(state, { promptLogin: true })
}

async function assertUserOAuthCallbackAccess(
  userId:      string,
  workspaceId: string
): Promise<void> {
  const user = await findUserById(userId)
  if (!user) throw new AppHttpError(403, "Unauthorized")
  if (user.approvalStatus !== "active") {
    throw new AppHttpError(403, "Account is not active")
  }
  const member = await userIsActiveMemberOfWorkspace(userId, workspaceId)
  if (!member) throw new AppHttpError(403, "Workspace access denied")
}

export async function handleAppEbayCallback(input: {
  code:  string
  state: string
}): Promise<{ redirectUrl: string; storeCode: string; seller: string | null }> {
  const code  = input.code?.trim()
  const state = input.state?.trim()
  if (!code) throw new AppHttpError(400, "code is required")
  if (!state) throw new AppHttpError(400, "state is required")

  let payload
  try {
    payload = verifyUserOAuthState(state)
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid state"
    if (msg.includes("expired")) throw new AppHttpError(400, "State expired")
    if (msg.includes("signature")) throw new AppHttpError(400, "Invalid state signature")
    throw new AppHttpError(400, "Invalid state")
  }

  if (payload.flow !== "user") throw new AppHttpError(400, "Invalid state flow")

  await assertUserOAuthCallbackAccess(payload.userId, payload.workspaceId)

  const redirectUri = process.env.EBAY_RUNAME?.trim() || ""
  const simulationMode = ebaySimulation()

  try {
    if (payload.intent === "reconnect") {
      if (payload.storeId == null) {
        throw new AppHttpError(400, "Invalid reconnect state")
      }

      const result = await reconnectEbayStoreFromCode({
        workspaceId:    payload.workspaceId,
        storeId:        payload.storeId,
        storeCode:      payload.storeCode,
        code,
        simulationMode,
        redirectUri,
      })

      console.log(
        `[eBayOAuthUser] reconnected workspaceId=${payload.workspaceId} storeId=${payload.storeId} ` +
          `storeCode=${result.storeCode} seller=${result.ebayUserId ?? "unknown"}`
      )

      return {
        redirectUrl: userEbaySuccessRedirectUrl({ reconnected: true }),
        storeCode:   result.storeCode,
        seller:      result.ebayUserId,
      }
    }

    const result = await connectEbayStoreFromCode({
      workspaceId:    payload.workspaceId,
      storeCode:      payload.storeCode,
      code,
      simulationMode,
      redirectUri,
    })

    console.log(
      `[eBayOAuthUser] connected workspaceId=${payload.workspaceId} storeCode=${result.storeCode} ` +
        `seller=${result.ebayUserId ?? "unknown"}`
    )

    return {
      redirectUrl: userEbaySuccessRedirectUrl(),
      storeCode:   result.storeCode,
      seller:      result.ebayUserId,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "OAuth failed"
    if (msg.includes("EBAY_IDENTITY_MISMATCH")) {
      throw new AppHttpError(
        400,
        "Connected eBay account does not match this store. Credentials were not changed."
      )
    }
    if (msg.includes("token exchange")) throw new AppHttpError(502, "eBay token exchange failed")
    throw new AppHttpError(400, "OAuth connection failed")
  }
}
