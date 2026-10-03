/** Resident Core scheduler; consent and spending remain provider-owned. */
export type PersonalProbeCandidate = {accountRef:string;credentialGeneration:number;scope:string;enabled:boolean;ackCost:boolean;credentialType:string;eligibility:string;budget:{remaining:number;machineRemaining:number;retryAt:number|null}}
type Deps = {now():number;online():boolean;inUse():boolean;roster():Promise<PersonalProbeCandidate[]>;collect(row:PersonalProbeCandidate,signal:AbortSignal):Promise<unknown>}
export function createPersonalProbeScheduler(deps:Deps) {
 const next=new Map<string,number>();let closed=false,reading=false
 let flight:{row:PersonalProbeCandidate;controller:AbortController}|null=null
 const permitted=(r:PersonalProbeCandidate)=>r.scope==='personal'&&r.enabled&&r.ackCost&&r.credentialType==='setup_token'&&!['disabled','managed','account-disabled','scope-missing'].includes(r.eligibility)
 function cancel(ref?:string){if(flight&&(!ref||flight.row.accountRef===ref))flight.controller.abort()}
 async function tick() {
  if(closed)return
  if(!deps.online()||!deps.inUse()){cancel();return}
  if(reading)return
  reading=true
  try {
   const rows=await deps.roster()
   if(new Set(rows.map(r=>r.accountRef)).size!==rows.length){cancel();return}
   if(closed||!deps.online()||!deps.inUse()){cancel();return}
   if(flight){
    const current=rows.find(r=>r.accountRef===flight!.row.accountRef&&r.credentialGeneration===flight!.row.credentialGeneration)
    if(!current||!permitted(current))cancel()
    return
   }
   const now=deps.now()
   const row=rows.filter(r=>permitted(r)&&r.eligibility==='eligible'&&r.budget.remaining>0&&r.budget.machineRemaining>0&&(!r.budget.retryAt||r.budget.retryAt<=now)&&now>=(next.get(r.accountRef)??0)).sort((a,b)=>a.accountRef.localeCompare(b.accountRef))[0]
   if(!row)return
   const current={row,controller:new AbortController()};flight=current
   next.set(row.accountRef,now+900000)
   // Shared runtime serialization plus provider singleflight includes org probes.
   void deps.collect(row,current.controller.signal).catch(()=>undefined).finally(()=>{if(flight===current)flight=null})
  }catch{cancel()}finally{reading=false}
 }
 return {tick,cancel,close:()=>{closed=true;cancel()},running:()=>Boolean(flight)}
}
/** Only fresh, live Claude reports with actual use qualify; stale/recovered is unknown. */
export function hasActiveClaudeUse(sessions:ReadonlyArray<{pid:number;happySessionMetadataFromLocalWebhook?:{flavor?:string};runtime?:{updatedAt:number;thinking:boolean;hasOpenToolCall:boolean;pendingUserInput?:boolean;lastUserInteractionAt?:number}}>,now:number,alive:(pid:number)=>boolean):boolean {
 return sessions.some(s=>s.happySessionMetadataFromLocalWebhook?.flavor==='claude'&&alive(s.pid)&&s.runtime&&now>=s.runtime.updatedAt&&now-s.runtime.updatedAt<=120000&&(s.runtime.thinking||s.runtime.hasOpenToolCall||s.runtime.pendingUserInput===true||(typeof s.runtime.lastUserInteractionAt==='number'&&now>=s.runtime.lastUserInteractionAt&&now-s.runtime.lastUserInteractionAt<900000)))
}
