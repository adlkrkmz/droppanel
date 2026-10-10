import assert from "node:assert/strict"
import {
  isQuantityMutationSourceEnabled,
  quantityMutationDisabledMessage,
} from "../modules/ebay/quantityMutationSource"

process.env.EBAY_LIVE_QUANTITY_MUTATION_SOURCES = "manual_listing,sold_item_restock"
assert.equal(isQuantityMutationSourceEnabled("manual_listing"), true)
assert.equal(isQuantityMutationSourceEnabled("sold_item_restock"), true)
assert.equal(isQuantityMutationSourceEnabled("automatic_zero"), false)

process.env.EBAY_LIVE_QUANTITY_MUTATION_SOURCES = ""
assert.equal(isQuantityMutationSourceEnabled("manual_listing"), false)
assert.equal(isQuantityMutationSourceEnabled("sold_item_restock"), false)
assert.match(quantityMutationDisabledMessage("automatic_zero"), /automatic_zero/)

console.log("PASS quantity mutation source gate: manual + sold restock enabled; automatic zero blocked")
