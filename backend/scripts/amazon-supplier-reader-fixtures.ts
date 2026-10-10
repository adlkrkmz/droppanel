import assert from "assert"
import fs from "fs"
import path from "path"
import { extractAmazonAsinFromUrl, normalizeSupplierUrl } from "../modules/amazon/supplierUrl"
import { buildAmazonReaderEvidenceFields, isAmazonProductUrl } from "../modules/chatgptApp/services/chatgptAmazonSupplierReadService"

assert.equal(normalizeSupplierUrl("https://www.amazon.com/dp/B0BRDZVJHV?tag=x"), "https://www.amazon.com/dp/b0brdzvjhv")
assert.equal(extractAmazonAsinFromUrl("https://www.amazon.com/dp/B0BRDZVJHV?th=1"), "B0BRDZVJHV")
assert.equal(isAmazonProductUrl("https://www.amazon.com/dp/B0BRDZVJHV"), true)
const evidence = buildAmazonReaderEvidenceFields({ title:"Example", asin:"B0BRDZVJHV", url:"https://www.amazon.com/dp/B0BRDZVJHV", status:"FULL", bullets:["One"], attributes:{Size:"Small"}, images:["https://image.example/a.jpg"] })
assert.equal(evidence.title,"Example"); assert.deepEqual(evidence.bulletPoints,["One"]); assert.deepEqual(evidence.specifications,["Size: Small"])
const reader = fs.readFileSync(path.join(__dirname,"../modules/chatgptApp/services/chatgptAmazonSupplierReadHandlers.ts"),"utf8")
const service = fs.readFileSync(path.join(__dirname,"../modules/chatgptApp/services/chatgptAmazonSupplierReadService.ts"),"utf8")
assert(!reader.includes("chatgptProductPreviewService")); assert(!reader.includes("etsy")); assert(!service.includes("chatgptProductPreviewSchemas")); assert(!service.includes("etsy"))
console.log("PASS Amazon URL/ASIN normalization, evidence contract, and Etsy runtime decoupling")
