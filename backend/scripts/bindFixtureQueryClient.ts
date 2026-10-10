import type { PoolClient, QueryResult, QueryResultRow } from "pg"
import * as dbClient from "../db/client"

/**
 * Test-only: route db.query() through an explicit PoolClient for nested production
 * services that import query(). Does not change production db/client.ts.
 */
export async function withFixtureBoundQuery<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  const orig = dbClient.query
  const patched = (async <R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = []
  ): Promise<QueryResult<R>> => client.query<R>(text, params)) as typeof orig
  ;(dbClient as { query: typeof orig }).query = patched
  try {
    return await fn()
  } finally {
    ;(dbClient as { query: typeof orig }).query = orig
  }
}
