/**
 * Titlebot fixture dry-run — npm run titlebot:fixtures
 */
import { buildTitleBotTitle } from "../modules/titleBot/titleBotService"

const BANNED_TERMS = [
  "christmas", "xmas", "x-mas", "crismis", "chrismas", "chritmas", "cristmas",
]

type Fixture = {
  name:                string
  inputTitle:          string
  brand?:              string
  requiredAll?:        string[]
  requiredAnyGroups?:  string[][]
  forbidden?:          string[]
  minLength?:          number
  maxLength?:          number
}

const FIXTURES: Fixture[] = [
  {
    name: "Tumbler",
    brand: "Tmaccker",
    inputTitle: "Tmaccker Fathers Day Dad Gifts for Dad from Daughter Wife - 17oz Stainless Steel Bullet Tumbler Coffee Mug Birthday Gifts for Men Grandpa on Christmas Anniversary Valentines Stocking Stuffers for Men",
    requiredAll: ["17 oz", "Stainless Steel", "Tumbler", "Fathers Day"],
    forbidden: ["Tmaccker", "Christmas", "Xmas"],
    minLength: 55,
    maxLength: 80,
  },
  {
    name: "Nuts gift basket",
    inputTitle: "Fathers Day Nuts Gift Basket - Assortment of Sweet & Roasted Salted Gourmet Nuts - Food Gift Box for Dad, Him, Husband, Christmas, Father's Day, Mother's Day, Sympathy, Family, Men & Women",
    requiredAll: ["Fathers Day", "Gift Basket", "Nuts"],
    forbidden: ["Christmas", "Xmas"],
    minLength: 55,
    maxLength: 80,
  },
  {
    name: "Fathers Day card",
    inputTitle: "Daddy Fathers Day Card,Funny Fathers Day Gift,Dad Gift from son daughter,Fathers Day Gift Ideas,Fill in the blanks keepsake Card",
    requiredAll: ["Funny", "Fathers Day", "Fill in Blanks", "Card"],
    forbidden: ["Christmas"],
    minLength: 50,
    maxLength: 80,
  },
  {
    name: "Garden staples",
    inputTitle: "50 Pack 6 Inch Hot-dip Galvanized Landscape Staples 11 Gauge Plant Cover Spikes Weed Barrier Pins",
    requiredAll: ["50 Pcs", "6 in", "Galvanized", "Landscape Staples", "11 Gauge"],
    forbidden: ["Christmas"],
    minLength: 55,
    maxLength: 80,
  },
  {
    name: "Plant tags",
    inputTitle: "100 Pcs Plastic 6 X10cm Plant T-type Tags Garden Labels Nursery Markers",
    requiredAll: ["100 Pcs", "6x10 cm", "Plastic", "Plant Tags"],
    forbidden: ["Christmas"],
    minLength: 55,
    maxLength: 80,
  },
  {
    name: "Beauty cream",
    inputTitle: "Hydrating Face Body Moisturizing Cream 8.8oz Dry Sensitive Skin Fragrance Free",
    requiredAll: ["Moisturizing Cream", "8.8 oz", "Dry Sensitive Skin", "Fragrance Free"],
    forbidden: ["Christmas"],
    minLength: 55,
    maxLength: 80,
  },
  {
    name: "A) Spatula",
    inputTitle: "2PCS Metal Spatula Set - Stainless Steel Spatula Solid & Slotted Turner Flipper for Kitchen Use, Heat Resistant Kitchen Cooking Utensils for Flipping Fish, Eggs, Pancakes, Dishwasher Safe",
    requiredAll: ["2 Pcs", "Stainless Steel", "Spatula Set"],
    requiredAnyGroups: [
      ["Slotted Turner", "Turner Flipper"],
      ["Kitchen", "Cooking Utensils"],
    ],
    forbidden: ["2PCS", "Set Set", "Christmas"],
    minLength: 60,
    maxLength: 80,
  },
  {
    name: "B) Cord cover",
    inputTitle: "4 Pack Outdoor Extension Cord Cover Waterproof - Weatherproof Electrical Connection Box for Outdoor Outlet, Plug, Socket, Christmas Holiday Decoration, Power Tool, Black",
    requiredAll: ["4 Pcs", "Outdoor Extension Cord Cover", "Waterproof", "Black"],
    requiredAnyGroups: [
      ["Plug Socket", "Connection Box", "Plug Socket Box"],
    ],
    forbidden: ["Christmas", "Xmas", "Crismis", "Waterproof Waterproof"],
    minLength: 60,
    maxLength: 80,
  },
  {
    name: "C) Car wash",
    brand: "Chemical Guys",
    inputTitle: "Chemical Guys CWS22116 Mr. Pink Foam Party Wash & Wax (Works with Foam Cannons or Bucket Washes) Safe for Cars, Trucks, SUVS, Motorcycles, RVs & More, (16 fl oz) Tangerine Scent",
    requiredAll: ["16 fl oz", "Foam Party", "Wax", "Pink", "Tangerine Scent"],
    requiredAnyGroups: [
      ["Car Wash", "Auto Shampoo", "Auto Wash"],
    ],
    forbidden: ["Chemical Guys", "CWS22116", "Cws22116", "Mr.", "hemical", "Christmas"],
    minLength: 60,
    maxLength: 80,
  },
  {
    name: "D) Power strip",
    inputTitle: "Outdoor Power Strip with Stake Waterproof, 15 FT Extension Cord, 6 Grounded Outlets for Outdoor Lights, 14 AWG, 15A/1875W, ETL Listed",
    requiredAll: ["15 ft", "Outdoor Power Strip", "Stake", "6 Outlets", "14 AWG", "15A", "1875W", "ETL"],
    forbidden: ["Waterproof Waterproof", "Extension Extension", "Christmas"],
    minLength: 60,
    maxLength: 80,
  },
  {
    name: "E) IP67 electrical box",
    brand: "TICONN",
    inputTitle: 'TICONN Outdoor Electrical Box Waterproof, Junction Box IP67 ABS Plastic Enclosure with Hinged Cover with Mounting Plate, Wall Brackets, Cable Glands (Clear, 8.7"x6.7"x4.3")',
    requiredAll: ["8.7x6.7x4.3 in", "IP67", "Waterproof", "Junction Box"],
    requiredAnyGroups: [
      ["Plastic", "ABS Plastic"],
      ["Electrical Box", "Electrical Enclosure"],
    ],
    forbidden: ["TICONN", "Christmas", "Ip67", "Waterproof Waterproof"],
    minLength: 60,
    maxLength: 80,
  },
  {
    name: "F) Drill",
    inputTitle: "20v Drill Driver Set,Cordless Drill with Battery and Charger,LED Tools Kit,25+1 Torque Setting,43pcs Drill Bits,Orange",
    requiredAll: ["43 Pcs", "20V", "Cordless Drill Driver Set", "Battery", "Charger", "Orange"],
    requiredAnyGroups: [
      ["Drill Bits", "Tool Kit"],
    ],
    forbidden: ["20v", "Drill Drill", "Christmas"],
    minLength: 60,
    maxLength: 80,
  },
  {
    name: "G) Chainsaw chain",
    inputTitle: "6 Inch Chainsaw Chain, 4 PCS 6 Inch Cordless Electric Portable Mini Chainsaw, Portable manganese steel wear-resistant mini saw chain, Suitable for Cutting Wood, Bamboo, Plywood (37 Drive Links)",
    requiredAll: ["4 Pcs", "6 in", "Chainsaw Chain", "37 Drive Links"],
    requiredAnyGroups: [
      ["Manganese Steel", "Replacement", "Saw Chain"],
    ],
    forbidden: ["Portable Portable", "Wood Chainsaw Chain", "Cordless Electric Portable", "Christmas"],
    minLength: 60,
    maxLength: 80,
  },
  {
    name: "H) Magnetic garage hooks",
    inputTitle: "Heavy Duty Magnetic Garage Hooks,4 Pack Strong Large Magnet Hook for Power Drill,Garden Tools,Hose,Pegboard,Garage, Workshop,Magnetic Storage Hooks for Indoor Outdoor Hanging(Black)",
    requiredAll: ["4 Pcs", "Heavy Duty", "Magnetic Garage Hooks", "Black"],
    forbidden: ["Storage Storage", "Christmas"],
    minLength: 55,
    maxLength: 80,
  },
  {
    name: "I) Electrical box IP54",
    inputTitle: "Medium Outdoor Electrical Box, ETL Certified IP54 Waterproof Extension Cord Cover w/6 Cable Entry Ports, Weatherproof Connection Box for Power Strip, Timer, Plug, Holiday Lights, Black",
    requiredAll: ["IP54", "Waterproof", "Black"],
    requiredAnyGroups: [
      ["Outdoor Electrical Box", "Extension Cord Cover"],
    ],
    forbidden: ["Waterproof Weatherproof Waterproof", "Etl", "Christmas"],
    minLength: 55,
    maxLength: 80,
  },
]

