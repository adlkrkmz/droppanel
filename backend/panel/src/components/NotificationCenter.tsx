'use client'

// Anlık toast'lar: CustomEvent `app:notification`. Kalıcı geçmiş: Topbar zil menüsü → GET /admin/notifications.

import { useEffect, useRef, useState } from 'react'
import type { NotificationPayload, NotificationType } from '@/lib/notifications'

interface Notification extends NotificationPayload {
  id: number
  exiting: boolean
}

const MAX_VISIBLE = 5

const COLORS: Record<NotificationType, { border: string; icon: string; iconBg: string; titleColor: string }> = {
  success: { border: '#00ff88', icon: '✓',  iconBg: 'rgba(0,255,136,0.15)',  titleColor: '#00ff88' },
  error:   { border: '#ff4455', icon: '✗',  iconBg: 'rgba(255,68,85,0.15)',  titleColor: '#ff4455' },
  warning: { border: '#ffaa00', icon: '⚠',  iconBg: 'rgba(255,170,0,0.15)', titleColor: '#ffaa00' },
  info:    { border: '#3399ff', icon: 'ℹ',  iconBg: 'rgba(51,153,255,0.15)', titleColor: '#3399ff' },
}

const AUTO_DISMISS_MS: Record<NotificationType, number> = {
  success: 8000,
  info:    8000,
  warning: 8000,
  error:   15000,
}

export default function NotificationCenter() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const nextId = useRef(0)
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = (id: number) => {
    setNotifications(prev =>
      prev.map(n => (n.id === id ? { ...n, exiting: true } : n))
    )
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id))
    }, 320)
    const t = timers.current.get(id)
    if (t) { clearTimeout(t); timers.current.delete(id) }
  }

  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<NotificationPayload>
      const id = ++nextId.current
      const notification: Notification = { ...ev.detail, id, exiting: false }

      setNotifications(prev => {
        const next = [...prev, notification]
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next
      })

      const delay = AUTO_DISMISS_MS[ev.detail.type]
      const timer = setTimeout(() => dismiss(id), delay)
      timers.current.set(id, timer)
    }

    window.addEventListener('app:notification', handler)
    return () => window.removeEventListener('app:notification', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Clean up timers on unmount
  useEffect(() => {
    return () => { timers.current.forEach(t => clearTimeout(t)) }
  }, [])

  if (notifications.length === 0) return null

  return (
    <>
      <style>{`
        @keyframes nc-slide-in {
          from { opacity: 0; transform: translateX(24px); }
          to   { opacity: 1; transform: translateX(0);    }
        }
        @keyframes nc-slide-out {
          from { opacity: 1; transform: translateX(0);    }
          to   { opacity: 0; transform: translateX(24px); }
        }
        .nc-item-enter { animation: nc-slide-in 0.25s ease forwards; }
        .nc-item-exit  { animation: nc-slide-out 0.3s ease forwards; }
      `}</style>

      <div
        style={{
          position: 'fixed',
          top: '72px',
          right: '16px',
          zIndex: 10000,
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          width: '340px',
          pointerEvents: 'none',
        }}
      >
        {notifications.map(n => {
          const c = COLORS[n.type]
          return (
            <div
              key={n.id}
              className={n.exiting ? 'nc-item-exit' : 'nc-item-enter'}
              style={{
                background: '#111111',
                border: `1px solid ${c.border}`,
                borderLeft: `4px solid ${c.border}`,
                borderRadius: '4px',
                padding: '12px 14px',
                display: 'flex',
                gap: '10px',
                alignItems: 'flex-start',
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                pointerEvents: 'all',
              }}
            >
              {/* Icon */}
              <div
                style={{
                  flexShrink: 0,
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  background: c.iconBg,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '13px',
                  color: c.titleColor,
                  fontWeight: 700,
                  marginTop: '1px',
                }}
              >
                {c.icon}
              </div>

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '12px',
                    fontWeight: 700,
                    color: c.titleColor,
                    marginBottom: n.message ? '4px' : 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {n.title}
                </div>
                {n.message && (
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '11px',
                      color: '#888888',
                      lineHeight: '1.5',
                      wordBreak: 'break-word',
                    }}
                  >
                    {n.message}
                  </div>
                )}
              </div>

              {/* Close */}
              <button
                onClick={() => dismiss(n.id)}
                style={{
                  flexShrink: 0,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: '#555555',
                  fontSize: '14px',
                  lineHeight: 1,
                  padding: '2px 4px',
                  borderRadius: '2px',
                  marginTop: '-2px',
                }}
                aria-label="Kapat"
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
    </>
  )
}
