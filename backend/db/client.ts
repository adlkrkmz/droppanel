import { Pool, QueryResult, QueryResultRow } from "pg"

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

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  const client = await db.connect()

  try {
    return await client.query<T>(text, params)
  } finally {
    client.release()
  }
}

export async function closeDbPool(): Promise<void> {
  await db.end()
}
