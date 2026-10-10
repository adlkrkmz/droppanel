export type EbayAspectMap = Record<string, string[]>

export type EbayRequiredAspect = {
  name: string
  required: boolean
  values: string[]
  /** Explicit taxonomy signal; omitted retains backwards-compatible free-text handling. */
  acceptsFreeText?: boolean
}

export type RequiredAspectCompletionEvidence = {
  aspect: string
  value: string
  source: "existing" | "alias" | "title" | "neutral" | "first_allowed"
}

function normalizedAspectValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase()
}

function normalizedComparableValue(value: string): string {
  return normalizedAspectValue(value)
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
}

function normalizedAspectName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase()
}

/**
 * eBay aspect names must be human-readable labels. Keep normal punctuation in
 * labels (for example "Men's Size"), but reject symbol/emoji-only keys copied
 * from a source product table.
 */
export function isMeaningfulEbayAspectName(value: string): boolean {
  const name = value.trim()
  return name.length > 0 && /[\p{L}\p{N}]/u.test(name)
}

export function sanitizeEbayAspectMap(aspects: EbayAspectMap): EbayAspectMap {
  const clean: EbayAspectMap = {}
  for (const [rawName, rawValues] of Object.entries(aspects)) {
    const name = rawName.trim()
    if (!isMeaningfulEbayAspectName(name)) continue
    const values = rawValues
      .map((value) => String(value).trim())
      .filter(Boolean)
    if (values.length > 0) clean[name] = values
  }
  return clean
}

function hasUsableAspectValue(values: string[] | undefined): boolean {
  return Boolean(values?.some((value) => {
    const normalized = String(value).trim().toLocaleLowerCase()
    return normalized.length > 0 && normalized !== "does not apply"
  }))
}

export function findMissingRequiredEbayAspects(
  aspects: EbayAspectMap,
  requiredAspects: EbayRequiredAspect[]
): string[] {
  const entries = Object.entries(aspects).map(([name, values]) => ({
    name: normalizedAspectName(name),
    values,
  }))
  return requiredAspects
    .filter((aspect) => aspect.required)
    .map((aspect) => aspect.name.trim())
    .filter(Boolean)
    .filter((requiredName) => {
      const match = entries.find((entry) => entry.name === normalizedAspectName(requiredName))
      if (hasUsableAspectValue(match?.values)) return false
      // "Does Not Apply" is normally not usable, but it is technically valid
      // when this exact restricted taxonomy explicitly offers it as neutral.
      const required = requiredAspects.find((aspect) => normalizedAspectName(aspect.name) === normalizedAspectName(requiredName))
      const hasAllowedNeutral = match?.values?.some((value) => {
        const normalized = normalizedAspectValue(String(value))
        return ["does not apply", "not applicable", "unknown", "not specified", "unspecified", "other"].includes(normalized) &&
          Boolean(required?.values.some((allowed) => normalizedAspectValue(allowed) === normalized))
      })
      return !hasAllowedNeutral
    })
}

/**
 * Fill only evidence-backed required aspects.  This intentionally has no
 * category defaults: every added value comes from a retained source field and
 * must resolve to a value returned by eBay taxonomy for that exact aspect.
 */
