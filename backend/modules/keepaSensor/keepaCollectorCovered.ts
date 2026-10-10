export function shouldMarkCoveredBySnapshot(input: {
  createdAt: string
  snapshotStartedAt: string
  status: string
}): boolean {
  if (input.status !== "PENDING") return false
  const created = Date.parse(input.createdAt)
  const started = Date.parse(input.snapshotStartedAt)
  if (!Number.isFinite(created) || !Number.isFinite(started)) return false
  return created < started
}
