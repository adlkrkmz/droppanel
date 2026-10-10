"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { fetchAuthMe } from "@/lib/userAuthClient"

/**
 * Client-side gate for /app/admin/* pages.
 * Backend/BFF still enforce admin authorization; this only improves UX.
 */
export default function AdminGate({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [allowed, setAllowed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const me = await fetchAuthMe()
      if (cancelled) return
      if (!me) {
        router.replace("/app/login")
        return
      }
      if (me.role !== "admin" || me.approvalStatus !== "active") {
        router.replace("/app/dashboard")
        return
      }
      setAllowed(true)
    })()
    return () => {
      cancelled = true
    }
  }, [router])

  if (!allowed) {
    return (
      <p style={{ color: "var(--dim)", fontSize: 14, padding: 24 }}>
        Checking admin access…
      </p>
    )
  }

  return <>{children}</>
}