function hasAdjacentDuplicate(title: string): boolean {
  const parts = title.split(/\s+/)
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].toLowerCase() === parts[i - 1].toLowerCase()) return true
  }
  return false
}

function containsBannedTerm(title: string): string | null {
  const lower = title.toLowerCase()
  for (const term of BANNED_TERMS) {
    if (lower.includes(term)) return term
  }
  return null
}

function containsModelCode(title: string): boolean {
  const m = title.match(/\b[A-Za-z]{2,}\d{3,}[A-Za-z0-9]*\b/)
  if (!m) return false
  const bare = m[0].replace(/[^A-Za-z0-9]/g, "")
  if (/^IP\d{2}$/i.test(bare)) return false
  return true
}

function checkForbidden(title: string, forbidden: string[]): string[] {
  const errors: string[] = []
  for (const f of forbidden) {
    if (f === "20v") {
      if (/\b20v\b/.test(title)) errors.push(`forbidden "${f}"`)
      continue
    }
    if (f === "Ip67") {
      if (/\bIp67\b/.test(title)) errors.push(`forbidden lowercase Ip67`)
      continue
    }
    if (f === "Etl") {
      if (/\bEtl\b/.test(title)) errors.push(`forbidden lowercase Etl`)
      continue
    }
    if (f === "Wood Chainsaw Chain") {
      if (/^Wood Chainsaw Chain/i.test(title)) errors.push(`forbidden start "${f}"`)
      continue
    }
    if (title.toLowerCase().includes(f.toLowerCase())) errors.push(`forbidden "${f}"`)
  }
  return errors
}

