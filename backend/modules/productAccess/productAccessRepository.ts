// ----------------------------------------------------------------
// productAccessRepository.ts — user_product_access rows
// ----------------------------------------------------------------

import { query } from "../../db/client"

export type ProductId = "EBAY"
export type ProductAccessStatus = "ACTIVE" | "TRIAL" | "DISABLED" | "PENDING"

export type ProductAccessRow = {
  product: ProductId
  status:  ProductAccessStatus
}

function mapRow(r: Record<string, unknown>): ProductAccessRow {
  return {
    product: r.product as ProductId,
    status:  r.status as ProductAccessStatus,
  }
}

export async function insertPendingProductAccess(
  userId:  string,
  product: ProductId
): Promise<void> {
  try {
    await query(
      `INSERT INTO user_product_access (user_id, product, status)
       VALUES ($1::uuid, $2, 'PENDING')
       ON CONFLICT (user_id, product)
       DO UPDATE SET status = 'PENDING', updated_at = NOW()`,
      [userId, product]
    )
  } catch (e) {
    console.warn("[ProductAccess] insertPendingProductAccess skipped:", e)
  }
}

export async function activateProductAccessForUser(
  userId:           string,
  requestedProduct: ProductId | null
): Promise<void> {
  try {
    if (requestedProduct) {
      await query(
        `INSERT INTO user_product_access (user_id, product, status)
         VALUES ($1::uuid, $2, 'ACTIVE')
         ON CONFLICT (user_id, product)
         DO UPDATE SET status = 'ACTIVE', updated_at = NOW()`,
        [userId, requestedProduct]
      )
      return
    }

    await query(
      `UPDATE user_product_access
       SET status = 'ACTIVE', updated_at = NOW()
       WHERE user_id = $1::uuid AND status = 'PENDING'`,
      [userId]
    )
  } catch (e) {
    console.warn("[ProductAccess] activateProductAccessForUser skipped:", e)
  }
}

/** Rows usable for dashboard routing (ACTIVE or TRIAL). */
export async function listUsableProductAccessForUser(
  userId: string
): Promise<ProductAccessRow[]> {
  try {
    const res = await query<{ product: string; status: string }>(
      `SELECT product, status
       FROM user_product_access
       WHERE user_id = $1::uuid AND product = 'EBAY'
         AND status IN ('ACTIVE', 'TRIAL')
       ORDER BY product ASC`,
      [userId]
    )
    return res.rows.map((r) => mapRow(r as Record<string, unknown>))
  } catch {
    return []
  }
}

export async function getRequestedProductForUser(
  userId: string
): Promise<ProductId | null> {
  const res = await query<{ requested_product: string | null }>(
    `SELECT requested_product FROM users WHERE id = $1::uuid LIMIT 1`,
    [userId]
  )
  const raw = res.rows[0]?.requested_product
  if (raw === "EBAY") return raw
  return null
}