export function populateExplicitRequiredEbayAspects(input: {
  aspects: EbayAspectMap
  requiredAspects: EbayRequiredAspect[]
  title?: string | null
}): EbayAspectMap {
  const aspects = sanitizeEbayAspectMap(input.aspects)

  const requiredByName = new Map(
    input.requiredAspects
      .filter((aspect) => aspect.required)
      .map((aspect) => [normalizedAspectName(aspect.name), aspect])
  )

  const allowedValue = (aspectName: string, candidate: string): string | null => {
    const required = requiredByName.get(normalizedAspectName(aspectName))
    if (!required) return null
    const normalized = normalizedAspectValue(candidate)
    const direct = required.values.find((value) => normalizedAspectValue(value) === normalized)
    if (direct) return direct

    // Amazon's canonical department spellings are unambiguous aliases, but
    // are only used when their eBay counterpart is explicitly allowed.
    if (normalizedAspectName(aspectName) === "department") {
      const aliases: Record<string, string> = {
        womens: "women",
        womenswear: "women",
        mens: "men",
        menswear: "men",
      }
      const alias = aliases[normalized]
      if (alias) return required.values.find((value) => normalizedAspectValue(value) === alias) ?? null
    }
    return null
  }

  // Canonicalize an existing required aspect when eBay exposes a matching
  // allowed value (for example, Amazon "womens" -> eBay "Women").
  for (const [name, values] of Object.entries(aspects)) {
    const required = requiredByName.get(normalizedAspectName(name))
    if (!required || values.length === 0) continue
    const resolved = allowedValue(required.name, values[0])
    if (resolved) aspects[required.name] = [resolved]
  }

  const firstAspect = (...names: string[]): string | null => {
    for (const [name, values] of Object.entries(aspects)) {
      if (names.some((candidate) => normalizedAspectName(name) === normalizedAspectName(candidate))) {
        const value = values[0]?.trim()
        if (value) return value
      }
    }
    return null
  }
  const setIfAllowed = (aspectName: string, candidate: string | null): void => {
    const existing = Object.entries(aspects).find(([name]) => normalizedAspectName(name) === normalizedAspectName(aspectName))
    if (existing && hasUsableAspectValue(existing[1])) return
    if (!candidate) return
    const resolved = allowedValue(aspectName, candidate)
    if (resolved) aspects[aspectName] = [resolved]
  }

  // Material aliases identify the physical material, unlike a category default.
  setIfAllowed("Material", firstAspect("Outer Material", "Material Type", "Fabric Type", "Enclosure Material", "Shell Material"))
  // Footwear taxonomy calls this physical source field "Upper Material".
  // It remains taxonomy-gated just like Material above.
  setIfAllowed("Upper Material", firstAspect("Outer Material", "Upper Material", "Material", "Material Type"))

  // A product explicitly described as a protective case can map to eBay's
  // equivalent taxonomy label, but only in categories that offer that label.
  if (/\bprotective\s+case\b/i.test(input.title ?? "")) {
    setIfAllowed("Type", "Protective Shell/Skin")
  }

  return aspects
}

/**
 * Complete required aspects from fields already retained in the listing
 * payload. This is deliberately local and deterministic: it must never call
 * an AI provider or select an arbitrary taxonomy value.
 */
