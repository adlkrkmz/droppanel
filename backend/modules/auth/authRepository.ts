// ----------------------------------------------------------------
// authRepository.ts
// ----------------------------------------------------------------

import { query } from "../../db/client"
import type { ApprovalStatus, PendingUserSummary, UserRow } from "./authTypes"

function mapUserRow(r: Record<string, unknown>): UserRow {
  const requested = r.requested_product as string | null | undefined
  return {
    id:               r.id as string,
    email:            r.email as string,
    passwordHash:     (r.credential_password_hash as string|null|undefined) ?? null,
    role:             r.role as UserRow["role"],
    approvalStatus:   r.approval_status as ApprovalStatus,
    emailVerifiedAt:  (r.email_verified_at as string | null) ?? null,
    approvedAt:       (r.approved_at as string | null) ?? null,
    approvedByUserId: (r.approved_by_user_id as string | null) ?? null,
    rejectedAt:       (r.rejected_at as string | null) ?? null,
    suspendedAt:      (r.suspended_at as string | null) ?? null,
    displayName:      (r.display_name as string | null) ?? null,
    requestedProduct:
      requested === "EBAY" ? requested : null,
    createdAt:        r.created_at as string,
    updatedAt:        r.updated_at as string,
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const normalized = normalizeEmail(email)
  const res = await queryUsersWithOptionalCredentials(
    `SELECT u.*, pc.password_hash AS credential_password_hash FROM users u
     LEFT JOIN password_credentials pc ON pc.user_id=u.id WHERE u.email = $1 LIMIT 1`,
    `SELECT u.*, NULL::text AS credential_password_hash FROM users u WHERE u.email = $1 LIMIT 1`,
    [normalized]
  )
  const row = res.rows[0]
  return row ? mapUserRow(row as Record<string, unknown>) : null
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const res = await queryUsersWithOptionalCredentials(
    `SELECT u.*, pc.password_hash AS credential_password_hash FROM users u
    LEFT JOIN password_credentials pc ON pc.user_id=u.id WHERE u.id = $1::uuid LIMIT 1`,
    `SELECT u.*, NULL::text AS credential_password_hash FROM users u WHERE u.id = $1::uuid LIMIT 1`,
    [id]
  )
  const row = res.rows[0]
  return row ? mapUserRow(row as Record<string, unknown>) : null
}

async function queryUsersWithOptionalCredentials(sqlWithCreds: string, sqlFallback: string, params: unknown[]) {
  try {
    return await query(sqlWithCreds, params)
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code?: unknown }).code) : ""
    if (code !== "42P01") throw e
    return query(sqlFallback, params)
  }
}

export async function createUserWithWorkspace(input: {
  email:            string
  passwordHash:     string
  role?:            "admin" | "user"
  approvalStatus?:  ApprovalStatus
  emailVerifiedAt?: Date | null
  displayName?:     string | null
  requestedProduct?: "EBAY" | null
}): Promise<{ user: UserRow; workspaceId: string }> {
  const email = normalizeEmail(input.email)
  const role = input.role ?? "user"
  const approvalStatus = input.approvalStatus ?? "pending_approval"
  const displayName = input.displayName?.trim() || null
  const requestedProduct = input.requestedProduct ?? null

  const userRes = await query<{ id: string }>(
    `INSERT INTO users (
       email, password_hash, role, approval_status,
       email_verified_at, display_name, requested_product
     )
     VALUES ($1, NULL, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      email,
      role,
      approvalStatus,
      input.emailVerifiedAt ? input.emailVerifiedAt.toISOString() : null,
      displayName,
      requestedProduct,
    ]
  ).catch(async () => {
    console.warn("[Auth] createUserWithWorkspace fallback — apply migration 044 for product fields")
    return query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, approval_status, email_verified_at)
       VALUES ($1, NULL, $2, $3, $4)
       RETURNING id`,
      [
        email,
        role,
        approvalStatus,
        input.emailVerifiedAt ? input.emailVerifiedAt.toISOString() : null,
      ]
    )
  })
  const userId = userRes.rows[0]?.id
  if (!userId) throw new Error("Failed to create user")

  // Authoritative credential store. users.password_hash is written above only for
  // expand/migrate deployment compatibility and is not read by authentication.
  await upsertPasswordCredential(userId, input.passwordHash)

  const wsName = email.split("@")[0] || "User Workspace"
  const wsRes = await query<{ id: string }>(
    `INSERT INTO workspaces (name, owner_user_id, status)
     VALUES ($1, $2::uuid, 'active')
     RETURNING id`,
    [wsName, userId]
  )
  const workspaceId = wsRes.rows[0]?.id
  if (!workspaceId) throw new Error("Failed to create workspace")

  await query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1::uuid, $2::uuid, 'owner')`,
    [workspaceId, userId]
  )

  const user = await findUserById(userId)
  if (!user) throw new Error("User not found after create")
  return { user, workspaceId }
}

/** Authoritative password store (bcrypt hash only). */
export async function upsertPasswordCredential(userId: string, passwordHash: string): Promise<void> {
  await query(
    `INSERT INTO password_credentials (user_id, password_hash, password_changed_at)
     VALUES ($1::uuid, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       password_changed_at = NOW(),
       updated_at = NOW()`,
    [userId, passwordHash]
  )
}

export async function hasPasswordCredentialRow(userId: string): Promise<boolean> {
  const r = await query(`SELECT 1 FROM password_credentials WHERE user_id = $1::uuid LIMIT 1`, [userId])
  return Boolean(r.rows[0])
}

export async function getPrimaryWorkspaceIdForUser(userId: string): Promise<string | null> {
  const res = await query<{ workspace_id: string }>(
    `SELECT workspace_id
     FROM workspace_members
     WHERE user_id = $1::uuid
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId]
  )
  return res.rows[0]?.workspace_id ?? null
}

