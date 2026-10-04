import { createHash } from 'node:crypto'
/** Group custody journal: hashes only, durable intent before changing credentials. */
export type GroupProvider = 'claude' | 'codex'
export type CredentialGroupRequest = { version:1; scope:string; userId:string; provider:GroupProvider; generation:number; fingerprint:string; payload:string|null }
/** `managed`: the desired identities that are org-managed setup-tokens (absent in older journals). */
type Entry = Omit<CredentialGroupRequest,'version'|'payload'> & { desired:string[]; owned:string[]; pending:boolean; payloadDigest:string|null; managed?:string[] }
type Journal = { version:1; entries:Entry[] }
export type CredentialGroupDeps = {
  read():Promise<string|null>; write(value:string):Promise<void>
  snapshot(provider:GroupProvider):Promise<string[]>
  incoming(provider:GroupProvider,payload:string):string[]
  managedIdentities?(provider:GroupProvider,payload:string):string[]
  /** `owned` are identities this scope installed earlier: the only slots it may replace. */
  apply(provider:GroupProvider,payload:string,owned:string[]):Promise<unknown>
  remove(provider:GroupProvider,identities:string[]):Promise<void>
}
const fail=(code:string):never=>{throw new Error(code)}
const id=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=128
function request(value:CredentialGroupRequest) {
  if(!value||value.version!==1||!id(value.scope)||!id(value.userId)
    ||!['claude','codex'].includes(value.provider)||!Number.isSafeInteger(value.generation)||value.generation<1
    ||!(/^[a-f0-9]{64}$/).test(value.fingerprint)||!(value.payload===null||typeof value.payload==='string'&&Buffer.byteLength(value.payload)<=1024*1024))fail('AI_GROUP_INVALID_INPUT')
}
function parse(raw:string|null):Journal {
  if(raw===null)return {version:1,entries:[]}
  try {
    if(Buffer.byteLength(raw)>1024*1024)fail('AI_GROUP_JOURNAL_INVALID')
    const value=JSON.parse(raw) as Journal
    if(value.version!==1||!Array.isArray(value.entries)||value.entries.length>1000)fail('AI_GROUP_JOURNAL_INVALID')
    for(const entry of value.entries){
      request({...entry,version:1,payload:null})
      if(!(entry.payloadDigest===null||typeof entry.payloadDigest==='string'&&/^[a-f0-9]{64}$/.test(entry.payloadDigest))||typeof entry.pending!=='boolean'||![entry.desired,entry.owned,entry.managed??[]].every(items=>Array.isArray(items)&&items.length<=1000&&items.every(id)))fail('AI_GROUP_JOURNAL_INVALID')
    }
    if(new Set(value.entries.map(e=>JSON.stringify([e.scope,e.provider]))).size!==value.entries.length)fail('AI_GROUP_JOURNAL_INVALID')
    return value
  }catch{ return fail('AI_GROUP_JOURNAL_INVALID') }
}
const receipt=(entry:Entry)=>({version:1 as const,scope:entry.scope,userId:entry.userId,provider:entry.provider,generation:entry.generation,fingerprint:entry.fingerprint,payloadDigest:entry.payloadDigest,reconciled:!entry.pending})
export function createCredentialGroupSync(deps:CredentialGroupDeps) {
  async function readReceipt(scope:string,provider:GroupProvider) {
    return parse(await deps.read()).entries.find(e=>e.scope===scope&&e.provider===provider)
  }
  async function sync(input:CredentialGroupRequest) {
    request(input)
    const journal=parse(await deps.read())
    const prior=journal.entries.find(e=>e.scope===input.scope&&e.provider===input.provider)
    if(prior&&input.generation<prior.generation)fail('AI_GROUP_GENERATION_STALE')
    if(prior&&input.generation===prior.generation&&(input.fingerprint!==prior.fingerprint||input.userId!==prior.userId))fail('AI_GROUP_GENERATION_CONFLICT')
    if(prior&&input.fingerprint===prior.fingerprint&&(input.payload===null?null:createHash('sha256').update(input.payload).digest('hex'))!==prior.payloadDigest)fail('AI_GROUP_PAYLOAD_CONFLICT')
    if(prior&&!prior.pending&&input.fingerprint===prior.fingerprint&&input.userId===prior.userId){prior.generation=input.generation;await deps.write(JSON.stringify(journal));return receipt(prior)}
    const payloadDigest=input.payload===null?null:createHash('sha256').update(input.payload).digest('hex')
    if(prior&&input.fingerprint===prior.fingerprint&&payloadDigest!==prior.payloadDigest)fail('AI_GROUP_PAYLOAD_CONFLICT')
    const before=new Set(await deps.snapshot(input.provider))
    const desired=input.payload===null?[]:[...new Set(deps.incoming(input.provider,input.payload))]
    if(desired.length>500||desired.some(value=>!id(value)))fail('AI_GROUP_INVALID_INPUT')
    const managed=input.payload===null?[]:(deps.managedIdentities?.(input.provider,input.payload)??[]).filter(value=>desired.includes(value))
    const entry:Entry={scope:input.scope,userId:input.userId,provider:input.provider,generation:input.generation,fingerprint:input.fingerprint,payloadDigest,desired,managed,
      owned:[...new Set([...(prior?.owned??[]),...desired.filter(value=>!before.has(value))])],pending:true}
    journal.entries=journal.entries.filter(e=>!(e.scope===input.scope&&e.provider===input.provider))
    journal.entries.push(entry)
    await deps.write(JSON.stringify(journal))
    if(input.payload!==null)await deps.apply(input.provider,input.payload,prior?.owned??[])
    const after=new Set(await deps.snapshot(input.provider))
    if(desired.some(identity=>!after.has(identity)))fail('AI_GROUP_INSTALL_INCOMPLETE')
    const related=journal.entries.filter(e=>e.provider===input.provider)
    const wanted=new Set(related.flatMap(e=>e.desired))
    const removable=[...new Set(related.flatMap(e=>e.owned))].filter(value=>!wanted.has(value)&&after.has(value))
    if(removable.length)await deps.remove(input.provider,removable)
    const installed=new Set(await deps.snapshot(input.provider))
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
  async function assignment(scope:string,provider:GroupProvider){const entry=await readReceipt(scope,provider);return entry?{userId:entry.userId,desired:[...entry.desired],reconciled:!entry.pending}:null}
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
  const authorize=async(scope:string,userId:string,identity:string)=>{const e=await readReceipt(scope,'claude');return Boolean(e&&!e.pending&&e.userId===userId&&e.desired.includes(identity)&&e.owned.includes(identity))}
  return {sync,invalidate,assignment,hasManagedDesired,unprojected,recordManaged,authorize,receipt:async(scope:string,provider:GroupProvider)=>{const entry=await readReceipt(scope,provider);return entry?receipt(entry):null}}
}
