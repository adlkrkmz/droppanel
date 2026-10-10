import type { Express, Request, Response } from "express"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createLogger } from "../logger/logger"
import {
  isChatGptAppMcpEnabled,
  resolveChatGptAppMcpMountDecision,
} from "./chatgptAppConfig"
import { createListJetGoMcpServer } from "./mcpServer"
import {
  amazonReaderAvailabilityHandler,
  amazonReaderClaimHandler,
  amazonReaderHeartbeatHandler,
  amazonReaderJobStatusHandler,
  amazonReaderProgressHandler,
  amazonReaderResultHandler,
} from "./services/chatgptAmazonSupplierReadHandlers"

const logger = createLogger("chatgptApp")

/**
 * Stateless Streamable HTTP handler for `/mcp`.
 * Uses the official SDK transport; does not dump headers/bodies or secrets.
 */
export async function handleChatGptAppMcpRequest(
  req: Request,
  res: Response
): Promise<void> {
  const server = createListJetGoMcpServer()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  const cleanup = (): void => {
    void transport.close().catch(() => undefined)
    void server.close().catch(() => undefined)
  }

  res.on("close", cleanup)

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    logger.error("MCP request failed", {
      error: error instanceof Error ? error.message : "unknown_error",
    })
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      })
    }
    cleanup()
  }
}

/**
 * Mounts `/mcp` only when the private-development feature flag allows it.
 * Production never mounts unauthenticated MCP (even if the flag is true).
 * Does not reorder existing routes; call from buildApp near other mounts.
 *
 * Amazon Supplier Reader bridge routes are always registered (no new MCP tool).
 */
export function registerChatGptAppRoutes(app: Express): void {
  app.post("/api/chatgpt/supplier-reader/heartbeat", amazonReaderHeartbeatHandler)
  app.get(
    "/api/chatgpt/supplier-reader/availability",
    amazonReaderAvailabilityHandler
  )
  app.post("/api/chatgpt/supplier-reader/claim", amazonReaderClaimHandler)
  app.get(
    "/api/chatgpt/supplier-reader/jobs/:jobId",
    amazonReaderJobStatusHandler
  )
  app.post("/api/chatgpt/supplier-reader/progress", amazonReaderProgressHandler)
  app.post("/api/chatgpt/supplier-reader/result", (req, res) => {
    void amazonReaderResultHandler(req, res)
  })

  const decision = resolveChatGptAppMcpMountDecision()

  if (!decision.shouldMount) {
    if (decision.reason === "production_unauthenticated_blocked") {
      logger.warn(
        "ChatGPT App MCP not mounted: unauthenticated MCP is blocked in production"
      )
    }
    return
  }

  app.all("/mcp", (req, res) => {
    void handleChatGptAppMcpRequest(req, res)
  })

  logger.info("ChatGPT App MCP mounted at /mcp (private development)")
}

export {
  isChatGptAppMcpEnabled,
  resolveChatGptAppMcpMountDecision,
}
