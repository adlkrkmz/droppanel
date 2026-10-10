import { query } from "../../db/client"

export type SessionRow = {
  id: string; userId: string; tokenHash: string; createdAt: string; expiresAt: string
  lastSeenAt: string; revokedAt: string | null; revokedReason: string | null
  ipAddress: string | null; userAgent: string | null
}

function map(r: Record<string, unknown>): SessionRow {
  return {
    id: r.id as string, userId: r.user_id as string, tokenHash: r.token_hash as string,
    createdAt: r.created_at as string, expiresAt: r.expires_at as string,
    lastSeenAt: r.last_seen_at as string, revokedAt: (r.revoked_at as string|null) ?? null,
    revokedReason: (r.revoked_reason as string|null) ?? null,
    ipAddress: (r.ip_address as string|null) ?? null, userAgent: (r.user_agent as string|null) ?? null,
  }
}

export async function createSession(input: { userId:string; tokenHash:string; expiresAt:Date; ipAddress?:string|null; userAgent?:string|null }): Promise<SessionRow> {
  const res = await query(`INSERT INTO sessions (user_id, token_hash, expires_at, ip_address, user_agent)
    VALUES ($1::uuid,$2,$3,$4,$5) RETURNING *`, [input.userId,input.tokenHash,input.expiresAt.toISOString(),input.ipAddress??null,input.userAgent??null])
  return map(res.rows[0] as Record<string,unknown>)
}

export async function findActiveSessionByTokenHash(tokenHash:string): Promise<SessionRow|null> {
  const res = await query(`SELECT * FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>NOW() LIMIT 1`,[tokenHash])
  return res.rows[0] ? map(res.rows[0] as Record<string,unknown>) : null
}

export async function touchSession(id:string, throttleMinutes=5): Promise<void> {
  await query(`UPDATE sessions SET last_seen_at=NOW() WHERE id=$1::uuid AND last_seen_at < NOW()-($2::text||' minutes')::interval`,[id,throttleMinutes])
}

export async function revokeSession(id:string,userId:string,reason:string): Promise<boolean> {
  const res=await query(`UPDATE sessions SET revoked_at=COALESCE(revoked_at,NOW()), revoked_reason=COALESCE(revoked_reason,$3)
    WHERE id=$1::uuid AND user_id=$2::uuid RETURNING id`,[id,userId,reason])
  return res.rowCount === 1
}

export async function revokeAllUserSessions(userId:string,reason:string): Promise<number> {
  const res=await query(`UPDATE sessions SET revoked_at=NOW(), revoked_reason=$2 WHERE user_id=$1::uuid AND revoked_at IS NULL`,[userId,reason])
  return res.rowCount ?? 0
}

export async function listActiveSessionsForUser(userId:string): Promise<SessionRow[]> {
  const res=await query(`SELECT * FROM sessions WHERE user_id=$1::uuid AND revoked_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC`,[userId])
  return res.rows.map(r=>map(r as Record<string,unknown>))
}

export async function deleteExpiredSessions(retentionDays:number): Promise<number> {
  const res=await query(`DELETE FROM sessions WHERE (expires_at<NOW() OR revoked_at IS NOT NULL)
    AND COALESCE(revoked_at,expires_at)<NOW()-($1::text||' days')::interval`,[retentionDays])
  return res.rowCount ?? 0
}
