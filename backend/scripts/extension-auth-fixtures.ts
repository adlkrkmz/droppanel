import assert from "assert"
process.env.EXTENSION_TOKEN_SECRET = "fixture-secret-that-is-longer-than-32-bytes"
process.env.DATABASE_URL = "postgres://fixture:fixture@localhost:5432/fixture"
// Load after fixture env setup so importing the shared auth module remains side-effect safe.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { issueExtensionToken, verifyExtensionToken } = require("../modules/app/extensionAuth") as typeof import("../modules/app/extensionAuth")
const issued = issueExtensionToken("00000000-0000-0000-0000-000000000001")
assert.equal(verifyExtensionToken(issued.accessToken)?.sub, "00000000-0000-0000-0000-000000000001")
assert.equal(verifyExtensionToken(`${issued.accessToken}x`), null)
const parts = issued.accessToken.split(".")
const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); claims.aud = "wrong"
const altered = `${parts[0]}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${parts[2]}`
assert.equal(verifyExtensionToken(altered), null)
console.log("PASS extension token signature, audience, purpose, and ID fixtures")
