import "dotenv/config"
import fs from "fs"
import path from "path"
import { Pool } from "pg"

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error("DATABASE_URL is not defined")
  const host = new URL(dbUrl).hostname.toLowerCase()
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Refusing migration: not local")
  }
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/059_keepa_monitor_telemetry.sql"), "utf8")
  const pool = new Pool({ connectionString: dbUrl })
  await pool.query(sql)
  await pool.end()
  console.log("APPLIED migrations/059_keepa_monitor_telemetry.sql")
}

void main().catch(e => {
  console.error(e)
  process.exit(1)
})
