// ----------------------------------------------------------------
// authTypes.ts
// ----------------------------------------------------------------

export type UserRole = "admin" | "user"

export type ApprovalStatus =
  | "email_unverified"
  | "pending_approval"
  | "active"
  | "rejected"
  | "suspended"

export type UserRow = {
  id:                  string
  email:               string
  passwordHash:        string | null
  role:                UserRole
  approvalStatus:      ApprovalStatus
  emailVerifiedAt:     string | null
  approvedAt:          string | null
  approvedByUserId:    string | null
  rejectedAt:          string | null
  suspendedAt:         string | null
  displayName:         string | null
  requestedProduct:    "EBAY" | null
  createdAt:           string
  updatedAt:           string
}

export type PublicUser = {
  id:              string
  email:           string
  role:            UserRole
  approvalStatus:  ApprovalStatus
  emailVerifiedAt: string | null
  workspaceId:     string | null
  /** True when user can sign in with Google but has not set a ListJetGo password yet. */
  needsPasswordSetup: boolean
}

export type JwtPayload = {
  sub:             string
  email:           string
  role:            UserRole
  approvalStatus:  ApprovalStatus
  workspaceId:     string | null
}

export type AuthContext = {
  user:       PublicUser
  session?: { id: string; createdAt: string; expiresAt: string }
}

export type PendingUserSummary = {
  id:               string
  email:            string
  role:             UserRole
  approvalStatus:   ApprovalStatus
  emailVerifiedAt:  string | null
  displayName:      string | null
  requestedProduct: "EBAY" | null
  createdAt:        string
  workspaceId:      string | null
  workspaceName:    string | null
}

export type UserDetailResponse = {
  user:      PublicUser
  workspace: {
    id:          string
    name:        string
    status:      string
    ownerUserId: string | null
    createdAt:   string
  } | null
  membership: {
    role:      string
    createdAt: string
  } | null
}
