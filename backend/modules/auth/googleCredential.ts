import crypto from "crypto"
import { OAuth2Client, type TokenPayload } from "google-auth-library"
export function googleClientId():string|null{return process.env.GOOGLE_CLIENT_ID?.trim()||null}
export function googleEnabled():boolean{return process.env.GOOGLE_AUTH_ENABLED==="true"&&Boolean(googleClientId())}
export function generateGoogleNonce():string{return crypto.randomBytes(32).toString("base64url")}
export type GoogleClaims={sub:string;email:string;emailVerified:boolean;name:string|null;nonce:string|null;hostedDomain:string|null}
export interface GoogleCredentialVerifier{verify(idToken:string,audience:string):Promise<TokenPayload>}
const officialVerifier:GoogleCredentialVerifier={async verify(idToken,audience){const ticket=await new OAuth2Client().verifyIdToken({idToken,audience});const p=ticket.getPayload();if(!p)throw new Error("GOOGLE_INVALID_CREDENTIAL");return p}}
export async function verifyGoogleCredential(idToken:string,expectedNonce:string,verifier:GoogleCredentialVerifier=officialVerifier):Promise<GoogleClaims>{
  const audience=googleClientId();if(!audience)throw new Error("GOOGLE_NOT_CONFIGURED")
  const p=await verifier.verify(idToken,audience)
  if(!p.sub||!p.email)throw new Error("GOOGLE_CLAIMS_MISSING")
  if(p.email_verified!==true)throw new Error("GOOGLE_EMAIL_UNVERIFIED")
  if(!expectedNonce)throw new Error("GOOGLE_EXPECTED_NONCE_MISSING")
  if(!p.nonce)throw new Error("GOOGLE_NONCE_MISSING")
  const actual=Buffer.from(p.nonce), expected=Buffer.from(expectedNonce)
  if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))throw new Error("GOOGLE_NONCE_INVALID")
  return{sub:p.sub,email:p.email,emailVerified:true,name:p.name??null,nonce:p.nonce,hostedDomain:p.hd??null}
}
