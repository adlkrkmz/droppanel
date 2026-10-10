// ----------------------------------------------------------------
// authRoutes.ts — /auth/* public + session endpoints
// ----------------------------------------------------------------

import type { Express, Request, Response } from "express"
import {
  AuthHttpError,
  changePasswordForUser,
  getMeFromUserId,
  getProductAccessForUser,
  loginUser,
  parseRegisterProduct,
  registerUser,
  requestPasswordReset,
  resetPasswordWithToken,
  setInitialPasswordForUser,
  verifyEmailToken,
} from "./authService"
import { requireActiveUser, resolveAuthContext, type AuthedRequest } from "./authMiddleware"
import { issueSession, requestSessionMetadata, sessionCookieName, sessionCookieOptions } from "./sessionService"
import { listActiveSessionsForUser, revokeAllUserSessions, revokeSession } from "./sessionRepository"
import { insertAuditLog } from "./authRepository"
import { authenticateGoogle, generateGoogleNonce, googleClientId, googleEnabled, verifyGoogleCredential } from "./googleAuthService"
import { hasPasswordCredential, listExternalIdentities } from "./externalIdentityRepository"

function sendAuthError(res: Response, e: unknown): void {
  if (e instanceof AuthHttpError) {
    res.status(e.status).json({
      ok:             false,
      error:          e.message,
      approvalStatus: e.approvalStatus,
    })
    return
  }
  console.error("[Auth]", e)
  res.status(500).json({ ok: false, error: process.env.NODE_ENV === "production" ? "INTERNAL_ERROR" : (e instanceof Error ? e.message : "Internal error") })
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(sessionCookieName(), token, sessionCookieOptions())
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(sessionCookieName(), { path: "/" })
}