/** Extension worker uses the member workspace that actually has active stores. */
export async function getWorkspaceIdForExtensionUser(userId: string): Promise<string | null> {
  const res = await query<{ workspace_id: string }>(
    `SELECT wm.workspace_id::text AS workspace_id
     FROM workspace_members wm
     JOIN stores st ON st.workspace_id = wm.workspace_id AND st.status = 'active'
     WHERE wm.user_id = $1::uuid
     GROUP BY wm.workspace_id
     ORDER BY COUNT(st.id) DESC, MIN(wm.created_at) ASC
     LIMIT 1`,
    [userId]
  )
  return res.rows[0]?.workspace_id ?? getPrimaryWorkspaceIdForUser(userId)
}

export async function insertEmailVerificationToken(input: {
  userId:    string
  tokenHash: string
  expiresAt: Date
}): Promise<void> {
  await query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES ($1::uuid, $2, $3)`,
    [input.userId, input.tokenHash, input.expiresAt.toISOString()]
  )
}

export async function findValidVerificationToken(
  tokenHash: string
): Promise<{ id: string; userId: string } | null> {
  const res = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id
     FROM email_verification_tokens
     WHERE token_hash = $1
       AND used_at IS NULL
       AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  )
  const row = res.rows[0]
  if (!row) return null
  return { id: row.id, userId: row.user_id }
}

export async function markVerificationTokenUsed(id: string): Promise<void> {
  await query(
    `UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1::uuid`,
    [id]
  )
}

export async function invalidatePasswordResetTokensForUser(userId: string): Promise<void> {
  await query(
    `UPDATE password_reset_tokens
     SET used_at = NOW()
     WHERE user_id = $1::uuid AND used_at IS NULL`,
    [userId]
  )
}

export async function insertPasswordResetToken(input: {
  userId: string
  tokenHash: string
  expiresAt: Date
}): Promise<void> {
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1::uuid, $2, $3)`,
    [input.userId, input.tokenHash, input.expiresAt.toISOString()]
  )
}

export async function findValidPasswordResetToken(
  tokenHash: string
): Promise<{ id: string; userId: string } | null> {
  const res = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id
     FROM password_reset_tokens
     WHERE token_hash = $1
       AND used_at IS NULL
       AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  )
  const row = res.rows[0]
  if (!row) return null
  return { id: row.id, userId: row.user_id }
}

export async function markPasswordResetTokenUsed(id: string): Promise<void> {
  await query(
    `UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1::uuid`,
    [id]
  )
}

export async function markEmailVerifiedPendingApproval(userId: string): Promise<void> {
  await query(
    `UPDATE users
     SET email_verified_at = NOW(),
         approval_status = 'pending_approval',
         updated_at = NOW()
     WHERE id = $1::uuid`,
    [userId]
  )
}

