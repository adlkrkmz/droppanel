/** Desktop observations are diagnostic only unless explicitly re-enabled. */
export function isDesktopAgentAutomationEnabled(): boolean {
  return (process.env.DESKTOP_AGENT_AUTOMATION_ENABLED ?? "").trim().toLowerCase() === "true"
}
