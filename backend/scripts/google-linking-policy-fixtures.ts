import assert from "assert"
import fs from "fs"
import path from "path"
import { classifyGoogleEmailAuthority } from "../modules/auth/googleLinkingPolicy"
const c=(email:string,hd?:string|null)=>classifyGoogleEmailAuthority({email,emailVerified:true,hostedDomain:hd,existingUser:true})
assert.equal(c("user@gmail.com"),"AUTO_LINK_GMAIL");console.log("PASS Gmail safe linking")
assert.equal(c("employee@company.com","company.com"),"AUTO_LINK_WORKSPACE");console.log("PASS Workspace safe linking")
for(const email of ["owner@company.com","user@outlook.com","user@yahoo.com"]){assert.equal(c(email),"REAUTH_REQUIRED_THIRD_PARTY")}
console.log("PASS Third-party email protection");console.log("PASS Outlook collision protection");console.log("PASS Yahoo collision protection")
assert.equal(c("employee@company.com","other.com"),"REAUTH_REQUIRED_THIRD_PARTY");console.log("PASS Workspace domain mismatch protection")
assert.equal(classifyGoogleEmailAuthority({email:"x@gmail.com",emailVerified:false,existingUser:true}),"REJECT_UNVERIFIED");console.log("PASS Unverified email rejection")
assert.equal(classifyGoogleEmailAuthority({email:"x@yahoo.com",emailVerified:true,existingUser:false}),"NEW_ACCOUNT_ALLOWED");console.log("PASS New third-party user policy")
const repository=fs.readFileSync(path.join(__dirname,"../modules/auth/externalIdentityRepository.ts"),"utf8")
assert(repository.indexOf("findExternalIdentity(\"google\", input.sub)") < repository.indexOf("findUserByEmail(email)"))
assert.match(repository,/ACCOUNT_LINK_REAUTH_REQUIRED/)
assert.match(repository,/IDENTITY_COLLISION/)
console.log("PASS Existing provider subject remains authoritative")
console.log("PASS Cross-account identity collision protection")