let passed = 0
let failed = 0

console.log("=== Titlebot Fixtures (strict) ===\n")

for (const fx of FIXTURES) {
  const result = buildTitleBotTitle({ amazonTitle: fx.inputTitle, brand: fx.brand })
  const title = result.title
  const maxLen = fx.maxLength ?? 80
  const minLen = fx.minLength ?? 0
  const errors: string[] = []

  if (title.length > maxLen) errors.push(`length ${title.length} > ${maxLen}`)
  if (title.length < minLen) errors.push(`length ${title.length} < ${minLen}`)

  for (const req of fx.requiredAll ?? []) {
    if (!title.toLowerCase().includes(req.toLowerCase())) errors.push(`missing required "${req}"`)
  }

  for (const group of fx.requiredAnyGroups ?? []) {
    if (!group.some(g => title.toLowerCase().includes(g.toLowerCase()))) {
      errors.push(`missing any of [${group.join(" | ")}]`)
    }
  }

  errors.push(...checkForbidden(title, fx.forbidden ?? []))

  const banned = containsBannedTerm(title)
  if (banned) errors.push(`banned term "${banned}" in final title`)

  if (hasAdjacentDuplicate(title)) errors.push("adjacent duplicate token")

  if (fx.brand && title.toLowerCase().includes(fx.brand.toLowerCase())) {
    errors.push(`brand leak "${fx.brand}"`)
  }

  if (containsModelCode(title)) errors.push("model code leak")

  const ok = errors.length === 0
  if (ok) passed++
  else failed++

  console.log(`${ok ? "PASS" : "FAIL"} — ${fx.name}`)
  console.log(`  title: ${title} (${title.length} chars)`)
  console.log(`  strategy: ${result.strategy} | productType: ${result.productType} | quality: ${result.qualityScore}`)
  if (result.warnings?.length) console.log(`  warnings: ${result.warnings.join(", ")}`)
  if (errors.length) console.log(`  errors: ${errors.join("; ")}`)
  console.log()
}

console.log(`Results: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
