import crypto from "crypto"
import { db, query } from "../../db/client"
import { generateDesktopAgentToken } from "./desktopAgentAuth"
import type { DesktopAgentDeviceRow } from "./desktopAgentTypes"

export const DESKTOP_AGENT_PAIRING_TTL_MS = 10 * 60_000

/** Ambiguity-safe alphabet (no 0/O/1/I/L). */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

function hashPairingCode(normalizedCode: string): string {
  return crypto.createHash("sha256").update(normalizedCode, "utf8").digest("hex")
}

/** Normalize user/agent input to canonical LJG-XXXX-XXX form. */
export function normalizePairingCode(raw: string): string | null {
  const cleaned = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
  if (!cleaned.startsWith("LJG") || cleaned.length !== 10) return null
  const body = cleaned.slice(3)
  if (!/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{7}$/.test(body)) return null
  return `LJG-${body.slice(0, 4)}-${body.slice(4)}`
}

export function generatePairingCode(): { pairingCode: string; codeHash: string } {
  const bytes = crypto.randomBytes(7)
  let body = ""
  for (let i = 0; i < 7; i++) {
    body += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]!
  }
  const pairingCode = `LJG-${body.slice(0, 4)}-${body.slice(4)}`
  return { pairingCode, codeHash: hashPairingCode(pairingCode) }
}

export async function createDesktopAgentPairing(input: {
  workspaceId: string
  userId: string
}): Promise<{ pairingCode: string; expiresAt: string }> {
  // Housekeeping: drop stale unclaimed rows for this workspace (non-blocking).
  await query(
    `DELETE FROM desktop_agent_pairings
     WHERE workspace_id = $1::uuid
       AND claimed_at IS NULL
       AND expires_at < NOW()`,
    [input.workspaceId]
  ).catch(() => undefined)

  const { pairingCode, codeHash } = generatePairingCode()
  const expiresAt = new Date(Date.now() + DESKTOP_AGENT_PAIRING_TTL_MS)
  await query(
    `INSERT INTO desktop_agent_pairings (
       code_hash, workspace_id, user_id, expires_at, created_at
     ) VALUES ($1, $2::uuid, $3::uuid, $4::timestamptz, NOW())`,
    [codeHash, input.workspaceId, input.userId, expiresAt]
  )
  return { pairingCode, expiresAt: expiresAt.toISOString() }
}

export type ClaimPairingResult =
  | {
      ok: true
      device: DesktopAgentDeviceRow
      plainToken: string
    }
  | {
      ok: false
      code: "INVALID_CODE" | "EXPIRED" | "ALREADY_CLAIMED" | "CLAIM_RACE"
      message: string
    }

/**
 * Atomic one-time claim: mark pairing claimed, then mint device via existing register path.
 * Never logs plaintext pairing code or device token.
 */
export async function claimDesktopAgentPairing(input: {
  pairingCode: string
  deviceName?: string
  version?: string | null
}): Promise<ClaimPairingResult> {
  const normalized = normalizePairingCode(input.pairingCode)
  if (!normalized) {
    return { ok: false, code: "INVALID_CODE", message: "Invalid pairing code" }
  }
  const codeHash = hashPairingCode(normalized)

  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const lock = await client.query<{
      id: string
      workspace_id: string
      user_id: string
      expires_at: Date
      claimed_at: Date | null
    }>(
      `SELECT id::text, workspace_id::text AS workspace_id, user_id::text AS user_id,
              expires_at, claimed_at
       FROM desktop_agent_pairings
       WHERE code_hash = $1
       FOR UPDATE`,
      [codeHash]
    )
    const row = lock.rows[0]
    if (!row) {
      await client.query("ROLLBACK")
      return { ok: false, code: "INVALID_CODE", message: "Invalid pairing code" }
    }
    if (row.claimed_at) {
      await client.query("ROLLBACK")
      return { ok: false, code: "ALREADY_CLAIMED", message: "Pairing code already used" }
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query("ROLLBACK")
      return { ok: false, code: "EXPIRED", message: "Pairing code expired" }
    }

    // Create device inside same transaction via direct insert (reuse token helpers).
    const deviceId = `da_${crypto.randomBytes(16).toString("hex")}`
    const { plainToken, tokenHash } = generateDesktopAgentToken()
    const name = (input.deviceName ?? "Desktop Agent").trim().slice(0, 120) || "Desktop Agent"

    const deviceRes = await client.query<{
      id: string
      device_id: string
      workspace_id: string
      user_id: string
      device_name: string
      status: string
      version: string | null
      last_heartbeat_at: Date | null
      last_observation_at: Date | null
      scanned_count: string
      success_count_today: string
      failure_count_today: string
      created_at: Date
    }>(
      `INSERT INTO desktop_agent_devices (
         device_id, workspace_id, user_id, device_name, token_hash, status, version,
         last_heartbeat_at, created_at, updated_at
       ) VALUES (
         $1, $2::uuid, $3::uuid, $4, $5, 'ONLINE', $6,
         NOW(), NOW(), NOW()
       )
       RETURNING id, device_id, workspace_id::text AS workspace_id, user_id::text AS user_id,
                 device_name, status, version, last_heartbeat_at, last_observation_at,
                 scanned_count::text, success_count_today::text, failure_count_today::text, created_at`,
      [deviceId, row.workspace_id, row.user_id, name, tokenHash, input.version?.trim() || null]
    )

    const claimed = await client.query(
      `UPDATE desktop_agent_pairings
       SET claimed_at = NOW(),
           claimed_device_id = $2
       WHERE id = $1::bigint
         AND claimed_at IS NULL
         AND expires_at > NOW()`,
      [row.id, deviceId]
    )
    if ((claimed.rowCount ?? 0) !== 1) {
      await client.query("ROLLBACK")
      return { ok: false, code: "CLAIM_RACE", message: "Pairing code already used" }
    }

    await client.query("COMMIT")
    const d = deviceRes.rows[0]
    const device: DesktopAgentDeviceRow = {
      id: Number(d.id),
      deviceId: d.device_id,
      workspaceId: d.workspace_id,
      userId: d.user_id,
      deviceName: d.device_name,
      status: d.status as DesktopAgentDeviceRow["status"],
      version: d.version,
      lastHeartbeatAt: d.last_heartbeat_at ? new Date(d.last_heartbeat_at) : null,
      lastObservationAt: d.last_observation_at ? new Date(d.last_observation_at) : null,
      scannedCount: Number(d.scanned_count) || 0,
      successCountToday: Number(d.success_count_today) || 0,
      failureCountToday: Number(d.failure_count_today) || 0,
      createdAt: new Date(d.created_at),
    }
    return { ok: true, device, plainToken }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}
