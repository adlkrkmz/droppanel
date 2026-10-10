import { query } from "../../db/client"
import { decryptToken, encryptToken } from "../security/tokenEncryption"
import type { AmazonAccountStatus } from "./amazonBrowserWorkerConstants"

export type AmazonWorkerAccountRow = {
  id: number
  sourcePlatform: string
  accountType: "PERSONAL" | "BUSINESS"
  email: string | null
  passwordEncrypted: string | null
  authenticatorEnabled: boolean
  totpSecretEncrypted: string | null
  proxyEnabled: boolean
  proxyHost: string | null
  proxyPort: number | null
  proxyUsername: string | null
  proxyPasswordEncrypted: string | null
  accountStatus: AmazonAccountStatus
  browserProfileId: string
  lastLoginAt: Date | null
  lastSuccessfulVerificationAt: Date | null
  lastError: string | null
  sessionState: string
}

function mapRow(row: Record<string, unknown>): AmazonWorkerAccountRow {
  return {
    id: Number(row.id),
    sourcePlatform: String(row.source_platform ?? "amazon.com"),
    accountType: row.account_type === "BUSINESS" ? "BUSINESS" : "PERSONAL",
    email: typeof row.email === "string" ? row.email : null,
    passwordEncrypted: typeof row.password_encrypted === "string" ? row.password_encrypted : null,
    authenticatorEnabled: row.authenticator_enabled === true,
    totpSecretEncrypted: typeof row.totp_secret_encrypted === "string" ? row.totp_secret_encrypted : null,
    proxyEnabled: row.proxy_enabled === true,
    proxyHost: typeof row.proxy_host === "string" ? row.proxy_host : null,
    proxyPort: row.proxy_port != null ? Number(row.proxy_port) : null,
    proxyUsername: typeof row.proxy_username === "string" ? row.proxy_username : null,
    proxyPasswordEncrypted:
      typeof row.proxy_password_encrypted === "string" ? row.proxy_password_encrypted : null,
    accountStatus: String(row.account_status ?? "UNCONFIGURED") as AmazonAccountStatus,
    browserProfileId: String(row.browser_profile_id ?? "default"),
    lastLoginAt: row.last_login_at ? new Date(String(row.last_login_at)) : null,
    lastSuccessfulVerificationAt: row.last_successful_verification_at
      ? new Date(String(row.last_successful_verification_at))
      : null,
    lastError: typeof row.last_error === "string" ? row.last_error : null,
    sessionState: String(row.session_state ?? "UNKNOWN"),
  }
}

export async function ensureAmazonWorkerAccount(): Promise<AmazonWorkerAccountRow> {
  await query(`INSERT INTO amazon_worker_accounts (id) VALUES (1) ON CONFLICT (id) DO NOTHING`)
  const res = await query(`SELECT * FROM amazon_worker_accounts WHERE id = 1`)
  return mapRow(res.rows[0] as Record<string, unknown>)
}

export async function getAmazonWorkerAccount(): Promise<AmazonWorkerAccountRow> {
  return ensureAmazonWorkerAccount()
}

export function publicAmazonAccountView(row: AmazonWorkerAccountRow): Record<string, unknown> {
  return {
    sourcePlatform: row.sourcePlatform,
    accountType: row.accountType,
    email: row.email,
    passwordConfigured: Boolean(row.passwordEncrypted),
    authenticatorEnabled: row.authenticatorEnabled,
    totpConfigured: Boolean(row.totpSecretEncrypted),
    proxyEnabled: row.proxyEnabled,
    proxyConfigured: Boolean(row.proxyEnabled && row.proxyHost),
    proxyHost: row.proxyHost,
    proxyPort: row.proxyPort,
    proxyUsername: row.proxyUsername,
    accountStatus: row.accountStatus,
    browserProfileId: row.browserProfileId,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    lastSuccessfulVerificationAt: row.lastSuccessfulVerificationAt?.toISOString() ?? null,
    lastError: row.lastError,
    sessionState: row.sessionState,
  }
}

function safeError(message: string | null | undefined): string | null {
  if (!message) return null
  return message
    .replace(/password[^=\s]*\s*[:=]\s*\S+/gi, "password=[redacted]")
    .replace(/cookie[s]?\s*[:=]\s*\S+/gi, "cookies=[redacted]")
    .replace(/totp[^=\s]*\s*[:=]\s*\S+/gi, "totp=[redacted]")
    .slice(0, 400)
}

