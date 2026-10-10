// ----------------------------------------------------------------
// poolCategoryPreferencesService.ts — workspace-scoped category prefs (DB)
// ----------------------------------------------------------------

import fs from "fs"
import path from "path"
import { query } from "../../db/client"

export const POOL_CATEGORY_OPTIONS = [
  "Home & Kitchen",
  "Patio, Lawn & Garden",
  "Beauty & Personal Care",
  "Health & Household",
  "Tools & Home Improvement",
  "Office Products",
  "Pet Supplies",
  "Baby",
  "Sports & Outdoors",
  "Toys & Games",
  "Automotive",
  "Electronics Accessories",
] as const

export const POOL_CATEGORY_PREFERENCES_KEY = "pool_category_preferences"

export type PoolCategoryPreferences = {
  categories: string[]
  note:       string
}

const ALLOWED = new Set<string>(POOL_CATEGORY_OPTIONS)
const LEGACY_JSON_FILE = path.join(process.cwd(), "data", "pool-category-preferences.json")
const NOTE_MAX = 500

function emptyPrefs(): PoolCategoryPreferences {
  return { categories: [], note: "" }
}

function normalizeInput(input: Partial<PoolCategoryPreferences>): PoolCategoryPreferences {
  const categories = Array.isArray(input.categories)
    ? [...new Set(
        input.categories
          .filter((c): c is string => typeof c === "string")
          .map((c) => c.trim())
          .filter((c) => ALLOWED.has(c))
      )]
    : []

  const note = typeof input.note === "string" ? input.note.trim().slice(0, NOTE_MAX) : ""

  return { categories, note }
}

function parseValue(raw: unknown): PoolCategoryPreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyPrefs()
  const obj = raw as Record<string, unknown>
  return normalizeInput({
    categories: obj.categories as string[] | undefined,
    note:       obj.note as string | undefined,
  })
}

function readLegacyJsonStore(): Record<string, PoolCategoryPreferences> {
  try {
    if (!fs.existsSync(LEGACY_JSON_FILE)) return {}
    const raw = fs.readFileSync(LEGACY_JSON_FILE, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, PoolCategoryPreferences> = {}
    for (const [wsId, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[wsId] = parseValue(value)
    }
    return out
  } catch (e) {
    console.error("[PoolCategoryPreferences] legacy JSON read failed:", e instanceof Error ? e.message : String(e))
    return {}
  }
}

async function upsertPreferences(
  workspaceId: string,
  prefs:       PoolCategoryPreferences
): Promise<void> {
  await query(
    `INSERT INTO workspace_preferences (workspace_id, key, value, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (workspace_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [workspaceId, POOL_CATEGORY_PREFERENCES_KEY, JSON.stringify(prefs)]
  )
}

/** One-time import from legacy JSON file when DB row is missing. */
export async function importPoolCategoryPreferencesFromJsonIfNeeded(): Promise<void> {
  const legacy = readLegacyJsonStore()
  const entries = Object.entries(legacy)
  if (entries.length === 0) return

  let imported = 0
  for (const [workspaceId, prefs] of entries) {
    const existing = await query<{ id: number }>(
      `SELECT id FROM workspace_preferences
       WHERE workspace_id = $1 AND key = $2
       LIMIT 1`,
      [workspaceId, POOL_CATEGORY_PREFERENCES_KEY]
    )
    if (existing.rows.length > 0) continue
    await upsertPreferences(workspaceId, normalizeInput(prefs))
    imported++
  }

  if (imported > 0) {
    console.log("[PoolCategoryPreferences] imported from legacy JSON", { imported })
  }
}

export async function getPoolCategoryPreferences(
  workspaceId: string
): Promise<PoolCategoryPreferences> {
  const result = await query<{ value: PoolCategoryPreferences }>(
    `SELECT value FROM workspace_preferences
     WHERE workspace_id = $1 AND key = $2
     LIMIT 1`,
    [workspaceId, POOL_CATEGORY_PREFERENCES_KEY]
  )
  const row = result.rows[0]
  if (!row) return emptyPrefs()
  return parseValue(row.value)
}

export async function savePoolCategoryPreferences(
  workspaceId: string,
  input:       Partial<PoolCategoryPreferences>
): Promise<PoolCategoryPreferences> {
  const prefs = normalizeInput(input)
  await upsertPreferences(workspaceId, prefs)
  console.log("[PoolCategoryPreferences] saved", {
    workspaceId,
    categoryCount: prefs.categories.length,
    hasNote:       Boolean(prefs.note),
  })
  return prefs
}