export async function listPendingUsers(): Promise<PendingUserSummary[]> {
  const fullQuery = `SELECT u.id,
            u.email,
            u.role,
            u.approval_status,
            u.email_verified_at,
            u.display_name,
            u.requested_product,
            u.created_at,
            w.id AS workspace_id,
            w.name AS workspace_name
     FROM users u
     LEFT JOIN workspace_members wm ON wm.user_id = u.id
     LEFT JOIN workspaces w ON w.id = wm.workspace_id
     WHERE u.approval_status = 'pending_approval'
     ORDER BY u.created_at ASC`

  const legacyQuery = `SELECT u.id,
            u.email,
            u.role,
            u.approval_status,
            u.email_verified_at,
            u.created_at,
            w.id AS workspace_id,
            w.name AS workspace_name
     FROM users u
     LEFT JOIN workspace_members wm ON wm.user_id = u.id
     LEFT JOIN workspaces w ON w.id = wm.workspace_id
     WHERE u.approval_status = 'pending_approval'
     ORDER BY u.created_at ASC`

  type Row = {
    id: string
    email: string
    role: string
    approval_status: string
    email_verified_at: string | null
    display_name?: string | null
    requested_product?: string | null
    created_at: string
    workspace_id: string | null
    workspace_name: string | null
  }

  let res
  try {
    res = await query<Row>(fullQuery)
  } catch {
    res = await query<Row>(legacyQuery)
  }

  return res.rows.map((r) => {
    const requested = r.requested_product
    return {
      id:              r.id,
      email:           r.email,
      role:            r.role as PendingUserSummary["role"],
      approvalStatus:  r.approval_status as PendingUserSummary["approvalStatus"],
      emailVerifiedAt: r.email_verified_at,
      displayName:     r.display_name ?? null,
      requestedProduct:
        requested === "EBAY" ? requested : null,
      createdAt:       r.created_at,
      workspaceId:     r.workspace_id,
      workspaceName:   r.workspace_name,
    }
  })
}

export async function approveUser(userId: string, adminUserId: string | null): Promise<void> {
  await query(
    `UPDATE users
     SET approval_status = 'active',
         approved_at = NOW(),
         approved_by_user_id = $2::uuid,
         rejected_at = NULL,
         suspended_at = NULL,
         updated_at = NOW()
     WHERE id = $1::uuid`,
    [userId, adminUserId]
  )
}

export async function rejectUser(userId: string): Promise<void> {
  await query(
    `UPDATE users
     SET approval_status = 'rejected',
         rejected_at = NOW(),
         updated_at = NOW()
     WHERE id = $1::uuid`,
    [userId]
  )
}

export async function suspendUser(userId: string): Promise<void> {
  await query(
    `UPDATE users
     SET approval_status = 'suspended',
         suspended_at = NOW(),
         updated_at = NOW()
     WHERE id = $1::uuid`,
    [userId]
  )
}

export async function insertAuditLog(input: {
  actorUserId: string | null
  action:      string
  targetType?: string | null
  targetId?:   string | null
  metadata?:   Record<string, unknown>
}): Promise<void> {
  await query(
    `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
    [
      input.actorUserId,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  )
}

export async function getUserDetail(userId: string): Promise<{
  user: UserRow
  workspace: {
    id: string
    name: string
    status: string
    ownerUserId: string | null
    createdAt: string
  } | null
  membershipRole: string | null
  membershipCreatedAt: string | null
} | null> {
  const user = await findUserById(userId)
  if (!user) return null

  const res = await query<{
    workspace_id: string
    workspace_name: string
    workspace_status: string
    owner_user_id: string | null
    workspace_created_at: string
    member_role: string
    member_created_at: string
  }>(
    `SELECT w.id AS workspace_id,
            w.name AS workspace_name,
            w.status AS workspace_status,
            w.owner_user_id,
            w.created_at AS workspace_created_at,
            wm.role AS member_role,
            wm.created_at AS member_created_at
     FROM workspace_members wm
     INNER JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = $1::uuid
     ORDER BY wm.created_at ASC
     LIMIT 1`,
    [userId]
  )
  const row = res.rows[0]
  return {
    user,
    workspace: row
      ? {
          id:          row.workspace_id,
          name:        row.workspace_name,
          status:      row.workspace_status,
          ownerUserId: row.owner_user_id,
          createdAt:   row.workspace_created_at,
        }
      : null,
    membershipRole:      row?.member_role ?? null,
    membershipCreatedAt: row?.member_created_at ?? null,
  }
}

/** MVP store ownership — use in Phase 2+ endpoint guards. */
export async function storeBelongsToWorkspace(
  workspaceId: string,
  storeCode:   string
): Promise<boolean> {
  const res = await query<{ ok: number }>(
    `SELECT 1 AS ok
     FROM stores
     WHERE workspace_id = $1::uuid
       AND store_code = $2
     LIMIT 1`,
    [workspaceId, storeCode.trim()]
  )
  return !!res.rows[0]
}

/** User OAuth callback — active user must belong to workspace. */
export async function userIsActiveMemberOfWorkspace(
  userId:      string,
  workspaceId: string
): Promise<boolean> {
  const res = await query<{ ok: number }>(
    `SELECT 1 AS ok
     FROM users u
     INNER JOIN workspace_members wm
       ON wm.user_id = u.id AND wm.workspace_id = $2::uuid
     WHERE u.id = $1::uuid
       AND u.approval_status = 'active'
     LIMIT 1`,
    [userId, workspaceId]
  )
  return !!res.rows[0]
}
