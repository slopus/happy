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
import { revokeAppGrant, deleteOwnedAppGrant } from '@/app/appDelegation/appDelegation';
import { initEncrypt } from '@/modules/encrypt';
let ctx:Awaited<ReturnType<typeof createTestDatabase>>, app:Fastify, services:ReturnType<typeof createSharedAIServices>, token:string, owner:string,machine:string,seq=0;
const native=(account='native-A',access='access-one')=>({ OPENAI_API_KEY:null,tokens:{ account_id:account,access_token:access,refresh_token:'refresh-fixture',id_token:'id-fixture' },last_refresh:'2026-10-05T00:00:00.000Z' });
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
 expect((await req(`/v1/ai-service-worker/${machine}/announce`,{ protocol:'ai-services/1',publicKey:Buffer.from(nacl.box.keyPair().publicKey).toString('base64') })).statusCode).toBe(200);
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
async function completeProbe(probe:any,target:any) {
 const catalog={ ...target,protocol:'ai-services/1',observedAt:Date.now(),availability:'online',completeness:'complete',defaultModelId:'native',models:[{ id:'native',name:'Native',supportsImages:false,reasoning:{ supportsDefault:true,values:[],defaultValue:null } }] };
 const response=await req(`/v1/ai-service-worker/${machine}/probes/${probe.id}`,{ lease:probe.lease,catalog });expect(response.statusCode,response.body).toBe(200);
}
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
 const turnProbe=await nextProbe();await completeProbe(turnProbe,f.target);const record=await starting;
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
 const published=await req(`/v1/ai-service-worker/${machine}/announce`,{ protocol:'ai-services/1',publicKey:Buffer.from(nacl.box.keyPair().publicKey).toString('base64'),claudeIdentity:{ identityId,observedAt:Date.now() } });
 expect(published.statusCode,published.body).toBe(200);
 const own=await app.inject({ method:'GET',url:'/v1/ai-services/workers',headers:{ authorization:`Bearer ${token}` } });
 expect(own.json().workers).toEqual([expect.objectContaining({ machineId:machine,serviceClaudeIdentity:identityId })]);
 expect(own.body).not.toContain('tokens');expect(own.body).not.toContain('email');
 expect((await app.inject({ method:'GET',url:'/v1/ai-services/workers',headers:{ authorization:`Bearer ${f.receipt.credential}` } })).statusCode).toBe(401);
 const foreign=await auth.createToken('foreign');
 expect((await req(`/v1/ai-service-worker/${machine}/announce`,{ protocol:'ai-services/1',publicKey:Buffer.from(nacl.box.keyPair().publicKey).toString('base64') },foreign)).statusCode).toBe(403);
 expect((await app.inject({ method:'GET',url:'/v1/ai-services/workers',headers:{ authorization:`Bearer ${foreign}` } })).json()).toEqual({ workers:[] });
});

it('prevents legacy owner mutations from corrupting shared grant history and terminal states',async()=>{
 const f=await setup();
 await expect(revokeAppGrant(owner,f.receipt.id)).rejects.toThrow();
 await expect(deleteOwnedAppGrant(owner,f.receipt.id)).rejects.toThrow();
 expect((await ctx.database.appDelegation.findUniqueOrThrow({ where:{ id:f.receipt.id } })).state).toBe('service-ready');
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
