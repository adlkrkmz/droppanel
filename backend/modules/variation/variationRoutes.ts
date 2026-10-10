import type { AdminRequest } from '../admin/adminTypes'
import { extractVariationProduct } from './variationExtractService'
import { publishVariationListing } from './variationPublishService'
import { generateVariationListing } from './variationAiService'
import { db as pool } from '../../db/client'
import type { VariationCaptureData } from './variationTypes'

function getWorkspaceId(): string {
  const id = process.env.WORKSPACE_ID
  if (!id) throw new Error('WORKSPACE_ID is not defined')
  return id
}

export async function handlePostVariationExtract(req: AdminRequest): Promise<{ status: number; body: unknown }> {
  try {
    const data = req.body as VariationCaptureData
    if (!data.asin || !data.variations?.length) {
      return { status: 400, body: { error: 'asin ve variations zorunlu' } }
    }
    const workspaceId = getWorkspaceId()
    const result = await extractVariationProduct(data, workspaceId)
    return { status: 200, body: { ok: true, ...result } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { status: 500, body: { error: msg } }
  }
}

export async function handlePostVariationGenerateAi(req: AdminRequest): Promise<{ status: number; body: unknown }> {
  try {
    const { variationProductId } = req.body as { variationProductId: number }
    if (!variationProductId) {
      return { status: 400, body: { error: 'variationProductId zorunlu' } }
    }
    await generateVariationListing(variationProductId)
    return { status: 200, body: { ok: true } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { status: 500, body: { error: msg } }
  }
}

export async function handlePostVariationPublish(req: AdminRequest): Promise<{ status: number; body: unknown }> {
  try {
    const { variationProductId, simulationMode } = req.body as {
      variationProductId: number
      simulationMode?: boolean
    }
    if (!variationProductId) {
      return { status: 400, body: { error: 'variationProductId zorunlu' } }
    }
    const result = await publishVariationListing(variationProductId, simulationMode ?? false)
    return { status: 200, body: result }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { status: 500, body: { error: msg } }
  }
}

export async function handleGetVariationList(req: AdminRequest): Promise<{ status: number; body: unknown }> {
  try {
    const workspaceId = getWorkspaceId()
    const { status, limit = '50', offset = '0' } = req.query as Record<string, string>

    let query = `SELECT * FROM variation_products WHERE workspace_id = $1`
    const params: (string | number)[] = [workspaceId]

    if (status) {
      params.push(status)
      query += ` AND status = $${params.length}`
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(parseInt(limit), parseInt(offset))

    const result = await pool.query(query, params)
    return { status: 200, body: { ok: true, rows: result.rows, total: result.rowCount } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { status: 500, body: { error: msg } }
  }
}
