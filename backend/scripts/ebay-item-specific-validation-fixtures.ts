import {
  findMissingRequiredEbayAspects,
  completeRequiredEbayAspects,
  type RequiredAspectCompletionEvidence,
  populateExplicitRequiredEbayAspects,
  sanitizeEbayAspectMap,
} from "../modules/ebay/ebayItemSpecificValidation"
import { summarizeExtensionCaptureOutcome } from "../modules/extensionCapture/extensionCaptureOutcome"

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const sanitized = sanitizeEbayAspectMap({
  "✔": ["✔"],
  "✘": ["✔"],
  "🎒": ["bag"],
  "Men's Size": ["Small"],
  Brand: ["JINGDU"],
  Department: ["womens"],
  "Size Type": ["Regular"],
})
assert(!("✔" in sanitized) && !("✘" in sanitized) && !("🎒" in sanitized), "symbol-only names removed")
assert(
  sanitized["Men's Size"]?.[0] === "Small" && sanitized.Brand?.[0] === "JINGDU" &&
  sanitized.Department?.[0] === "womens" && sanitized["Size Type"]?.[0] === "Regular",
  "valid labels preserved"
)

const completedFromRetainedData = completeRequiredEbayAspects({
  aspects: {
    Brand: ["Nautica"],
    Scent: ["Nautica Voyage"],
    "Item Form": ["Liquid"],
    "Item Volume": ["100 ml"],
    "Model Number": ["ABC123"],
    "Outer Material": ["Nylon"],
  },
  requiredAspects: [
    { name: "Fragrance Name", required: true, values: [] },
    { name: "Type", required: true, values: ["Liquid", "Spray"] },
    { name: "Volume", required: true, values: [] },
    { name: "Model", required: true, values: [] },
    { name: "Material", required: true, values: ["Nylon"] },
  ],
})
assert(
  completedFromRetainedData["Fragrance Name"]?.[0] === "Nautica Voyage" &&
  completedFromRetainedData.Type?.[0] === "Liquid" &&
  completedFromRetainedData.Volume?.[0] === "100 ml" &&
  completedFromRetainedData.Model?.[0] === "ABC123" &&
  completedFromRetainedData.Material?.[0] === "Nylon",
  "retained Amazon aliases complete fragrance, type, volume, model, and material"
)
const neutralCompletion = completeRequiredEbayAspects({
  aspects: { "✔": ["bad"], Brand: ["Generic"] },
  requiredAspects: [
    { name: "Free Text", required: true, values: [] },
    { name: "Restricted Unknown", required: true, values: ["Unknown", "Men"] },
    { name: "Restricted DNA", required: true, values: ["Does Not Apply", "Women"] },
  ],
})
assert(
  neutralCompletion["Free Text"]?.[0] === "Unknown" &&
  neutralCompletion["Restricted Unknown"]?.[0] === "Unknown" &&
  neutralCompletion["Restricted DNA"]?.[0] === "Does Not Apply" &&
  !("✔" in neutralCompletion),
  "neutral fallback is allowed-only for restricted fields and sanitizer remains active"
)
const preservedExisting = completeRequiredEbayAspects({
  aspects: { Department: ["Women"], Material: ["Nylon"], Model: ["ABC123"] },
  requiredAspects: [
    { name: "Department", required: true, values: ["Women", "Men"] },
    { name: "Material", required: true, values: ["Nylon"] },
    { name: "Model", required: true, values: [] },
  ],
})
assert(
  preservedExisting.Department?.[0] === "Women" &&
  preservedExisting.Material?.[0] === "Nylon" &&
  preservedExisting.Model?.[0] === "ABC123",
  "existing valid required values are preserved"
)
const completionEvidence: RequiredAspectCompletionEvidence[] = []
const titleAndLastResort = completeRequiredEbayAspects({
  aspects: { Brand: ["Generic"] },
  title: "Fresh Eau de Parfum body spray and protective case",
  requiredAspects: [
    { name: "Type", required: true, values: ["Eau de Parfum", "Body Spray"] },
    { name: "Part Type", required: true, values: ["Accessory", "Component"] },
  ],
  evidence: completionEvidence,
})
assert(
  titleAndLastResort.Type?.[0] === "Body Spray" &&
  titleAndLastResort["Part Type"]?.[0] === "Accessory" &&
  completionEvidence.some((x) => x.aspect === "Type" && x.source === "title") &&
  completionEvidence.some((x) => x.aspect === "Part Type" && x.source === "first_allowed"),
  "explicit title values win before the last-resort first allowed taxonomy value"
)
const technicallyImpossible = completeRequiredEbayAspects({
  aspects: { Brand: ["Generic"] },
  requiredAspects: [{ name: "Impossible", required: true, values: [], acceptsFreeText: false }],
})
assert(
  findMissingRequiredEbayAspects(technicallyImpossible, [{ name: "Impossible", required: true, values: [], acceptsFreeText: false }]).join(",") === "Impossible",
  "only an explicitly non-free-text aspect with no allowed values remains missing"
)
assert(
  findMissingRequiredEbayAspects(neutralCompletion, [
    { name: "Free Text", required: true, values: [] },
    { name: "Restricted Unknown", required: true, values: ["Unknown"] },
    { name: "Restricted DNA", required: true, values: ["Does Not Apply"] },
  ]).length === 0,
  "completed required payload passes validator"
)

