import crypto from "crypto"
import { query } from "../../db/client"
import { findUserById, userIsActiveMemberOfWorkspace } from "../auth/authRepository"
import { appBaseUrl, jwtSecret } from "../auth/token"
import { AppHttpError } from "../app/appTypes"
import { MAILBOX_GMAIL_SCOPES } from "./mailboxTypes"
import {
  assertMailboxGrantedScopes,
  buildGmailAuthUrl,
  decryptMailboxTokens,
  encryptMailboxTokens,
  exchangeGmailCode,
  fetchGmailUserEmail,
  gmailGetProfile,
  googleMailboxRedirectUri,
  mailboxOAuthConfigured,
  mailboxOAuthMissingEnv,
  refreshGmailAccessToken,
} from "./gmailClient"

const STATE_TTL_MS = 15 * 60 * 1000

type MailboxOAuthState = {
  flow: "mailbox"
  userId: string
  workspaceId: string
  nonce: string
  createdAt: number
}

function stateSecret(): string {
  return process.env.GOOGLE_MAILBOX_STATE_SECRET?.trim() || jwtSecret()
}

export function signMailboxOAuthState(input: {
  userId: string
  workspaceId: string
}): string {
  const payload: MailboxOAuthState = {
    flow: "mailbox",
    userId: input.userId,
    workspaceId: input.workspaceId,
    nonce: crypto.randomBytes(16).toString("hex"),
    createdAt: Date.now(),
  }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const sig = crypto.createHmac("sha256", stateSecret()).update(body).digest("base64url")
  return `${body}.${sig}`
}

function hmacEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest()
  const hb = crypto.createHash("sha256").update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}

export function verifyMailboxOAuthState(raw: string): MailboxOAuthState {
  const [body, sig] = raw.split(".")
  if (!body || !sig) throw new Error("invalid_state")
  const expect = crypto.createHmac("sha256", stateSecret()).update(body).digest("base64url")
  if (!hmacEqual(sig, expect)) throw new Error("invalid_state")
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as MailboxOAuthState
  if (payload.flow !== "mailbox") throw new Error("invalid_state")
  if (Date.now() - payload.createdAt > STATE_TTL_MS) throw new Error("state_expired")
  return payload
}

export function mailboxSuccessRedirect(): string {
  const q = new URLSearchParams({ mailboxConnected: "1" })
  return `${appBaseUrl()}/app/settings?${q.toString()}`
}

export function mailboxErrorRedirect(code: string): string {
  const q = new URLSearchParams({ mailboxError: code.slice(0, 80) })
  return `${appBaseUrl()}/app/settings?${q.toString()}`
}

export async function buildMailboxConnectUrl(input: {
  userId: string
  workspaceId: string
}): Promise<{ ok: true; authUrl: string }> {
  if (!mailboxOAuthConfigured()) {
    const missing = mailboxOAuthMissingEnv().join(", ")
    throw new AppHttpError(500, `Gmail mailbox OAuth is not configured (${missing})`)
  }
  const state = signMailboxOAuthState({
    userId: input.userId,
    workspaceId: input.workspaceId,
  })
  return { ok: true, authUrl: buildGmailAuthUrl(state) }
}

async function assertMailboxCallbackAccess(state: MailboxOAuthState): Promise<void> {
  const user = await findUserById(state.userId)
  if (!user) throw new AppHttpError(403, "Unauthorized")
  if (user.approvalStatus !== "active") {
    throw new AppHttpError(403, "Account is not active")
  }
  const member = await userIsActiveMemberOfWorkspace(state.userId, state.workspaceId)
  if (!member) throw new AppHttpError(403, "Workspace access denied")
}

function mapMailboxOAuthError(e: unknown): never {
  const msg = e instanceof Error ? e.message : "mailbox_oauth_failed"
  if (e instanceof AppHttpError) throw e
  if (msg === "invalid_state" || msg === "state_expired") {
    throw new AppHttpError(400, msg === "state_expired" ? "State expired" : "Invalid state")
  }
  if (msg === "gmail_refresh_token_missing") {
    throw new AppHttpError(400, "Gmail reconnect required: offline access was not granted")
  }
  if (msg === "gmail_already_bound_other_workspace") {
    throw new AppHttpError(409, "This Gmail account is already connected to another workspace")
  }
  if (msg === "gmail_write_scope_refused") {
    throw new AppHttpError(400, "Gmail write access is not allowed")
  }
  if (msg === "gmail_readonly_scope_missing") {
    throw new AppHttpError(400, "Gmail read access was not granted")
  }
  if (msg === "invalid_grant" || msg === "redirect_uri_mismatch" || msg === "invalid_client") {
    throw new AppHttpError(400, `Gmail token exchange failed (${msg})`)
  }
  if (
    msg.startsWith("gmail_userinfo_failed") ||
    msg.startsWith("gmail_profile_") ||
    msg.startsWith("gmail_token_exchange_")
  ) {
    throw new AppHttpError(400, msg.slice(0, 80))
  }
  console.warn("[mailbox] oauth unmapped error:", msg)
  throw new AppHttpError(400, "Gmail mailbox connection failed")
}

