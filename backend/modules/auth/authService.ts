// ----------------------------------------------------------------
// authService.ts
// ----------------------------------------------------------------

import {
  activateProductAccessForUser,
  insertPendingProductAccess,
  listUsableProductAccessForUser,
} from "../productAccess/productAccessRepository"
import type { ProductAccessRow } from "../productAccess/productAccessRepository"
import {
  approveUser,
  createUserWithWorkspace,
  findUserByEmail,
  findUserById,
  findValidPasswordResetToken,
  findValidVerificationToken,
  getPrimaryWorkspaceIdForUser,
  getUserDetail,
  hasPasswordCredentialRow,
  insertAuditLog,
  insertEmailVerificationToken,
  insertPasswordResetToken,
  invalidatePasswordResetTokensForUser,
  listPendingUsers,
  markEmailVerifiedPendingApproval,
  markPasswordResetTokenUsed,
  markVerificationTokenUsed,
  normalizeEmail,
  rejectUser,
  suspendUser,
  upsertPasswordCredential,
} from "./authRepository"
import { deliverPasswordResetEmail, logVerificationLink } from "./emailVerificationService"
import { hashPassword, validatePasswordStrength, verifyPassword } from "./password"
import {
  generateOpaqueToken,
  hashOpaqueToken,
  verificationExpiresAt,
} from "./token"
import type { PublicUser, UserDetailResponse } from "./authTypes"
import { revokeAllUserSessions } from "./sessionRepository"

export class AuthHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly approvalStatus?: string
  ) {
    super(message)
    this.name = "AuthHttpError"
  }
}

async function toPublicUser(
  user: Awaited<ReturnType<typeof findUserById>>,
  workspaceId: string | null
): Promise<PublicUser> {
  if (!user) throw new Error("User required")
  const needsPasswordSetup = !(await hasPasswordCredentialRow(user.id))
  return {
    id:              user.id,
    email:           user.email,
    role:            user.role,
    approvalStatus:  user.approvalStatus,
    emailVerifiedAt: user.emailVerifiedAt,
    workspaceId,
    needsPasswordSetup,
  }
}

export type RegisterProduct = "EBAY"

function parseRegisterProduct(raw: unknown): RegisterProduct | null {
  const v = String(raw ?? "").trim().toUpperCase()
  if (v === "EBAY") return v
  return null
}

export async function registerUser(
  email: string,
  password: string,
  opts?: { name?: string; product?: RegisterProduct | null }
): Promise<{
  status:  string
  message: string
}> {
  const normalized = normalizeEmail(email)
  if (!normalized || !normalized.includes("@")) {
    throw new AuthHttpError("Valid email is required", 400)
  }
  const pwErr = validatePasswordStrength(password)
  if (pwErr) throw new AuthHttpError(pwErr, 400)

  const existing = await findUserByEmail(normalized)
  if (existing) throw new AuthHttpError("Email already registered", 409)

  const product: RegisterProduct = "EBAY"
  const passwordHash = await hashPassword(password)
  const { user } = await createUserWithWorkspace({
    email:           normalized,
    passwordHash,
    approvalStatus:  "pending_approval",
    emailVerifiedAt: new Date(),
    displayName:     opts?.name ?? null,
    requestedProduct: product,
  })

  if (product) {
    await insertPendingProductAccess(user.id, product)
  }

  const requireEmailVerify =
    process.env.REGISTRATION_REQUIRE_EMAIL_VERIFY === "true"
  if (requireEmailVerify) {
    const rawToken = generateOpaqueToken()
    await insertEmailVerificationToken({
      userId:    user.id,
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt: verificationExpiresAt(24),
    })
    logVerificationLink(normalized, rawToken)
    return {
      status:  "email_unverified",
      message: "Verification email sent",
    }
  }

  console.log(
    `[Auth] Registered user pending approval email=${normalized} product=${product ?? "none"}`
  )

  return {
    status:  "pending_approval",
    message: "Account created — waiting for admin approval",
  }
}

export async function verifyEmailToken(rawToken: string): Promise<{ status: string }> {
  const token = rawToken?.trim()
  if (!token) throw new AuthHttpError("Token is required", 400)

  const row = await findValidVerificationToken(hashOpaqueToken(token))
  if (!row) throw new AuthHttpError("Invalid or expired verification token", 400)

  await markVerificationTokenUsed(row.id)
  await markEmailVerifiedPendingApproval(row.userId)

  return { status: "pending_approval" }
}

export type LoginResult =
  | { kind: "blocked"; status: string; message: string }
  | { kind: "success"; user: PublicUser }

