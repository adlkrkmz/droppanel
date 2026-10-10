"use client"

import AdminGate from "@/components/app/AdminGate"
import AmazonWorkerPage from "@/app/(dashboard)/admin/platform/amazon-worker/page"

export default function AppAdminAmazonWorkerPage() {
  return (
    <AdminGate>
      <AmazonWorkerPage />
    </AdminGate>
  )
}
