import type { Request, Response } from "express"
import {
  claimNextAmazonSupplierReadJob, getAmazonReaderAvailability, getAmazonSupplierReadJob,
  recordAmazonReaderHeartbeat, submitAmazonSupplierReadResult, updateAmazonSupplierReadJobStatus,
  type AmazonReaderProductPayload,
} from "./chatgptAmazonSupplierReadService"

function json(res: Response, status: number, body: unknown): void { res.status(status).json(body) }
export function amazonReaderHeartbeatHandler(req: Request, res: Response): void {
  const result = recordAmazonReaderHeartbeat({ readerInstanceId: String((req.body ?? {}).readerInstanceId || "") })
  json(res, 200, { ok: true, ...result, ...getAmazonReaderAvailability() })
}
export function amazonReaderAvailabilityHandler(_req: Request, res: Response): void { json(res, 200, { ok: true, ...getAmazonReaderAvailability() }) }
export function amazonReaderClaimHandler(req: Request, res: Response): void {
  const readerInstanceId = String((req.body ?? {}).readerInstanceId || "").trim()
  if (!readerInstanceId) return json(res, 400, { ok: false, error: "readerInstanceId required" })
  recordAmazonReaderHeartbeat({ readerInstanceId }); const job = claimNextAmazonSupplierReadJob({ readerInstanceId })
  if (!job) return json(res, 200, { ok: true, job: null })
  json(res, 200, { ok:true, job:{ jobId:job.jobId, status:job.status, suppliedUrl:job.suppliedUrl, asin:job.asin, shopId:job.shopId, workspaceId:job.workspaceId, selectedVariationKey:job.selectedVariationKey } })
}
export function amazonReaderJobStatusHandler(req: Request, res: Response): void {
  const job = getAmazonSupplierReadJob(String(req.params.jobId || "").trim())
  if (!job) return json(res, 404, { ok:false, error:"JOB_NOT_FOUND" })
  json(res, 200, { ok:true, job:{ jobId:job.jobId, status:job.status, suppliedUrl:job.suppliedUrl, asin:job.asin, browserTabOpened:job.browserTabOpened, captchaEncountered:job.captchaEncountered, draftId:job.draftId, panelPath:job.panelPath, panelDraftSaved:job.panelDraftSaved, databaseWritePerformed:job.databaseWritePerformed, errorMessage:job.errorMessage } })
}
export function amazonReaderProgressHandler(req: Request, res: Response): void {
  const body=(req.body ?? {}) as {jobId?:string;status?:string;browserTabOpened?:boolean;captchaEncountered?:boolean}; const jobId=String(body.jobId||"").trim(); const status=String(body.status||"").trim()
  if (!jobId) return json(res,400,{ok:false,error:"jobId required"}); if (!new Set(["opening_supplier_page","reading_supplier_page","awaiting_user_verification"]).has(status)) return json(res,400,{ok:false,error:"invalid status"})
  const job=updateAmazonSupplierReadJobStatus(jobId,{status:status as "opening_supplier_page"|"reading_supplier_page"|"awaiting_user_verification",browserTabOpened:Boolean(body.browserTabOpened),captchaEncountered:Boolean(body.captchaEncountered)})
  if(!job) return json(res,404,{ok:false,error:"JOB_NOT_FOUND"}); json(res,200,{ok:true,status:job.status})
}
export async function amazonReaderResultHandler(req: Request,res: Response): Promise<void> {
  const body=(req.body??{}) as {jobId?:string;readerInstanceId?:string;captchaEncountered?:boolean;userVerificationCompleted?:boolean;payload?:AmazonReaderProductPayload}; const jobId=String(body.jobId||"").trim()
  if(!jobId||!body.payload) return json(res,400,{ok:false,error:"jobId and payload required"})
  const submitted=submitAmazonSupplierReadResult({jobId,readerInstanceId:body.readerInstanceId,payload:body.payload,captchaEncountered:body.captchaEncountered,userVerificationCompleted:body.userVerificationCompleted})
  if(!submitted.ok) return json(res,400,{ok:false,code:submitted.code,message:submitted.message})
  if(submitted.duplicate && (submitted.job.status==="panel_draft_saved"||submitted.job.status==="panel_draft_updated")) return json(res,200,{ok:true,duplicate:true,status:submitted.job.status,draftId:submitted.job.draftId,panelPath:submitted.job.panelPath})
  // Source acquisition is intentionally independent from marketplace preview/draft persistence.
  json(res,200,{ok:true,duplicate:submitted.duplicate,status:submitted.job.status,sourceReadSucceeded:true,draftSaved:false})
}