export async function updateAmazonAccountStatus(input: {
  accountStatus?: AmazonAccountStatus
  sessionState?: string
  lastError?: string | null
  lastLoginAt?: Date | null
  lastSuccessfulVerificationAt?: Date | null
}): Promise<void> {
  await ensureAmazonWorkerAccount()
  await query(
    `UPDATE amazon_worker_accounts
     SET account_status = COALESCE($1, account_status),
         session_state = COALESCE($2, session_state),
         last_error = CASE WHEN $6::boolean THEN $3 ELSE last_error END,
         last_login_at = COALESCE($4, last_login_at),
         last_successful_verification_at = COALESCE($5, last_successful_verification_at),
         updated_at = NOW()
     WHERE id = 1`,
    [
      input.accountStatus ?? null,
      input.sessionState ?? null,
      input.lastError === undefined ? null : safeError(input.lastError),
      input.lastLoginAt ?? null,
      input.lastSuccessfulVerificationAt ?? null,
      input.lastError !== undefined,
    ]
  )
}

export async function saveAmazonWorkerAccount(input: {
  email?: string | null
  accountType?: "PERSONAL" | "BUSINESS"
  password?: string | null
  authenticatorEnabled?: boolean
  totpSecret?: string | null
  proxyEnabled?: boolean
  proxyHost?: string | null
  proxyPort?: number | null
  proxyUsername?: string | null
  proxyPassword?: string | null
  removePassword?: boolean
  removeTotp?: boolean
  removeProxyPassword?: boolean
}): Promise<AmazonWorkerAccountRow> {
  const current = await ensureAmazonWorkerAccount()
  let passwordEncrypted = current.passwordEncrypted
  let totpEncrypted = current.totpSecretEncrypted
  let proxyPasswordEncrypted = current.proxyPasswordEncrypted

  if (input.removePassword === true) passwordEncrypted = null
  else if (typeof input.password === "string" && input.password.trim() !== "") {
    passwordEncrypted = encryptToken(input.password)
  }

  if (input.removeTotp === true) totpEncrypted = null
  else if (typeof input.totpSecret === "string" && input.totpSecret.trim() !== "") {
    totpEncrypted = encryptToken(input.totpSecret.replace(/\s+/g, ""))
  }

  if (input.removeProxyPassword === true) proxyPasswordEncrypted = null
  else if (typeof input.proxyPassword === "string" && input.proxyPassword.trim() !== "") {
    proxyPasswordEncrypted = encryptToken(input.proxyPassword)
  }

  const email = input.email !== undefined ? (input.email?.trim() || null) : current.email
  const authenticatorEnabled =
    input.authenticatorEnabled !== undefined ? input.authenticatorEnabled : current.authenticatorEnabled
  const ready = Boolean(email && passwordEncrypted)
  const nextStatus: AmazonAccountStatus =
    current.accountStatus === "PAUSED" ||
    current.accountStatus === "CHALLENGE_REQUIRED" ||
    current.accountStatus === "THROTTLED"
      ? current.accountStatus
      : ready
        ? current.accountStatus === "UNCONFIGURED" || current.accountStatus === "ERROR"
          ? "READY"
          : current.accountStatus
        : "UNCONFIGURED"

  await query(
    `UPDATE amazon_worker_accounts
     SET email = $1,
         account_type = $2,
         password_encrypted = $3,
         authenticator_enabled = $4,
         totp_secret_encrypted = $5,
         proxy_enabled = $6,
         proxy_host = $7,
         proxy_port = $8,
         proxy_username = $9,
         proxy_password_encrypted = $10,
         account_status = $11,
         updated_at = NOW()
     WHERE id = 1`,
    [
      email,
      input.accountType ?? current.accountType,
      passwordEncrypted,
      authenticatorEnabled,
      totpEncrypted,
      input.proxyEnabled !== undefined ? input.proxyEnabled : current.proxyEnabled,
      input.proxyHost !== undefined ? input.proxyHost?.trim() || null : current.proxyHost,
      input.proxyPort !== undefined ? input.proxyPort : current.proxyPort,
      input.proxyUsername !== undefined ? input.proxyUsername?.trim() || null : current.proxyUsername,
      proxyPasswordEncrypted,
      nextStatus,
    ]
  )
  return getAmazonWorkerAccount()
}

export function decryptAmazonPassword(row: AmazonWorkerAccountRow): string | null {
  if (!row.passwordEncrypted) return null
  return decryptToken(row.passwordEncrypted)
}

export function decryptAmazonTotpSecret(row: AmazonWorkerAccountRow): string | null {
  if (!row.totpSecretEncrypted) return null
  return decryptToken(row.totpSecretEncrypted)
}

export function decryptAmazonProxyPassword(row: AmazonWorkerAccountRow): string | null {
  if (!row.proxyPasswordEncrypted) return null
  return decryptToken(row.proxyPasswordEncrypted)
}
