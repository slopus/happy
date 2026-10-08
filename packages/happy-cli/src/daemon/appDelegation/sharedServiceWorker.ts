import { createNativeSessionRuntime, type NativeSessionHooks, type NativePhase, type NativeConversationMessage } from './nativeSessionRuntime';
import { loadApplicationPolicy } from './applicationPolicy';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeIdentityId, sameServiceTarget } from './serviceCapabilities';
import { restrictedClaudeEnv } from './restrictedClaude';
import { homedir } from 'node:os';
import nacl from 'tweetnacl';
import { NATIVE_SNAPSHOT_PLAINTEXT_MAX_BYTES, NATIVE_SNAPSHOT_CIPHERTEXT_MAX_BYTES, ServiceGrantScopeSchema, ServiceErrorCodeSchema, type ExecutionBinding, type ServiceTarget, type TurnRecord, type ServiceGrantScope, type AppPolicy, type BusinessPromptRef } from '@slopus/happy-wire';
import type { Machine } from '@/api/types';
import { decodeBase64, decryptLegacy, encodeBase64, encryptLegacy } from '@/api/encryption';
import { CodexAccountLaunch, type AccountApi } from '@/daemon/codexAccountLaunch';
import { createBoundServiceRuntime, type BoundWorkspace, type BoundCredentialLease, type BoundTurnInput } from './executionBinding';
import { recoverAppChatCredentialJobs } from './credentialRecovery';