const normalized = populateExplicitRequiredEbayAspects({
  aspects: { Department: ["womens"], "Outer Material": ["Nylon"] },
  requiredAspects: [
    { name: "Department", required: true, values: ["Men", "Women"] },
    { name: "Material", required: true, values: ["Canvas", "Nylon"] },
  ],
})
assert(normalized.Department?.[0] === "Women" && normalized.Material?.[0] === "Nylon", "explicit taxonomy-gated department/material normalization")

const upperMaterial = completeRequiredEbayAspects({
  aspects: { "Outer Material": ["Ethylene Vinyl Acetate (EVA)"] },
  requiredAspects: [{ name: "Upper Material", required: true, values: ["EVA"], acceptsFreeText: false }],
})
assert(upperMaterial["Upper Material"]?.[0] === "EVA", "outer material resolves to taxonomy-approved upper material abbreviation")

const retainedBrandWins = completeRequiredEbayAspects({
  aspects: { Brand: ["Viyafit"] },
  requiredAspects: [{ name: "Brand", required: true, values: ["Other"], acceptsFreeText: true }],
})
assert(retainedBrandWins.Brand?.[0] === "Viyafit", "retained free-text brand wins over Other")

const noOtherBrandFallback = completeRequiredEbayAspects({
  aspects: {},
  requiredAspects: [{ name: "Brand", required: true, values: ["Other"], acceptsFreeText: false }],
})
assert(!noOtherBrandFallback.Brand, "Brand never uses Other as generic neutral fallback")

const protectiveCase = populateExplicitRequiredEbayAspects({
  aspects: { Brand: ["JINGDU"] },
  title: "Protective Case Compatible with Switch",
  requiredAspects: [{ name: "Type", required: true, values: ["Protective Shell/Skin"] }],
})
assert(protectiveCase.Type?.[0] === "Protective Shell/Skin", "explicit protective-case taxonomy mapping")

const noFabrication = populateExplicitRequiredEbayAspects({
  aspects: { Brand: ["Generic"] },
  title: "Flannel shirt",
  requiredAspects: [
    { name: "Size Type", required: true, values: ["Regular"] },
    { name: "Size", required: true, values: ["S"] },
  ],
})
assert(!noFabrication["Size Type"] && !noFabrication.Size, "no size defaults fabricated")

