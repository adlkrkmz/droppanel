export type GoogleEmailAuthorityInput = {
  email: string
  emailVerified: boolean
  hostedDomain?: string | null
  existingUser: boolean
}
export type GoogleEmailAuthority =
  | "GOOGLE_IDENTITY_EXISTING"
  | "AUTO_LINK_GMAIL"
  | "AUTO_LINK_WORKSPACE"
  | "REAUTH_REQUIRED_THIRD_PARTY"
  | "NEW_ACCOUNT_ALLOWED"
  | "REJECT_UNVERIFIED"

export function classifyGoogleEmailAuthority(input: GoogleEmailAuthorityInput): GoogleEmailAuthority {
  if (!input.emailVerified) return "REJECT_UNVERIFIED"
  if (!input.existingUser) return "NEW_ACCOUNT_ALLOWED"
  const email = input.email.trim().toLowerCase()
  if (email.endsWith("@gmail.com")) return "AUTO_LINK_GMAIL"
  const hd = input.hostedDomain?.trim().toLowerCase() || ""
  const domain = email.split("@")[1] || ""
  if (hd && domain === hd) return "AUTO_LINK_WORKSPACE"
  return "REAUTH_REQUIRED_THIRD_PARTY"
}
