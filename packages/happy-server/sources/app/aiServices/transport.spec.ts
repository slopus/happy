import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { NATIVE_SNAPSHOT_CIPHERTEXT_MAX_BYTES } from '@slopus/happy-wire';
import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import fastify from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import nacl from 'tweetnacl';
import type { Fastify } from '@/app/api/types';
const state=vi.hoisted(()=>({ database:null as unknown as PrismaClient }));
vi.mock('@/utils/log',()=>({ log:vi.fn() }));
vi.mock('@/storage/db',()=>({ db:new Proxy({}, { get:(_,key)=> { const value=(state.database as any)[key]; return typeof value === 'function' ? value.bind(state.database) : value; } }) }));
import { createTestDatabase } from './testDatabase';
import { createSharedAIServices } from './composition';
import { aiServiceRoutes } from '@/app/api/routes/aiServiceRoutes';
import { codexAccountRoutes } from '@/app/api/routes/codexAccountRoutes';
import { codexAccountStore } from '@/app/api/routes/codexAccountStore';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { auth } from '@/app/auth/auth';
import { initEncrypt } from '@/modules/encrypt';
import { sealServiceEnvelope } from './grants';
let ctx:Awaited<ReturnType<typeof createTestDatabase>>, app:Fastify, services:ReturnType<typeof createSharedAIServices>, token:string, owner:string,machine:string,seq=0;
const native=(account='native-A',access='access-one')=>({ OPENAI_API_KEY:null,tokens:{ account_id:account,access_token:access,refresh_token:'refresh-fixture',id_token:'id-fixture' },last_refresh:'2026-10-05T00:00:00.000Z' });

