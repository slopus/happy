/** Explicit personal probe actions; no scheduler or organization consent fallback. */
type Deps = {invoke(args:string[]):Promise<string>}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const fail=(error:string)=>({version:1,status:'unavailable',error:'TOKEN_PROBE_'+error})
export function personalProbeSupported(c:any):boolean {
 return c?.artifact==='saycode-setup-token-runtime-v1'&&c.setupTokenObservation===true&&c.durableProbeBudget===true&&c.personalProbeVersion===1
}
function iso(value:unknown) {
 if(value===null)return true
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))return false
 const time=Date.parse(value);return Number.isSafeInteger(time)&&time>=0
}
function safeObservation(o:any) {
 if(!o)return undefined
 if(o.source!=='inference_probe'||o.coverage!=='unknown'||o.observedAt===null||!iso(o.observedAt)||!Array.isArray(o.windows)||o.windows.length>2)throw new Error()
 const kinds=new Set<string>()
 const windows=o.windows.map((w:any)=>{
  if(!['unified5h','unified7d'].includes(w.kind)||kinds.has(w.kind)||!(w.pct===null||typeof w.pct==='number'&&Number.isFinite(w.pct)&&w.pct>=0&&w.pct<=100)||!iso(w.resetsAt))throw new Error()
  kinds.add(w.kind);return {kind:w.kind,pct:w.pct,resetsAt:w.resetsAt}
 })
 if(typeof o.reason!=='string'||!['coverage_unknown','throttled','authentication_failed','scope_missing','transport_failed','response_too_large','redirect_refused','bad_request','not_found','provider_unavailable','unknown_status'].includes(o.reason)||!iso(o.retryAt))throw new Error()
 return {source:'inference_probe',observedAt:o.observedAt,windows,coverage:'unknown',reason:o.reason,retryAt:o.retryAt}
}
function safeAccount(a:any) {
 if(typeof a.accountRef!=='string'||!uuid.test(a.accountRef)||!Number.isSafeInteger(a.credentialGeneration)||a.credentialGeneration<1)throw new Error()
 if(typeof a.probeEnabled!=='boolean'||!['setup_token','oauth','api_key'].includes(a.credentialType)||!['unverified','expiry-unknown','invalid','usable'].includes(a.authState)||!['probe-disabled','unavailable','scope-missing','partial','stale','backing-off'].includes(a.usageStatus)||!Array.isArray(a.reasonCodes)||a.reasonCodes.some((s:any)=>!['coverage_unknown','writer_ownership_unavailable','probe_disabled','not_observed','scope_diagnosis_required','legacy_source','scope_missing','throttled','authentication_failed','transport_failed','response_too_large','redirect_refused','bad_request','not_found','provider_unavailable','unknown_status'].includes(s)))throw new Error()
   if(a.managedAccountId&&!uuid.test(a.managedAccountId))throw new Error()
   return {accountRef:a.accountRef,credentialGeneration:a.credentialGeneration,credentialType:a.credentialType,probeEnabled:a.probeEnabled,authState:a.authState,usageStatus:a.usageStatus,decisionEligible:false,reasonCodes:a.reasonCodes,...(a.managedAccountId?{managedAccountId:a.managedAccountId}:{}),...(a.observation?{observation:safeObservation(a.observation)}:{})}
}
export async function readTokenRuntime(deps:Deps) {
 try {
  const c=JSON.parse(await deps.invoke(['token-runtime','capabilities']))
  if(c.artifact!=='saycode-setup-token-runtime-v1'||c.setupTokenObservation!==true)return null
  const status=JSON.parse(await deps.invoke(['token-runtime','status']))
  if(!Array.isArray(status.accounts)||status.accounts.length>500)return null
  const accounts=status.accounts.map((a:any)=>{
   const account=safeAccount(a)
   if(!Number.isSafeInteger(a.number)||a.number<1||!a.roster||!['email','organizationUuid','uuid'].every(k=>typeof a.roster[k]==='string'&&a.roster[k].length<=320))throw new Error()
   return {...account,number:a.number,roster:{email:a.roster.email,organizationUuid:a.roster.organizationUuid,uuid:a.roster.uuid},legacyUsageOwned:false}
  })
  return {version:1,state:'available',accounts}
 }catch{return null}
}
export function createTokenProbe(deps:Deps) {
 return async(input:any)=>{
  try {
   if(!input||Array.isArray(input)||input.version!==1||!['status','consent','collect'].includes(input.operation)||typeof input.accountRef!=='string'||!uuid.test(input.accountRef)||!Number.isSafeInteger(input.credentialGeneration)||input.credentialGeneration<1)return fail('INVALID_INPUT')
   const keys=['version','operation','accountRef','credentialGeneration',...(input.operation==='consent'?['enabled','ackCost']:[])]
   if(Object.keys(input).some(k=>!keys.includes(k)))return fail('INVALID_INPUT')
   if(input.operation==='consent'){
    if(typeof input.enabled!=='boolean'||(input.ackCost!==undefined&&typeof input.ackCost!=='boolean'))return fail('INVALID_INPUT')
    if(input.enabled&&input.ackCost!==true)return fail('COST_ACK_REQUIRED')
   }
   if(!personalProbeSupported(JSON.parse(await deps.invoke(['token-runtime','capabilities']))))return fail('RUNTIME_UNSUPPORTED')
   const read=async()=>{
    const status=JSON.parse(await deps.invoke(['token-runtime','status']))
    const rows=status.accounts?.filter((a:any)=>a.accountRef===input.accountRef)
    if(rows?.length!==1)return {error:'ACCOUNT_NOT_FOUND'}
    if(rows[0].credentialGeneration!==input.credentialGeneration)return {error:'GENERATION_CHANGED'}
    return {row:rows[0],budget:status.budget}
   }
   const before=await read();if(before.error)return fail(before.error)
   if(input.operation!=='status'&&(before.row.managedAccountId||before.row.roster?.organizationUuid))return fail('ORGANIZATION_COLLECTOR_REQUIRED')
   if(input.operation!=='status'){
    const args=['token-runtime',input.operation,input.accountRef,'--generation',String(input.credentialGeneration)]
    args.push(...(input.operation==='collect'?['--in-use']:input.enabled?['--enable','--ack-cost']:['--disable']))
    const result=JSON.parse(await deps.invoke(args))
    if(result.reason){
     const codes:Record<string,string>={credential_changed:'GENERATION_CHANGED',backing_off:'BACKING_OFF',budget_exhausted:'BUDGET_EXHAUSTED',collector_busy:'COLLECTOR_BUSY',probe_disabled:'PROBE_DISABLED',account_disabled:'ACCOUNT_DISABLED'}
     return fail(codes[result.reason]??'REQUEST_FAILED')
    }
   }
   const after=await read();if(after.error)return fail(after.error)
   if(input.operation!=='status'&&(after.row.managedAccountId||after.row.roster?.organizationUuid))return fail('ORGANIZATION_COLLECTOR_REQUIRED')
   const a=after.row
   const account=safeAccount(a)
   const b=after.budget
   if(!b||!['machineUsed24h','machineLimit24h','accountLimit24h'].every(k=>Number.isSafeInteger(b[k])&&b[k]>=0))throw new Error()
   return {version:1,operation:input.operation,accountRef:a.accountRef,credentialGeneration:a.credentialGeneration,account,budget:{machineUsed24h:b.machineUsed24h,machineLimit24h:b.machineLimit24h,accountLimit24h:b.accountLimit24h}}
  }catch{return fail('REQUEST_FAILED')}
 }
}