export function registerAuthRoutes(app: Express): void {
  app.get("/auth/google/config", (_req:Request,res:Response)=>{
    if(!googleEnabled()){res.status(404).json({ok:false,error:"Google sign-in is not configured"});return}
    const nonce=generateGoogleNonce(),isProd=process.env.NODE_ENV==="production"
    res.cookie("listjetgo_google_nonce",nonce,{httpOnly:true,secure:isProd,sameSite:isProd?"none":"lax",path:"/auth/google",maxAge:10*60_000})
    res.status(200).json({ok:true,clientId:googleClientId(),nonce})
  })

  app.post("/auth/google/credential",async(req:Request,res:Response)=>{
    try{
      if(!googleEnabled()){res.status(404).json({ok:false,error:"Google sign-in is not configured"});return}
      const nonce=String(req.cookies?.listjetgo_google_nonce??"");if(!nonce)throw new AuthHttpError("Invalid Google login state",400)
      let claims
      try { claims=await verifyGoogleCredential(String(req.body?.credential??""),nonce) }
      catch(e) {
        const code=e instanceof Error?e.message:"GOOGLE_INVALID_CREDENTIAL"
        throw new AuthHttpError(code === "GOOGLE_NONCE_INVALID" || code === "GOOGLE_NONCE_MISSING" || code === "GOOGLE_EXPECTED_NONCE_MISSING" ? "Invalid Google login state" : "Google credential rejected",400,code)
      }
      const resolved=await authenticateGoogle(claims)
      res.clearCookie("listjetgo_google_nonce",{path:"/auth/google"})
      if(resolved.user.approvalStatus!=="active"){
        res.status(403).json({ok:false,status:resolved.user.approvalStatus,message:"Your account is waiting for admin approval."});return
      }
      const issued=await issueSession(resolved.user.id,requestSessionMetadata(req));setSessionCookie(res,issued.rawToken)
      await insertAuditLog({actorUserId:resolved.user.id,action:resolved.linked?"identity.google_link":"identity.google_login",targetType:"session",targetId:issued.session.id})
      res.status(200).json({ok:true,user:await getMeFromUserId(resolved.user.id),created:resolved.created,linked:resolved.linked})
    }catch(e){
      res.clearCookie("listjetgo_google_nonce",{path:"/auth/google"})
      if(e instanceof Error && e.message === "ACCOUNT_LINK_REAUTH_REQUIRED") {
        res.status(409).json({ok:false,error:"ACCOUNT_LINK_REAUTH_REQUIRED",message:"Please sign in with your existing account to connect Google."})
        return
      }
      sendAuthError(res,e)
    }
  })
  app.post("/auth/register", async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        email?:    string
        password?: string
        name?:     string
        product?:  string
      }
      const email = String(body.email ?? "")
      const password = String(body.password ?? "")
      const name = body.name ? String(body.name) : undefined
      const product = parseRegisterProduct(body.product)
      const result = await registerUser(email, password, { name, product })
      res.status(201).json({ ok: true, ...result })
    } catch (e) {
      sendAuthError(res, e)
    }
  })

  app.get("/auth/verify-email", async (req: Request, res: Response) => {
    try {
      const token = String(req.query.token ?? "")
      const result = await verifyEmailToken(token)
      res.status(200).json({ ok: true, ...result })
    } catch (e) {
      sendAuthError(res, e)
    }
  })

  app.post("/auth/verify-email", async (req: Request, res: Response) => {
    try {
      const body = req.body as { token?: string }
      const token = String(body.token ?? req.query?.token ?? "")
      const result = await verifyEmailToken(token)
      res.status(200).json({ ok: true, ...result })
    } catch (e) {
      sendAuthError(res, e)
    }
  })

  app.post("/auth/login", async (req: Request, res: Response) => {
    try {
      const body = req.body as { email?: string; password?: string }
      const result = await loginUser(String(body.email ?? ""), String(body.password ?? ""))

      if (result.kind === "blocked") {
        res.status(403).json({
          ok:      false,
          status:  result.status,
          message: result.message,
        })
        return
      }

      const issued = await issueSession(result.user.id, requestSessionMetadata(req))
      await insertAuditLog({actorUserId:result.user.id,action:"session.login",targetType:"session",targetId:issued.session.id})
      setSessionCookie(res, issued.rawToken)
      res.status(200).json({
        ok:    true,
        user:  result.user,
      })
    } catch (e) {
      sendAuthError(res, e)
    }
  })

  app.get("/auth/me", async (req: Request, res: Response) => {
    try {
      const ctx = await resolveAuthContext(req)
      if (!ctx) {
        res.status(401).json({ ok: false, error: "Not authenticated" })
        return
      }
      const fresh = await getMeFromUserId(ctx.user.id)
      if (!fresh) {
        res.status(401).json({ ok: false, error: "User not found" })
        return
      }
      res.status(200).json({ ok: true, user: fresh })
    } catch (e) {
      sendAuthError(res, e)
    }
  })

  app.get("/auth/product-access", requireActiveUser, async (req: Request, res: Response) => {
    try {
      const userId = (req as AuthedRequest).auth?.user.id
      if (!userId) {
        res.status(401).json({ ok: false, error: "Not authenticated" })
        return
      }
      const access = await getProductAccessForUser(userId)
      res.status(200).json({ ok: true, source: "db", userId, access })
    } catch (e) {
      sendAuthError(res, e)
    }
  })

  app.post("/auth/logout", async (req: Request, res: Response) => {
    try {
      const ctx=await resolveAuthContext(req)
      if (ctx?.session) { await revokeSession(ctx.session.id,ctx.user.id,"logout"); await insertAuditLog({actorUserId:ctx.user.id,action:"session.logout",targetType:"session",targetId:ctx.session.id}) }
      clearSessionCookie(res); res.status(200).json({ok:true})
    } catch(e) { sendAuthError(res,e) }
  })

  app.post("/auth/logout-all", requireActiveUser, async (req:Request,res:Response)=>{
    try { const ctx=(req as AuthedRequest).auth!; await revokeAllUserSessions(ctx.user.id,"logout_all"); await insertAuditLog({actorUserId:ctx.user.id,action:"session.logout_all",targetType:"user",targetId:ctx.user.id}); clearSessionCookie(res); res.status(200).json({ok:true}) }
    catch(e){sendAuthError(res,e)}
  })

  app.get("/auth/sessions", requireActiveUser, async (req:Request,res:Response)=>{
    try { const ctx=(req as AuthedRequest).auth!; const rows=await listActiveSessionsForUser(ctx.user.id)
      res.status(200).json({ok:true,sessions:rows.map(s=>({sessionId:s.id,createdAt:s.createdAt,lastSeenAt:s.lastSeenAt,expiresAt:s.expiresAt,ipAddress:s.ipAddress,userAgent:s.userAgent,isCurrent:s.id===ctx.session?.id}))})
    } catch(e){sendAuthError(res,e)}
  })

  app.get("/auth/login-methods",requireActiveUser,async(req:Request,res:Response)=>{
    try{const userId=(req as AuthedRequest).auth!.user.id;const [password,identities]=await Promise.all([hasPasswordCredential(userId),listExternalIdentities(userId)]);const google=identities.find(x=>x.provider==="google");res.status(200).json({ok:true,password:{connected:password},google:{available:googleEnabled(),connected:Boolean(google),email:google?.providerEmail??null},needsPasswordSetup:!password})}catch(e){sendAuthError(res,e)}
  })

  app.post("/auth/password/set", requireActiveUser, async (req: Request, res: Response) => {
    try {
      const userId = (req as AuthedRequest).auth!.user.id
      const body = req.body as { password?: string; confirmPassword?: string }
      const password = String(body.password ?? "")
      const confirmPassword = String(body.confirmPassword ?? "")
      const user = await setInitialPasswordForUser(userId, password, confirmPassword)
      res.status(200).json({ ok: true, user })
    } catch (e) {
      sendAuthError(res, e)
    }
  })

  app.post("/auth/password/change", requireActiveUser, async (req: Request, res: Response) => {
    try {
      const userId = (req as AuthedRequest).auth!.user.id
      const body = req.body as {
        currentPassword?: string
        newPassword?: string
        confirmPassword?: string
      }
      const user = await changePasswordForUser(
        userId,
        String(body.currentPassword ?? ""),
        String(body.newPassword ?? ""),
        String(body.confirmPassword ?? "")
      )
      res.status(200).json({ ok: true, user })
    } catch (e) {
      sendAuthError(res, e)
    }
  })

  app.post("/auth/password/forgot", async (req: Request, res: Response) => {
    try {
      const email = String((req.body as { email?: string }).email ?? "")
      const result = await requestPasswordReset(email)
      res.status(200).json({ ok: true, message: result.message })
    } catch (e) {
      sendAuthError(res, e)
    }
  })

  app.post("/auth/password/reset", async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        token?: string
        password?: string
        confirmPassword?: string
      }
      await resetPasswordWithToken(
        String(body.token ?? ""),
        String(body.password ?? ""),
        String(body.confirmPassword ?? "")
      )
      res.status(200).json({ ok: true, message: "Password updated. You can sign in with your new password." })
    } catch (e) {
      sendAuthError(res, e)
    }
  })

  app.delete("/auth/sessions/:id", requireActiveUser, async (req:Request,res:Response)=>{
    try { const ctx=(req as AuthedRequest).auth!; const id=String(req.params.id??""); const revoked=await revokeSession(id,ctx.user.id,"user_revoked")
      if(!revoked){res.status(404).json({ok:false,error:"Session not found"});return}
      if(id===ctx.session?.id) clearSessionCookie(res)
      res.status(200).json({ok:true})
    } catch(e){sendAuthError(res,e)}
  })
}
