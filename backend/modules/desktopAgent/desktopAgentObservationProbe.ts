/** Tiny probe export so validation script can assert technical-status classification without importing Express routes. */
const TECHNICAL_STATUSES = new Set([
  "CAPTCHA",
  "ROBOT_CHECK",
  "ACCESS_DENIED",
  "TIMEOUT",
  "BROWSER_CRASH",
  "AMAZON_INCOMPLETE",
  "NETWORK_ERROR",
  "TECHNICAL",
  "TECHNICAL_ERROR",
  "CHALLENGE",
  "AMAZON_CHALLENGE",
])

export function isTechnicalStatusProbe(status: string | null | undefined): boolean {
  const s = String(status ?? "").trim().toUpperCase()
  if (TECHNICAL_STATUSES.has(s)) return true
  if (/CAPTCHA|ROBOT|ACCESS.?DENIED|TIMEOUT|CRASH|INCOMPLETE|NETWORK|CHALLENGE/.test(s)) return true
  return false
}
