import "dotenv/config"
import { runKeepaCollector } from "./modules/keepaSensor/keepaCollectorLoop"
import { KEEPA_COLLECTOR_VERSION } from "./modules/keepaSensor/keepaCollectorVersion"

console.log(`[keepa-collector] version ${KEEPA_COLLECTOR_VERSION}`)
void runKeepaCollector().then(result => {
  process.exit(result.exitCode)
})
