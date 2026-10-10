import { NextRequest } from "next/server"
import { appAdminBackendFetch } from "@/lib/adminBffAuth"

async function proxy(request: NextRequest, method: string, suffix = ""): Promise<Response> {
  const body = method === "GET" ? undefined : await request.text()
  return appAdminBackendFetch(request, `/admin/platform/amazon-worker${suffix}`, {
    method,
    body: body && body.length > 0 ? body : undefined,
  })
}

export async function GET(request: NextRequest) {
  return proxy(request, "GET")
}

export async function PUT(request: NextRequest) {
  return proxy(request, "PUT")
}