export async function loginUser(email: string, password: string): Promise<LoginResult> {
  const user = await findUserByEmail(email)
  if (!user) throw new AuthHttpError("Invalid email or password", 401)

  const ok = user.passwordHash ? await verifyPassword(password, user.passwordHash) : false
  if (!ok) throw new AuthHttpError("Invalid email or password", 401)

  if (user.approvalStatus === "email_unverified") {
    return {
      kind:    "blocked",
      status:  "email_unverified",
      message: "Please verify your email before signing in",
    }
  }
  if (user.approvalStatus === "pending_approval") {
    return {
      kind:    "blocked",
      status:  "pending_approval",
      message: "Your account is waiting for admin approval.",
    }
  }
  if (user.approvalStatus === "rejected") {
    return {
      kind:    "blocked",
      status:  "rejected",
      message: "Your account registration was rejected",
    }
  }
  if (user.approvalStatus === "suspended") {
    return {
      kind:    "blocked",
      status:  "suspended",
      message: "Your account has been suspended",
    }
  }

  const workspaceId = await getPrimaryWorkspaceIdForUser(user.id)
  return {
    kind: "success",
    user: await toPublicUser(user, workspaceId),
  }
}

export async function getMeFromUserId(userId: string): Promise<PublicUser | null> {
  const user = await findUserById(userId)
  if (!user) return null
  const workspaceId = await getPrimaryWorkspaceIdForUser(user.id)
  return toPublicUser(user, workspaceId)
}

/**
 * One-time ListJetGo password for Google-only (or password-less) accounts.
 * Does not create a second user — attaches password_credentials to the same user id.
 */
export async function setInitialPasswordForUser(
  userId: string,
  password: string,
  confirmPassword: string
): Promise<PublicUser> {
  if (password !== confirmPassword) {
    throw new AuthHttpError("Passwords do not match", 400, "PASSWORD_MISMATCH")
  }
  const pwErr = validatePasswordStrength(password)
  if (pwErr) throw new AuthHttpError(pwErr, 400, "PASSWORD_WEAK")

  const user = await findUserById(userId)
  if (!user) throw new AuthHttpError("User not found", 404)
  if (user.approvalStatus !== "active") {
    throw new AuthHttpError("Account is not active", 403, "ACCOUNT_NOT_ACTIVE")
  }

  if (await hasPasswordCredentialRow(userId)) {
    throw new AuthHttpError("Password already set for this account", 409, "PASSWORD_ALREADY_SET")
  }

  const passwordHash = await hashPassword(password)
  await upsertPasswordCredential(userId, passwordHash)
  await insertAuditLog({
    actorUserId: userId,
    action: "credential.password_set",
    targetType: "user",
    targetId: userId,
  })

  const workspaceId = await getPrimaryWorkspaceIdForUser(userId)
  return toPublicUser(user, workspaceId)
}

/**
 * Authenticated password change (Settings). Requires existing password.
 * Never logs or returns plaintext passwords.
 */
export async function changePasswordForUser(
  userId: string,
  currentPassword: string,
  newPassword: string,
  confirmPassword: string
): Promise<PublicUser> {
  if (newPassword !== confirmPassword) {
    throw new AuthHttpError("Passwords do not match", 400, "PASSWORD_MISMATCH")
  }
  const pwErr = validatePasswordStrength(newPassword)
  if (pwErr) throw new AuthHttpError(pwErr, 400, "PASSWORD_WEAK")

  const user = await findUserById(userId)
  if (!user) throw new AuthHttpError("User not found", 404)
  if (user.approvalStatus !== "active") {
    throw new AuthHttpError("Account is not active", 403, "ACCOUNT_NOT_ACTIVE")
  }
  if (!user.passwordHash) {
    throw new AuthHttpError("No password set for this account", 400, "PASSWORD_NOT_SET")
  }

  const ok = await verifyPassword(currentPassword, user.passwordHash)
  if (!ok) throw new AuthHttpError("Current password is incorrect", 401, "CURRENT_PASSWORD_INVALID")

  const passwordHash = await hashPassword(newPassword)
  await upsertPasswordCredential(userId, passwordHash)
  await invalidatePasswordResetTokensForUser(userId)
  await insertAuditLog({
    actorUserId: userId,
    action: "credential.password_changed",
    targetType: "user",
    targetId: userId,
  })

  const workspaceId = await getPrimaryWorkspaceIdForUser(userId)
  return toPublicUser(user, workspaceId)
}

/**
 * Forgot-password request. Always returns the same message (no email enumeration).
 * Issues a hashed reset token when the user exists and already has a password.
 */
