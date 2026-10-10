import "dotenv/config"
import fs from "fs"
import path from "path"
import { Pool } from "pg"

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error("DATABASE_URL is not defined")
  const host = new URL(dbUrl).hostname.toLowerCase()
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && process.env.ALLOW_GLOBAL_KEEPA_PHASE11 !== "1") {
    throw new Error("Refusing migration: not local")
  }
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/057_stock_guard_v2_activity.sql"), "utf8")
  const pool = new Pool({ connectionString: dbUrl })
  await pool.query(sql)
  await pool.end()
  console.log("APPLIED migrations/057_stock_guard_v2_activity.sql")
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})
