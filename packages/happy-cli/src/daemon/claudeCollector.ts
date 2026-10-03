/** Trusted Core bridge. Studio bearer and credential bytes never enter this DTO. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
export type CollectorRequest = {version:1;companyId:string;userId:string;machineId:string;managedAccountId:string;accountRef:string;permitId:string;credentialGeneration:number;policyRevision:number;grant:string}
type Deps = {studioOrigin:string|null;machineId:string;now():number;fetchImpl?:typeof fetch;authorize(request:CollectorRequest):Promise<boolean>;consume(id:string,expiresAt:number):Promise<boolean>;invoke(args:string[],input?:string):Promise<string>}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const exact = (value:any,keys:string[]) => value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join('|')===keys.sort().join('|')
const integer = (n:unknown):n is number => Number.isSafeInteger(n) && Number(n)>=0
const failure = (error:string,action=false) => ({version:1,status:action?'action-required':'unavailable',error:'COLLECTOR_'+error})
export async function collectorVerificationReady(studioOrigin:string|null, fetchImpl?:typeof fetch):Promise<boolean> {
 return Boolean(await publicKey({studioOrigin,fetchImpl}))
}
async function publicKey(deps:Pick<Deps,'studioOrigin'|'fetchImpl'>) {
 if(!deps.studioOrigin) return null
 try {
  const origin=new URL(deps.studioOrigin)
  if(origin.username||origin.password||origin.origin!==deps.studioOrigin || (origin.protocol!=='https:' && !(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname))))return null
  const response=await (deps.fetchImpl??fetch)(new URL('/api/claude-collector/public-key',origin),{redirect:'error',signal:AbortSignal.timeout(5000)})
  if(!response.ok||!response.body)return null
  const reader=response.body.getReader();const parts:Uint8Array[]=[];let length=0
  try {while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>8192)return null;parts.push(value)}}finally{await reader.cancel()}
  const data=JSON.parse(Buffer.concat(parts).toString('utf8'))
  const audience='claude-collector-v1@'+origin.origin
  if(data.version!==1||data.type!=='claude-collector-v1'||data.algorithm!=='Ed25519'||data.audience!==audience||typeof data.publicKeyBase64!=='string')return null
  const der=Buffer.from(data.publicKeyBase64,'base64')
  if(createHash('sha256').update(der).digest('hex')!==data.keyId)return null
  const key=createPublicKey({key:der,type:'spki',format:'der'})
  if(key.asymmetricKeyType!=='ed25519')return null
  return {key,keyId:data.keyId,audience}
 }catch{return null}
}
function epoch(value:unknown):number|null {
 if(value===null)return null
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))throw new Error()
 const n=Date.parse(value);if(!integer(n))throw new Error();return n
}
function observation(raw:any,claims:any) {
 if(raw?.source!=='inference_probe'||raw.coverage!=='unknown'||!Array.isArray(raw.windows)||raw.windows.length>2)throw new Error()
 const observedAt=epoch(raw.observedAt)
 if(observedAt===null||observedAt<claims.reservedAt||observedAt>claims.transportDeadline)throw new Error()
 const kinds=new Set<string>()
 const windows=raw.windows.map((w:any)=>{
  if(!['unified5h','unified7d'].includes(w.kind)||kinds.has(w.kind))throw new Error();kinds.add(w.kind)
  if(w.pct!==null&&(typeof w.pct!=='number'||!Number.isFinite(w.pct)||w.pct<0||w.pct>100))throw new Error()
  return {kind:w.kind,pct:w.pct,resetsAt:epoch(w.resetsAt)}
 })
 const reasons:Record<string,string>={coverage_unknown:windows.some((w:any)=>w.pct!==null)?'ok':'headers-missing',throttled:'rate-limited',authentication_failed:'authentication-failed',scope_missing:'scope-missing',timeout:'timeout'}
 return {source:'inference_probe',observedAt,windows,coverage:'unknown',reason:reasons[raw.reason]??'request-failed',retryAt:epoch(raw.retryAt)}
}
export function createClaudeCollector(deps:Deps) {
 return async (input:unknown) => {
  try {
   if(!exact(input,['version','companyId','userId','machineId','managedAccountId','accountRef','permitId','credentialGeneration','policyRevision','grant']))return failure('GRANT_INVALID')
   const r=input as CollectorRequest
   if(r.version!==1||r.machineId!==deps.machineId||![r.companyId,r.userId,r.machineId].every(v=>typeof v==='string'&&v.length>0&&v.length<=128)||!uuid.test(r.managedAccountId)||!uuid.test(r.accountRef)||!uuid.test(r.permitId)||!integer(r.credentialGeneration)||r.credentialGeneration<1||!integer(r.policyRevision)||r.policyRevision<1||typeof r.grant!=='string'||Buffer.byteLength(r.grant)>8192)return failure('GRANT_INVALID')
   const trust=await publicKey(deps);if(!trust)return failure('SIGNER_UNAVAILABLE',true)
   const segments=r.grant.split('.')
   if(segments.length!==2||segments.some(s=>!s||!/^[A-Za-z0-9_-]+$/.test(s)))return failure('GRANT_INVALID')
   if(!verify(null,Buffer.from(segments[0]),trust.key,Buffer.from(segments[1],'base64url')))return failure('GRANT_INVALID')
   const c=JSON.parse(Buffer.from(segments[0],'base64url').toString('utf8'))
   if(!exact(c,['v','type','aud','keyId','companyId','userId','machineId','managedAccountId','credentialGeneration','policyRevision','permitId','reservedAt','transportDeadline','expiresAt'])||c.v!==1||c.type!=='claude-collector-v1'||c.aud!==trust.audience||c.keyId!==trust.keyId||!uuid.test(c.permitId))return failure('GRANT_INVALID')
   for(const f of ['companyId','userId','machineId','managedAccountId','credentialGeneration','policyRevision','permitId'] as const)if(c[f]!==r[f])return failure('GRANT_INVALID')
   if(![c.reservedAt,c.transportDeadline,c.expiresAt].every(integer)||c.transportDeadline!==c.reservedAt+10000||c.expiresAt!==c.reservedAt+30000||c.reservedAt>deps.now())return failure('GRANT_INVALID')
   if(deps.now()>=c.transportDeadline)return failure('PERMIT_EXPIRED')
   if(!await deps.authorize(r))return failure('ACCOUNT_NOT_ASSIGNED')
   const caps=JSON.parse(await deps.invoke(['token-runtime','capabilities']))
   if(caps.artifact!=='saycode-setup-token-runtime-v1'||caps.organizationCollectorVersion!==1)return failure('RUNTIME_UNSUPPORTED')
   const roster=JSON.parse(await deps.invoke(['token-runtime','status']))
   const rows=roster.accounts?.filter((a:any)=>a.managedAccountId===r.managedAccountId)
   const a=rows?.length===1?rows[0]:null
   if(!a||a.accountRef!==r.accountRef||!uuid.test(a.accountRef)||a.managedAccountId!==r.managedAccountId||a.credentialGeneration!==r.credentialGeneration||a.credentialType!=='setup_token'||a.disabled)return failure('GENERATION_CHANGED')
   // Fresh local ownership and time check after key/provider reads.
   if(!await deps.authorize(r))return failure('ACCOUNT_NOT_ASSIGNED')
   if(deps.now()>=c.transportDeadline)return failure('PERMIT_EXPIRED')
   if(!await deps.consume(c.companyId+':'+c.permitId,c.expiresAt))return failure('PERMIT_REPLAYED')
   const permit={version:1,permitId:c.permitId,companyId:c.companyId,machineId:c.machineId,managedAccountId:c.managedAccountId,credentialGeneration:c.credentialGeneration,policyRevision:c.policyRevision,reservedAt:c.reservedAt,transportDeadline:c.transportDeadline,expiresAt:c.expiresAt,timeoutMs:10000,accountRemaining:0,companyRemaining:0}
   const context={companyId:r.companyId,machineId:r.machineId,managedAccountId:r.managedAccountId,credentialGeneration:r.credentialGeneration,policyRevision:r.policyRevision,accountRef:a.accountRef}
   const result=JSON.parse(await deps.invoke(['token-runtime','collect-org'],JSON.stringify({version:1,context,permit,inUse:true,online:true})))
   if(!await deps.authorize(r))return failure('ACCOUNT_NOT_ASSIGNED')
   if(deps.now()>=c.expiresAt)return failure('PERMIT_EXPIRED')
   if(!result.observation)return failure('REQUEST_FAILED')
   if(result.observation.accountRef!==a.accountRef||result.observation.credentialGeneration!==r.credentialGeneration)return failure('GENERATION_CHANGED')
   return {version:1,status:'observed',companyId:r.companyId,machineId:r.machineId,managedAccountId:r.managedAccountId,credentialGeneration:r.credentialGeneration,policyRevision:r.policyRevision,permitId:c.permitId,observation:observation(result.observation,c)}
  }catch{return failure('REQUEST_FAILED')}
 }
}
/** Exclusive on-disk lock; crash leaves the gate closed until explicit recovery. */
export async function consumeCollectorPermit(directory:string,id:string,expiresAt:number,now:number):Promise<boolean> {
 await mkdir(directory,{recursive:true,mode:0o700})
 const lock=join(directory,'consume.lock')
 await mkdir(lock,{mode:0o700})
 try {
  const path=join(directory,'permits.json');let permits:Record<string,number>={}
  try {permits=JSON.parse(await readFile(path,'utf8'))}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
  if(!permits||Array.isArray(permits)||typeof permits!=='object'||Object.entries(permits).some(([k,v])=>!/^[a-f0-9]{64}$/.test(k)||!integer(v)))throw new Error()
  const digest=createHash('sha256').update(id).digest('hex')
  if(digest in permits)return false
  permits=Object.fromEntries(Object.entries(permits).filter(([,v])=>v>now-86400000))
  if(Object.keys(permits).length>=10000)throw new Error()
  permits[digest]=expiresAt
  const temp=join(directory,'permits.pending');const file=await open(temp,'w',0o600)
  try {await file.writeFile(JSON.stringify(permits));await file.sync()}finally{await file.close()}
  await rename(temp,path)
  if(process.platform!=='win32'){const dir=await open(directory,'r');try{await dir.sync()}finally{await dir.close()}}
  return true
 }finally{await rm(lock,{recursive:true})}
}
