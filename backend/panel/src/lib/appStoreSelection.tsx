"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"

/** Canonical persisted selected store for /app user panel (exact store_id). */
export const APP_SELECTED_STORE_ID_KEY = "listjetgo_selectedStoreId"
/** Legacy key used storeCode; migrate once only when canonical key is absent. */
export const LEGACY_SELECTED_STORE_CODE_KEY = "dp_selected_store"

type StoreLike = { storeId: number; storeCode: string }

type AppStoreSelectionContextType = {
  selectedStoreId: number | null
  setSelectedStoreId: (storeId: number) => void
  isStoreSelectionReady: boolean
}

const AppStoreSelectionContext = createContext<AppStoreSelectionContextType>({
  selectedStoreId: null,
  setSelectedStoreId: () => {},
  isStoreSelectionReady: false,
})

function readPersistedStoreId(): number | null {
  try {
    const raw = localStorage.getItem(APP_SELECTED_STORE_ID_KEY)?.trim()
    if (!raw) return null
    const id = Number(raw)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

function hasCanonicalPersistedStoreId(): boolean {
  try {
    const raw = localStorage.getItem(APP_SELECTED_STORE_ID_KEY)?.trim()
    return Boolean(raw)
  } catch {
    return false
  }
}

function readLegacyStoreCode(): string | null {
  try {
    const code = localStorage.getItem(LEGACY_SELECTED_STORE_CODE_KEY)?.trim()
    return code || null
  } catch {
    return null
  }
}

function writePersistedStoreId(storeId: number): void {
  try {
    localStorage.setItem(APP_SELECTED_STORE_ID_KEY, String(storeId))
  } catch {
    /* private mode / blocked storage */
  }
}

function byId(stores: StoreLike[], id: number | null | undefined): number | null {
  if (id == null || !Number.isFinite(id) || id <= 0) return null
  return stores.some(s => s.storeId === id) ? id : null
}

function byCode(stores: StoreLike[], code: string | null | undefined): number | null {
  const c = String(code ?? "").trim()
  if (!c) return null
  return stores.find(s => s.storeCode === c)?.storeId ?? null
}

export type AdoptStoreSelectionResult = {
  storeId: number | null
  /** True only when page must write into provider (url / legacy migrate / first fallback). */
  shouldWriteProvider: boolean
  source: "provider" | "url" | "legacy" | "first" | "none"
}

/**
 * Resolve store for a page mount WITHOUT letting stale URL/legacy overwrite a valid
 * provider/persisted selectedStoreId.
 *
 * Precedence:
 * 1. valid provider/persisted selectedStoreId (canonical — never overwritten by URL)
 * 2. URL storeId / storeCode (only when provider empty/invalid) → write provider
 * 3. legacy dp_selected_store (only when canonical key absent) → write provider
 * 4. first owned store → write provider
 */
export function adoptStoreSelection(
  stores: StoreLike[],
  opts: {
    providerStoreId?: number | null
    urlStoreId?: number | null
    urlStoreCode?: string | null
  } = {}
): AdoptStoreSelectionResult {
  if (!stores.length) return { storeId: null, shouldWriteProvider: false, source: "none" }

  const fromProvider = byId(stores, opts.providerStoreId)
  if (fromProvider != null) {
    return { storeId: fromProvider, shouldWriteProvider: false, source: "provider" }
  }

  const fromUrl =
    byId(stores, opts.urlStoreId) ?? byCode(stores, opts.urlStoreCode)
  if (fromUrl != null) {
    return { storeId: fromUrl, shouldWriteProvider: true, source: "url" }
  }

  // Legacy code may seed selection ONLY when canonical key was never written.
  if (!hasCanonicalPersistedStoreId()) {
    const fromLegacy = byCode(stores, readLegacyStoreCode())
    if (fromLegacy != null) {
      return { storeId: fromLegacy, shouldWriteProvider: true, source: "legacy" }
    }
  }

  return { storeId: stores[0]!.storeId, shouldWriteProvider: true, source: "first" }
}

/** @deprecated Prefer adoptStoreSelection — kept for any residual callers. */
export function resolveAppStoreId(
  stores: StoreLike[],
  opts: {
    persistedStoreId?: number | null
    urlStoreId?: number | null
    urlStoreCode?: string | null
    legacyStoreCode?: string | null
  } = {}
): number | null {
  return adoptStoreSelection(stores, {
    providerStoreId: opts.persistedStoreId,
    urlStoreId: opts.urlStoreId,
    urlStoreCode: opts.urlStoreCode,
  }).storeId
}

export function storeCodeForId(stores: StoreLike[], storeId: number | null | undefined): string {
  if (storeId == null) return ""
  return stores.find(s => s.storeId === storeId)?.storeCode ?? ""
}

export function parseUrlStoreId(raw: string | null | undefined): number | null {
  if (raw == null || !String(raw).trim()) return null
  const id = Number(String(raw).trim())
  return Number.isFinite(id) && id > 0 ? id : null
}

export function AppStoreSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedStoreId, setSelectedStoreIdState] = useState<number | null>(null)
  const [isStoreSelectionReady, setIsStoreSelectionReady] = useState(false)

  useEffect(() => {
    setSelectedStoreIdState(readPersistedStoreId())
    setIsStoreSelectionReady(true)
  }, [])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== APP_SELECTED_STORE_ID_KEY) return
      if (e.newValue == null || e.newValue.trim() === "") {
        setSelectedStoreIdState(null)
        return
      }
      const id = Number(e.newValue)
      if (Number.isFinite(id) && id > 0) setSelectedStoreIdState(id)
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const setSelectedStoreId = useCallback((storeId: number) => {
    if (!Number.isFinite(storeId) || storeId <= 0) return
    setSelectedStoreIdState(storeId)
    writePersistedStoreId(storeId)
  }, [])

  return (
    <AppStoreSelectionContext.Provider
      value={{ selectedStoreId, setSelectedStoreId, isStoreSelectionReady }}
    >
      {children}
    </AppStoreSelectionContext.Provider>
  )
}

export function useAppStoreSelection() {
  return useContext(AppStoreSelectionContext)
}

/** @deprecated Use adoptStoreSelection (legacy is read only when canonical key absent). */
export function readLegacyStoreCodeForMigration(): string | null {
  if (hasCanonicalPersistedStoreId()) return null
  return readLegacyStoreCode()
}
