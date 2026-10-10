import { NextRequest } from "next/server"
import { appAdminBackendFetch } from "@/lib/adminBffAuth"

type Ctx = { params: Promise<{ userId: string; action: string }> }

export async function POST(request: NextRequest, ctx: Ctx) {
  const { userId, action } = await ctx.params
  const allowed = new Set(["approve", "reject", "suspend"])
  if (!allowed.has(action)) {
    return Response.json({ error: "Invalid action" }, { status: 400 })
  }

  return appAdminBackendFetch(
    request,
    `/admin/users/${encodeURIComponent(userId)}/${action}`,
    { method: "POST" }
  )
}
