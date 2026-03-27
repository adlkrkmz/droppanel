'use client'

import React, { createContext, useContext, useState, useEffect } from 'react'

type StoreContextType = {
  selectedStore: string
  setSelectedStore: (code: string) => void
}

const StoreContext = createContext<StoreContextType>({
  selectedStore: 'S1',
  setSelectedStore: () => {},
})

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [selectedStore, setSelectedStoreState] = useState<string>('S1')

  useEffect(() => {
    const saved = localStorage.getItem('dp_selected_store')
    if (saved) setSelectedStoreState(saved)
  }, [])

  const setSelectedStore = (code: string) => {
    setSelectedStoreState(code)
    localStorage.setItem('dp_selected_store', code)
  }

  return (
    <StoreContext.Provider value={{ selectedStore, setSelectedStore }}>
      {children}
    </StoreContext.Provider>
  )
}

export function useStore() {
  return useContext(StoreContext)
}