// Retained failure shapes from command 313 (only the evidence relevant to
// required-aspect derivation is kept in the fixture).
const b07 = populateExplicitRequiredEbayAspects({
  aspects: { Brand: ["Esbuy"], Color: ["Khaki"], "Outer Material": ["Nylon"], "Product Style": ["Daypack Backpacks"] },
  title: "Tactical Backpack Outdoor Shoulder Bag Satchel Sling Chest Packs Daypacks",
  requiredAspects: [
    { name: "Brand", required: true, values: ["Esbuy"] },
    { name: "Material", required: true, values: ["Nylon"] },
    { name: "Style", required: true, values: ["Backpack"] },
    { name: "Department", required: true, values: ["Men", "Unisex Adults"] },
    { name: "Color", required: true, values: ["Khaki"] },
  ],
})
assert(findMissingRequiredEbayAspects(b07, [
  { name: "Material", required: true, values: ["Nylon"] },
  { name: "Style", required: true, values: ["Backpack"] },
  { name: "Department", required: true, values: ["Men", "Unisex Adults"] },
]).join(",") === "Style,Department", "B07 only explicit material is safely derived")

const b0bj = populateExplicitRequiredEbayAspects({
  aspects: { Brand: ["Zontroldy"], Department: ["womens"], Color: ["01 Khaki"], "top-style": ["Button Down"] },
  title: "Womens Flannel Shirt Long Sleeve Oversized Button Plaid Shirt Top",
  requiredAspects: [
    { name: "Size Type", required: true, values: ["Regular", "Plus"] },
    { name: "Size", required: true, values: ["S", "M", "L"] },
    { name: "Department", required: true, values: ["Women"] },
    { name: "Type", required: true, values: ["Button-Up"] },
  ],
})
assert(b0bj.Department?.[0] === "Women" && findMissingRequiredEbayAspects(b0bj, [
  { name: "Size Type", required: true, values: ["Regular"] },
  { name: "Size", required: true, values: ["S"] },
  { name: "Type", required: true, values: ["Button-Up"] },
]).join(",") === "Size Type,Size,Type", "B0BJ does not invent size type, size, or type")

// Retained failing data: B07KLX6MC2 has no Department in its Amazon specs;
// B0BJDRH3QJ has Department but no Size Type. No value is invented.
assert(
  findMissingRequiredEbayAspects({ Brand: ["Generic"], Size: ["Small"] }, [
    { name: "Department", required: true, values: ["Men"] },
  ]).join(",") === "Department",
  "B07KLX6MC2 missing Department"
)
assert(
  findMissingRequiredEbayAspects({ Brand: ["Generic"], Department: ["womens"] }, [
    { name: "Size Type", required: true, values: ["Regular"] },
  ]).join(",") === "Size Type",
  "B0BJDRH3QJ missing Size Type"
)

const validation400 = summarizeExtensionCaptureOutcome({
  itemStatus: "failed",
  errorMessage: 'publishOffer failed: HTTP 400 - {"errors":[{"errorId":25002,"message":"The item specific Department is missing"}]}',
})
assert(validation400.retryable === false && validation400.code === "EBAY_25002_VALIDATION", "HTTP 400/25002 permanent")

const invalidName400 = summarizeExtensionCaptureOutcome({
  itemStatus: "failed",
  errorMessage: 'publishOffer failed: HTTP 400 - {"errors":[{"errorId":25002,"message":"The item specific name ✘ is too short"}]}',
})
assert(invalidName400.retryable === false && invalidName400.message === "Geçersiz ürün özelliği adı", "invalid name permanent")

const system500 = summarizeExtensionCaptureOutcome({
  itemStatus: "failed",
  errorMessage: 'publishOffer failed: HTTP 500 - {"errors":[{"errorId":25002,"message":"System error. Please try again later."}]}',
})
assert(system500.retryable === true && system500.code === "EBAY_25002", "HTTP 5xx transient")

assert(
  findMissingRequiredEbayAspects({ Department: ["Women"], "Size Type": ["Regular"] }, [
    { name: "Department", required: true, values: [] },
    { name: "Size Type", required: true, values: [] },
  ]).length === 0,
  "complete required aspects remain publish-eligible"
)

console.log("ebay-item-specific-validation-fixtures PASS")
