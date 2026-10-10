// ----------------------------------------------------------------
// appOrdersService.ts — user-scoped orders (DB list + eBay sync)
//
// Reuses ordersRepository / ordersSyncService under JWT workspace
// + owned store — same data path as legacy /admin/orders.
// ----------------------------------------------------------------

import {
  buildAssistPacket,
  getOrderDetail,
  listOrdersFromDb,
  setManualAsin,
  updateManualFields,
  type OrderStore,
} from "../orders/ordersRepository"
import { refreshOrderEarnings } from "../orders/ordersEarningsService"
import { enrichEbayTrackingIfMissing } from "../orders/orderTrackingService"
import {
  syncOrdersForAllStores,
  syncOrdersForStore,
} from "../orders/ordersSyncService"
import type {
  AssistedOrderPacket,
  OrderDetail,
  OrderListItem,
  OrderManualUpdateInput,
} from "../orders/ordersTypes"
import { OrdersHttpError } from "../orders/ordersTypes"
import type { OwnedStore } from "./appOwnership"
import { AppHttpError } from "./appTypes"
import type {
  AppOrderItem,
  AppOrdersResponse,
  AppOrdersStoreError,
} from "./appTypes"

function toAppOrderItem(row: OrderListItem): AppOrderItem {
  return {
    id:                   row.id,
    orderId:              row.orderId,
    storeCode:            row.storeCode,
    storeName:            row.storeName,
    creationDate:         row.creationDate,
    buyerUsername:        row.buyerUsername,
    productTitle:         row.productTitle,
    imageUrl:             row.imageUrl,
    quantity:             row.quantity,
    total:                row.total,
    currency:             row.currency,
    status:               row.status,
    operationStatus:      row.operationStatus,
    operationStatusLabel: row.operationStatusLabel,
  }
}

function toAppOrdersResponse(
  allStores: boolean,
  storeCode: string | null,
  orders: OrderListItem[],
  errors: AppOrdersStoreError[]
): AppOrdersResponse {
  return {
    ok:        true,
    allStores,
    storeCode,
    orders:    orders.map(toAppOrderItem),
    errors,
  }
}

function ownedToOrderStore(store: OwnedStore): OrderStore {
  return {
    id:        store.id,
    storeCode: store.storeCode,
    name:      store.name,
  }
}

/** List from DB only (fast). Refresh uses syncAppOrders*. */
export async function getAppOrdersForStore(
  workspaceId: string,
  store:       OwnedStore
): Promise<AppOrdersResponse> {
  const orders = await listOrdersFromDb(workspaceId, {
    storeId:   store.id,
    allStores: false,
  })
  return toAppOrdersResponse(false, store.storeCode, orders, [])
}

export async function getAppOrdersForAllStores(
  workspaceId: string
): Promise<AppOrdersResponse> {
  const orders = await listOrdersFromDb(workspaceId, { allStores: true })
  return toAppOrdersResponse(true, null, orders, [])
}

export async function syncAppOrdersForStore(
  workspaceId: string,
  store:       OwnedStore
): Promise<AppOrdersResponse> {
  const outcome = await syncOrdersForStore(workspaceId, ownedToOrderStore(store))
  const errors: AppOrdersStoreError[] = outcome.error
    ? [{
        storeCode: outcome.error.storeCode,
        storeName: outcome.error.storeName,
        message:   outcome.error.message,
      }]
    : []
  const orders = await listOrdersFromDb(workspaceId, {
    storeId:   store.id,
    allStores: false,
  })
  return toAppOrdersResponse(false, store.storeCode, orders, errors)
}

export async function syncAppOrdersForAllStores(
  workspaceId: string
): Promise<AppOrdersResponse> {
  const { errors: syncErrors } = await syncOrdersForAllStores(workspaceId)
  const errors: AppOrdersStoreError[] = syncErrors.map((e) => ({
    storeCode: e.storeCode,
    storeName: e.storeName,
    message:   e.message,
  }))
  const orders = await listOrdersFromDb(workspaceId, { allStores: true })
  return toAppOrdersResponse(true, null, orders, errors)
}

export async function getAppOrderDetail(
  workspaceId: string,
  orderId:     number
): Promise<OrderDetail> {
  const existing = await getOrderDetail(workspaceId, orderId)
  if (!existing) throw new AppHttpError(404, "Sipariş bulunamadı")
  await enrichEbayTrackingIfMissing({ workspaceId, orderPk: orderId }).catch(() => undefined)
  const detail = await getOrderDetail(workspaceId, orderId)
  if (!detail) throw new AppHttpError(404, "Sipariş bulunamadı")
  return detail
}

export async function patchAppOrderManual(
  workspaceId: string,
  orderId:     number,
  input:       OrderManualUpdateInput
): Promise<OrderDetail> {
  try {
    const detail = await updateManualFields(workspaceId, orderId, input)
    if (!detail) throw new AppHttpError(404, "Sipariş bulunamadı")
    return detail
  } catch (e) {
    if (e instanceof OrdersHttpError) throw new AppHttpError(e.status, e.message)
    throw e
  }
}

export async function refreshAppOrderEarnings(
  workspaceId: string,
  orderId:     number
): Promise<OrderDetail> {
  const detail = await refreshOrderEarnings(workspaceId, orderId)
  if (!detail) throw new AppHttpError(404, "Sipariş bulunamadı")
  return detail
}

export async function getAppOrderAssist(
  workspaceId: string,
  orderId:     number,
  autoRun:     boolean
): Promise<AssistedOrderPacket> {
  try {
    return await buildAssistPacket(workspaceId, orderId, autoRun)
  } catch (e) {
    if (e instanceof OrdersHttpError) throw new AppHttpError(e.status, e.message)
    throw e
  }
}

export async function patchAppOrderAssistAsin(
  workspaceId: string,
  orderId:     number,
  asin:        string
): Promise<{ asin: string }> {
  try {
    return await setManualAsin(workspaceId, orderId, asin)
  } catch (e) {
    if (e instanceof OrdersHttpError) throw new AppHttpError(e.status, e.message)
    throw e
  }
}
