import { afterEach, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, readdir, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Machine } from '@/api/types';
import { encryptLegacy, decryptLegacy, encodeBase64, decodeBase64, libsodiumEncryptForPublicKey } from '@/api/encryption';
import { createSharedServiceWorker, decodeServiceJob, serviceMachineKey, type SharedServiceJob } from './sharedServiceWorker';
import { claudeIdentityId } from './serviceCapabilities';
import { acquireMachineLock } from './workerLock';
const roots:string[]=[];
afterEach(async()=>{ await Promise.all(roots.splice(0).map(root=>rm(root,{ recursive:true,force:true }))); });
const machine={ id:'shared-machine',encryptionKey:randomBytes(32),encryptionVariant:'dataKey',metadata:{} as Machine['metadata'],metadataVersion:1,daemonState:null,daemonStateVersion:1 } satisfies Machine;
const target={ machineId:machine.id,engine:'codex' as const,accountRef:{ kind:'codex-profile' as const,id:'exact-profile' } };
const binding={ ...target,id:'binding',appId:'summary-app',serviceId:'service',revision:1,requestedModel:null,reasoning:{ mode:'default' as const },permissions:['chat' as const] };
const scope={ appId:binding.appId,serviceId:binding.serviceId,targets:[target],permissions:['chat' as const],expiresAt:null };
function jobFixture() {
 const key=randomBytes(32),grantId='grant';
 const envelope=encodeBase64(libsodiumEncryptForPublicKey(Buffer.from(JSON.stringify({ protocol:'ai-services/1',ownerId:'owner',grantId,appId:binding.appId,serviceId:binding.serviceId,machineId:machine.id,scope,messageKey:key.toString('base64') })),serviceMachineKey(machine).publicKey));
 const payload={ protocol:'ai-services/1',grantId,appId:binding.appId,serviceId:binding.serviceId,bindingId:binding.id,requestId:'request',direction:'input',sequence:0,messages:[{ role:'user',text:'A short topic.' }] };
 const job:SharedServiceJob={ record:{ id:'turn',conversationId:binding.id,requestId:'request',binding,status:'running',actual:{ modelId:null,reasoning:null },createdAt:Date.now(),startedAt:Date.now(),completedAt:null,error:null },grantId,ownerId:'owner',kind:'personal-grant',scope,lease:'l'.repeat(43),envelope,input:encodeBase64(encryptLegacy(payload,key)) };
 return { key,job,payload };
}
it('rejects cross-binding, cross-app and cross-machine ciphertext before native execution',()=>{
 const f=jobFixture();expect(decodeServiceJob(machine,f.job).messages).toEqual(f.payload.messages);
 for(const patch of [{ bindingId:'other' },{ appId:'other' },{ requestId:'other' },{ protocol:'legacy' }]) {
  expect(()=>decodeServiceJob(machine,{ ...f.job,input:encodeBase64(encryptLegacy({ ...f.payload,...patch },f.key)) })).toThrow('permission-denied');
 }
 expect(()=>decodeServiceJob({ ...machine,id:'other' },f.job)).toThrow('permission-denied');
 expect(()=>decodeServiceJob(machine,{ ...f.job,record:{ ...f.job.record,binding:{ ...binding,accountRef:{ kind:'codex-profile',id:'unauthorized' } } } })).toThrow('permission-denied');
});
it('composes authenticated probe and turn acquisition, dynamic policy, encrypted output and private credential cleanup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'shared-worker-'));roots.push(root);const binary=join(root,'codex'),audit=join(root,'audit');
 await writeFile(binary,`#!/usr/bin/env node
const fs=require('fs'),rl=require('readline');if(process.argv.includes('--version')){console.log('codex-cli 0.159.3');process.exit(0)};
rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify(m)+'\\n');if(m.id==null)return;let result={};if(m.method==='model/list')result={data:[{id:'native',model:'native',displayName:'Native',isDefault:true,inputModalities:['text'],supportedReasoningEfforts:[],defaultReasoningEffort:null}],nextCursor:null};if(m.method==='thread/start')result={thread:{id:'thread'},model:'native'};console.log(JSON.stringify({id:m.id,result}));if(m.method==='turn/start'){console.log(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'Summary answer'}}));console.log(JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}}));}});`,{ mode:0o700 });
 const claude=join(root,'claude'),login={ loggedIn:true,authMethod:'oauth',apiProvider:'firstParty',email:'fixture@example.test',orgId:'fixture-org',tokens:'never-publish' };
 await writeFile(claude,'#!/usr/bin/env node\nconsole.log('+JSON.stringify(JSON.stringify({ loggedIn:true,authMethod:'oauth',apiProvider:'firstParty',email:'fixture@example.test',orgId:'fixture-org',tokens:'never-publish' }))+');',{ mode:0o700 });
 const f=jobFixture(),calls:{ path:string;body:any }[]=[],saved:any[]=[];let phase=0;
 const worker=createSharedServiceWorker({ machine,recoveryRoot:join(root,'jobs'),lifetime:new AbortController().signal,codexBinary:binary,claudeBinary:claude,
  request:async <T>(path:string,body:any):Promise<T>=>{
   calls.push({ path,body });
   if(path.endsWith('/announce'))return {} as T;
   if(path.endsWith('/claim'))return (phase++ === 0 ? { probe:{ id:'probe',lease:'p'.repeat(43),target,deadline:Date.now()+20000 },job:null } : { probe:null,job:f.job }) as T;
   if(path.endsWith('/authority'))return { target } as T;
   if(path.endsWith('/credential'))return { grant:'g'.repeat(43) } as T;
   if(path.endsWith('/policy'))return { policy:{ appId:'summary-app',name:'Summary',origins:['https://summary.example'],capabilities:['chat'],businessPrompt:{ id:'summary',version:'1' } },ref:{ id:'summary',version:'1' },prompt:'Summarize the supplied topic in one sentence.' } as T;
   return { accepted:true } as T;
  },
  api:{ redeemCodexSessionGrant:async()=>({ auth:{ tokens:{ id_token:'fixture-id',access_token:'fixture-access',refresh_token:'fixture-refresh',account_id:'fixture-account' } },launchId:'launch',profile:{ id:'exact-profile',displayName:'Exact',credentialVersion:3 } }),attachCodexSession:async()=>({ success:true as const }),updateCodexAccountCredential:async(id,input)=>{ saved.push({ id,input });return { profile:{ id,status:'available' as const,displayName:'Exact',credentialVersion:4 } }; },reportCodexAccountQuota:async()=>({ accepted:true }),reportCodexAccountStatus:async()=>({ profile:{ id:'exact-profile',status:'available' as const,displayName:'Exact',credentialVersion:3 } }) }
 });
 expect(await worker.tick()).toBe(true);expect(await worker.tick()).toBe(true);
 const announced=calls.find(call=>call.path.endsWith('/announce'))!.body;expect(announced.claudeIdentity.identityId).toBe(claudeIdentityId(login));expect(JSON.stringify(announced)).not.toContain('fixture@example.test');expect(JSON.stringify(announced)).not.toContain('never-publish');
 const acquisitions=calls.filter(call=>call.path.endsWith('/credential')).map(call=>call.body.kind);expect(acquisitions).toEqual(['probe','turn']);
 const published=calls.find(call=>call.path.endsWith('/turns/turn') && call.body.status === 'completed');expect(published).toBeDefined();
 expect(published!.body.output).not.toContain('Summary answer');expect(decryptLegacy(decodeBase64(published!.body.output),f.key)).toMatchObject({ text:'Summary answer',bindingId:'binding',requestId:'request',direction:'output' });
 expect(published!.body.actual.modelId).toBe('native');
 const nativeCalls=(await readFile(audit,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 expect(nativeCalls.filter(call=>call.method === 'turn/start')).toHaveLength(1);
 expect(nativeCalls.find(call=>call.method === 'thread/start').params.baseInstructions).toContain('Summarize the supplied topic');
 expect((await readdir(join(root,'jobs'))).filter(name=>name.startsWith('job-'))).toEqual([]);
},15000);
it('shares the old machine-wide exclusion primitive',async()=>{
 const root=await mkdtemp(join(tmpdir(),'shared-worker-lock-'));roots.push(root);
 const release=await acquireMachineLock(machine.id,()=>{});expect(release).not.toBeNull();
 try { expect(await acquireMachineLock(machine.id,()=>{})).toBeNull(); } finally { await release!(); }
 const again=await acquireMachineLock(machine.id,()=>{});expect(again).not.toBeNull();await again!();
});
