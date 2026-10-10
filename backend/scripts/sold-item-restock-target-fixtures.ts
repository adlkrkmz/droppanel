/**
 * Dry-run fixtures for sold-item auto-restock target decision.
 * Run: npx ts-node --transpile-only scripts/sold-item-restock-target-fixtures.ts
 */

import {
  SOLD_ITEM_RESTOCK_TARGET_QUANTITY,
  shouldRestockSoldItem,
} from "../modules/orders/soldItemAutoRestockDecision"

type Case = {
  name:     string
  liveQty:  number
  expected: boolean
}

const cases: Case[] = [
  { name: "live 0 → restock to 3", liveQty: 0, expected: true },
  { name: "live 1 → restock to 3", liveQty: 1, expected: true },
  { name: "live 2 → restock to 3", liveQty: 2, expected: true },
  { name: "live 3 → no update", liveQty: 3, expected: false },
  { name: "live 4 → no update", liveQty: 4, expected: false },
  { name: "live 10 → no update", liveQty: 10, expected: false },
]

let passed = 0
let failed = 0

console.log(`target=${SOLD_ITEM_RESTOCK_TARGET_QUANTITY}`)

for (const c of cases) {
  const got = shouldRestockSoldItem(c.liveQty)
  const ok = got === c.expected
  if (ok) {
    passed++
    console.log(`✓ ${c.name}`)
  } else {
    failed++
    console.error(`✗ ${c.name}`, { expected: c.expected, got })
  }
}

console.log(`\n${passed}/${cases.length} passed`)
if (failed > 0) process.exit(1)
if (SOLD_ITEM_RESTOCK_TARGET_QUANTITY !== 3) {
  console.error("SOLD_ITEM_RESTOCK_TARGET_QUANTITY must be 3")
  process.exit(1)
}