/** Bounded native snapshot; oversize is an explicit display error, never an unknown execution result. */
export function encodeNativeServiceSnapshot(payload:Record<string,unknown>,key:Uint8Array,forceTooLarge=false):string {
 let plain=payload;
 const compact=()=>{plain={...payload,messages:[],snapshotError:'snapshot-too-large'};if(Buffer.byteLength(JSON.stringify(plain))>NATIVE_SNAPSHOT_PLAINTEXT_MAX_BYTES)plain={...plain,text:''};};
 if(forceTooLarge || Buffer.byteLength(JSON.stringify(plain))>NATIVE_SNAPSHOT_PLAINTEXT_MAX_BYTES)compact();
 // A rejected bounded envelope may have reached an older 1MiB server. Keep a
 // readable final answer when it fits that compatibility fallback budget.
 if(forceTooLarge && Buffer.byteLength(JSON.stringify(plain))>512*1024 && 'text' in plain)plain={...plain,text:''};
 let ciphertext=encodeBase64(encryptLegacy(plain,key));
 if(Buffer.byteLength(ciphertext)>NATIVE_SNAPSHOT_CIPHERTEXT_MAX_BYTES){compact();ciphertext=encodeBase64(encryptLegacy(plain,key));}
 if(Buffer.byteLength(ciphertext)>NATIVE_SNAPSHOT_CIPHERTEXT_MAX_BYTES)throw new Error('snapshot-too-large');
 return ciphertext;
}
export interface SharedServiceJob { record: TurnRecord; lease: string; input: string; envelope: string; kind: string; grantId: string; ownerId: string; scope: ServiceGrantScope; sequence?:number }
interface Probe { id: string; lease: string; target: ServiceTarget; deadline: number }
type Authority = { kind: 'probe'|'turn'; id: string; lease: string };
type Request = <T>(path: string, body: unknown) => Promise<T>;
export function serviceMachineKey(machine: Machine) {
 // Separate cryptographic purpose from the owner's normal machine/message key.
 return nacl.box.keyPair.fromSecretKey(createHash('sha256').update('paws-ai-services-machine-box/1\0').update(machine.encryptionKey).digest());
}
export function decodeServiceJob(machine: Machine, job: SharedServiceJob) {
 const bundle=decodeBase64(job.envelope), keys=serviceMachineKey(machine);
 const opened=nacl.box.open(bundle.slice(56),bundle.slice(32,56),bundle.slice(0,32),keys.secretKey);
 if (!opened) throw new Error('permission-denied');
 const envelope=JSON.parse(Buffer.from(opened).toString('utf8'));
 const binding=job.record.binding;
 if (envelope.protocol !== 'ai-services/1' || envelope.grantId !== job.grantId || envelope.ownerId !== job.ownerId || envelope.appId !== binding.appId || envelope.serviceId !== binding.serviceId || envelope.machineId !== machine.id || binding.machineId !== machine.id || JSON.stringify(ServiceGrantScopeSchema.parse(envelope.scope)) !== JSON.stringify(ServiceGrantScopeSchema.parse(job.scope))) throw new Error('permission-denied');
 if (!job.scope.targets.some(target=>sameServiceTarget(target,binding)) || binding.permissions.some(value=>!job.scope.permissions.includes(value))) throw new Error('permission-denied');
 if (job.scope.expiresAt !== null && job.scope.expiresAt <= Date.now()) throw new Error('authorization-expired');
 const key=decodeBase64(envelope.messageKey);
 if (key.length !== 32) throw new Error('permission-denied');
 const payload=decryptLegacy(decodeBase64(job.input),key);
 if (!payload || payload.protocol !== 'ai-services/1' || payload.grantId !== job.grantId || payload.appId !== binding.appId || payload.serviceId !== binding.serviceId || payload.bindingId !== binding.id || payload.requestId !== job.record.requestId || payload.direction !== 'input' || payload.sequence !== 0) throw new Error('permission-denied');
 return { key,messages:payload.messages as BoundTurnInput['messages'] };
}
/** Called only inside the existing legacy/new machine lock. It never starts its own competing loop. */
export function createSharedServiceWorker(context: { machine: Machine; request: Request; api: AccountApi; recoveryRoot: string; lifetime: AbortSignal; codexBinary: string; claudeBinary: string; nativeSessionHooks?: NativeSessionHooks }) {
 const { machine,request,api,lifetime }=context;
 const native=context.nativeSessionHooks ? createNativeSessionRuntime({ hooks:context.nativeSessionHooks,root:join(context.recoveryRoot,'native'),machineId:machine.id }) : null;
 const path=`ai-service-worker/${encodeURIComponent(machine.id)}`;
 let authority: Authority | null=null;
 let claudeIdentity: { identityId:string; observedAt:number } | null=null;
 let identityCheckedAt=0;
 let policyData: { policy:AppPolicy; ref:BusinessPromptRef; prompt:string } | null=null;
 const nativeClaudeEnv: NodeJS.ProcessEnv={ HOME:homedir(),PATH:process.env.PATH,LANG:process.env.LANG,TMPDIR:process.env.TMPDIR };
 const acquire=async (target:ServiceTarget,workspace:BoundWorkspace,signal:AbortSignal):Promise<BoundCredentialLease> => {
  if (!authority) throw new Error('permission-denied');
  signal.throwIfAborted();
  const verified=await request<{ target:ServiceTarget }>(`${path}/authority`,authority);
  if (!sameServiceTarget(target,verified.target)) throw new Error('account-identity-changed');
  if (target.engine === 'claude') return { engine:'claude',target,binary:context.claudeBinary,env:nativeClaudeEnv };
  const grant=await request<{ grant:string }>(`${path}/credential`,authority);
  const launch=await CodexAccountLaunch.prepare(api,machine.id,grant.grant,{ sourceHome:workspace.cwd,createTempDir:()=>workspace.codexHome,skipHistory:true });
  return { engine:'codex',target,binary:context.codexBinary,launch };
 };
 const runtime=createBoundServiceRuntime({ machineId:machine.id,workspaceRoot:context.recoveryRoot,
  acquireDiscovery:async (target,workspace,signal)=> { if (authority?.kind !== 'probe') throw new Error('permission-denied'); return acquire(target,workspace,signal); },
  acquireTurn:async (binding,workspace,signal)=> { if (authority?.kind !== 'turn') throw new Error('permission-denied'); return acquire(binding,workspace,signal); },
  loadApplication:async appId=> {
   if (authority?.kind !== 'turn') throw new Error('permission-denied');
   policyData=await request(`${path}/policy`,authority);
   if (!policyData || policyData.policy.appId !== appId) throw new Error('permission-denied');
   return policyData.policy;
  },
  resolveBusinessPrompt:async ref=> policyData && ref.id === policyData.ref.id && ref.version === policyData.ref.version ? policyData.prompt : null,
 });
 async function execute(job:SharedServiceJob) {
  const control=new AbortController(), abort=()=>control.abort(); lifetime.addEventListener('abort',abort,{ once:true });
  authority={ kind:'turn',id:job.record.id,lease:job.lease };
  let latest='',sequence=job.sequence??0,flushing:Promise<unknown>=Promise.resolve(),heartbeat:NodeJS.Timeout|undefined;
  let key:Uint8Array|undefined, phase:NativePhase|undefined;
  let messages:NativeConversationMessage[]|undefined, terminalObserved=false;
  const publish=(body:object)=>request(`${path}/turns/${job.record.id}`,{ lease:job.lease,...(phase ? {phase}:{}),...body });
  const encode=(includeHistory=true,forceTooLarge=false)=>encodeNativeServiceSnapshot({ protocol:'ai-services/1',grantId:job.grantId,appId:job.record.binding.appId,serviceId:job.record.binding.serviceId,bindingId:job.record.binding.id,requestId:job.record.requestId,turnId:job.record.id,direction:'output',sequence:++sequence,text:latest,...(includeHistory && messages ? {messages}: {historyComplete:false}) },key!,forceTooLarge);
  const publishTerminal=async(body:object)=>{
   let output=encode();
   try{await publish({...body,output,sequence});}
   catch(error){if(!(error instanceof Error)||error.message!=='snapshot-too-large')throw error;output=encode(false,true);await publish({...body,output,sequence});}
  };
  try {
   const decoded=decodeServiceJob(machine,job); key=decoded.key;
   heartbeat=setInterval(()=> {
    flushing=flushing.then(async()=> { if (!control.signal.aborted) await publish({ output:encode(false),sequence }); }).catch(()=>control.abort());
   },3000);
   if (!native) throw new Error('protocol-incompatible');
   if(job.record.status==='cancel-requested'){
    const outcome=await native.cancel(job.record.binding,job.record.requestId,job.record.sessionId);
    if(outcome.status==='pending')await publish({phase:'recovering'});
    else {terminalObserved=true;latest=outcome.text;messages=outcome.messages;await publishTerminal({status:outcome.status,actual:outcome.actual,...(outcome.status==='completed'?{}:{error:{code:'execution-interrupted',retryable:false}})});}
    return;
   }
   const verified=await request<{target:ServiceTarget}>(`${path}/authority`,authority);
   if (!sameServiceTarget(job.record.binding,verified.target)) throw new Error('account-identity-changed');
   const data=await request<{policy:AppPolicy;ref:BusinessPromptRef;prompt:string}>(`${path}/policy`,authority);
   const {systemPrompt}=await loadApplicationPolicy(job.record.binding.appId,job.record.binding.permissions,async()=>data.policy,async ref=>ref.id===data.ref.id && ref.version===data.ref.version ? data.prompt:null,job.record.binding.permissionMode);
   const grant=job.record.binding.engine==='codex' ? await request<{grant:string}>(`${path}/credential`,authority):undefined;
   const result=await native.execute(job.record.binding,{id:job.record.id,conversationId:job.record.conversationId,requestId:job.record.requestId,createdAt:job.record.createdAt,messages:decoded.messages},
    {sessionId:job.record.sessionId,codexSessionGrant:grant?.grant,systemPrompt,attach:async id=>{await request(`${path}/turns/${job.record.id}/session`,{lease:job.lease,sessionId:id});}},control.signal,event=>{
     if(event.type==='text')latest=event.text;
     else if(event.type==='messages')messages=event.messages;
     else {phase=event.phase;flushing=flushing.then(()=>publish({})).catch(()=>control.abort());}
    });
   terminalObserved=true;latest=result.text;messages=result.messages;

   clearInterval(heartbeat); heartbeat=undefined; await flushing;
   await publishTerminal({ status:result.status,actual:result.actual,...(result.status!=='completed' ? {error:{code:'execution-interrupted',retryable:false}} : {}) });
  } catch(error) {
   control.abort(); await flushing;
   if(terminalObserved || error instanceof Error && error.message==='native-execution-pending'){phase='recovering';await publish({}).catch(()=>undefined);return;}
   const parsed=ServiceErrorCodeSchema.safeParse(error instanceof Error ? error.message : '');
   await publish({ status:'failed',error:{ code:parsed.success ? parsed.data : 'execution-interrupted',retryable:false } }).catch(()=>undefined);
  } finally { if (heartbeat) clearInterval(heartbeat); await flushing; authority=null; policyData=null; lifetime.removeEventListener('abort',abort); }
 }
 return {
  async tickHistory():Promise<void> {
   if(!native)return;
   const {history}=await request<{history:null|{id:string;sessionId:string;binding:ExecutionBinding;grantId:string;ownerId:string;scope:ServiceGrantScope;envelope:string;requestId:string}}>(`${path}/history/claim`,{});
   if(!history)return;
   const bundle=decodeBase64(history.envelope),keys=serviceMachineKey(machine);
   const opened=nacl.box.open(bundle.slice(56),bundle.slice(32,56),bundle.slice(0,32),keys.secretKey);
   if(!opened)throw new Error('permission-denied');
   const envelope=JSON.parse(Buffer.from(opened).toString('utf8')),binding=history.binding;
   if(envelope.protocol!=='ai-services/1'||envelope.grantId!==history.grantId||envelope.ownerId!==history.ownerId||envelope.appId!==binding.appId||envelope.serviceId!==binding.serviceId||envelope.machineId!==machine.id||binding.machineId!==machine.id||history.id!==binding.id||JSON.stringify(ServiceGrantScopeSchema.parse(envelope.scope))!==JSON.stringify(ServiceGrantScopeSchema.parse(history.scope))||!history.scope.targets.some(target=>sameServiceTarget(target,binding))||binding.permissions.some(permission=>!history.scope.permissions.includes(permission))||(history.scope.expiresAt!==null&&history.scope.expiresAt<=Date.now()))throw new Error('permission-denied');
   const key=decodeBase64(envelope.messageKey);if(key.length!==32)throw new Error('permission-denied');
   const snapshot=await native.snapshot(binding,history.sessionId,lifetime);
   let ciphertext=encodeNativeServiceSnapshot({protocol:'ai-services/1',direction:'session-history',grantId:history.grantId,appId:binding.appId,serviceId:binding.serviceId,bindingId:binding.id,requestId:history.requestId,...snapshot},key);
   try{await request(`${path}/history/${history.id}`,{requestId:history.requestId,sessionId:history.sessionId,ciphertext});}
   catch(error){if(!(error instanceof Error)||error.message!=='snapshot-too-large')throw error;ciphertext=encodeNativeServiceSnapshot({protocol:'ai-services/1',direction:'session-history',grantId:history.grantId,appId:binding.appId,serviceId:binding.serviceId,bindingId:binding.id,requestId:history.requestId,sessionId:history.sessionId,active:snapshot.active},key,true);await request(`${path}/history/${history.id}`,{requestId:history.requestId,sessionId:history.sessionId,ciphertext});}
  },
  async tick():Promise<boolean> {
   lifetime.throwIfAborted();
   // Both roots are recovered while holding the one machine lock, before any native observation.
   if (!await recoverAppChatCredentialJobs(context.recoveryRoot,machine.id,api)) throw new Error('resource-busy');
   if (Date.now()-identityCheckedAt > 30000) {
    identityCheckedAt=Date.now();claudeIdentity=null;
    try {
     const cwd=join(context.recoveryRoot,'identity');await mkdir(cwd,{ recursive:true,mode:0o700 });
     const { stdout }=await promisify(execFile)(context.claudeBinary,['auth','status','--json'],{ cwd,env:restrictedClaudeEnv(nativeClaudeEnv),signal:lifetime,timeout:5000,maxBuffer:65536 });
     claudeIdentity={ identityId:claudeIdentityId(JSON.parse(stdout)),observedAt:Date.now() };
    } catch { /* Never return login JSON, email, tokens, or an invented identity. */ }
   }
   await request(`${path}/announce`,{ protocol:'ai-services/1',nativeSessions:!!context.nativeSessionHooks,publicKey:Buffer.from(serviceMachineKey(machine).publicKey).toString('base64'),claudeIdentity });
   const { probe,job }=await request<{ probe:Probe|null;job:SharedServiceJob|null }>(`${path}/claim`,{});
   if (probe) {
    authority={ kind:'probe',id:probe.id,lease:probe.lease };
    try {
     const signal=AbortSignal.any([lifetime,AbortSignal.timeout(Math.max(1,Math.min(20000,probe.deadline-Date.now())))]);
     const catalog=await runtime.readServiceCapabilities(probe.target,signal);
     await request(`${path}/probes/${probe.id}`,{ lease:probe.lease,catalog });
    } catch (error) {
     const code=ServiceErrorCodeSchema.safeParse(error instanceof Error ? error.message : '');
     await request(`${path}/probes/${probe.id}`,{ lease:probe.lease,catalog:null,error:code.success ? code.data : 'execution-interrupted' }).catch(()=>undefined);
    } finally { authority=null; }
    return true;
   }
   if (job) { await execute(job); return true; }
   return false;
  },
 };
}
