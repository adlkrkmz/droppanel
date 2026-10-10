import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg"

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error("DATABASE_URL is not defined")
}

export const db = new Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
})

type PoolSnapshot = { total: number; idle: number; waiting: number; max: number }
export type DbIncidentError = { timestamp: string; message: string; className: string }

// Deliberately in-process and bounded: this is incident correlation telemetry,
// not a second logging or persistence subsystem.
const recentIncidentErrors: DbIncidentError[] = []
const DB_INCIDENT_BUFFER_LIMIT = 50

function poolSnapshot(): PoolSnapshot {
  return { total: db.totalCount, idle: db.idleCount, waiting: db.waitingCount, max: 20 }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function processSnapshot(): { uptimeSeconds: number; rssBytes: number; heapUsedBytes: number } {
  const memory = process.memoryUsage()
  return {
    uptimeSeconds: Math.round(process.uptime()),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  }
}

function recordConnectionIncident(error: unknown): void {
  if (!isConnectionError(error)) return
  recentIncidentErrors.push({
    timestamp: new Date().toISOString(),
    message: errorMessage(error).slice(0, 500),
    className: error instanceof Error ? error.name : typeof error,
  })
  if (recentIncidentErrors.length > DB_INCIDENT_BUFFER_LIMIT) recentIncidentErrors.splice(0, recentIncidentErrors.length - DB_INCIDENT_BUFFER_LIMIT)
}

/** Recent acquire/socket incidents for read-only operational correlation. */
export function countRecentDbConnectionErrors(since: Date): number {
  const start = since.getTime()
  return recentIncidentErrors.filter(event => new Date(event.timestamp).getTime() >= start).length
}

export function isConnectionError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : ""
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|57P01|57P02|57P03)$/.test(code) ||
    /connection terminated|connection timeout|timeout expired|server closed the connection|socket/i.test(errorMessage(error))
}

export async function acquireClient(operation: string): Promise<PoolClient> {
  const startedAt = Date.now()
  try {
    const client = await db.connect()
    const waitMs = Date.now() - startedAt
    if (waitMs >= 250) console.warn("[db] client acquired slowly", { operation, waitMs, ...poolSnapshot() })
    return client
  } catch (error) {
    recordConnectionIncident(error)
    console.error("[db] client acquire failed", {
      timestamp: new Date().toISOString(),
      operation,
      elapsedMs: Date.now() - startedAt,
      error: errorMessage(error),
      connectionError: isConnectionError(error),
      ...poolSnapshot(),
      ...processSnapshot(),
    })
    throw error
  }
}

db.on("error", err => {
  recordConnectionIncident(err)
  console.error("[db] idle client error", {
    timestamp: new Date().toISOString(),
    error: errorMessage(err),
    connectionError: isConnectionError(err),
    ...poolSnapshot(),
    ...processSnapshot(),
  })
})

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  const client = await acquireClient("query")
  let failure: unknown = null

  try {
    return await client.query<T>(text, params)
  } catch (error) {
    failure = error
    throw error
  } finally {
    client.release(isConnectionError(failure) ? asError(failure) : undefined)
  }
}

/** Run a read query with PostgreSQL JIT disabled for this pooled session only. */
export async function queryWithoutJit<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  const client = await acquireClient("queryWithoutJit")
  let failure: unknown = null
  let resetFailure: unknown = null
  let releaseFailure: Error | undefined

  try {
    await client.query("SET jit = off")
    return await client.query<T>(text, params)
  } catch (error) {
    failure = error
    if (isConnectionError(error)) releaseFailure = asError(error)
    throw error
  } finally {
    if (!isConnectionError(failure)) {
      try {
        await client.query("RESET jit")
      } catch (error) {
        resetFailure = error
        if (isConnectionError(error)) releaseFailure = asError(error)
      }
    }
    client.release(releaseFailure)
    if (resetFailure && !failure) throw resetFailure
  }
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await acquireClient("transaction")
  let failure: unknown = null

  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (e) {
    failure = e
    try {
      await client.query("ROLLBACK")
    } catch (rollbackError) {
      if (isConnectionError(rollbackError)) failure = rollbackError
      /* rollback is best-effort */
    }
    throw e
  } finally {
    client.release(isConnectionError(failure) ? asError(failure) : undefined)
  }
}

export async function closeDbPool(): Promise<void> {
  await db.end()
}
