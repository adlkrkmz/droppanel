import { decryptToken, encryptToken } from "../security/tokenEncryption"
import { MAILBOX_GMAIL_SCOPES } from "./mailboxTypes"

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1"

export function googleMailboxRedirectUri(): string {
  const explicit = process.env.GOOGLE_MAILBOX_REDIRECT_URI?.trim()
  if (explicit) return explicit
  const api = (process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE ?? "").trim().replace(/\/$/, "")
  if (api) return `${api}/app/mailbox/callback`
  return "http://localhost:4000/app/mailbox/callback"
}

function googleClientId(): string {
  return process.env.GOOGLE_CLIENT_ID?.trim() || ""
}

function googleClientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET?.trim() || ""
}

export function mailboxOAuthConfigured(): boolean {
  return mailboxOAuthMissingEnv().length === 0
}

export function mailboxOAuthMissingEnv(): string[] {
  const missing: string[] = []
  if (!googleClientId()) missing.push("GOOGLE_CLIENT_ID")
  if (!googleClientSecret()) missing.push("GOOGLE_CLIENT_SECRET")
  return missing
}

const GMAIL_WRITE_SCOPE_RE = /gmail\.(send|compose|modify|insert|settings)/i

export function assertMailboxGrantedScopes(scope: string): void {
  const parts = scope.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
  if (parts.some(s => GMAIL_WRITE_SCOPE_RE.test(s))) {
    throw new Error("gmail_write_scope_refused")
  }
  if (!parts.some(s => s.includes("gmail.readonly"))) {
    throw new Error("gmail_readonly_scope_missing")
  }
}

export function buildGmailAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: googleMailboxRedirectUri(),
    response_type: "code",
    scope: MAILBOX_GMAIL_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  })
  return `${AUTH_URL}?${params.toString()}`
}

export type GmailTokenSet = {
  accessToken: string
  refreshToken: string
  expiresAt: Date | null
  scope: string
}

export async function exchangeGmailCode(code: string): Promise<GmailTokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      redirect_uri: googleMailboxRedirectUri(),
      grant_type: "authorization_code",
    }),
  })
  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    error?: string
  }
  if (!res.ok || !data.access_token) {
    const desc =
      typeof (data as { error_description?: string }).error_description === "string"
        ? (data as { error_description?: string }).error_description!
            .replace(/[^\w\s:().-]/g, "")
            .slice(0, 80)
        : ""
    throw new Error(
      data.error ||
        (desc ? `gmail_token_exchange_${res.status}:${desc}` : `gmail_token_exchange_${res.status}`)
    )
  }
  if (!data.refresh_token) {
    throw new Error("gmail_refresh_token_missing")
  }
  const scope = data.scope || MAILBOX_GMAIL_SCOPES
  assertMailboxGrantedScopes(scope)
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    scope,
  }
}

export async function refreshGmailAccessToken(refreshToken: string): Promise<GmailTokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      grant_type: "refresh_token",
    }),
  })
  const data = (await res.json()) as {
    access_token?: string
    expires_in?: number
    scope?: string
    error?: string
  }
  if (!res.ok || !data.access_token) {
    throw new Error(data.error || `gmail_refresh_${res.status}`)
  }
  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    scope: data.scope || MAILBOX_GMAIL_SCOPES,
  }
}

export async function fetchGmailUserEmail(accessToken: string): Promise<{
  email: string
  id: string
}> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data = (await res.json()) as { email?: string; id?: string; sub?: string }
  const id = data.id || data.sub
  if (!res.ok || !data.email || !id) throw new Error(`gmail_userinfo_failed_${res.status}`)
  return { email: data.email, id: String(id) }
}

export function encryptMailboxTokens(tokens: GmailTokenSet): {
  accessEnc: string
  refreshEnc: string
} {
  return {
    accessEnc: encryptToken(tokens.accessToken),
    refreshEnc: encryptToken(tokens.refreshToken),
  }
}

export function decryptMailboxTokens(row: {
  access_token_enc: string
  refresh_token_enc: string
}): { accessToken: string; refreshToken: string } {
  return {
    accessToken: decryptToken(row.access_token_enc),
    refreshToken: decryptToken(row.refresh_token_enc),
  }
}

export type GmailPartMeta = {
  filename: string | null
  mimeType: string
  size: number | null
  attachmentId: string | null
  contentId: string | null
  disposition: string | null
}

