import fs from "fs"
import path from "path"
import dotenv from "dotenv"
import { Pool } from "pg"

dotenv.config({ path: path.join(__dirname, "../.env") })

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error("DATABASE_URL is not defined")
  const sql = fs.readFileSync(
    path.join(__dirname, "../migrations/087_delivery_proof_and_cs_messaging.sql"),
    "utf8"
  )
  const pool = new Pool({ connectionString: dbUrl })
  await pool.query(sql)
  await pool.end()
  console.log("APPLIED migrations/087_delivery_proof_and_cs_messaging.sql")
}

void main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
