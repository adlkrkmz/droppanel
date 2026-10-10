import { resolveGoogleIdentity } from "./externalIdentityRepository"
import type { GoogleClaims } from "./googleCredential"
export { generateGoogleNonce, googleClientId, googleEnabled, verifyGoogleCredential } from "./googleCredential"
export async function authenticateGoogle(claims:GoogleClaims & {hostedDomain?:string|null}){return resolveGoogleIdentity({sub:claims.sub,email:claims.email,emailVerified:claims.emailVerified,hostedDomain:claims.hostedDomain,displayName:claims.name})}
