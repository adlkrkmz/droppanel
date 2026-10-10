import { NextRequest } from "next/server"
import { appAdminBackendFetch } from "@/lib/adminBffAuth"

export async function GET(request: NextRequest) {
  return appAdminBackendFetch(request, "/admin/users/pending")
}
