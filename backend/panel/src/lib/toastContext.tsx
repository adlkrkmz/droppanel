'use client'
import React, { createContext, useContext, useState, useCallback, useRef } from 'react'

type ToastType = 'success' | 'error'
type Toast = { id: number; message: string; type: ToastType }

type ToastContextType = {
  showToast: (message: string, type?: ToastType) => void
}

const ToastContext = createContext<ToastContextType>({ showToast: () => {} })

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextIdRef = useRef(0)

  const showToast = useCallback((message: string, type: ToastType = 'success') => {
    const id = ++nextIdRef.current
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 3500)
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Toast container — sağ üst köşe */}
      <div style={{
        position: 'fixed', top: '64px', right: '16px',
        zIndex: 9999, display: 'flex', flexDirection: 'column', gap: '8px'
      }}>
        {toasts.map(toast => (
          <div key={toast.id} style={{
            padding: '10px 16px',
            borderRadius: '4px',
            fontSize: '12px',
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 600,
            color: '#000',
            background: toast.type === 'success' ? 'var(--accent)' : 'var(--danger)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            animation: 'slideIn 0.2s ease',
            maxWidth: '360px',
            wordBreak: 'break-word',
          }}>
            {toast.type === 'success' ? '✓ ' : '✗ '}{toast.message}
          </div>
        ))}
      </div>
      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
