import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  CHATGPT_APP_MCP_VERSION,
  resolveSafeEnvironmentLabel,
} from "../chatgptAppConfig"
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  emptyToolInputShape,
  listjetgoHealthOutputSchema,
  listjetgoHealthOutputShape,
  type ListjetgoHealthOutput,
} from "../chatgptAppTypes"

const HEALTH_TEXT =
  "ListJetGo MCP connection is healthy. This development build has no marketplace account access enabled."

export function buildListjetgoHealthOutput(
  env: NodeJS.ProcessEnv = process.env
): ListjetgoHealthOutput {
  return listjetgoHealthOutputSchema.parse({
    ok: true,
    status: "healthy",
    service: "ListJetGo ChatGPT App MCP",
    environment: resolveSafeEnvironmentLabel(env),
    mcpVersion: CHATGPT_APP_MCP_VERSION,
  })
}

export function buildListjetgoHealthToolResult(
  env: NodeJS.ProcessEnv = process.env
): CallToolResult {
  const structuredContent = buildListjetgoHealthOutput(env)
  return {
    content: [{ type: "text", text: HEALTH_TEXT }],
    structuredContent,
  }
}

export function registerListjetgoHealthTool(server: McpServer): void {
  server.registerTool(
    "listjetgo_health",
    {
      title: "ListJetGo health",
      description:
        "Check whether the private ListJetGo development MCP server is reachable. This tool does not access marketplace accounts, users, databases, or external services.",
      inputSchema: emptyToolInputShape,
      outputSchema: listjetgoHealthOutputShape,
      annotations: { ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    async () => buildListjetgoHealthToolResult()
  )
}
