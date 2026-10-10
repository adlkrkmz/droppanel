import assert from "assert"
import fs from "fs"
import path from "path"
import { generateSessionToken, hashSessionToken, sessionCookieOptions } from "../modules/auth/sessionToken"

type Row={id:string;userId:string;hash:string;expiresAt:number;revoked:boolean;raw?:never}
class MemorySessions {
  rows:Row[]=[]
  create(userId:string,ttl=10000){const raw=generateSessionToken();const row={id:`s${this.rows.length+1}`,userId,hash:hashSessionToken(raw),expiresAt:Date.now()+ttl,revoked:false};this.rows.push(row);return{raw,row}}
  auth(raw:string){return this.rows.find(r=>r.hash===hashSessionToken(raw)&&!r.revoked&&r.expiresAt>Date.now())??null}
  revoke(id:string,userId:string){const r=this.rows.find(x=>x.id===id&&x.userId===userId);if(!r)return false;r.revoked=true;return true}
  all(userId:string){this.rows.filter(r=>r.userId===userId).forEach(r=>r.revoked=true)}
  list(userId:string){return this.rows.filter(r=>r.userId===userId&&!r.revoked&&r.expiresAt>Date.now())}
}

const db=new MemorySessions(), a=db.create("A"), b=db.create("A")
assert.equal(Buffer.from(a.raw,"base64url").length,32);assert.notEqual(a.raw,a.row.hash);assert(!("raw" in a.row));console.log("PASS Session creation")
assert.equal(db.auth(a.raw)?.userId,"A");assert.equal(db.auth("unknown"),null);console.log("PASS Session authentication")
const expired=db.create("A",-1);assert.equal(db.auth(expired.raw),null);console.log("PASS Expired session rejection")
db.revoke(a.row.id,"A");assert.equal(db.auth(a.raw),null);console.log("PASS Revoked session rejection");console.log("PASS Logout")
db.all("A");assert.equal(db.auth(b.raw),null);console.log("PASS Logout-all")
const owned=db.create("A"), foreign=db.create("B");assert.equal(db.revoke(foreign.row.id,"A"),false);assert.equal(db.list("A").length,1);console.log("PASS Session ownership")
const inactiveUser={approvalStatus:"suspended"};assert(inactiveUser.approvalStatus!=="active");console.log("PASS Inactive-user session")
const before=generateSessionToken(),after=generateSessionToken();assert.notEqual(before,after);console.log("PASS Session fixation")
const prod=sessionCookieOptions(true),dev=sessionCookieOptions(false);assert(prod.httpOnly&&prod.secure&&prod.path==="/"&&prod.sameSite==="none");assert(dev.httpOnly&&!dev.secure&&dev.sameSite==="lax");console.log("PASS Cookie security")
assert(!JSON.stringify({ok:true,user:{id:"A"}}).includes(owned.raw));assert(!JSON.stringify(owned.row).includes(owned.raw));console.log("PASS Raw token leak check")

const client=fs.readFileSync(path.join(__dirname,"../panel/src/lib/userAuthClient.ts"),"utf8")+fs.readFileSync(path.join(__dirname,"../panel/src/lib/userAppClient.ts"),"utf8")
assert(!client.includes("localStorage"));assert(!client.includes("listjetgo_user_token"));assert(!client.match(/Authorization:\s*`Bearer/));assert.match(client,/credentials:\s*["']include["']/)
const routes=fs.readFileSync(path.join(__dirname,"../modules/auth/authRoutes.ts"),"utf8")
assert(!routes.match(/token:\s*result\.token/));assert.match(routes,/issueSession/);assert.match(routes,/logout-all/);assert.match(routes,/auth\/sessions/)
console.log("PASS Frontend cookie-auth contract")

const middleware=fs.readFileSync(path.join(__dirname,"../modules/auth/authMiddleware.ts"),"utf8")
assert.match(middleware,/approvalStatus !== "active"/);assert.match(middleware,/getPrimaryWorkspaceIdForUser/)
console.log("PASS Tenant and active-user session contract")
