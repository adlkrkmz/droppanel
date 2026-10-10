// ----------------------------------------------------------------
// listingAiModeService.ts — titleMode ↔ listing AI behavior
// ----------------------------------------------------------------

import type { TitleMode } from "../titleBot/titleBotService"

export type ListingAiMode = "off" | "cache" | "generate"

/** titleMode API compat: titlebot = AI off, ai = generate + cache allowed */
export function titleModeToListingAiMode(titleMode: TitleMode): ListingAiMode {
  return titleMode === "ai" ? "generate" : "off"
}

export function parseTitleMode(
  raw: unknown,
  useAiTitle?: unknown
): TitleMode {
  const mode = String(raw ?? "").trim().toLowerCase()
  if (mode === "ai" || mode === "titlebot" || mode === "original") return mode
  if (useAiTitle === true) return "ai"
  return "ai"
}

export function isAiOff(titleMode: TitleMode): boolean {
  return titleModeToListingAiMode(titleMode) === "off"
}

export function allowsAiCache(titleMode: TitleMode): boolean {
  return titleMode === "ai"
}

export function allowsAiGenerate(titleMode: TitleMode): boolean {
  return titleMode === "ai"
}

export function allowsGeminiCategory(titleMode: TitleMode): boolean {
  return titleMode === "ai"
}

export function skipDispatchAiGenerate(titleMode: TitleMode): boolean {
  return isAiOff(titleMode)
}
