import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeIdentityId, sameServiceTarget } from './serviceCapabilities';
import { restrictedClaudeEnv } from './restrictedClaude';
import { homedir } from 'node:os';
import nacl from 'tweetnacl';
import { ServiceGrantScopeSchema, ServiceErrorCodeSchema, type ExecutionBinding, type ServiceTarget, type TurnRecord, type ServiceGrantScope, type AppPolicy, type BusinessPromptRef } from '@slopus/happy-wire';
import type { Machine } from '@/api/types';
import { decodeBase64, decryptLegacy, encodeBase64, encryptLegacy } from '@/api/encryption';
import { CodexAccountLaunch, type AccountApi } from '@/daemon/codexAccountLaunch';
import { createBoundServiceRuntime, type BoundWorkspace, type BoundCredentialLease, type BoundTurnInput } from './executionBinding';
import { recoverAppChatCredentialJobs } from './credentialRecovery';

export interface SharedServiceJob { record: TurnRecord; lease: string; input: string; envelope: string; kind: string; grantId: string; ownerId: string; scope: ServiceGrantScope }
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
export function createSharedServiceWorker(context: { machine: Machine; request: Request; api: AccountApi; recoveryRoot: string; lifetime: AbortSignal; codexBinary: string; claudeBinary: string }) {
 const { machine,request,api,lifetime }=context;
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
  let latest='',sequence=0,flushing:Promise<unknown>=Promise.resolve(),heartbeat:NodeJS.Timeout|undefined;
  let key:Uint8Array|undefined;
  const publish=(body:object)=>request(`${path}/turns/${job.record.id}`,{ lease:job.lease,...body });
  const encode=()=>encodeBase64(encryptLegacy({ protocol:'ai-services/1',grantId:job.grantId,appId:job.record.binding.appId,serviceId:job.record.binding.serviceId,bindingId:job.record.binding.id,requestId:job.record.requestId,turnId:job.record.id,direction:'output',sequence:++sequence,text:latest },key!));
  try {
   const decoded=decodeServiceJob(machine,job); key=decoded.key;
   heartbeat=setInterval(()=> {
    flushing=flushing.then(async()=> { if (!control.signal.aborted) await publish({ output:encode(),sequence }); }).catch(()=>control.abort());
   },3000);
   const result=await runtime.executeBoundTurn(job.record.binding,{ id:job.record.id,conversationId:job.record.conversationId,requestId:job.record.requestId,createdAt:job.record.createdAt,messages:decoded.messages },control.signal,event=> { if (event.type === 'text') latest=event.text; });
   clearInterval(heartbeat); heartbeat=undefined; await flushing;
   const output=encode();
   await publish({ output,sequence,status:result.status,actual:result.actual,...(result.error ? { error:result.error } : {}) });
  } catch {
   control.abort(); await flushing;
   await publish({ status:'failed',error:{ code:'execution-interrupted',retryable:false } }).catch(()=>undefined);
  } finally { if (heartbeat) clearInterval(heartbeat); await flushing; authority=null; policyData=null; lifetime.removeEventListener('abort',abort); }
 }
 return {
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
   await request(`${path}/announce`,{ protocol:'ai-services/1',publicKey:Buffer.from(serviceMachineKey(machine).publicKey).toString('base64'),claudeIdentity });
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
