import { assignPoolEntryToStore, fetchSchedulerCandidates } from "../pool/poolRepository"
import { listStoresByWorkspace, getStoreCapacity } from "../stores/storeRepository"

export type AssignmentResultRow = {
  poolId: number
  asinRegistryId: number
  asin: string
  assignedStoreId: number
  assignedStoreCode: string
  assignedStoreName: string
}

type StoreWithCapacity = {
  id: number
  name: string
  store_code: string
  status: string
  remaining_capacity: number
}

function buildRoundRobinStoreOrder(stores: StoreWithCapacity[]): StoreWithCapacity[] {
  return stores.filter((store) => store.remaining_capacity > 0)
}

export async function assignValidatedPoolEntriesToStores(
  workspaceId: string,
  limit = 100
): Promise<AssignmentResultRow[]> {
  const stores = await listStoresByWorkspace(workspaceId)

  const activeStores = stores.filter((store: any) => store.status === "active")

  if (activeStores.length === 0) {
    return []
  }

  const capacityRows = await Promise.all(
    activeStores.map((store: any) => getStoreCapacity(store.id))
  )

  const storesWithCapacity: StoreWithCapacity[] = capacityRows
    .filter((row: any) => row && row.status === "active")
    .map((row: any) => ({
      id: row.id,
      name: row.name,
      store_code: row.store_code,
      status: row.status,
      remaining_capacity: Number(row.remaining_capacity ?? 0)
    }))
    .filter((row) => row.remaining_capacity > 0)

  if (storesWithCapacity.length === 0) {
    return []
  }

  const schedulerCandidates = await fetchSchedulerCandidates(workspaceId, limit)

  const eligibleCandidates = schedulerCandidates.filter(
    (row: any) =>
      row.status === "ready" &&
      row.pipeline_stage === "validated" &&
      (row.assigned_store_id === null || row.assigned_store_id === undefined)
  )

  if (eligibleCandidates.length === 0) {
    return []
  }

  const roundRobinStores = buildRoundRobinStoreOrder(storesWithCapacity)

  if (roundRobinStores.length === 0) {
    return []
  }

  const assignments: AssignmentResultRow[] = []
  let storePointer = 0

  for (const candidate of eligibleCandidates) {
    let attempts = 0
    let selectedStore: StoreWithCapacity | null = null

    while (attempts < roundRobinStores.length) {
      const store = roundRobinStores[storePointer % roundRobinStores.length]
      storePointer += 1
      attempts += 1

      if (store.remaining_capacity > 0) {
        selectedStore = store
        break
      }
    }

    if (!selectedStore) {
      break
    }

    await assignPoolEntryToStore(candidate.id, selectedStore.id)

    selectedStore.remaining_capacity -= 1

    assignments.push({
      poolId: Number(candidate.id),
      asinRegistryId: Number(candidate.asin_registry_id),
      asin: String(candidate.asin),
      assignedStoreId: selectedStore.id,
      assignedStoreCode: selectedStore.store_code,
      assignedStoreName: selectedStore.name
    })

    const hasAnyCapacityLeft = roundRobinStores.some(
      (store) => store.remaining_capacity > 0
    )

    if (!hasAnyCapacityLeft) {
      break
    }
  }

  return assignments
}