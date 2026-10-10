import type { OperationStatus } from "@/lib/api"

export type OpBadgeConfig = { bg: string; color: string }

export const DEFAULT_OP_BADGE: OpBadgeConfig = {
  bg: "rgba(120,130,150,0.18)",
  color: "var(--dim)",
}

const BLUE = { bg: "rgba(59,130,246,0.15)", color: "#7eb0ff" }
const AMBER = { bg: "rgba(200,160,60,0.18)", color: "#d9b65f" }
const VIOLET = { bg: "rgba(150,110,230,0.16)", color: "#b79df0" }
const CYAN = { bg: "rgba(60,170,200,0.16)", color: "#67c6da" }
const GREEN = { bg: "rgba(60,180,120,0.16)", color: "#5fc98c" }
const RED = { bg: "rgba(200,60,60,0.16)", color: "#e88" }

export const OPERATION_BADGE: Record<OperationStatus, OpBadgeConfig> = {
  NEW_ORDER:               BLUE,
  AMAZON_PENDING:          AMBER,
  AMAZON_ORDERED:          VIOLET,
  AQUALINE_PENDING:        AMBER,
  TRACKING_PENDING:        AMBER,
  TRACKING_RECEIVED:       CYAN,
  EBAY_TRACKING_SUBMITTED: CYAN,
  IN_TRANSIT:              CYAN,
  DELIVERED:               GREEN,
  PROBLEM:                 RED,
  CANCELLED_REFUNDED:      RED,
}
