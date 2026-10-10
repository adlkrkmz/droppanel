import type { PriceConfirmationSource } from "../stockAlerts/stockAlertUserMessages"

export const KEEPA_DIRECT_MUTATIONS_FLAG = "KEEPA_DIRECT_MUTATIONS_ENABLED"

/** Non-Keepa origins that may still enter apply pipelines when the master gate is off. */
export const BROWSER_CONFIRMED_SOURCES = [
  "EXTENSION_VERIFIED",
  "DESKTOP_AGENT",
  "SERVER_BROWSER_PUBLIC",
  "SERVER_BROWSER_AUTH",
] as const satisfies readonly PriceConfirmationSource[]

/** Known Keepa-direct mutation provenance labels used at apply call-sites. */
export const KEEPA_DIRECT_MUTATION_SOURCES = ["KEEPA_CONFIRMED"] as const satisfies readonly PriceConfirmationSource[]

export type ConfirmationSourceClass = "browser_confirmed" | "keepa_direct" | "unknown"

const BROWSER_SET = new Set<string>(BROWSER_CONFIRMED_SOURCES)
const KEEPA_SET = new Set<string>(KEEPA_DIRECT_MUTATION_SOURCES)

/** Master gate. Unset/empty/invalid → false. Independent of GLOBAL_KEEPA_* / KEEPA_ENABLED. */
export function keepaDirectMutationsEnabled(raw = process.env.KEEPA_DIRECT_MUTATIONS_ENABLED): boolean {
  return String(raw ?? "").trim().toLowerCase() === "true"
}

export function normalizeConfirmationSource(source: string | null | undefined): string {
  return String(source ?? "").trim().toUpperCase()
}

export function classifyConfirmationSource(source: string | null | undefined): ConfirmationSourceClass {
  const n = normalizeConfirmationSource(source)
  if (!n) return "unknown"
  if (BROWSER_SET.has(n)) return "browser_confirmed"
  if (KEEPA_SET.has(n) || n.includes("KEEPA")) return "keepa_direct"
  return "unknown"
}

export function isKeepaDirectConfirmationSource(source: string | null | undefined): boolean {
  return classifyConfirmationSource(source) === "keepa_direct"
}

export function isBrowserConfirmedSource(source: string | null | undefined): boolean {
  return classifyConfirmationSource(source) === "browser_confirmed"
}

export function evaluateKeepaDirectMutationGate(source: string | null | undefined): {
  allowed: boolean
  skip: "KEEPA_DIRECT_MUTATION_DISABLED" | null
  sourceClass: ConfirmationSourceClass
} {
  const sourceClass = classifyConfirmationSource(source)
  if (sourceClass === "browser_confirmed") {
    return { allowed: true, skip: null, sourceClass }
  }
  if (sourceClass === "keepa_direct" && keepaDirectMutationsEnabled()) {
    return { allowed: true, skip: null, sourceClass }
  }
  return { allowed: false, skip: "KEEPA_DIRECT_MUTATION_DISABLED", sourceClass }
}
