"use client"

import AdminGate from "@/components/app/AdminGate"
import AdminPendingUsersPage from "@/app/(dashboard)/admin/users/pending/page"

export default function AppAdminUsersPage() {
  return (
    <AdminGate>
      <AdminPendingUsersPage />
    </AdminGate>
  )
}