export async function handleMailboxOAuthCallback(code: string, stateRaw: string): Promise<{
  workspaceId: string
  accountId: number
}> {
  if (!code.trim()) throw new AppHttpError(400, "code is required")
  if (!stateRaw.trim()) throw new AppHttpError(400, "state is required")

  let state: MailboxOAuthState
  try {
    state = verifyMailboxOAuthState(stateRaw)
  } catch (e) {
    mapMailboxOAuthError(e)
    throw e
  }

  await assertMailboxCallbackAccess(state)

  try {
    const tokens = await exchangeGmailCode(code)
    assertMailboxGrantedScopes(tokens.scope)
    const user = await fetchGmailUserEmail(tokens.accessToken)
    let historyId: string | null = null
    try {
      const profile = await gmailGetProfile(tokens.accessToken)
      historyId = profile.historyId
    } catch (e) {
      console.warn("[mailbox] gmail profile skipped", e instanceof Error ? e.message : e)
    }
    const enc = encryptMailboxTokens(tokens)
    console.warn("[mailbox] token exchange ok", {
      workspaceId: state.workspaceId,
      hasRefresh: Boolean(tokens.refreshToken),
      hasHistoryId: Boolean(historyId),
      scope: tokens.scope,
    })

    const taken = await query<{ workspace_id: string }>(
      `SELECT workspace_id::text FROM mailbox_accounts
       WHERE provider = 'gmail' AND provider_account_id = $1 AND workspace_id <> $2::uuid`,
      [user.id, state.workspaceId]
    )
    if (taken.rows[0]) {
      throw new Error("gmail_already_bound_other_workspace")
    }

    const ins = await query<{ id: number }>(
      `INSERT INTO mailbox_accounts (
         workspace_id, store_id, provider, email_address, provider_account_id,
         access_token_enc, refresh_token_enc, token_expires_at, scope, status, history_id, updated_at
       ) VALUES ($1::uuid, NULL, 'gmail', $2, $3, $4, $5, $6, $7, 'CONNECTED', $8, NOW())
       ON CONFLICT (workspace_id, provider, provider_account_id) DO UPDATE SET
         email_address = EXCLUDED.email_address,
         provider_account_id = EXCLUDED.provider_account_id,
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         token_expires_at = EXCLUDED.token_expires_at,
         scope = EXCLUDED.scope,
         status = 'CONNECTED',
         history_id = EXCLUDED.history_id,
         last_error = NULL,
         updated_at = NOW()
       RETURNING id`,
      [
        state.workspaceId,
        user.email,
        user.id,
        enc.accessEnc,
        enc.refreshEnc,
        tokens.expiresAt,
        tokens.scope || MAILBOX_GMAIL_SCOPES,
        historyId,
      ]
    )
    if (!ins.rows[0]?.id) throw new Error("mailbox_account_insert_failed")
    console.warn("[mailbox] mailbox_accounts upserted", {
      accountId: ins.rows[0]?.id,
      workspaceId: state.workspaceId,
    })
    return {
      workspaceId: state.workspaceId,
      accountId: Number(ins.rows[0]!.id),
    }
  } catch (e) {
    mapMailboxOAuthError(e)
    throw e
  }
}

export async function getValidGmailAccessToken(accountId: number): Promise<string> {
  const res = await query<{
    access_token_enc: string
    refresh_token_enc: string
    token_expires_at: Date | null
  }>(
    `SELECT access_token_enc, refresh_token_enc, token_expires_at
     FROM mailbox_accounts WHERE id = $1 AND status = 'CONNECTED'`,
    [accountId]
  )
  const row = res.rows[0]
  if (!row) throw new Error("mailbox_not_connected")
  const tokens = decryptMailboxTokens(row)
  const exp = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0
  if (exp && exp > Date.now() + 60_000) return tokens.accessToken
  const refreshed = await refreshGmailAccessToken(tokens.refreshToken)
  const enc = encryptMailboxTokens({
    ...refreshed,
    refreshToken: refreshed.refreshToken || tokens.refreshToken,
  })
  await query(
    `UPDATE mailbox_accounts
     SET access_token_enc = $2, refresh_token_enc = $3, token_expires_at = $4, updated_at = NOW()
     WHERE id = $1`,
    [accountId, enc.accessEnc, enc.refreshEnc, refreshed.expiresAt]
  )
  return refreshed.accessToken
}

export type WorkspaceMailboxStatus = {
  id: number
  email: string
  status: string
  lastIngestedAt: string | null
  lastError: string | null
}

export async function listWorkspaceMailboxes(workspaceId: string): Promise<WorkspaceMailboxStatus[]> {
  const res = await query<{
    id: number
    email_address: string
    status: string
    last_ingested_at: Date | null
    last_error: string | null
  }>(
    `SELECT id, email_address, status, last_ingested_at, last_error
     FROM mailbox_accounts
     WHERE workspace_id = $1::uuid
     ORDER BY created_at ASC, id ASC`,
    [workspaceId]
  )
  return res.rows.map(row => ({
    id: Number(row.id),
    email: row.email_address,
    status: row.status,
    lastIngestedAt: row.last_ingested_at ? new Date(row.last_ingested_at).toISOString() : null,
    lastError: row.last_error?.trim() || null,
  }))
}

export async function assertWorkspaceMailboxAccount(workspaceId: string, accountId: number): Promise<number> {
  const res = await query<{ id: number }>(
    `SELECT id FROM mailbox_accounts WHERE id = $1 AND workspace_id = $2::uuid LIMIT 1`,
    [accountId, workspaceId]
  )
  if (!res.rows[0]) throw new AppHttpError(404, "Mailbox not found")
  return Number(res.rows[0].id)
}

export async function disconnectWorkspaceMailbox(workspaceId: string, accountId: number): Promise<void> {
  await assertWorkspaceMailboxAccount(workspaceId, accountId)
  await query(
    `UPDATE mailbox_accounts
     SET status = 'DISCONNECTED', last_error = NULL, updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2::uuid`,
    [accountId, workspaceId]
  )
}

export { googleMailboxRedirectUri, mailboxOAuthConfigured }
