import type { Request } from "express"
import { createSession, type SessionRow } from "./sessionRepository"
import { generateSessionToken, hashSessionToken, sessionTtlDays } from "./sessionToken"
export { sessionCookieName, sessionCookieOptions, sessionRetentionDays } from "./sessionToken"
export function requestSessionMetadata(req:Request): {ipAddress:string|null;userAgent:string|null} {
  return { ipAddress:req.ip||req.socket.remoteAddress||null, userAgent:typeof req.headers["user-agent"]==="string"?req.headers["user-agent"].slice(0,512):null }
}
export async function issueSession(userId:string, metadata:{ipAddress:string|null;userAgent:string|null}): Promise<{rawToken:string;session:SessionRow}> {
  const rawToken=generateSessionToken(), tokenHash=hashSessionToken(rawToken)
  const expiresAt=new Date(Date.now()+sessionTtlDays()*86400000)
  const session=await createSession({userId,tokenHash,expiresAt,...metadata})
  return {rawToken,session}
}
