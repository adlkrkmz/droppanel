"use client"

import AdminGate from "@/components/app/AdminGate"
import { useRouter } from "next/navigation"
import { useEffect } from "react"

function Redirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/app/admin/amazon-worker")
  }, [router])
  return <p style={{ color: "var(--dim)", padding: 24 }}>Amazon Kaynak Kontrol Merkezi’ne yönlendiriliyor…</p>
}

export default function AppAdminKeepaPage() {
  return (
    <AdminGate>
      <Redirect />
    </AdminGate>
  )
}
