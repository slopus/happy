import { createHash } from 'node:crypto'
/** Group custody journal: hashes only, durable intent before changing credentials. */
export type GroupProvider = 'claude' | 'codex'
export type CredentialGroupRequest = {
  version: 1
  scope: string
  provider: GroupProvider
  generation: number
  fingerprint: string
  payload: string | null
  /** Setup-token wire: the provider bundle generation (equal to `generation`) and the Studio lease it applies. */
  assignmentGeneration?: number
  leaseId?: string
} & ({ principalType?: 'user'; userId: string; machineId?: never } | { principalType: 'machine'; machineId: string; userId?: never })
type NormalizedRequest = { version:1; scope:string; principalType:'user'|'machine'; userId:string; machineId?:string; provider:GroupProvider; generation:number; fingerprint:string; payload:string|null; assignmentGeneration?:number; leaseId?:string }
export type AppliedCredentialReceipt = { managedAccountId:string; credentialGeneration:number }
/** `managed`: the desired identities that are org-managed setup-tokens (absent in older journals). */
type Entry = Omit<NormalizedRequest,'version'|'payload'> & { desired:string[]; owned:string[]; pending:boolean; payloadDigest:string|null; managed?:string[]; appliedCredentials?:AppliedCredentialReceipt[] }
type Journal = { version:1; entries:Entry[] }
export type CredentialGroupDeps = {
  read():Promise<string|null>; write(value:string):Promise<void>
  snapshot(provider:GroupProvider):Promise<string[]>
  incoming(provider:GroupProvider,payload:string):string[]
  managedIdentities?(provider:GroupProvider,payload:string):string[]
  /** Secret-free receipt projection for setup-token rows applied by this operation. */
  appliedCredentials?(provider:GroupProvider,payload:string,applied:unknown):AppliedCredentialReceipt[]
  /** `owned` are identities this scope installed earlier: the only slots it may replace. */
  apply(provider:GroupProvider,payload:string,owned:string[]):Promise<unknown>
  remove(provider:GroupProvider,identities:string[]):Promise<void>
}
const fail=(code:string):never=>{throw new Error(code)}
const id=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=128
function request(value:CredentialGroupRequest):NormalizedRequest {
  if(!value||value.version!==1||!id(value.scope)
    ||!['claude','codex'].includes(value.provider)||!Number.isSafeInteger(value.generation)||value.generation<1
    ||!(/^[a-f0-9]{64}$/).test(value.fingerprint)||!(value.payload===null||typeof value.payload==='string'&&Buffer.byteLength(value.payload)<=1024*1024)
    ||(value.assignmentGeneration!==undefined&&(!Number.isSafeInteger(value.assignmentGeneration)||value.assignmentGeneration!==value.generation))
    ||(value.leaseId!==undefined&&!/^[A-Za-z0-9_-]{1,128}$/.test(value.leaseId)))fail('AI_GROUP_INVALID_INPUT')
  const principalType=value.principalType??'user'
  if(principalType==='machine') {
    const machineId=value.machineId
    if(typeof machineId!=='string'||!id(machineId)||value.userId!==undefined)fail('AI_GROUP_INVALID_INPUT')
    return {...value,principalType,userId:machineId as string,machineId:machineId as string}
  }
  const userId=value.userId
  if(principalType!=='user'||typeof userId!=='string'||!id(userId)||value.machineId!==undefined)fail('AI_GROUP_INVALID_INPUT')
  return {...value,principalType,userId:userId as string}
}
const principalType=(entry:Pick<Entry,'principalType'>)=>entry.principalType??'user'
const samePrincipal=(entry:Pick<Entry,'principalType'|'userId'|'machineId'>, request:Pick<NormalizedRequest,'principalType'|'userId'|'machineId'>) => principalType(entry)===request.principalType && (request.principalType==='machine' ? entry.machineId===request.machineId : entry.userId===request.userId)
/** One user assignment per scope and provider (a new userId replaces it); machine assignments are kept per machine. */
const sameSlot=(entry:Pick<Entry,'principalType'|'machineId'>, request:Pick<NormalizedRequest,'principalType'|'machineId'>) => principalType(entry)===request.principalType && (request.principalType!=='machine' || entry.machineId===request.machineId)
function validAppliedCredentials(values:unknown):values is AppliedCredentialReceipt[] {
  return Array.isArray(values)&&values.length<=500
    &&values.every(value=>value&&id(value.managedAccountId)&&Number.isSafeInteger(value.credentialGeneration)&&value.credentialGeneration>=1)
    &&new Set(values.map(value=>value.managedAccountId)).size===values.length
}
function parse(raw:string|null):Journal {
  if(raw===null)return {version:1,entries:[]}
  try {
    if(Buffer.byteLength(raw)>1024*1024)fail('AI_GROUP_JOURNAL_INVALID')
    const value=JSON.parse(raw) as Journal
    if(value.version!==1||!Array.isArray(value.entries)||value.entries.length>1000)fail('AI_GROUP_JOURNAL_INVALID')
    for(const entry of value.entries){
      const candidate = principalType(entry)==='machine' ? {...entry,userId:undefined} : entry
      request({...candidate,version:1,payload:null} as CredentialGroupRequest)
      if (principalType(entry)==='machine' && !id(entry.machineId)) fail('AI_GROUP_JOURNAL_INVALID')
      if(!(entry.payloadDigest===null||typeof entry.payloadDigest==='string'&&/^[a-f0-9]{64}$/.test(entry.payloadDigest))||typeof entry.pending!=='boolean'||![entry.desired,entry.owned,entry.managed??[]].every(items=>Array.isArray(items)&&items.length<=1000&&items.every(id)))fail('AI_GROUP_JOURNAL_INVALID')
      if(entry.appliedCredentials!==undefined&&!validAppliedCredentials(entry.appliedCredentials))fail('AI_GROUP_JOURNAL_INVALID')
    }
    if(new Set(value.entries.map(e=>JSON.stringify([e.scope,e.provider,principalType(e),principalType(e)==='machine'?e.machineId:null]))).size!==value.entries.length)fail('AI_GROUP_JOURNAL_INVALID')
    return value
  }catch{ return fail('AI_GROUP_JOURNAL_INVALID') }
}
const receipt=(entry:Entry)=>({version:1 as const,scope:entry.scope, ...(principalType(entry)==='machine' ? {principalType:'machine' as const,machineId:entry.machineId} : {userId:entry.userId}),provider:entry.provider,generation:entry.generation,fingerprint:entry.fingerprint,payloadDigest:entry.payloadDigest,reconciled:!entry.pending,
  assignmentGeneration:entry.assignmentGeneration??entry.generation,leaseId:entry.leaseId??null,appliedCredentials:[...(entry.appliedCredentials??[])]})
