import "dotenv/config"
import { createAsinRegistryEntry } from "./modules/registry/registryRepository"

async function run() {
  const workspaceId = "00000000-0000-0000-0000-000000000001"

  const result = await createAsinRegistryEntry({
    workspaceId,
    asin: "B0TEST12345",
    brand: "TestBrand",
    title: "Test Product"
  })

  console.log("RESULT:", result)
}

run().catch(err => {
  console.error(err)
})