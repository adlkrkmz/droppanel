// ----------------------------------------------------------------
// emailVerificationService.ts — email verification + password reset delivery.
// Never log plaintext passwords, reset tokens, or SMTP_PASS.
// ----------------------------------------------------------------

import { appBaseUrl } from "./token"
import { isSmtpConfigured, sendPasswordResetEmail } from "./mailService"

export function logVerificationLink(email: string, rawToken: string): void {
  // Dev/ops only — never print token in production.
  if (process.env.NODE_ENV === "production") {
    console.log(`[Auth] Verification email pending for ${email} (link not logged in production)`)
    return
  }
  const url = `${appBaseUrl()}/verify-email?token=${encodeURIComponent(rawToken)}`
  console.log(`[Auth] Verification link for ${email}: ${url}`)
}

/**
 * Deliver password-reset email via SMTP in production.
 * Dev without SMTP may log the link locally; production never logs the token/URL.
 */
export async function deliverPasswordResetEmail(
  email: string,
  rawToken: string
): Promise<{ sent: boolean; accepted: boolean }> {
  const url = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(rawToken)}`

  if (isSmtpConfigured()) {
    const result = await sendPasswordResetEmail({ to: email, resetUrl: url })
    console.log(`[Auth] Password reset email dispatched for ${email} accepted=${result.accepted}`)
    return { sent: true, accepted: result.accepted }
  }

  if (process.env.NODE_ENV === "production") {
    console.error("[Auth] Password reset email not sent: SMTP is not configured")
    return { sent: false, accepted: false }
  }

  // Local/dev sink only — never used when NODE_ENV=production.
  console.log(`[Auth] Password reset link for ${email}: ${url}`)
  return { sent: false, accepted: false }
}

/** @deprecated Prefer deliverPasswordResetEmail — kept for call-site clarity in older imports. */
export function logPasswordResetLink(email: string, rawToken: string): void {
  void deliverPasswordResetEmail(email, rawToken)
}
