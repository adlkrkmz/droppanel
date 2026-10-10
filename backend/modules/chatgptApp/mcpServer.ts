import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  CHATGPT_APP_MCP_INSTRUCTIONS,
  CHATGPT_APP_MCP_NAME,
  CHATGPT_APP_MCP_VERSION,
} from "./chatgptAppConfig"
import { registerListjetgoCapabilitiesTool } from "./tools/listjetgoCapabilitiesTool"
import { registerListjetgoHealthTool } from "./tools/listjetgoHealthTool"

/**
 * Creates a fresh MCP server instance for a single Streamable HTTP request
 * (stateless mode). Callers must close the server after the HTTP response ends.
 */
export function createListJetGoMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: CHATGPT_APP_MCP_NAME,
      version: CHATGPT_APP_MCP_VERSION,
    },
    {
      instructions: CHATGPT_APP_MCP_INSTRUCTIONS,
    }
  )

  registerListjetgoHealthTool(server)
  registerListjetgoCapabilitiesTool(server)

  return server
}
