// ─────────────────────────────────────────────────────────────
// dispatchService.ts
//
// Manuel dispatch: storeCode + count + selectionMode
//
// Publish ETMEZ.
// Sadece asin_pool.assigned_store_id günceller.
// Worker/runtime sonraki turda bu kayıtları publish eder.
// ─────────────────────────────────────────────────────────────

import {
  findStoreByCode,
  fetchDispatchCandidates,
  fetchAlreadyListedAsins,
  assignPoolEntriesToStore
} from "./dispatchRepository"
import type {
  DispatchCandidate,
  DispatchOptions,
  DispatchResult,
  SelectionMode
} from "./dispatchTypes"

// ─── SEÇİM MODLARI ────────────────────────────────────────────

function applySelectionMode(
  candidates: DispatchCandidate[],
  mode:       SelectionMode,
  count:      number
): DispatchCandidate[] {
  let pool = [...candidates]

  if (mode === "random") {
    // Fisher-Yates karıştırma
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]]
    }
  } else if (mode === "priority") {
    pool.sort((a, b) => b.priority - a.priority)
  }
  // fifo: ORDER BY id ASC — DB'den zaten sıralı geldi

  return pool.slice(0, count)
}

// ─── ANA DISPATCH ─────────────────────────────────────────────

export async function runDispatch(
  opts: DispatchOptions
): Promise<DispatchResult> {
  const {
    workspaceId,
    storeCode,
    count,
    selectionMode,
    delaySeconds
  } = opts

  console.log(
    `[Dispatch] Starting | store=${storeCode} count=${count} ` +
    `mode=${selectionMode} delay=${delaySeconds}s`
  )

  // 1. Mağazayı bul
  const store = await findStoreByCode(workspaceId, storeCode)
  if (!store) {
    throw new Error("Store not found")
  }
  if (store.status !== "active") {
    throw new Error(`Store is not active: ${store.name?.trim() || "Store"} (${store.status})`)
  }

  console.log(`[Dispatch] Store found: ${store.name} (id=${store.id})`)

  // 2. Mağazada zaten listelenmiş ASIN'leri çek
  const alreadyListed = await fetchAlreadyListedAsins(workspaceId, store.id)
  console.log(`[Dispatch] Already listed in store: ${alreadyListed.size} ASIN`)

  // 3. Uygun adayları çek (count * 5 buffer — duplicate elendikten sonra count kalmalı)
  const fetchLimit = Math.min(count * 5, 1000)
  const rawCandidates = await fetchDispatchCandidates(workspaceId, fetchLimit)
  console.log(`[Dispatch] Raw candidates: ${rawCandidates.length}`)

  // 4. Duplicate eleme
  const filtered  = rawCandidates.filter(c => !alreadyListed.has(c.asin))
  const skippedCount = rawCandidates.length - filtered.length
  console.log(`[Dispatch] After dedup: ${filtered.length} (skipped=${skippedCount})`)

  // 5. Seçim modunu uygula
  const selected = applySelectionMode(filtered, selectionMode, count)
  console.log(`[Dispatch] Selected: ${selected.length}`)

  if (selected.length === 0) {
    console.log("[Dispatch] No candidates to assign")
    return {
      storeId:         store.id,
      storeCode:       store.storeCode,
      storeName:       store.name,
      selectionMode,
      delaySeconds,
      selectedCount:   0,
      skippedCount,
      assignedPoolIds: [],
      assignedAsins:   [],
      dispatchedAt:    new Date().toISOString()
    }
  }

  // 6. Pool kayıtlarını mağazaya ata
  const poolIds = selected.map(c => c.poolId)
  const updated = await assignPoolEntriesToStore(poolIds, store.id)
  console.log(`[Dispatch] Pool entries updated: ${updated}`)

  return {
    storeId:         store.id,
    storeCode:       store.storeCode,
    storeName:       store.name,
    selectionMode,
    delaySeconds,
    selectedCount:   selected.length,
    skippedCount,
    assignedPoolIds: selected.map(c => c.poolId),
    assignedAsins:   selected.map(c => c.asin),
    dispatchedAt:    new Date().toISOString()
  }
}
