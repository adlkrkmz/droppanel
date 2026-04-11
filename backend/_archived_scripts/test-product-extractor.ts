import "dotenv/config"
import { closeDbPool } from "./db/client"
import { extractAndSaveProduct } from "./modules/productExtractor/productExtractorService"
import type {
  ProductExtractorRequest,
  ProductExtractorResponse,
} from "./modules/productExtractor/productExtractorTypes"

// ─────────────────────────────────────────────────────────────
// test-product-extractor.ts
// Chrome Extension backend'i için productExtractor servisini test eder.
//
// Çalıştırma:
//   cd "C:\\Users\\pc\\Desktop\\ebay listing\\backend"
//   npx ts-node test-product-extractor.ts B071251380
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const workspaceId = process.env.WORKSPACE_ID
  if (!workspaceId) {
    console.error("[Test] WORKSPACE_ID is not defined in .env")
    process.exit(1)
  }

  const asin = process.argv[2] ?? "B071251380"

  const payload: ProductExtractorRequest = {
    asin,
    title:           "Sample Amazon Product Title",
    brand:           "Sample Brand",
    price:           19.99,
    currency:        "USD",
    images:          ["https://images-na.ssl-images-amazon.com/images/I/sample1.jpg"],
    bullets:         ["Sample bullet 1", "Sample bullet 2"],
    description:     "Long sample description from Amazon product page.",
    specs:           { Color: "Black", Size: "Medium" },
    rating:          4.5,
    reviews:         1234,
    bsr:             1024,
    category:        "Sample Category",
    isPrime:         true,
    isFreeShipping:  true,
  }

  console.log("═".repeat(64))
  console.log("[Test] productExtractor — extractAndSaveProduct")
  console.log("═".repeat(64))
  console.log(`workspaceId : ${workspaceId}`)
  console.log(`asin        : ${payload.asin}`)
  console.log("")

  try {
    const result: ProductExtractorResponse = await extractAndSaveProduct(workspaceId, payload)
    console.log("[Result]")
    console.dir(result, { depth: null })
  } catch (err) {
    console.error("[Test] Failed:", err instanceof Error ? err.message : err)
  } finally {
    await closeDbPool()
  }
}

main().catch(err => {
  console.error("[Test] Unhandled error:", err instanceof Error ? err.message : err)
  process.exit(1)
})

