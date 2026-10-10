import { db, query } from "../../db/client"
import { findUserByEmail, findUserById, normalizeEmail } from "./authRepository"
import type { UserRow } from "./authTypes"
import { classifyGoogleEmailAuthority } from "./googleLinkingPolicy"

export type ExternalIdentity={id:string;userId:string;provider:string;providerUserId:string;providerEmail:string|null;emailVerified:boolean}
function map(r:Record<string,unknown>):ExternalIdentity{return{id:r.id as string,userId:r.user_id as string,provider:r.provider as string,providerUserId:r.provider_user_id as string,providerEmail:(r.provider_email as string|null)??null,emailVerified:Boolean(r.email_verified)}}
export async function findExternalIdentity(provider:string,providerUserId:string):Promise<ExternalIdentity|null>{const r=await query(`SELECT * FROM external_identities WHERE provider=$1 AND provider_user_id=$2 LIMIT 1`,[provider,providerUserId]);return r.rows[0]?map(r.rows[0] as Record<string,unknown>):null}
export async function listExternalIdentities(userId:string):Promise<ExternalIdentity[]>{const r=await query(`SELECT * FROM external_identities WHERE user_id=$1::uuid ORDER BY created_at`,[userId]);return r.rows.map(x=>map(x as Record<string,unknown>))}
export async function hasPasswordCredential(userId:string):Promise<boolean>{const r=await query(`SELECT 1 FROM password_credentials WHERE user_id=$1::uuid`,[userId]);return Boolean(r.rows[0])}

export async function resolveGoogleIdentity(input:{sub:string;email:string;emailVerified:boolean;hostedDomain?:string|null;displayName?:string|null}):Promise<{user:UserRow;created:boolean;linked:boolean}>{
  if(!input.emailVerified)throw new Error("GOOGLE_EMAIL_UNVERIFIED")
  const existingIdentity=await findExternalIdentity("google",input.sub)
  if(existingIdentity){
    const user=await findUserById(existingIdentity.userId);if(!user)throw new Error("IDENTITY_USER_MISSING")
    await query(`UPDATE external_identities SET provider_email=$2, email_verified=TRUE, display_name=$3, last_login_at=NOW(), updated_at=NOW() WHERE id=$1::uuid`,[existingIdentity.id,normalizeEmail(input.email),input.displayName??null])
    return{user,created:false,linked:false}
  }
  const email=normalizeEmail(input.email),existingUser=await findUserByEmail(email)
  if(existingUser){
    if(existingUser.approvalStatus!=="active")throw new Error(`USER_${existingUser.approvalStatus.toUpperCase()}`)
    const authority=classifyGoogleEmailAuthority({email,emailVerified:input.emailVerified,hostedDomain:input.hostedDomain,existingUser:true})
    if(authority==="REAUTH_REQUIRED_THIRD_PARTY")throw new Error("ACCOUNT_LINK_REAUTH_REQUIRED")
    if(authority==="REJECT_UNVERIFIED")throw new Error("GOOGLE_EMAIL_UNVERIFIED")
    try{await query(`INSERT INTO external_identities(user_id,provider,provider_user_id,provider_email,email_verified,display_name,last_login_at) VALUES($1::uuid,'google',$2,$3,TRUE,$4,NOW())`,[existingUser.id,input.sub,email,input.displayName??null])}
    catch(e){const winner=await findExternalIdentity("google",input.sub);if(!winner||winner.userId!==existingUser.id)throw new Error("IDENTITY_COLLISION")}
    return{user:existingUser,created:false,linked:true}
  }
  const client=await db.connect();let userId=""
  try{
    await client.query("BEGIN")
    const ur=await client.query<{id:string}>(`INSERT INTO users(email,password_hash,role,approval_status,email_verified_at,display_name,requested_product) VALUES($1,NULL,'user','pending_approval',NOW(),$2,'EBAY') RETURNING id`,[email,input.displayName??null]);userId=ur.rows[0]?.id??""
    const wr=await client.query<{id:string}>(`INSERT INTO workspaces(name,owner_user_id,status) VALUES($1,$2::uuid,'active') RETURNING id`,[email.split("@")[0]||"User Workspace",userId]);const workspaceId=wr.rows[0]?.id
    await client.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1::uuid,$2::uuid,'owner')`,[workspaceId,userId])
    await client.query(`INSERT INTO external_identities(user_id,provider,provider_user_id,provider_email,email_verified,display_name,last_login_at) VALUES($1::uuid,'google',$2,$3,TRUE,$4,NOW())`,[userId,input.sub,email,input.displayName??null])
    await client.query("COMMIT")
  }catch(e){await client.query("ROLLBACK");const winner=await findExternalIdentity("google",input.sub);if(winner){const user=await findUserById(winner.userId);if(user)return{user,created:false,linked:false}}throw e}finally{client.release()}
  const user=await findUserById(userId);if(!user)throw new Error("GOOGLE_USER_CREATE_FAILED");return{user,created:true,linked:false}
}
