import { beforeAll, afterAll, it, expect } from 'vitest';
import type { CapabilityCatalog } from '@slopus/happy-wire';
import { createTestDatabase } from './testDatabase';
import { createAIServiceStore } from './store';
import { createServiceGrants } from './grants';
import { createServiceProbes } from './probes';
import nacl from 'tweetnacl';

let context: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { context = await createTestDatabase(); }, 120000);
afterAll(async () => { await context.database.$disconnect(); await context.pg.close(); });

it('shares same-principal discovery and reuses fresh results without caching authorization', async () => {
 const db=context.database, owner='probe-owner';
 const target={machineId:'probe-machine',engine:'codex' as const,accountRef:{kind:'codex-profile' as const,id:'probe-profile'}};
 await db.account.create({data:{id:owner,publicKey:owner}});
 await db.machine.create({data:{id:target.machineId,accountId:owner,metadata:'encrypted'}});
 await db.codexAccountProfile.create({data:{id:target.accountRef.id,accountId:owner,displayName:'A',externalAccountFingerprint:'A',credential:Buffer.from('cipher')}});
 const catalog:CapabilityCatalog={...target,protocol:'ai-services/1',observedAt:Date.now(),availability:'online',completeness:'complete',defaultModelId:'m',models:[{id:'m',name:'M',supportsImages:false,reasoning:{supportsDefault:true,values:[],defaultValue:null}}]};
 const store=createAIServiceStore(db,{readLive:async()=>catalog});
 const service=await store.createService(owner,{name:'Service',config:{...target,modelId:null,reasoning:{mode:'default'}}});
 const notifications:Array<Promise<number>>=[];
 const probes=createServiceProbes(db,(ownerId,machineId)=>{expect(ownerId).toBe(owner);expect(machineId).toBe(target.machineId);notifications.push(db.aIServiceProbe.count({where:{ownerId,machineId}}));});
 await probes.announce(owner,target.machineId,Buffer.from(nacl.box.keyPair().publicKey).toString('base64'),null,true);
 const grants=createServiceGrants(db,store);
 const receipt=await grants.issueServiceGrant(owner,'relationship-advisor',service.id,{appId:'relationship-advisor',serviceId:service.id,targets:[target],permissions:['chat'],expiresAt:null});
 const principal=await grants.authenticate(receipt.credential);
 const reads=Promise.all([probes.source.readLive(owner,target,principal),probes.source.readLive(owner,target,principal)]);
 const outcome=reads.then(value=>({value}),error=>({error}));
 let job:Awaited<ReturnType<typeof probes.claim>>=null;
 for(let i=0;i<50&&!job;i++){job=await probes.claim(owner,target.machineId);if(!job)await new Promise(resolve=>setTimeout(resolve,10));}
 expect(job).not.toBeNull();
 await probes.publish(owner,target.machineId,job!.id,job!.lease,catalog);
 expect(await outcome).toEqual({value:[catalog,catalog]});
 expect(await db.aIServiceProbe.count({where:{ownerId:owner}})).toBe(1);
 expect(notifications.length).toBeGreaterThan(0);expect((await Promise.all(notifications)).every(count=>count===1)).toBe(true);
 const notificationCount=notifications.length;
 expect(await probes.source.readLive(owner,target,principal)).toEqual(catalog);
 expect(await probes.claim(owner,target.machineId)).toBeNull();
 expect(notifications).toHaveLength(notificationCount);
 // Worker liveness and account identity are checked even when a catalog exists.
 await db.appChatWorker.update({where:{machineId:target.machineId},data:{activeUntil:new Date(0)}});
 await expect(probes.source.readLive(owner,target,principal)).rejects.toMatchObject({code:'machine-offline'});
 await probes.announce(owner,target.machineId,Buffer.from(nacl.box.keyPair().publicKey).toString('base64'),null,true);
 await db.codexAccountProfile.update({where:{id:target.accountRef.id},data:{externalAccountFingerprint:'B'}});
 await expect(probes.source.readLive(owner,target,principal)).rejects.toMatchObject({code:'account-identity-changed'});
 await db.codexAccountProfile.update({where:{id:target.accountRef.id},data:{externalAccountFingerprint:'A'}});
 // Expired catalog must cause a new discovery, not acquire a new observedAt.
 await db.aIServiceProbe.update({where:{id:job!.id},data:{catalog:{...catalog,observedAt:Date.now()-61000}}});
 const refresh=probes.source.readLive(owner,target,principal).then(value=>({value}),error=>({error}));
 let next:Awaited<ReturnType<typeof probes.claim>>=null;
 for(let i=0;i<50&&!next;i++){next=await probes.claim(owner,target.machineId);if(!next)await new Promise(resolve=>setTimeout(resolve,10));}
 expect(next?.id).not.toBe(job!.id);
 await probes.publish(owner,target.machineId,next!.id,next!.lease,{...catalog,observedAt:Date.now()});
 expect(await refresh).toHaveProperty('value');
 // A Claude login is local to the device. Even a fresh catalog for A cannot
 // substitute for discovery after the worker announces a different login B.
 const claude={machineId:target.machineId,engine:'claude' as const,accountRef:{kind:'device-identity' as const,machineId:target.machineId,identityId:'claude:'+'a'.repeat(64)}};
 const claudeCatalog:CapabilityCatalog={...catalog,...claude};
 const ownerPrincipal={kind:'owner' as const,ownerId:owner};
 await db.aIServiceProbe.create({data:{id:'cached-claude',ownerId:owner,machineId:target.machineId,principal:ownerPrincipal,target:claude,fingerprint:claude.accountRef.identityId,state:'completed',deadline:new Date(Date.now()+25000),catalog:claudeCatalog}});
 await probes.announce(owner,target.machineId,Buffer.from(nacl.box.keyPair().publicKey).toString('base64'),{identityId:'claude:'+'b'.repeat(64),observedAt:Date.now()},true);
 const claudeRead=probes.source.readLive(owner,claude,ownerPrincipal).then(value=>({value}),error=>({error}));
 let claudeJob:Awaited<ReturnType<typeof probes.claim>>=null;
 for(let i=0;i<50&&!claudeJob;i++){claudeJob=await probes.claim(owner,target.machineId);if(!claudeJob)await new Promise(resolve=>setTimeout(resolve,10));}
 expect(claudeJob?.target).toEqual(claude);
 await probes.publish(owner,target.machineId,claudeJob!.id,claudeJob!.lease,null,'account-identity-changed');
 expect(await claudeRead).toMatchObject({error:{code:'account-identity-changed'}});
 await store.revokeAuthorization(owner,receipt.id);
 await expect(probes.source.readLive(owner,target,principal)).rejects.toMatchObject({code:'authorization-revoked'});
},30000);
