"use client"

import { useEffect, useRef } from "react"

type UseFocusRefetchOptions = {
  minIntervalMs?: number
  enabled?: boolean
}

export function useFocusRefetch(
  callback: () => void | Promise<void>,
  options: UseFocusRefetchOptions = {}
) {
  const { minIntervalMs = 10000, enabled = true } = options
  const lastRefetchAtRef = useRef(0)
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    if (!enabled) return

    function maybeRefetch() {
      if (document.visibilityState !== "visible") return
      const now = Date.now()
      if (now - lastRefetchAtRef.current < minIntervalMs) return
      lastRefetchAtRef.current = now
      void callbackRef.current()
    }

    window.addEventListener("focus", maybeRefetch)
    document.addEventListener("visibilitychange", maybeRefetch)
    return () => {
      window.removeEventListener("focus", maybeRefetch)
      document.removeEventListener("visibilitychange", maybeRefetch)
    }
  }, [enabled, minIntervalMs])
}
