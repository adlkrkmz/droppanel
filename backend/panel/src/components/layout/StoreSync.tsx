"use client"

import { useEffect } from "react"
import { getStores } from "@/lib/api"
import { useStore } from "@/lib/storeContext"

/**
 * After stores load, ensure selectedStore matches a real connected store.
 * UI-only — no DB writes.
 */
export default function StoreSync() {
  const { selectedStore, setSelectedStore, isStoreReady } = useStore()

  useEffect(() => {
    if (!isStoreReady) return

    let cancelled = false

    void getStores()
      .then(d => {
        if (cancelled) return
        const rows = d.rows ?? []
        const active = rows.filter(s => s.status === "active")
        const list = active.length > 0 ? active : rows
        if (list.length === 0) return

        const valid = selectedStore && list.some(s => s.storeCode === selectedStore)
        if (!valid) {
          setSelectedStore(list[0]!.storeCode)
        }
      })
      .catch(() => {
        /* API down — keep current selection */
      })

    return () => {
      cancelled = true
    }
  }, [isStoreReady, selectedStore, setSelectedStore])

  return null
}
