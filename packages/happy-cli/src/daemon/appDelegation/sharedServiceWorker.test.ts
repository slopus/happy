import { deflateSync } from 'node:zlib';
import { NATIVE_SNAPSHOT_PLAINTEXT_MAX_BYTES, NATIVE_SNAPSHOT_CIPHERTEXT_MAX_BYTES } from '@slopus/happy-wire';
import type { NativeMessage } from './nativeSessionRuntime';
import { afterEach, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, readdir, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Machine } from '@/api/types';
import { encryptLegacy, decryptLegacy, encodeBase64, decodeBase64, libsodiumEncryptForPublicKey } from '@/api/encryption';
import { createSharedServiceWorker, encodeNativeServiceSnapshot, decodeServiceJob, serviceMachineKey, type SharedServiceJob } from './sharedServiceWorker';
import { claudeIdentityId } from './serviceCapabilities';
import { acquireMachineLock } from './workerLock';
/** A valid uncompressible 512x512 RGB PNG, large enough to cross the old 1MiB encrypted-output cap. */
function screenshotFixture():string {
 const chunk=(type:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,body,checksum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(512,0);header.writeUInt32BE(512,4);header[8]=8;header[9]=2;
 const scanlines=Buffer.alloc((512*3+1)*512);for(let row=0;row<512;row++)randomBytes(512*3).copy(scanlines,row*(512*3+1)+1);
 return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(scanlines)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
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
it('accepts the same scoped account after JSONB reorders keys and still rejects a different account',()=>{
 const f=jobFixture();
 f.job.scope={ ...f.job.scope,targets:[{ machineId:target.machineId,engine:target.engine,accountRef:{ id:target.accountRef.id,kind:target.accountRef.kind } }] };
 expect(Object.keys(f.job.scope.targets[0].accountRef)).toEqual(['id','kind']);
 expect(Object.keys(f.job.record.binding.accountRef)).toEqual(['kind','id']);
 expect(decodeServiceJob(machine,f.job).messages).toEqual(f.payload.messages);
 expect(()=>decodeServiceJob(machine,{ ...f.job,record:{ ...f.job.record,binding:{ ...binding,accountRef:{ id:'other-account',kind:'codex-profile' } } } })).toThrow('permission-denied');
 expect(()=>decodeServiceJob(machine,{ ...f.job,record:{ ...f.job.record,binding:{ ...binding,machineId:'other-machine' } } })).toThrow('permission-denied');
 expect(()=>decodeServiceJob(machine,{ ...f.job,record:{ ...f.job.record,binding:{ ...binding,engine:'claude',accountRef:{ kind:'device-identity',machineId:machine.id,identityId:'other-runtime' } } } })).toThrow('permission-denied');
});
it.each([false,true])('publishes authenticated native output and explicit history including large screenshots=%s',async withImage=>{
 const root=await mkdtemp(join(tmpdir(),'shared-worker-'));roots.push(root);const binary=join(root,'codex'),audit=join(root,'audit');
 await writeFile(binary,`#!/usr/bin/env node
const fs=require('fs'),rl=require('readline');if(process.argv.includes('--version')){console.log('codex-cli 0.159.3');process.exit(0)};
rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify(m)+'\\n');if(m.id==null)return;let result={};if(m.method==='model/list')result={data:[{id:'native',model:'native',displayName:'Native',isDefault:true,inputModalities:['text'],supportedReasoningEfforts:[],defaultReasoningEffort:null}],nextCursor:null};if(m.method==='thread/start')result={thread:{id:'thread'},model:'native'};console.log(JSON.stringify({id:m.id,result}));if(m.method==='turn/start'){console.log(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'Summary answer'}}));console.log(JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}}));}});`,{ mode:0o700 });
 const claude=join(root,'claude'),login={ loggedIn:true,authMethod:'oauth',apiProvider:'firstParty',email:'fixture@example.test',orgId:'fixture-org',tokens:'never-publish' };
 await writeFile(claude,'#!/usr/bin/env node\nconsole.log('+JSON.stringify(JSON.stringify({ loggedIn:true,authMethod:'oauth',apiProvider:'firstParty',email:'fixture@example.test',orgId:'fixture-org',tokens:'never-publish' }))+');',{ mode:0o700 });
 const image=withImage?screenshotFixture():undefined;
 const f=jobFixture(),calls:{ path:string;body:any }[]=[],saved:any[]=[];let phase=0,rejectSize=false;
 f.job.scope={ ...f.job.scope,targets:[{ machineId:target.machineId,engine:target.engine,accountRef:{ id:target.accountRef.id,kind:target.accountRef.kind } }] };
 if(image)f.job.input=encodeBase64(encryptLegacy({...f.payload,messages:[{...f.payload.messages[0],images:[image]}]},f.key));
 const nativeMessages:NativeMessage[]=[];let consumer:((message:NativeMessage)=>void)|undefined,nativePrompt='';
 const append=(content:unknown,localId:string|null=null)=>{const message={id:String(nativeMessages.length+1),seq:nativeMessages.length+1,localId,content};nativeMessages.push(message);consumer?.(message);};
 const worker=createSharedServiceWorker({ machine,recoveryRoot:join(root,'jobs'),lifetime:new AbortController().signal,codexBinary:binary,claudeBinary:claude,
  nativeSessionHooks:{connect:async()=>{},get:async()=>({id:'native-session',active:true,metadata:{machineId:machine.id,application:{appId:binding.appId,bindingId:binding.id},codexAccountProfileId:'exact-profile',currentModelCode:'native'},agentState:{}}),
   start:async input=>{nativePrompt=input.systemPrompt;expect(input.codexSessionGrant).toBe('g'.repeat(43));append({role:'agent',content:{type:'event',data:{type:'ready'}}});return {type:'success',sessionId:'native-session'};},
   historyPage:async(_id,{afterSeq})=>({messages:nativeMessages.filter(message=>message.seq>afterSeq),hasMore:false}),
   watch:async(_id,options)=>{consumer=message=>{if(message.seq>options.afterSeq)options.onMessage(message);};nativeMessages.forEach(consumer);return {sync:async()=>{},unsubscribe:()=>{consumer=undefined;}};},
   readImage:async()=>image!,
   send:async input=>{if(image)append({role:'session',content:{type:'session',data:{role:'user',ev:{t:'file',ref:'sessions/native-session/attachments/screenshot.enc',mimeType:'image/png'}}}},input.localId+':image:0');append({role:'user',content:{type:'text',text:input.text}},input.localId);for(const ev of [{t:'turn-start',localIds:[input.localId]},{t:'text',text:'Summary answer'}])append({role:'session',content:{type:'session',data:{role:'agent',turn:'native-turn',ev}}});if(image)await new Promise(resolve=>setTimeout(resolve,3200));append({role:'session',content:{type:'session',data:{role:'agent',turn:'native-turn',ev:{t:'turn-end',status:'completed'}}}});},cancel:async()=>{}},
  request:async <T>(path:string,body:any):Promise<T>=>{
   calls.push({ path,body });
   if(rejectSize && path.endsWith('/turns/turn') && body.status){rejectSize=false;throw new Error('snapshot-too-large');}
   if(path.endsWith('/announce'))return {} as T;
   if(path.endsWith('/history/claim'))return {history:{id:binding.id,sessionId:'native-session',binding,grantId:f.job.grantId,ownerId:f.job.ownerId,scope:f.job.scope,envelope:f.job.envelope,requestId:'history-request'}} as T;
   if((path.endsWith('/turns/turn')&&body.output)||path.endsWith('/history/binding'))expect(Buffer.byteLength(body.output||body.ciphertext)).toBeLessThanOrEqual(NATIVE_SNAPSHOT_CIPHERTEXT_MAX_BYTES);
   if(path.endsWith('/claim'))return (phase++ === 0 ? { probe:{ id:'probe',lease:'p'.repeat(43),target,deadline:Date.now()+20000 },job:null } : { probe:null,job:f.job }) as T;
   if(path.endsWith('/authority'))return { target:{ accountRef:{ id:target.accountRef.id,kind:target.accountRef.kind },engine:target.engine,machineId:target.machineId } } as T;
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
 if(image){const heartbeat=calls.find(call=>call.path.endsWith('/turns/turn')&&call.body.output&&!call.body.status)!;expect(heartbeat).toBeDefined();const partial=decryptLegacy(decodeBase64(heartbeat.body.output),f.key);expect(partial).toMatchObject({historyComplete:false,text:'Summary answer'});expect(partial.messages).toBeUndefined();expect(Buffer.byteLength(heartbeat.body.output)).toBeLessThan(2048);expect(Buffer.byteLength(published!.body.output)).toBeGreaterThan(1024*1024);expect(decryptLegacy(decodeBase64(published!.body.output),f.key).messages.at(-1).images).toEqual([image]);}
 await worker.tickHistory();const history=calls.find(call=>call.path.endsWith('/history/binding'))!.body;const snapshot=decryptLegacy(decodeBase64(history.ciphertext),f.key);expect(snapshot.messages.map((message:{text:string})=>message.text)).toEqual(['A short topic.','Summary answer']);if(image)expect(snapshot.messages[0].images).toEqual([image]);
 const nativeCalls=(await readFile(audit,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 expect(nativeCalls.filter(call=>call.method === 'turn/start')).toHaveLength(0);
 expect(nativePrompt).toContain('Summarize the supplied topic');
 expect((await readdir(join(root,'jobs'))).filter(name=>name.startsWith('job-'))).toEqual([]);
 rejectSize=withImage;
 f.job.record.status='cancel-requested';f.job.record.sessionId='native-session';
 await worker.tick();
 const reconciled=calls.filter(call=>call.path.endsWith('/turns/turn')&&call.body.status).at(-1)!;
 expect(reconciled.body.status).toBe('completed');expect(decryptLegacy(decodeBase64(reconciled.body.output),f.key)).toMatchObject(withImage?{text:'Summary answer',messages:[],snapshotError:'snapshot-too-large'}:{text:'Summary answer'});
},15000);
it('shares the old machine-wide exclusion primitive',async()=>{
 const root=await mkdtemp(join(tmpdir(),'shared-worker-lock-'));roots.push(root);
 const release=await acquireMachineLock(machine.id,()=>{});expect(release).not.toBeNull();
 try { expect(await acquireMachineLock(machine.id,()=>{})).toBeNull(); } finally { await release!(); }
 const again=await acquireMachineLock(machine.id,()=>{});expect(again).not.toBeNull();await again!();
});

it('compacts an over-cap native snapshot explicitly without losing its terminal response',()=>{
 const key=randomBytes(32),image=screenshotFixture();
 const messages=Array.from({length:10},(_,index)=>({role:'user',text:String(index),images:[image]}));
 expect(Buffer.byteLength(JSON.stringify(messages))).toBeGreaterThan(NATIVE_SNAPSHOT_PLAINTEXT_MAX_BYTES);
 const output=encodeNativeServiceSnapshot({direction:'output',text:'Native execution completed.',messages},key);
 expect(Buffer.byteLength(output)).toBeLessThan(NATIVE_SNAPSHOT_CIPHERTEXT_MAX_BYTES);
 expect(decryptLegacy(decodeBase64(output),key)).toEqual({direction:'output',text:'Native execution completed.',messages:[],snapshotError:'snapshot-too-large'});
 const history=encodeNativeServiceSnapshot({direction:'session-history',sessionId:'native',active:false,messages},key);
 expect(decryptLegacy(decodeBase64(history),key)).toMatchObject({sessionId:'native',active:false,messages:[],snapshotError:'snapshot-too-large'});
});
