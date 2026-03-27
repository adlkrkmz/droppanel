import "dotenv/config"
import { startServer } from "./modules/http/httpServer"

const PORT = parseInt(process.env.PORT ?? "4000", 10)

const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)

startServer({
  port:        PORT,
  corsOrigins: CORS_ORIGINS,
})
