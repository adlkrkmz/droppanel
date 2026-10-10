"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

export default function KeepaMonitorRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/app/admin/amazon-worker")
  }, [router])
  return <p style={{ color: "var(--dim)", padding: 24 }}>Amazon Kaynak Kontrol Merkezi’ne yönlendiriliyor…</p>
}
