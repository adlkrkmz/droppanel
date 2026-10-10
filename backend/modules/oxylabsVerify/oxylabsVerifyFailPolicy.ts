export const OXYLABS_CALL_OUTCOME_UNKNOWN = "OXYLABS_CALL_OUTCOME_UNKNOWN"

const TERMINAL = new Set([
  OXYLABS_CALL_OUTCOME_UNKNOWN,
  "CALL_OUTCOME_UNKNOWN",
  "OXYLABS_PRICING_FORBIDDEN",
  "UNAUTHORIZED",
  "CREDENTIAL_REJECT",
  "401",
  "403",
])

export function isOxylabsTerminalFailCode(code: string | null | undefined): boolean {
  const c = String(code ?? "").trim().toUpperCase()
  return TERMINAL.has(c)
}

export function normalizeOxylabsFailCode(code: string | null | undefined): string {
  const c = String(code ?? "").trim().toUpperCase()
  if (c === "CALL_OUTCOME_UNKNOWN") return OXYLABS_CALL_OUTCOME_UNKNOWN
  if (TERMINAL.has(c)) return c === "401" || c === "403" ? "CREDENTIAL_REJECT" : c
  return c.slice(0, 80) || "WORKER_FAIL"
}
