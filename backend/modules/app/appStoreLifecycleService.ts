// ----------------------------------------------------------------
// appStoreLifecycleService.ts — soft-remove store (ListJetGo only)
// ----------------------------------------------------------------

import { insertAuditLog } from "../auth/authRepository"
import { updateStoreStatus } from "../stores/storeRepository"
import type { OwnedStore } from "./appOwnership"
import { AppHttpError } from "./appTypes"

/**
 * Soft-deactivate a store for the authenticated workspace.
 * Does NOT touch eBay, catalog rows, orders, alerts, or oauth credential rows.
 * Inactive stores are already excluded from sync / Keepa / token refresh / Stock Guard
 * via status = 'active' filters.
 */
export async function appRemoveStore(input: {
  workspaceId: string
  actorUserId: string
  store:       OwnedStore
  confirm:     boolean
}): Promise<{ ok: true; storeId: number; storeCode: string; status: string }> {
  if (input.confirm !== true) {
    throw new AppHttpError(400, "confirm must be true")
  }

  const updated = await updateStoreStatus(input.store.id, "inactive")
  if (!updated) {
    throw new AppHttpError(404, "Store not found")
  }

  await insertAuditLog({
    actorUserId: input.actorUserId,
    action:      "app.store.remove",
    targetType:  "store",
    targetId:    String(input.store.id),
    metadata:    {
      storeId:   input.store.id,
      storeCode: input.store.storeCode,
      name:      input.store.name,
      status:    "inactive",
    },
  }).catch(() => {})

  return {
    ok:        true,
    storeId:   input.store.id,
    storeCode: input.store.storeCode,
    status:    "inactive",
  }
}