export async function requestPasswordReset(email: string): Promise<{ message: string }> {
  const message =
    "If an account with that email exists, a password reset link has been sent."
  const normalized = normalizeEmail(email)
  if (!normalized || !normalized.includes("@")) {
    return { message }
  }

  const user = await findUserByEmail(normalized)
  if (!user || user.approvalStatus !== "active") {
    return { message }
  }
  if (!(await hasPasswordCredentialRow(user.id))) {
    return { message }
  }

  await invalidatePasswordResetTokensForUser(user.id)
  const rawToken = generateOpaqueToken()
  await insertPasswordResetToken({
    userId: user.id,
    tokenHash: hashOpaqueToken(rawToken),
    expiresAt: verificationExpiresAt(1),
  })
  try {
    await deliverPasswordResetEmail(normalized, rawToken)
  } catch {
    // Anti-enumeration: never leak delivery failure to the client.
    // Do not log token / SMTP_PASS / password.
    console.error("[Auth] Password reset email delivery failed")
  }
  await insertAuditLog({
    actorUserId: user.id,
    action: "credential.password_reset_requested",
    targetType: "user",
    targetId: user.id,
  })
  return { message }
}

/**
 * Complete password reset with opaque token. Same user id — no duplicate accounts.
 */
export async function resetPasswordWithToken(
  rawToken: string,
  password: string,
  confirmPassword: string
): Promise<{ ok: true }> {
  const token = rawToken?.trim()
  if (!token) throw new AuthHttpError("Reset token is required", 400)

  if (password !== confirmPassword) {
    throw new AuthHttpError("Passwords do not match", 400, "PASSWORD_MISMATCH")
  }
  const pwErr = validatePasswordStrength(password)
  if (pwErr) throw new AuthHttpError(pwErr, 400, "PASSWORD_WEAK")

  const row = await findValidPasswordResetToken(hashOpaqueToken(token))
  if (!row) throw new AuthHttpError("Invalid or expired reset token", 400)

  const user = await findUserById(row.userId)
  if (!user || user.approvalStatus !== "active") {
    throw new AuthHttpError("Invalid or expired reset token", 400)
  }

  const passwordHash = await hashPassword(password)
  await upsertPasswordCredential(row.userId, passwordHash)
  await markPasswordResetTokenUsed(row.id)
  await invalidatePasswordResetTokensForUser(row.userId)
  await revokeAllUserSessions(row.userId, "password_reset")
  await insertAuditLog({
    actorUserId: row.userId,
    action: "credential.password_reset_completed",
    targetType: "user",
    targetId: row.userId,
  })
  return { ok: true }
}

export async function getPendingUsersForAdmin() {
  return listPendingUsers()
}

export async function approveUserByAdmin(
  targetUserId: string,
  actorUserId:  string | null
): Promise<void> {
  const user = await findUserById(targetUserId)
  if (!user) throw new AuthHttpError("User not found", 404)
  if (user.approvalStatus !== "pending_approval") {
    throw new AuthHttpError("User is not pending approval", 400)
  }
  await approveUser(targetUserId, actorUserId)
  await activateProductAccessForUser(targetUserId, user.requestedProduct)
  await insertAuditLog({
    actorUserId,
    action:     "user.approve",
    targetType: "user",
    targetId:   targetUserId,
  })
}

export async function rejectUserByAdmin(
  targetUserId: string,
  actorUserId:  string | null
): Promise<void> {
  const user = await findUserById(targetUserId)
  if (!user) throw new AuthHttpError("User not found", 404)
  await rejectUser(targetUserId)
  await revokeAllUserSessions(targetUserId, "user_rejected")
  await insertAuditLog({
    actorUserId,
    action:     "user.reject",
    targetType: "user",
    targetId:   targetUserId,
  })
}

export async function suspendUserByAdmin(
  targetUserId: string,
  actorUserId:  string | null
): Promise<void> {
  const user = await findUserById(targetUserId)
  if (!user) throw new AuthHttpError("User not found", 404)
  await suspendUser(targetUserId)
  await revokeAllUserSessions(targetUserId, "user_suspended")
  await insertAuditLog({
    actorUserId,
    action:     "user.suspend",
    targetType: "user",
    targetId:   targetUserId,
  })
}

export async function getUserDetailForAdmin(userId: string): Promise<UserDetailResponse> {
  const detail = await getUserDetail(userId)
  if (!detail) throw new AuthHttpError("User not found", 404)
  const workspaceId = detail.workspace?.id ?? null
  return {
    user: await toPublicUser(detail.user, workspaceId),
    workspace: detail.workspace,
    membership: detail.membershipRole
      ? { role: detail.membershipRole, createdAt: detail.membershipCreatedAt ?? "" }
      : null,
  }
}

export async function getProductAccessForUser(userId: string): Promise<ProductAccessRow[]> {
  const rows = await listUsableProductAccessForUser(userId)
  if (rows.length > 0) return rows

  const user = await findUserById(userId)
  if (user?.requestedProduct && user.approvalStatus === "active") {
    return [{ product: user.requestedProduct, status: "ACTIVE" }]
  }
  return []
}

export { parseRegisterProduct }

export { storeBelongsToWorkspace } from "./authRepository"
