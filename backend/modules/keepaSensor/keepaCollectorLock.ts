import fs from "fs"
import path from "path"

export class CollectorLockError extends Error {
  constructor(message = "COLLECTOR_LOCK_HELD") {
    super(message)
    this.name = "CollectorLockError"
  }
}

export function collectorLockPath(dbPath: string): string {
  return `${dbPath}.lock`
}

export function readCollectorLockPid(dbPath: string): number | null {
  try {
    const raw = fs.readFileSync(collectorLockPath(dbPath), "utf8").trim()
    const pid = parseInt(raw, 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function collectorLockHeldByThisProcess(dbPath: string): boolean {
  return readCollectorLockPid(dbPath) === process.pid
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function acquireCollectorProcessLock(dbPath: string): { release: () => void } {
  const lockPath = collectorLockPath(dbPath)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  try {
    const fd = fs.openSync(lockPath, "wx")
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
    return {
      release: () => {
        try {
          fs.unlinkSync(lockPath)
        } catch {
          /* already gone */
        }
      },
    }
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code?: unknown }).code) : ""
    if (code === "EEXIST") {
      let existing = 0
      try {
        existing = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10) || 0
      } catch {
        existing = 0
      }
      if (existing === process.pid) {
        throw new CollectorLockError("COLLECTOR_LOCK_HELD")
      }
      if (existing && pidAlive(existing)) {
        throw new CollectorLockError("COLLECTOR_LOCK_HELD")
      }
      try {
        fs.unlinkSync(lockPath)
      } catch {
        throw new CollectorLockError("COLLECTOR_LOCK_HELD")
      }
      return acquireCollectorProcessLock(dbPath)
    }
    throw e
  }
}
