// ----------------------------------------------------------------
// appListingsImportMatchService.ts — user-scoped ASIN match (Phase 3I-E)
// ----------------------------------------------------------------

import { insertAuditLog } from "../auth/authRepository"
import { importMatchListings } from "../listings/listingsImportService"
import type { ImportMatchRequest } from "../listings/listingsImportTypes"
import type { OwnedStore } from "./appOwnership"
import type { AppImportMatchResponse, AppImportMatchRowInput } from "./appTypes"
import { AppHttpError } from "./appTypes"

const MAX_ROWS = 500

function mapImportMatchError(e: unknown): AppHttpError {
  const msg = e instanceof Error ? e.message : String(e)

  if (/active store not found/i.test(msg)) {
    return new AppHttpError(404, "Store not found")
  }
  if (/storeCode is required/i.test(msg)) {
    return new AppHttpError(400, msg)
  }

  return new AppHttpError(500, msg.length > 160 ? "Import match failed" : msg)
}

export async function appImportMatchListings(input: {
  workspaceId: string
  actorUserId: string
  store:       OwnedStore
  rows:        AppImportMatchRowInput[]
}): Promise<AppImportMatchResponse> {
  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    throw new AppHttpError(400, "rows must be a non-empty array")
  }
  if (input.rows.length > MAX_ROWS) {
    throw new AppHttpError(400, "Too many rows")
  }

  const req: ImportMatchRequest = {
    storeCode: input.store.storeCode,
    rows: input.rows.map(r => ({
      ebayItemId: String(r.ebayItemId ?? "").trim(),
      asin:       String(r.asin ?? "").trim(),
    })),
  }

  try {
    const result = await importMatchListings(input.workspaceId, req)
    const s = result.summary

    const skipped = s.alreadyExists + s.duplicate
    const failed  = s.failed + s.invalidAsin + s.ebayNotFound + s.storeConflict

    await insertAuditLog({
      actorUserId: input.actorUserId,
      action:      "app.listings.import_match",
      targetType:  "store",
      targetId:    input.store.storeCode,
      metadata:    {
        storeId: input.store.id,
        total:   s.total,
        matched: s.matched,
        skipped,
        failed,
      },
    })

    return {
      ok:        true,
      storeCode: input.store.storeCode,
      total:     s.total,
      matched:   s.matched,
      skipped,
      failed,
      summary:   s,
      results: result.results.map(r => ({
        ebayItemId: r.ebayItemId,
        asin:       r.asin,
        status:     r.status,
        message:    r.message,
      })),
    }
  } catch (e) {
    const httpErr = e instanceof AppHttpError ? e : mapImportMatchError(e)

    await insertAuditLog({
      actorUserId: input.actorUserId,
      action:      "app.listings.import_match.failed",
      targetType:  "store",
      targetId:    input.store.storeCode,
      metadata:    {
        storeId: input.store.id,
        status:  httpErr.status,
      },
    }).catch(() => {})

    throw httpErr
  }
}
