'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { fetchGoogleConfig, postGoogleCredential } from '@/lib/userAuthClient'

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            client_id: string
            nonce: string
            callback: (response: { credential: string }) => void
          }) => void
          renderButton: (element: HTMLElement, options: Record<string, unknown>) => void
        }
      }
    }
  }
}

/**
 * Mount host DOM first, then paint official GIS button.
 * Regression root cause: early `return null` before refs existed → renderButton no-op.
 */
export default function GoogleSignInButton({
  compact = false,
  divider = true,
  orLabel = 'or',
}: {
  compact?: boolean
  divider?: boolean
  orLabel?: string
}) {
  const elementRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const lastWidthRef = useRef(0)
  const router = useRouter()
  const [config, setConfig] = useState<{ clientId: string; nonce: string } | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const cfg = await fetchGoogleConfig()
        if (cancelled) return
        if (!cfg?.clientId || !cfg?.nonce) {
          setUnavailable(true)
          return
        }
        setConfig({ clientId: cfg.clientId, nonce: cfg.nonce })
      } catch {
        if (!cancelled) setUnavailable(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!config) return
    let cancelled = false
    let resizeObserver: ResizeObserver | null = null
    let debounce: ReturnType<typeof setTimeout> | null = null

    const measureWidth = () => {
      const raw =
        hostRef.current?.clientWidth ||
        elementRef.current?.parentElement?.clientWidth ||
        0
      return Math.max(240, Math.min(400, Math.floor(raw || 320)))
    }

    const paint = (force = false) => {
      if (cancelled || !elementRef.current || !window.google?.accounts?.id) return
      const width = measureWidth()
      if (!force && Math.abs(width - lastWidthRef.current) < 12 && elementRef.current.querySelector('iframe')) {
        return
      }
      lastWidthRef.current = width
      elementRef.current.innerHTML = ''
      window.google.accounts.id.initialize({
        client_id: config.clientId,
        nonce: config.nonce,
        callback: async ({ credential }) => {
          try {
            const result = await postGoogleCredential(credential)
            if (result.blocked) {
              if (result.status === 'pending_approval') router.push('/pending-approval')
              else setError(result.message)
              return
            }
            router.push('/app/dashboard')
            router.refresh()
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Google sign-in failed')
          }
        },
      })
      window.google.accounts.id.renderButton(elementRef.current, {
        theme: 'filled_black',
        size: 'large',
        text: 'continue_with',
        shape: 'rectangular',
        width,
      })
    }

    const boot = () => {
      if (cancelled) return
      if (window.google?.accounts?.id) {
        requestAnimationFrame(() => paint(true))
        return
      }
      const existing = document.querySelector('script[data-lj-gsi="1"]') as HTMLScriptElement | null
      const onLoad = () => {
        if (!cancelled) requestAnimationFrame(() => paint(true))
      }
      if (existing) {
        existing.addEventListener('load', onLoad)
        if (window.google?.accounts?.id) onLoad()
        return
      }
      const script = document.createElement('script')
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.defer = true
      script.dataset.ljGsi = '1'
      script.onload = onLoad
      document.head.appendChild(script)
    }

    boot()

    if (typeof ResizeObserver !== 'undefined' && hostRef.current) {
      resizeObserver = new ResizeObserver(() => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => paint(false), 120)
      })
      resizeObserver.observe(hostRef.current)
    }

    return () => {
      cancelled = true
      if (debounce) clearTimeout(debounce)
      resizeObserver?.disconnect()
    }
  }, [config, router])

  if (unavailable) return null

  const dividerEl = divider ? (
    <div
      className="lj-auth__divider"
      role="separator"
      style={
        compact
          ? undefined
          : {
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              margin: '12px 0',
              color: 'var(--dim)',
              fontSize: 12,
              width: '100%',
            }
      }
    >
      {!compact && <span style={{ height: 1, background: 'var(--border)', flex: 1 }} />}
      <span>{orLabel}</span>
      {!compact && <span style={{ height: 1, background: 'var(--border)', flex: 1 }} />}
    </div>
  ) : null

  return (
    <div
      className={compact ? 'lj-auth__google-wrap' : undefined}
      style={compact ? undefined : { marginTop: 18, width: '100%' }}
    >
      {dividerEl}
      <div
        ref={hostRef}
        className={compact ? 'lj-auth__google-host' : undefined}
        style={compact ? undefined : { width: '100%', minHeight: 40 }}
      >
        <div ref={elementRef} style={{ width: '100%', minHeight: 40 }} />
      </div>
      {error && (
        <p
          className={compact ? 'lj-auth__google-error' : undefined}
          style={compact ? undefined : { color: '#f87171', fontSize: 13, marginTop: 8 }}
        >
          {error}
        </p>
      )}
    </div>
  )
}