export function completeRequiredEbayAspects(input: {
  aspects: EbayAspectMap
  requiredAspects: EbayRequiredAspect[]
  title?: string | null
  evidence?: RequiredAspectCompletionEvidence[]
}): EbayAspectMap {
  const aspects = populateExplicitRequiredEbayAspects(input)
  const entries = () => Object.entries(aspects)
  const valueFor = (...names: string[]): string | null => {
    for (const [name, values] of entries()) {
      if (!names.some((candidate) => normalizedAspectName(candidate) === normalizedAspectName(name))) continue
      const value = values.find((item) => String(item).trim() && normalizedAspectValue(String(item)) !== "does not apply")
      if (value) return String(value).trim()
    }
    return null
  }
  const candidatesFor = (name: string): string[] => {
    const key = normalizedAspectName(name)
    const aliases: Record<string, string[]> = {
      "material": ["Outer Material", "Material Type", "Fabric Type", "Shell Material", "Enclosure Material"],
      "model": ["Model Name", "Model Number", "Item Model Number", "Item model number", "Manufacturer Model Number", "Mfr Model", "Part Number", "Manufacturer Part Number"],
      "mpn": ["Manufacturer Part Number", "Mfr Part Number", "Part Number", "Model Number"],
      "part number": ["Manufacturer Part Number", "Mfr Part Number", "Part Number"],
      "fragrance name": ["Scent Name", "Scent", "Fragrance", "Model Name"],
      "volume": ["Item Volume", "Volume", "Liquid Volume", "Capacity", "Net Content Volume", "Unit Count"],
      "type": ["Item Type", "Item Type Name", "Product Type", "Product Type Name", "Shoe Type", "Item Form", "Form", "Curtain Form", "Pillow Type", "Rug Form Type", "Blanket Form", "Style"],
      "style": ["Style Name", "Style", "Product Style"],
      "department": ["Gender", "Target Gender"],
      "color": ["Colour"],
      "frame color": ["Color", "Colour"],
      "us shoe size": ["Shoe Size", "Size", "Selected Size", "Variation Size"],
      "upper material": ["Outer Material", "Material", "Material Type"],
      "sport": ["Sport Type", "Sports", "Activity", "Activity Type"],
      "product": ["Product Type", "Item Type", "Item Type Name", "Plant or Animal Product Type"],
      "part type": ["Item Type", "Product Type", "Part Name", "Component Type"],
    }
    const direct = valueFor(...(aliases[key] ?? []))
    return direct ? [direct] : []
  }
  const resolveAllowed = (required: EbayRequiredAspect, candidate: string): string | null => {
    if (required.values.length === 0) return candidate.trim() || null
    const normalized = normalizedAspectValue(candidate)
    const comparable = normalizedComparableValue(candidate)
    const exact = required.values.find((value) => normalizedAspectValue(value) === normalized)
    if (exact) return exact
    const punctuationNormalized = required.values.find((value) => normalizedComparableValue(value) === comparable)
    if (punctuationNormalized) return punctuationNormalized
    if (normalizedAspectName(required.name) === "department") {
      const aliases: Record<string, string> = { womens: "women", womenswear: "women", mens: "men", menswear: "men" }
      const alias = aliases[comparable]
      if (alias) return required.values.find((value) => normalizedAspectValue(value) === alias) ?? null
    }
    // Amazon commonly writes a material's full name followed by its widely
    // used taxonomy abbreviation, e.g. "Ethylene Vinyl Acetate (EVA)".
    // Only use the abbreviation when eBay explicitly permits that exact value.
    const parenthesized = candidate.match(/\(([^()]+)\)\s*$/)?.[1]?.trim()
    if (parenthesized) {
      const abbreviation = required.values.find((value) => normalizedAspectValue(value) === normalizedAspectValue(parenthesized))
      if (abbreviation) return abbreviation
    }
    // Selection suggestions are not a closed list for free-text aspects.
    if (required.acceptsFreeText === true) return candidate.trim() || null
    return null
  }
  const neutralValue = (required: EbayRequiredAspect): string | null => {
    if (required.values.length === 0) return required.acceptsFreeText === false ? null : "Unknown"
    const neutral = new Set(["unknown", "not specified", "unspecified", "does not apply", "not applicable", "other"])
    // eBay rejects "Other" as a Brand in some categories. It is never a
    // generic Brand fallback; use a retained/free-text brand or another
    // explicitly permitted neutral value instead.
    if (normalizedAspectName(required.name) === "brand") neutral.delete("other")
    return required.values.find((value) => neutral.has(normalizedAspectValue(value))) ?? null
  }
  const titleCandidates = (required: EbayRequiredAspect): string[] => {
    const title = input.title ?? ""
    const key = normalizedAspectName(required.name)
    if (key === "type") {
      const candidates: string[] = []
      if (/\bprotective\s+case\b/i.test(title)) candidates.push("Protective Shell/Skin")
      if (/\bbody\s+spray\b/i.test(title)) candidates.push("Body Spray")
      if (/\beau\s+de\s+toilette\b/i.test(title)) candidates.push("Eau de Toilette")
      if (/\beau\s+de\s+parfum\b/i.test(title)) candidates.push("Eau de Parfum")
      if (/\bclogs?\b/i.test(title)) candidates.push("Clog")
      if (/\bremote\s+control\b/i.test(title)) candidates.push("Remote Control")
      return candidates
    }
    if (key === "part type" && /\blaser\s+level\b/i.test(title)) return ["Laser Level"]
    return []
  }

  for (const required of input.requiredAspects.filter((item) => item.required)) {
    const current = entries().find(([name]) => normalizedAspectName(name) === normalizedAspectName(required.name))
    const currentAllowed = current?.[1].some((value) => Boolean(resolveAllowed(required, String(value)))) ?? false
    if (current && hasUsableAspectValue(current[1]) && (required.values.length === 0 || currentAllowed)) {
      input.evidence?.push({ aspect: required.name, value: current[1][0]!, source: "existing" })
      continue
    }

    let resolved: string | null = null
    let source: RequiredAspectCompletionEvidence["source"] | null = null
    for (const candidate of candidatesFor(required.name)) {
      resolved = resolveAllowed(required, candidate)
      if (resolved) { source = "alias"; break }
    }
    if (!resolved) {
      for (const candidate of titleCandidates(required)) {
        resolved = resolveAllowed(required, candidate)
        if (resolved) { source = "title"; break }
      }
    }
    if (!resolved) {
      resolved = neutralValue(required)
      if (resolved) source = "neutral"
    }
    // This is intentionally the final selection-only escape hatch. It is
    // recorded so callers can audit that no product evidence existed.
    if (!resolved && required.values.length > 0) {
      const isBrand = normalizedAspectName(required.name) === "brand"
      resolved = required.values.find((value) => !isBrand || normalizedAspectValue(value) !== "other") ?? null
      if (resolved) source = "first_allowed"
    }
    if (resolved) {
      aspects[required.name] = [resolved]
      input.evidence?.push({ aspect: required.name, value: resolved, source: source ?? "alias" })
    }
  }
  return sanitizeEbayAspectMap(aspects)
}
