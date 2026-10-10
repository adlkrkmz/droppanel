import assert from "assert"
process.env.DATABASE_URL = "postgres://fixture:fixture@localhost:5432/fixture"
const { parseStoreAddress } = require("../modules/app/appSettingsService") as typeof import("../modules/app/appSettingsService")
const base = { address1: "1 Main St", city: "Ankara", state: "06", zip: "06000" }
assert.equal(parseStoreAddress({ address: { ...base, country: "Turkey" } }).country, "TR")
assert.equal(parseStoreAddress({ address: { ...base, country: "United States" } }).country, "US")
assert.equal(parseStoreAddress({ address: { ...base, country: "TR" }, registrationCountry: "US" }).country, "TR")
assert.throws(() => parseStoreAddress({ address: { ...base, country: "" } }), /country is required/)
console.log("PASS secure address country mapping fixtures")
