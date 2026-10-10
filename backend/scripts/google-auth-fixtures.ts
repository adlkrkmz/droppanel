import assert from "assert"
import fs from "fs"
import path from "path"
import { verifyGoogleCredential, type GoogleCredentialVerifier } from "../modules/auth/googleCredential"

process.env.GOOGLE_CLIENT_ID = "fixture-client-id"
async function main(): Promise<void> {
const verifier: GoogleCredentialVerifier = { async verify(_token, audience) {
  assert.equal(audience, "fixture-client-id")
  return { sub:"sub-a", email:"a@example.com", email_verified:true, nonce:"nonce-a", name:"A" } as any
} }
const claims = await verifyGoogleCredential("mock", "nonce-a", verifier)
assert.equal(claims.sub, "sub-a"); assert.equal(claims.emailVerified, true); console.log("PASS Google credential verification")
await assert.rejects(() => verifyGoogleCredential("mock", "nonce-b", verifier)); console.log("PASS Google nonce/state rejection")
const missingNonce: GoogleCredentialVerifier = { async verify(){ return {sub:"x",email:"x@example.com",email_verified:true} as any } }
await assert.rejects(() => verifyGoogleCredential("mock", "nonce-a", missingNonce)); console.log("PASS Google missing nonce rejection")
await assert.rejects(() => verifyGoogleCredential("mock", "", verifier)); console.log("PASS Google missing expected nonce rejection")
const unverified: GoogleCredentialVerifier = { async verify(){ return {sub:"x",email:"x@example.com",email_verified:false,nonce:"n"} as any } }
await assert.rejects(() => verifyGoogleCredential("mock", "n", unverified)); console.log("PASS Google unverified email rejection")
const missing: GoogleCredentialVerifier = { async verify(){ return {email:"x@example.com",email_verified:true,nonce:"n"} as any } }
await assert.rejects(() => verifyGoogleCredential("mock", "n", missing)); console.log("PASS Google missing-sub rejection")
const migration=fs.readFileSync(path.join(__dirname,"../migrations/053_auth_credentials.sql"),"utf8")
assert.match(migration,/CREATE TABLE IF NOT EXISTS password_credentials/);assert.match(migration,/INSERT INTO password_credentials[\s\S]*SELECT id, password_hash/);assert.match(migration,/ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL/);assert.match(migration,/UNIQUE \(provider, provider_user_id\)/);assert(!/ebay_accounts|ebay_orders|stores/.test(migration));console.log("PASS Password credential migration contract")
const repo=fs.readFileSync(path.join(__dirname,"../modules/auth/externalIdentityRepository.ts"),"utf8")
assert.match(repo,/provider_user_id/);assert.match(repo,/emailVerified/);assert.match(repo,/IDENTITY_COLLISION/);assert.match(repo,/UNIQUE|catch/);assert(!repo.includes("'PENDING'"));console.log("PASS Google identity/linking contract")
const routes=fs.readFileSync(path.join(__dirname,"../modules/auth/authRoutes.ts"),"utf8")
assert.match(routes,/issueSession/);assert(!routes.match(/res\.status\(200\)\.json\(\{ok:true,[^}]*token/));console.log("PASS Google opaque session contract")
assert.match(routes,/httpOnly:true/);assert.match(routes,/maxAge:10\*60_?000/);assert.match(routes,/clearCookie\("listjetgo_google_nonce"/);console.log("PASS Google nonce cookie lifecycle contract")
const source=fs.readFileSync(path.join(__dirname,"../modules/auth/googleCredential.ts"),"utf8")
assert.match(source,/verifyIdToken/);assert.match(source,/email_verified/);assert.match(source,/timingSafeEqual/);assert.match(source,/GOOGLE_NONCE_MISSING/);console.log("PASS Google verification security contract")
}
void main().catch(e=>{console.error(e);process.exitCode=1})