export type GmailParsedMessage = {
  providerMessageId: string
  threadId: string | null
  rfcMessageId: string | null
  sender: string | null
  recipient: string | null
  subject: string | null
  receivedAt: Date | null
  textBody: string | null
  htmlBody: string | null
  attachments: GmailPartMeta[]
  inlineImages: GmailPartMeta[]
  historyId: string | null
}

type GmailMessageJson = {
  id?: string
  threadId?: string
  historyId?: string
  internalDate?: string
  payload?: GmailPayload
}

type GmailPayload = {
  mimeType?: string
  filename?: string
  body?: { size?: number; data?: string; attachmentId?: string }
  headers?: Array<{ name?: string; value?: string }>
  parts?: GmailPayload[]
}

function header(headers: Array<{ name?: string; value?: string }> | undefined, name: string): string | null {
  const h = headers?.find(x => (x.name ?? "").toLowerCase() === name.toLowerCase())
  return h?.value?.trim() || null
}

function decodeB64Url(data: string | undefined): string {
  if (!data) return ""
  const pad = data.replace(/-/g, "+").replace(/_/g, "/")
  return Buffer.from(pad, "base64").toString("utf8")
}

function walkParts(
  part: GmailPayload | undefined,
  acc: { text: string[]; html: string[]; attachments: GmailPartMeta[]; inline: GmailPartMeta[] }
): void {
  if (!part) return
  const mime = (part.mimeType ?? "").toLowerCase()
  const disp = header(part.headers, "Content-Disposition")
  const cid = header(part.headers, "Content-ID")
  const filename = part.filename?.trim() || null
  const attId = part.body?.attachmentId ?? null
  if (filename && attId) {
    const meta: GmailPartMeta = {
      filename,
      mimeType: mime,
      size: part.body?.size ?? null,
      attachmentId: attId,
      contentId: cid,
      disposition: disp,
    }
    if (disp?.toLowerCase().includes("inline") || cid) acc.inline.push(meta)
    else acc.attachments.push(meta)
  }
  if (mime === "text/plain" && part.body?.data) acc.text.push(decodeB64Url(part.body.data))
  if (mime === "text/html" && part.body?.data) acc.html.push(decodeB64Url(part.body.data))
  for (const child of part.parts ?? []) walkParts(child, acc)
}

export function parseGmailMessageJson(msg: GmailMessageJson): GmailParsedMessage {
  const acc = { text: [] as string[], html: [] as string[], attachments: [] as GmailPartMeta[], inline: [] as GmailPartMeta[] }
  walkParts(msg.payload, acc)
  const headers = msg.payload?.headers
  const internal = msg.internalDate ? Number(msg.internalDate) : NaN
  return {
    providerMessageId: String(msg.id ?? ""),
    threadId: msg.threadId ?? null,
    rfcMessageId: header(headers, "Message-ID"),
    sender: header(headers, "From"),
    recipient: header(headers, "To"),
    subject: header(headers, "Subject"),
    receivedAt: Number.isFinite(internal) ? new Date(internal) : null,
    textBody: acc.text.join("\n").trim() || null,
    htmlBody: acc.html.join("\n").trim() || null,
    attachments: acc.attachments,
    inlineImages: acc.inline,
    historyId: msg.historyId ?? null,
  }
}

type GmailErrorBody = {
  error?: {
    code?: number
    status?: string
    message?: string
    errors?: Array<{ reason?: string; message?: string; domain?: string }>
  }
}

function gmailErrorReason(body: GmailErrorBody): string | null {
  return body.error?.errors?.[0]?.reason ?? null
}

function formatGmailApiError(status: number, body: GmailErrorBody, op: string): string {
  const reason = gmailErrorReason(body)
  const message = (body.error?.message ?? "").replace(/\s+/g, " ").trim().slice(0, 180)
  const statusName = body.error?.status ?? ""
  return [op, String(status), reason, statusName, message].filter(Boolean).join(" ").slice(0, 280)
}

function isRetryableGmailStatus(status: number, body: GmailErrorBody): boolean {
  if (status === 429) return true
  const reason = gmailErrorReason(body)
  return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded"
}

function retryAfterMs(res: Response, fallback: number): number {
  const raw = res.headers.get("retry-after")
  if (!raw) return fallback
  const sec = Number(raw)
  if (Number.isFinite(sec) && sec >= 0) return Math.min(Math.max(sec * 1000, 500), 70_000)
  return fallback
}

