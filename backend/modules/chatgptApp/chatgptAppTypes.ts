import { z } from "zod/v4"

/** Empty tool input shape — health/capabilities accept `{}` only. */
export const emptyToolInputShape = {} as const

export const listjetgoHealthOutputShape = {
  ok: z.literal(true),
  status: z.literal("healthy"),
  service: z.string(),
  environment: z.string(),
  mcpVersion: z.string(),
}

export const listjetgoHealthOutputSchema = z.object(listjetgoHealthOutputShape)
export type ListjetgoHealthOutput = z.infer<typeof listjetgoHealthOutputSchema>

export const listjetgoCapabilitiesOutputShape = {
  app: z.literal("ListJetGo"),
  mode: z.literal("private_development"),
  configurationRequired: z.boolean().optional(),
  capabilities: z.object({
    mcpConnection: z.boolean(),
    healthCheck: z.boolean(),
    supplierImport: z.boolean(),
    imageGeneration: z.boolean(),
    imageUpload: z.boolean(),
    productPreview: z.boolean(),
    databaseAccess: z.boolean(),
    r2Access: z.boolean(),
    ebayAccess: z.boolean(),
    authentication: z.boolean(),
    chatgptWidget: z.boolean(),
    publicDistribution: z.boolean(),
  }),
  nextPlannedPhase: z.string(),
}

export const listjetgoCapabilitiesOutputSchema = z.object(
  listjetgoCapabilitiesOutputShape
)
export type ListjetgoCapabilitiesOutput = z.infer<
  typeof listjetgoCapabilitiesOutputSchema
>

export type ChatGptAppMcpMountDecision = {
  /** When true, `/mcp` may be registered. */
  shouldMount: boolean
  /** Safe reason code for logs/tests — never includes secret values. */
  reason:
    | "flag_disabled"
    | "production_unauthenticated_blocked"
    | "enabled_private_development"
}

export const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
} as const