export function createCredentialGroupSync(deps:CredentialGroupDeps) {
  async function readReceipt(scope:string,provider:GroupProvider, principal?: Pick<NormalizedRequest,'principalType'|'userId'|'machineId'>) {
    return parse(await deps.read()).entries.find(e=>e.scope===scope&&e.provider===provider&&(principal?samePrincipal(e,principal):principalType(e)==='user'))
  }
  async function sync(input:CredentialGroupRequest) {
    const normalized=request(input)
    const journal=parse(await deps.read())
    const prior=journal.entries.find(e=>e.scope===normalized.scope&&e.provider===normalized.provider&&sameSlot(e,normalized))
    if(prior&&normalized.generation<prior.generation)fail('AI_GROUP_GENERATION_STALE')
    if(prior&&normalized.generation===prior.generation&&(normalized.fingerprint!==prior.fingerprint||!samePrincipal(effectivePrincipal(prior),normalized)))fail('AI_GROUP_GENERATION_CONFLICT')
    if(prior&&normalized.generation===prior.generation&&normalized.fingerprint===prior.fingerprint&&(normalized.leaseId??null)!==(prior.leaseId??null))fail('AI_GROUP_LEASE_CONFLICT')
    if(prior&&normalized.fingerprint===prior.fingerprint&&(normalized.payload===null?null:createHash('sha256').update(normalized.payload).digest('hex'))!==prior.payloadDigest)fail('AI_GROUP_PAYLOAD_CONFLICT')
    if(prior&&!prior.pending&&normalized.fingerprint===prior.fingerprint&&samePrincipal(effectivePrincipal(prior),normalized)){
      // A reinstall can preserve the journal while losing the account manager's pool.
      // Reuse the receipt only when its desired accounts still exist locally.
      const installed=new Set(prior.desired.length?await deps.snapshot(normalized.provider):[])
      if(prior.desired.every(identity=>installed.has(identity))){prior.generation=normalized.generation;prior.assignmentGeneration=normalized.assignmentGeneration??normalized.generation;prior.leaseId=normalized.leaseId;await deps.write(JSON.stringify(journal));return receipt(prior)}
    }
    const payloadDigest=normalized.payload===null?null:createHash('sha256').update(normalized.payload).digest('hex')
    if(prior&&normalized.fingerprint===prior.fingerprint&&payloadDigest!==prior.payloadDigest)fail('AI_GROUP_PAYLOAD_CONFLICT')
    const before=new Set(await deps.snapshot(normalized.provider))
    const desired=normalized.payload===null?[]:[...new Set(deps.incoming(normalized.provider,normalized.payload))]
    if(desired.length>500||desired.some(value=>!id(value)))fail('AI_GROUP_INVALID_INPUT')
    const managed=normalized.payload===null?[]:(deps.managedIdentities?.(normalized.provider,normalized.payload)??[]).filter(value=>desired.includes(value))
    const entry:Entry={scope:normalized.scope,principalType:normalized.principalType,userId:normalized.userId,...(normalized.machineId?{machineId:normalized.machineId}:{}),provider:normalized.provider,generation:normalized.generation,assignmentGeneration:normalized.assignmentGeneration??normalized.generation,leaseId:normalized.leaseId,fingerprint:normalized.fingerprint,payloadDigest,desired,managed,appliedCredentials:[],
      owned:[...new Set([...(prior?.owned??[]),...desired.filter(value=>!before.has(value))])],pending:true}
    journal.entries=journal.entries.filter(e=>!(e.scope===normalized.scope&&e.provider===normalized.provider&&sameSlot(e,normalized)))
    journal.entries.push(entry)
    await deps.write(JSON.stringify(journal))
    if(normalized.payload!==null) {
      const applied=await deps.apply(normalized.provider,normalized.payload,prior?.owned??[])
      const appliedCredentials=deps.appliedCredentials?.(normalized.provider,normalized.payload,applied)??[]
      if(!validAppliedCredentials(appliedCredentials))fail('AI_GROUP_INVALID_PAYLOAD')
      entry.appliedCredentials=appliedCredentials
    }
    const after=new Set(await deps.snapshot(normalized.provider))
    if(desired.some(identity=>!after.has(identity)))fail('AI_GROUP_INSTALL_INCOMPLETE')
    const related=journal.entries.filter(e=>e.provider===normalized.provider)
    const wanted=new Set(related.flatMap(e=>e.desired))
    const removable=[...new Set(related.flatMap(e=>e.owned))].filter(value=>!wanted.has(value)&&after.has(value))
    if(removable.length)await deps.remove(normalized.provider,removable)
    const installed=new Set(await deps.snapshot(normalized.provider))
    if(removable.some(value=>installed.has(value)))fail('AI_GROUP_REMOVAL_INCOMPLETE')
    for(const other of related)other.owned=other.owned.filter(value=>installed.has(value))
    entry.pending=false
    await deps.write(JSON.stringify(journal))
    return receipt(entry)
  }
  async function invalidate(provider:GroupProvider,touched:string[]|null) {
    const journal=parse(await deps.read());let changed=false
    for(const entry of journal.entries.filter(e=>e.provider===provider)){entry.pending=true;entry.owned=touched===null?[]:entry.owned.filter(id=>!touched.includes(id));changed=true}
    if(changed)await deps.write(JSON.stringify(journal))
  }
  /** Who a scope's applied assignment belongs to and what it installed: the local ownership proof. */
  async function assignment(scope:string,provider:GroupProvider){const entry=parse(await deps.read()).entries.find(e=>e.scope===scope&&e.provider===provider&&principalType(e)==='user');return entry?{userId:entry.userId,desired:[...entry.desired],reconciled:!entry.pending}:null}
  /** Some current assignment (applied or in flight) desires an org-managed setup-token. Revoked entries desire nothing. */
  /** Entries written before the `managed` projection existed: unknown, never assumed unmanaged. */
  async function unprojected(provider:GroupProvider){return parse(await deps.read()).entries.filter(e=>e.provider===provider&&e.managed===undefined).map(e=>({scope:e.scope,desired:[...e.desired]}))}
  /** One-time migration: record which desired identities of an old entry are managed. */
  async function recordManaged(provider:GroupProvider,scope:string,managed:string[]){
    const journal=parse(await deps.read())
    const entry=journal.entries.find(e=>e.provider===provider&&e.scope===scope&&e.managed===undefined)
    if(!entry)return
    entry.managed=managed.filter(value=>entry.desired.includes(value))
    await deps.write(JSON.stringify(journal))
  }
  async function hasManagedDesired(provider:GroupProvider){return parse(await deps.read()).entries.some(e=>e.provider===provider&&(e.managed??[]).some(value=>e.desired.includes(value)))}
  /** Collector custody: the scope's reconciled assignment for this user both desires and installed the identity. */
  const authorize=async(scope:string,userId:string,identity:string)=>{const e=await readReceipt(scope,'claude',{principalType:'user',userId});return Boolean(e&&!e.pending&&e.userId===userId&&e.desired.includes(identity)&&e.owned.includes(identity))}
  return {sync,invalidate,assignment,hasManagedDesired,unprojected,recordManaged,authorize,receipt:async(scope:string,provider:GroupProvider, principal?: Pick<NormalizedRequest,'principalType'|'userId'|'machineId'>)=>{const entry=await readReceipt(scope,provider,principal);return entry?receipt(entry):null}}
}

function effectivePrincipal(entry:Pick<Entry,'principalType'|'userId'|'machineId'>):Pick<NormalizedRequest,'principalType'|'userId'|'machineId'> {
  return principalType(entry)==='machine'
    ? {principalType:'machine',userId:entry.machineId!,machineId:entry.machineId}
    : {principalType:'user',userId:entry.userId}
}
