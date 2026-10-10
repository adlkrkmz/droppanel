import { NextRequest } from "next/server"
import { appAdminBackendFetch } from "@/lib/adminBffAuth"

export async function POST(request: NextRequest) {
  return appAdminBackendFetch(request, "/admin/platform/amazon-worker/resume", {
    method: "POST",
  })
}