it('long polls phase changes and rejects authorization revoked while waiting', async () => {
 const f=await setup(),resolving=services.store.resolveBinding(f.principal,'relationship-advisor',f.service.id,{});
 await completeProbe(await nextProbe(),f.target);const binding=await resolving;
 const hints=vi.spyOn(services,'notifyWork');
 const accepted=await req(`/v1/apps/ai-services/bindings/${binding.id}/turns`,{requestId:'observed',ciphertext:'x'.repeat(80)},f.receipt.credential);
 expect(accepted.statusCode).toBe(200);const turn=accepted.json().record;
 expect(hints).toHaveBeenCalledWith(owner,machine);hints.mockRestore();
 const job=(await req(`/v1/ai-service-worker/${machine}/claim`)).json().job;
 const path=`/v1/apps/ai-services/bindings/${binding.id}/turns/${turn.id}`;
 const read=(suffix='')=>app.inject({method:'GET',url:path+suffix,headers:{authorization:`Bearer ${f.receipt.credential}`}});
 expect((await read()).json()).not.toHaveProperty('observationCursor');
 const first=(await read('?observe=1')).json();expect(first.observationCursor).toMatch(/^[a-f0-9]{64}$/);
 const original=services.turns.readBoundTurn.bind(services.turns);
 let entered:()=>void=()=>{};
 const spy=vi.spyOn(services.turns,'readBoundTurn').mockImplementation(async(...args)=>{const value=await original(...args);entered();return value;});
 try {
  let ready=new Promise<void>(resolve=>{entered=resolve;});
  const changed=read(`?observe=1&after=${first.observationCursor}`).then(value=>value);
  await ready;
  expect((await req(`/v1/ai-service-worker/${machine}/turns/${turn.id}`,{lease:job.lease,phase:'generating'})).statusCode).toBe(200);
  const next=(await changed).json();expect(next.record.phase).toBe('generating');expect(next.sequence).toBe(first.sequence);expect(next.observationCursor).not.toBe(first.observationCursor);
  ready=new Promise<void>(resolve=>{entered=resolve;});
  const revoked=read(`?observe=1&after=${next.observationCursor}`).then(value=>value);
  await ready;await services.store.revokeAuthorization(owner,f.receipt.id);
  const denied=await revoked;expect(denied.statusCode).toBe(409);expect(denied.json().error.code).toBe('authorization-revoked');
 } finally {spy.mockRestore();}
},30000);
const req=(path:string,body:unknown={},bearer=token)=>app.inject({ method:'POST',url:path,payload:body as any,headers:{ authorization:`Bearer ${bearer}` } });
beforeAll(async()=>{
 process.env.HANDY_MASTER_SECRET='test-shared-service-master'; await initEncrypt(); await auth.init();
 ctx=await createTestDatabase(); state.database=ctx.database; services=createSharedAIServices(ctx.database);
 app=fastify() as unknown as Fastify; app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler); enableAuthentication(app);
 aiServiceRoutes(app,services.store,services);codexAccountRoutes(app);await app.ready();
},120000);
beforeEach(async()=>{
 owner=`transport-${++seq}`;machine=`${owner}-machine`;await ctx.database.account.create({ data:{ id:owner,publicKey:owner } });
 await ctx.database.machine.create({ data:{ id:machine,accountId:owner,metadata:'sealed' } });token=await auth.createToken(owner);
 expect((await req(`/v1/ai-service-worker/${machine}/announce`,{ protocol:'ai-services/1',nativeSessions:true,publicKey:Buffer.from(nacl.box.keyPair().publicKey).toString('base64') })).statusCode).toBe(200);
});
afterAll(async()=>{ await app.close();await ctx.database.$disconnect();await ctx.pg.close(); });
async function setup() {
 const profile=(await codexAccountStore.upload(owner,native())).profile;
 const target={ machineId:machine,engine:'codex' as const,accountRef:{ kind:'codex-profile' as const,id:profile.id } };
 const service=await services.store.createService(owner,{ name:'Service',config:{ ...target,modelId:null,reasoning:{ mode:'default' } } });
 const receipt=await services.grants.issueServiceGrant(owner,'relationship-advisor',service.id,{ appId:'relationship-advisor',serviceId:service.id,targets:[target],permissions:['chat'],expiresAt:null });
 const principal=await services.grants.authenticate(receipt.credential);
 return { profile,target,service,receipt,principal };
}
async function nextProbe() {
 for(let i=0;i<200;i++) { const response=await req(`/v1/ai-service-worker/${machine}/claim`);expect(response.statusCode,response.body).toBe(200);if(response.json().probe)return response.json().probe;await new Promise(r=>setTimeout(r,10)); }
 throw new Error('No probe');
}
async function completeProbe(probe:any,target:any,executionPresets=false) {
 const catalog={ ...target,protocol:'ai-services/1',observedAt:Date.now(),availability:'online',completeness:'complete',defaultModelId:'native',
  ...(executionPresets?{execution:{permissionModes:['chat-only','yolo'],serviceTiers:['default','fast']}}:{}),
  models:[{ id:'native',name:'Native',supportsImages:false,reasoning:{ supportsDefault:true,values:[],defaultValue:null },...(executionPresets?{serviceTiers:['default','fast']}:{}) }] };
 const response=await req(`/v1/ai-service-worker/${machine}/probes/${probe.id}`,{ lease:probe.lease,catalog });expect(response.statusCode,response.body).toBe(200);
}
it('returns execution capabilities only when an owner or scoped client opts into the extension',async()=>{
 const f=await setup();
 for(const ownerRequest of [true,false])for(const executionPresets of [false,true]){
  const body=ownerRequest?{...f.target,...(executionPresets?{executionPresets:true}:{})}:{...(executionPresets?{executionPresets:true}:{})};
  const reading=req(ownerRequest?'/v1/ai-services/capabilities':'/v1/apps/ai-services/capabilities',body,ownerRequest?token:f.receipt.credential);
  if(ownerRequest && !executionPresets) await completeProbe(await nextProbe(),f.target,true);
  const response=await reading;expect(response.statusCode,response.body).toBe(200);
  const catalog=response.json().catalog;
  expect(catalog.execution).toEqual(executionPresets?{permissionModes:['chat-only','yolo'],serviceTiers:['default','fast']}:undefined);
  expect(catalog.models[0].serviceTiers).toEqual(executionPresets?['default','fast']:undefined);
  expect(Object.keys(catalog).sort()).toEqual(['accountRef','availability','completeness','defaultModelId','engine',...(executionPresets?['execution']:[]),'machineId','models','observedAt','protocol'].sort());
 }
},20000);
it('returns a scoped configuration directory without encrypted metadata or outside accounts', async () => {
 const f=await setup();
 await codexAccountStore.upload(owner,native('outside-account'));
 await ctx.database.machine.create({data:{id:machine+'-outside',accountId:owner,metadata:'private-machine-metadata'}});
 const response=await app.inject({method:'GET',url:'/v1/apps/ai-services/configuration',headers:{authorization:`Bearer ${f.receipt.credential}`}});
 expect(response.statusCode,response.body).toBe(200);
 expect(response.json()).toEqual({service:f.service,defaults:{...f.target,modelId:null,reasoning:{mode:'default'}},targets:[{target:f.target,machineName:machine,accountName:f.profile.displayName}],permissions:['chat'],allowModelOverride:true,allowReasoningOverride:true});
 for(const secret of ['sealed','private-machine-metadata','credential','outside-account',machine+'-outside'])expect(response.body).not.toContain(secret);
 expect((await app.inject({method:'GET',url:'/v1/apps/ai-services/configuration',headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(403);
});
it('accepts a scoped target for capability discovery and rejects a foreign tuple before queuing a probe',async()=>{
 const f=await setup();
 const pending=req('/v1/apps/ai-services/capabilities',{target:f.target},f.receipt.credential);
 const probe=await nextProbe();await completeProbe(probe,f.target);
 const response=await pending;expect(response.statusCode,response.body).toBe(200);expect(response.json().catalog.accountRef).toEqual(f.target.accountRef);
 const foreign=await req('/v1/apps/ai-services/capabilities',{target:{...f.target,machineId:machine+'-outside'}},f.receipt.credential);
 expect(foreign.statusCode,foreign.body).toBe(403);
 expect(await ctx.database.aIServiceProbe.count({where:{ownerId:owner}})).toBe(1);
});
it('upgrades an existing grant and its machine envelopes atomically while old bindings keep working',async()=>{
 const machineKeys=nacl.box.keyPair();
 await req(`/v1/ai-service-worker/${machine}/announce`,{protocol:'ai-services/1',nativeSessions:true,publicKey:Buffer.from(machineKeys.publicKey).toString('base64')});
 const f=await setup();
 const creating=services.store.resolveBinding(f.principal,'relationship-advisor',f.service.id,{});
 await completeProbe(await nextProbe(),f.target);const binding=await creating;
 const appPolicy=await ctx.database.aIServiceApplication.findUniqueOrThrow({where:{appId:'relationship-advisor'}});
 await ctx.database.aIServiceApplication.update({where:{appId:'relationship-advisor'},data:{policy:{...(appPolicy.policy as object),capabilities:['chat','images','tools']}}});
 const scope={...f.receipt.scope,permissions:['chat','tools'] as ('chat'|'tools')[]};
 const input={scope,allowModelOverride:true,allowReasoningOverride:true};
 const before=await ctx.database.aIServiceAuthorization.findUniqueOrThrow({where:{id:f.receipt.id}});
 await expect(services.store.updateAuthorizationScope(owner,f.receipt.id,input)).rejects.toMatchObject({code:'invalid-request'});
 await expect(services.store.updateAuthorizationScope(owner,f.receipt.id,input,async()=>{})).rejects.toMatchObject({code:'invalid-request'});
 await expect(services.store.updateAuthorizationScope(owner,f.receipt.id,{...input,scope:{...scope,permissions:['tools']}},async()=>{})).rejects.toMatchObject({code:'permission-denied'});
 const replacement=(await codexAccountStore.upload(owner,native('unapproved-upgrade-target'))).profile;
 await expect(services.store.updateAuthorizationScope(owner,f.receipt.id,{...input,scope:{...scope,targets:[{...f.target,accountRef:{kind:'codex-profile',id:replacement.id}}]}},async()=>{})).rejects.toMatchObject({code:'permission-denied'});
 await expect(services.store.updateAuthorizationScope(owner,f.receipt.id,input,async tx=>{
  await tx.aIServiceAuthorization.update({where:{id:f.receipt.id},data:{machineEnvelopes:{[machine]:'changed-in-rolled-back-transaction'}}});
  throw new Error('sealing-failed');
 })).rejects.toThrow('sealing-failed');
 expect(await ctx.database.aIServiceAuthorization.findUniqueOrThrow({where:{id:f.receipt.id}})).toEqual(before);
 const upgraded=await services.store.updateAuthorizationScope(owner,f.receipt.id,input,async(tx,grant)=>{
  const envelope=sealServiceEnvelope({protocol:grant.protocol,grantId:grant.id,ownerId:owner,appId:scope.appId,serviceId:scope.serviceId,scope:grant.scope,machineId:machine,messageKey:f.receipt.messageKey},Buffer.from(machineKeys.publicKey).toString('base64'));
  await tx.aIServiceAuthorization.update({where:{id:grant.id},data:{machineEnvelopes:{[machine]:envelope}}});
 });
 expect(upgraded).toMatchObject({id:f.receipt.id,scope});
 expect((await ctx.database.aIServiceAuthorization.findUniqueOrThrow({where:{id:f.receipt.id}})).credentialDigest).toBe(before.credentialDigest);
 const principal=await services.grants.authenticate(f.receipt.credential);
 expect(await services.store.readBinding(principal,'relationship-advisor',binding.id)).toEqual(binding);
 const starting=services.turns.startBoundTurn(principal,binding.id,'after-upgrade',{ciphertext:'x'.repeat(80)});
 const record=await starting;
 const job=(await req(`/v1/ai-service-worker/${machine}/claim`)).json().job;
 expect(job.record.id).toBe(record.id);expect(job.scope).toEqual(scope);
 const sealed=Buffer.from(job.envelope,'base64');
 const opened=nacl.box.open(sealed.subarray(56),sealed.subarray(32,56),sealed.subarray(0,32),machineKeys.secretKey);
 expect(JSON.parse(Buffer.from(opened!).toString())).toMatchObject({scope,messageKey:f.receipt.messageKey,grantId:f.receipt.id});
},20000);
it('authenticates actual callback transport, pins profile after default change, redeems latest refresh, and preserves legacy default grants',async()=>{
 const f=await setup();
 expect((await app.inject({ method:'GET',url:'/v1/ai-services',headers:{ authorization:`Bearer ${f.receipt.credential}` } })).statusCode).toBe(401);
 expect((await app.inject({ method:'GET',url:'/v1/apps/services',headers:{ authorization:`Bearer ${f.receipt.credential}`,origin:'https://advisor.paws.rodeo' } })).statusCode).toBe(403);
 const resolving=services.store.resolveBinding(f.principal,'relationship-advisor',f.service.id,{});
 const probe=await nextProbe();
 const other=(await codexAccountStore.upload(owner,native('native-B'))).profile;
 await codexAccountStore.bind(owner,machine,{ profileId:other.id,expectedVersion:0 });
 const issue=await req(`/v1/ai-service-worker/${machine}/credential`,{ kind:'probe',id:probe.id,lease:probe.lease });expect(issue.statusCode,issue.body).toBe(200);
 // A rotation between issue and redeem follows the same identity's current version.
 await codexAccountStore.upload(owner,native('native-A','access-two'));
 const redeemed=await req('/v1/codex-session-grants/redeem',{ machineId:machine,grant:issue.json().grant });expect(redeemed.statusCode,redeemed.body).toBe(200);
 expect(redeemed.json()).toMatchObject({ profile:{ id:f.profile.id,credentialVersion:2 },auth:{ tokens:{ access_token:'access-two' } } });
 await codexAccountStore.updateCredential(owner,f.profile.id,{ machineId:machine,launchId:redeemed.json().launchId,expectedVersion:2,auth:native('native-A','access-three') });
 await completeProbe(probe,f.target);
 const binding=await resolving;expect(binding.accountRef).toEqual(f.target.accountRef);
 const legacy=await codexAccountStore.createGrant(owner,machine);expect(legacy.profile.id).toBe(other.id);
 const starting=services.turns.startBoundTurn(f.principal,binding.id,'request-1',{ ciphertext:'x'.repeat(80) });
 const record=await starting;
 const claim=(await req(`/v1/ai-service-worker/${machine}/claim`)).json();expect(claim.job.record.id).toBe(record.id);
 const grant=await req(`/v1/ai-service-worker/${machine}/credential`,{ kind:'turn',id:record.id,lease:claim.job.lease });expect(grant.statusCode,grant.body).toBe(200);expect(grant.json().profile.id).toBe(f.profile.id);
 // Discovery IDs cannot masquerade as turns or resolve an application prompt.
 expect((await req(`/v1/ai-service-worker/${machine}/policy`,{ kind:'probe',id:probe.id,lease:probe.lease })).statusCode).toBe(403);
 expect((await req(`/v1/ai-service-worker/${machine}/credential`,{ kind:'turn',id:probe.id,lease:probe.lease })).statusCode).toBe(409);
 const policy=await req(`/v1/ai-service-worker/${machine}/policy`,{ kind:'turn',id:record.id,lease:claim.job.lease });expect(policy.statusCode,policy.body).toBe(200);expect(policy.json().prompt).toContain('狗头军师');
 await codexAccountStore.delete(owner,f.profile.id);
 expect((await req('/v1/codex-session-grants/redeem',{ machineId:machine,grant:grant.json().grant })).statusCode).not.toBe(200);
},20000);
it('revocation during a queued native probe denies credentials and atomic binding persistence',async()=>{
 const f=await setup(),resolving=services.store.resolveBinding(f.principal,'relationship-advisor',f.service.id,{});
 // Attach rejection now to avoid an unhandled rejection while the callback fails closed.
 const outcome=resolving.then(()=>null,error=>error);
 const probe=await nextProbe();await services.store.revokeAuthorization(owner,f.receipt.id);
 expect((await req(`/v1/ai-service-worker/${machine}/credential`,{ kind:'probe',id:probe.id,lease:probe.lease })).statusCode).toBe(409);
 await ctx.database.aIServiceProbe.update({ where:{ id:probe.id },data:{ state:'failed',error:'authorization-revoked' } });
 expect(await outcome).toBeInstanceOf(Error);
 expect(await ctx.database.aIServiceBinding.count({ where:{ serviceId:f.service.id } })).toBe(0);
});

it('exposes safe daemon-observed Claude identity only to its owner',async()=>{
 const f=await setup(),identityId='claude:'+ 'a'.repeat(64);
 const published=await req(`/v1/ai-service-worker/${machine}/announce`,{ protocol:'ai-services/1',nativeSessions:true,publicKey:Buffer.from(nacl.box.keyPair().publicKey).toString('base64'),claudeIdentity:{ identityId,observedAt:Date.now() } });
 expect(published.statusCode,published.body).toBe(200);
 const own=await app.inject({ method:'GET',url:'/v1/ai-services/workers',headers:{ authorization:`Bearer ${token}` } });
 expect(own.json().workers).toEqual([expect.objectContaining({ machineId:machine,serviceClaudeIdentity:identityId })]);
 expect(own.body).not.toContain('tokens');expect(own.body).not.toContain('email');
 expect((await app.inject({ method:'GET',url:'/v1/ai-services/workers',headers:{ authorization:`Bearer ${f.receipt.credential}` } })).statusCode).toBe(401);
 const foreign=await auth.createToken('foreign');
 expect((await req(`/v1/ai-service-worker/${machine}/announce`,{ protocol:'ai-services/1',nativeSessions:true,publicKey:Buffer.from(nacl.box.keyPair().publicKey).toString('base64') },foreign)).statusCode).toBe(403);
 expect((await app.inject({ method:'GET',url:'/v1/ai-services/workers',headers:{ authorization:`Bearer ${foreign}` } })).json()).toEqual({ workers:[] });
});

it('lists only the owner service grants and leaves retired authorization endpoints unavailable',async()=>{
 const f=await setup();
 const own=await app.inject({method:'GET',url:'/v1/ai-services/authorizations',headers:{authorization:`Bearer ${token}`}});
 expect(own.statusCode).toBe(200);
 expect(own.json().grants).toEqual(expect.arrayContaining([expect.objectContaining({id:f.receipt.id,protocol:'ai-services/1'})]));
 expect(own.body).not.toContain(f.receipt.credential);
 const foreign=await auth.createToken('foreign');
 expect((await app.inject({method:'GET',url:'/v1/ai-services/authorizations',headers:{authorization:`Bearer ${foreign}`}})).json()).toEqual({grants:[]});
 expect((await app.inject({method:'GET',url:'/v1/ai-services/authorizations'})).statusCode).toBe(401);
 for(const url of ['/v1/app-authorizations','/v1/apps/connection','/v1/apps/conversations']) {
  expect((await app.inject({method:'GET',url,headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(404);
 }
});

it('recovers a lost binding-create HTTP response with the same application conversation and no second probe',async()=>{
 const f=await setup();
 const creating=req('/v1/apps/ai-services/bindings',{overrides:{},appConversationId:'website-chat'},f.receipt.credential);
 const probe=await nextProbe();await completeProbe(probe,f.target);
 const first=await creating;expect(first.statusCode,first.body).toBe(200);
 const again=await req('/v1/apps/ai-services/bindings',{appConversationId:'website-chat',overrides:{}},f.receipt.credential);
 expect(again.statusCode,again.body).toBe(200);expect(again.json()).toEqual(first.json());
 const found=await app.inject({method:'GET',url:'/v1/apps/ai-services/conversations/website-chat/binding',headers:{authorization:`Bearer ${f.receipt.credential}`}});
 expect(found.statusCode,found.body).toBe(200);expect(found.json()).toEqual(first.json());
 expect(await ctx.database.aIServiceProbe.count({where:{machineId:machine}})).toBe(1);
 const changed=await req('/v1/apps/ai-services/bindings',{appConversationId:'website-chat',overrides:{modelId:'native'}},f.receipt.credential);
 expect(changed.json()).toMatchObject({error:{code:'invalid-request'}});
 await services.store.revokeAuthorization(owner,f.receipt.id);
 expect((await app.inject({method:'GET',url:'/v1/apps/ai-services/conversations/website-chat/binding',headers:{authorization:`Bearer ${f.receipt.credential}`}})).statusCode).not.toBe(200);
},20000);

for (const code of ['protocol-incompatible', 'account-identity-changed'] as const) it(`preserves ${code} through the actual probe route and store`, async () => {
 const f=await setup();
 const reading=services.probes.source.readLive(owner,f.target,f.principal);
 const result=expect(reading).rejects.toMatchObject({code});
 const probe=await nextProbe();
 const response=await req(`/v1/ai-service-worker/${machine}/probes/${probe.id}`,{lease:probe.lease,catalog:null,error:code});
 expect(response.statusCode,response.body).toBe(200);
 await result;
 expect((await ctx.database.aIServiceProbe.findUniqueOrThrow({where:{id:probe.id}})).error).toBe(code);
});

function screenshotFixture():string {
 const chunk=(type:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,body,checksum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(512,0);header.writeUInt32BE(512,4);header[8]=8;header[9]=2;
 const scanlines=Buffer.alloc((512*3+1)*512);for(let row=0;row<512;row++)randomBytes(512*3).copy(scanlines,row*(512*3+1)+1);
 return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(scanlines)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
it('accepts native encrypted screenshots through real routes, retains legacy limits and accounts exact bytes',async()=>{
 const f=await setup(),resolving=services.store.resolveBinding(f.principal,'relationship-advisor',f.service.id,{});
 await completeProbe(await nextProbe(),f.target);const binding=await resolving;
 const starting=services.turns.startBoundTurn(f.principal,binding.id,'image-request',{ciphertext:'i'.repeat(80)});
 const turn=await starting;
 const job=(await req(`/v1/ai-service-worker/${machine}/claim`)).json().job;
 const sessionId=`image-${binding.id}`;
 await ctx.database.session.create({data:{id:sessionId,accountId:owner,tag:`app-service:${binding.id}`,metadata:'encrypted'}});
 expect((await req(`/v1/ai-service-worker/${machine}/turns/${turn.id}/session`,{lease:job.lease,sessionId})).statusCode).toBe(200);
 const image=screenshotFixture(),messages=[{role:'user',text:'Inspect screenshots',images:[image,image,image,image]}];
 const seal=(payload:unknown)=>{const nonce=randomBytes(24);return Buffer.concat([nonce,Buffer.from(nacl.secretbox(Buffer.from(JSON.stringify(payload)),nonce,Buffer.from(f.receipt.messageKey,'base64')))]).toString('base64');};
 const context={protocol:'ai-services/1',grantId:f.receipt.id,appId:binding.appId,serviceId:binding.serviceId,bindingId:binding.id};
 const output=seal({...context,requestId:'image-request',turnId:turn.id,direction:'output',sequence:1,messages,text:'Screenshot answer'});
 expect(Buffer.byteLength(output)).toBeGreaterThan(5*1024*1024);
 await ctx.database.appChatTurn.update({where:{id:turn.id},data:{minimumProtocol:4}});
 expect((await req(`/v1/ai-service-worker/${machine}/turns/${turn.id}`,{lease:job.lease,status:'completed',sequence:1,output})).statusCode).toBe(413);
 await ctx.database.appChatTurn.update({where:{id:turn.id},data:{minimumProtocol:5}});
 const published=await req(`/v1/ai-service-worker/${machine}/turns/${turn.id}`,{lease:job.lease,status:'completed',sequence:1,output});
 expect(published.statusCode,published.body).toBe(200);
 expect((await services.turns.readBoundTurn(f.principal,binding.id,turn.id)).output).toBe(output);
 const reading=app.inject({method:'GET',url:`/v1/apps/ai-services/bindings/${binding.id}/session`,headers:{authorization:`Bearer ${f.receipt.credential}`}});
 let history:any;
 for(let i=0;i<100&&!history;i++){history=(await req(`/v1/ai-service-worker/${machine}/history/claim`)).json().history;if(!history)await new Promise(r=>setTimeout(r,5));}
 expect(history?.sessionId).toBe(sessionId);
 const ciphertext=seal({...context,requestId:history.requestId,direction:'session-history',sessionId,messages,active:false});
 expect((await req(`/v1/ai-service-worker/${machine}/history/${binding.id}`,{requestId:history.requestId,sessionId,ciphertext})).statusCode).toBe(200);
 expect((await reading).json().ciphertext).toBe(ciphertext);
 expect((await ctx.database.appDelegation.findUniqueOrThrow({where:{id:f.receipt.id}})).storedBytes).toBe(80+Buffer.byteLength(output)+Buffer.byteLength(ciphertext));
 const tooLarge=await req(`/v1/ai-service-worker/${machine}/history/${binding.id}`,{requestId:'over-limit',sessionId,ciphertext:'A'.repeat(NATIVE_SNAPSHOT_CIPHERTEXT_MAX_BYTES+1)});
 expect(tooLarge.statusCode).toBe(413);
},30000);

it('registers only the owned native session of a live service turn and retains the launch for owner resume', async () => {
 const f=await setup(),resolving=services.store.resolveBinding(f.principal,'relationship-advisor',f.service.id,{});
 const probe=await nextProbe();
 const probeGrant=(await req(`/v1/ai-service-worker/${machine}/credential`,{kind:'probe',id:probe.id,lease:probe.lease})).json();
 const probeLaunch=(await req('/v1/codex-session-grants/redeem',{machineId:machine,grant:probeGrant.grant})).json();
 await completeProbe(probe,f.target);const binding=await resolving;
 const starting=services.turns.startBoundTurn(f.principal,binding.id,'native-launch-registration',{ciphertext:'x'.repeat(80)});
 const record=await starting;
 const job=(await req(`/v1/ai-service-worker/${machine}/claim`)).json().job;
 const grant=(await req(`/v1/ai-service-worker/${machine}/credential`,{kind:'turn',id:record.id,lease:job.lease})).json();
 const launch=(await req('/v1/codex-session-grants/redeem',{machineId:machine,grant:grant.grant})).json();
 const session=await ctx.database.session.create({data:{accountId:owner,tag:`app-service:${binding.id}`,metadata:'sealed'}});
 const ordinary=await ctx.database.session.create({data:{accountId:owner,tag:'ordinary-session',metadata:'sealed'}});
 const register=(launchId:string,sourceSessionId=session.id,target=machine,bearer=token)=>req(`/v1/codex-session-grants/${launchId}/session`,{machineId:target,sourceSessionId},bearer);
 expect((await register(probeLaunch.launchId)).statusCode).not.toBe(200);
 expect((await register(launch.launchId,ordinary.id)).statusCode).not.toBe(200);
 expect((await register(launch.launchId,session.id,'foreign-machine')).statusCode).not.toBe(200);
 expect((await register(launch.launchId,session.id,machine,await auth.createToken('foreign-owner'))).statusCode).not.toBe(200);
 const attached=await register(launch.launchId);expect(attached.statusCode,attached.body).toBe(200);
 expect((await register(launch.launchId)).statusCode).toBe(200);
 expect((await register(launch.launchId,ordinary.id)).statusCode).not.toBe(200);
 const resume=await codexAccountStore.createGrant(owner,machine,session.id);expect(resume.profile.id).toBe(f.profile.id);
 await ctx.database.appChatTurn.update({where:{id:record.id},data:{leaseUntil:new Date(0)}});
 expect((await register(launch.launchId)).statusCode).not.toBe(200);
},20000);
