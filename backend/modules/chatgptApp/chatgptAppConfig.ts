import type { ChatGptAppMcpMountDecision } from "./chatgptAppTypes"

export const CHATGPT_APP_MCP_NAME = "listjetgo"
export const CHATGPT_APP_MCP_VERSION = "0.1.0"
export const CHATGPT_APP_MCP_INSTRUCTIONS = [
  "ListJetGo private development MCP exposes health and Amazon Supplier Reader support only.",
  "No marketplace publishing, account access, or database write tools are available.",
].join("\n")

export function isChatGptAppMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHATGPT_APP_MCP_ENABLED === "true"
}
export function resolveChatGptAppMcpMountDecision(env: NodeJS.ProcessEnv = process.env): ChatGptAppMcpMountDecision {
  if (!isChatGptAppMcpEnabled(env)) return { shouldMount:false, reason:"flag_disabled" }
  if (env.NODE_ENV === "production") return { shouldMount:false, reason:"production_unauthenticated_blocked" }
  return { shouldMount:true, reason:"enabled_private_development" }
}
export function resolveSafeEnvironmentLabel(env: NodeJS.ProcessEnv = process.env): string {
  return env.NODE_ENV?.trim() || "development"
}
