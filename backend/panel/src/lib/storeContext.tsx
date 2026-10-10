'use client'

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'

type StoreContextType = {
  /** Empty until localStorage hydration completes. */
  selectedStore: string
  setSelectedStore: (code: string) => void
  isStoreReady: boolean
}

const StoreContext = createContext<StoreContextType>({
  selectedStore: '',
  setSelectedStore: () => {},
  isStoreReady: false,
})

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [selectedStore, setSelectedStoreState] = useState<string>('')
  const [isStoreReady, setIsStoreReady] = useState(false)

  useEffect(() => {
    try {
      const saved = localStorage.getItem('dp_selected_store')?.trim()
      if (saved) setSelectedStoreState(saved)
    } catch {
      /* private mode / blocked storage */
    } finally {
      setIsStoreReady(true)
    }
  }, [])

  const setSelectedStore = useCallback((code: string) => {
    const trimmed = code.trim()
    if (!trimmed) return
    setSelectedStoreState(trimmed)
    try {
      localStorage.setItem('dp_selected_store', trimmed)
    } catch {
      /* ignore */
    }
  }, [])

  return (
    <StoreContext.Provider value={{ selectedStore, setSelectedStore, isStoreReady }}>
      {children}
    </StoreContext.Provider>
  )
}

export function useStore() {
  return useContext(StoreContext)
}