async function gmailGetJson<T>(accessToken: string, path: string, op: string): Promise<T> {
  let waitMs = 8000
  let lastErr = `${op}_failed`
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`${GMAIL_API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const body = (await res.json().catch(() => ({}))) as T & GmailErrorBody
    if (res.ok) return body
    lastErr = formatGmailApiError(res.status, body, op)
    if (attempt < 7 && isRetryableGmailStatus(res.status, body)) {
      const delay = retryAfterMs(res, waitMs)
      console.warn("[mailbox] gmail quota retry", {
        op,
        reason: gmailErrorReason(body),
        attempt,
        waitMs: delay,
      })
      await new Promise(r => setTimeout(r, delay))
      waitMs = Math.min(Math.max(delay, 8000) * 2, 70_000)
      continue
    }
    throw new Error(lastErr)
  }
  throw new Error(lastErr)
}

export async function gmailGetProfile(accessToken: string): Promise<{ historyId: string | null; email: string | null }> {
  const data = await gmailGetJson<{ historyId?: string; emailAddress?: string }>(
    accessToken,
    "/users/me/profile",
    "gmail_profile"
  )
  return { historyId: data.historyId != null ? String(data.historyId) : null, email: data.emailAddress ?? null }
}

export const GMAIL_WHITELIST_QUERY = [
  "newer_than:7d",
  "(",
  '(from:amazon.com (subject:Ordered OR subject:Shipped OR subject:"Delivery update" OR subject:Delivered))',
  "OR",
  '(from:ebay.com (subject:"You made the sale" OR subject:cancel OR subject:"return request" OR subject:payout OR subject:"We sent your payout"))',
  ")",
].join(" ")

export async function gmailListTransactionalIds(accessToken: string, pageToken?: string): Promise<{
  ids: string[]
  nextPageToken: string | null
}> {
  const params = new URLSearchParams({ q: GMAIL_WHITELIST_QUERY, maxResults: "50" })
  if (pageToken) params.set("pageToken", pageToken)
  const data = await gmailGetJson<{
    messages?: Array<{ id?: string }>
    nextPageToken?: string
  }>(accessToken, `/users/me/messages?${params.toString()}`, "gmail_list")
  return {
    ids: (data.messages ?? []).map(m => String(m.id ?? "")).filter(Boolean),
    nextPageToken: data.nextPageToken ?? null,
  }
}

export async function gmailHistoryMessageIds(
  accessToken: string,
  startHistoryId: string
): Promise<{ ids: string[]; newHistoryId: string | null; expired: boolean }> {
  const params = new URLSearchParams({
    startHistoryId,
    historyTypes: "messageAdded",
    maxResults: "100",
  })
  let data: {
    history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>
    historyId?: string
  }
  try {
    data = await gmailGetJson(
      accessToken,
      `/users/me/history?${params.toString()}`,
      "gmail_history"
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : ""
    if (/\bgmail_history 404\b/.test(msg)) return { ids: [], newHistoryId: null, expired: true }
    throw e
  }
  const ids: string[] = []
  for (const h of data.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      const id = added.message?.id
      if (id) ids.push(id)
    }
  }
  return { ids, newHistoryId: data.historyId != null ? String(data.historyId) : null, expired: false }
}

export async function gmailGetMessageMetadata(
  accessToken: string,
  id: string
): Promise<{ providerMessageId: string; sender: string | null; subject: string | null }> {
  const params = new URLSearchParams({ format: "metadata" })
  params.append("metadataHeaders", "From")
  params.append("metadataHeaders", "Subject")
  const json = await gmailGetJson<GmailMessageJson>(
    accessToken,
    `/users/me/messages/${encodeURIComponent(id)}?${params.toString()}`,
    "gmail_meta"
  )
  const headers = json.payload?.headers
  const header = (name: string): string | null => {
    const h = headers?.find(x => (x.name ?? "").toLowerCase() === name.toLowerCase())
    return h?.value?.trim() || null
  }
  return {
    providerMessageId: String(json.id ?? id),
    sender: header("From"),
    subject: header("Subject"),
  }
}

export async function gmailGetMessage(accessToken: string, id: string): Promise<GmailParsedMessage> {
  const json = await gmailGetJson<GmailMessageJson>(
    accessToken,
    `/users/me/messages/${encodeURIComponent(id)}?format=full`,
    "gmail_get"
  )
  return parseGmailMessageJson(json)
}
