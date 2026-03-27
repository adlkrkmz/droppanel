import "dotenv/config"
import { closeDbPool } from "./db/client"
import { generateAiListing } from "./modules/aiListing/aiListingService"
import type { AiListingInput, AiListingOutput } from "./modules/aiListing/aiListingTypes"

// ─────────────────────────────────────────────────────────────
// test-ai-listing.ts
// Gemini 1.5 Flash ile AI listing üretimini test eder.
//
// Çalıştırma:
//   cd "C:\\Users\\pc\\Desktop\\ebay listing\\backend"
//   npx ts-node test-ai-listing.ts B071251380
// GEMINI_API_KEY ve WORKSPACE_ID .env içinde tanımlı olmalı.
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const workspaceId = process.env.WORKSPACE_ID
  if (!workspaceId) {
    console.error("[Test] WORKSPACE_ID is not defined in .env")
    process.exit(1)
  }
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error("[Test] GEMINI_API_KEY is not defined in .env")
    process.exit(1)
  }

  const asin = process.argv[2] ?? "B071251380"

  const product: AiListingInput = {
    asin,
    title:           "Sample Amazon Product Title With Some Extra Words For Testing",
    brand:           "Sample Brand",
    price:           24.99,
    currency:        "USD",
    images:          ["https://images-na.ssl-images-amazon.com/images/I/sample1.jpg"],
    bullets: [
      "High-quality sample feature from Amazon Product Page",
      "Durable and reliable design for everyday use",
      "Great value compared to similar Prime items",
      "Easy to use, fits most common scenarios",
      "Trusted by many Amazon customers worldwide",
    ],
    description:     "This is a long sample description copied from an Amazon listing with Prime and seller links for testing.",
    specs:           { Color: "Black", Size: "Medium", Material: "Plastic" },
    rating:          4.6,
    reviews:         987,
    bsr:             2048,
    category:        "Sample Category",
    isPrime:         true,
    isFreeShipping:  true,
  }

  console.log("═".repeat(64))
  console.log("[Test] aiListing — generateAiListing")
  console.log("═".repeat(64))
  console.log(`asin        : ${product.asin}`)
  console.log("")

  try {
    const listing: AiListingOutput = await generateAiListing(product)

    console.log("[AI Listing Result]")
    console.log("ebayTitle:")
    console.log(`  ${listing.ebayTitle}`)
    console.log("")
    console.log("brand:")
    console.log(`  ${listing.brand}`)
    console.log("")
    console.log("bullets:")
    listing.bullets.forEach((b, idx) => {
      console.log(`  ${idx + 1}. ${b}`)
    })
    console.log("")
    console.log("description:")
    console.log(`  ${listing.description}`)
    console.log("")
    console.log("itemSpecifics:")
    Object.entries(listing.itemSpecifics).forEach(([k, v]) => {
      console.log(`  ${k}: ${v}`)
    })
    console.log("")

    if (listing.ebayTitle.length > 80) {
      console.warn(`[WARN] ebayTitle length > 80: ${listing.ebayTitle.length} chars`)
    } else {
      console.log(`[OK] ebayTitle length <= 80: ${listing.ebayTitle.length} chars`)
    }
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


