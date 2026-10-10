import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  emptyToolInputShape,
  listjetgoCapabilitiesOutputSchema,
  listjetgoCapabilitiesOutputShape,
  type ListjetgoCapabilitiesOutput,
} from "../chatgptAppTypes"
const CAPABILITIES_TEXT = "ListJetGo private development MCP exposes health and generic supplier-reader support only. eBay writes, authentication, widgets, and public distribution remain disabled."

export function buildListjetgoCapabilitiesOutput(
  env: NodeJS.ProcessEnv = process.env
): ListjetgoCapabilitiesOutput {
  void env

  return listjetgoCapabilitiesOutputSchema.parse({
    app: "ListJetGo",
    mode: "private_development",
    configurationRequired: false,
    capabilities: {
      mcpConnection: true,
      healthCheck: true,
      supplierImport: false,
      imageGeneration: false,
      imageUpload: false,
      productPreview: true,
      databaseAccess: false,
      r2Access: false,
      ebayAccess: false,
      authentication: false,
      chatgptWidget: false,
      publicDistribution: false,
    },
    nextPlannedPhase: "eBay-focused MCP capabilities require a separately scoped design.",
  })
}

export function buildListjetgoCapabilitiesToolResult(
  env: NodeJS.ProcessEnv = process.env
): CallToolResult {
  const structuredContent = buildListjetgoCapabilitiesOutput(env)
  const text = CAPABILITIES_TEXT
  return {
    content: [{ type: "text", text }],
    structuredContent,
  }
}

export function registerListjetgoCapabilitiesTool(server: McpServer): void {
  server.registerTool(
    "listjetgo_get_capabilities",
    {
      title: "ListJetGo capabilities",
      description:
        "Report enabled integrations in this private development MCP build. Does not call external marketplace APIs or modify data.",
      inputSchema: emptyToolInputShape,
      outputSchema: listjetgoCapabilitiesOutputShape,
      annotations: { ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    async () => buildListjetgoCapabilitiesToolResult()
  )
}
