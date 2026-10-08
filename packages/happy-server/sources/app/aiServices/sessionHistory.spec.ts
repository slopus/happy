import { beforeAll, afterAll, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { createTestDatabase } from './testDatabase';
import { createAIServiceStore } from './store';
import { createServiceGrants } from './grants';
import { createServiceTurns } from './turns';
import { createSessionHistory } from './sessionHistory';
let context: Awaited<ReturnType<typeof createTestDatabase>>, serial = 0;
beforeAll(async () => { context = await createTestDatabase(); }, 120000);
afterAll(async () => { await context.database.$disconnect(); await context.pg.close(); });
async function fixture() {
 const db=context.database, ownerId=`history-owner-${++serial}`, machineId=`history-machine-${serial}`, profileId=`history-profile-${serial}`;
 await db.account.create({data:{id:ownerId,publicKey:ownerId}});
 await db.machine.create({data:{id:machineId,accountId:ownerId,metadata:'cipher'}});
 await db.codexAccountProfile.create({data:{id:profileId,accountId:ownerId,displayName:'A',externalAccountFingerprint:'A',credential:Buffer.from('cipher')}});
 const target={machineId,engine:'codex' as const,accountRef:{kind:'codex-profile' as const,id:profileId}};
 const store=createAIServiceStore(db,{readLive:async()=>({...target,protocol:'ai-services/1',observedAt:Date.now(),availability:'online',completeness:'complete',defaultModelId:'m',models:[{id:'m',name:'M',supportsImages:false,reasoning:{supportsDefault:true,values:[],defaultValue:null}}]})});
 await db.appChatWorker.create({data:{machineId,accountId:ownerId,protocol:3,serviceProtocol:'ai-services/1',nativeSessions:true,servicePublicKey:Buffer.from(nacl.box.keyPair().publicKey).toString('base64'),activeUntil:new Date(Date.now()+60000)}});
 const service=await store.createService(ownerId,{name:'History',config:{...target,modelId:null,reasoning:{mode:'default'}}});
 const grants=createServiceGrants(db,store), receipt=await grants.issueServiceGrant(ownerId,'relationship-advisor',service.id,{appId:'relationship-advisor',serviceId:service.id,targets:[target],permissions:['chat'],expiresAt:null});
 const principal=await grants.authenticate(receipt.credential),history=createSessionHistory(db,store),turns=createServiceTurns(db,store);
 async function bind(mapped=true) { const binding=await store.resolveBinding(principal,'relationship-advisor',service.id,{});if(mapped) await db.aIServiceBinding.update({where:{id:binding.id},data:{sessionId:`session-${binding.id}`}});return binding; }
 async function claim() { for(let i=0;i<100;i++){const job=await history.claim(ownerId,machineId);if(job)return job;await new Promise(r=>setTimeout(r,5));}throw new Error('history job not queued'); }
 return {db,store,service,ownerId,machineId,principal,receipt,history,turns,bind,claim};
}
it('coalesces first readers and retains responses across replacement before consumption', async()=>{
 const f=await fixture(),b=await f.bind();
 const oldReads=[f.history.read(f.principal,b.id),f.history.read(f.principal,b.id)];
 const first=await f.claim();
 await f.history.publish(f.ownerId,f.machineId,b.id,{requestId:first.requestId,sessionId:first.sessionId,ciphertext:'a'.repeat(80)});
 const nextRead=f.history.read(f.principal,b.id),next=await f.claim();
 expect(next.requestId).not.toBe(first.requestId);
 await f.history.publish(f.ownerId,f.machineId,b.id,{requestId:next.requestId,sessionId:next.sessionId,ciphertext:'b'.repeat(80)});
 expect((await Promise.all(oldReads)).map(r=>r.ciphertext)).toEqual(['a'.repeat(80),'a'.repeat(80)]);
 expect((await nextRead).ciphertext).toBe('b'.repeat(80));
 expect((await f.db.appDelegation.findUniqueOrThrow({where:{id:f.receipt.id}})).storedBytes).toBe(160);
 await f.db.aIServiceHistoryRequest.updateMany({where:{bindingId:b.id},data:{deadline:new Date(0)}});
 const refreshed=f.history.read(f.principal,b.id),fresh=await f.claim();
 await f.history.publish(f.ownerId,f.machineId,b.id,{requestId:fresh.requestId,sessionId:fresh.sessionId,ciphertext:'c'.repeat(80)});
 await refreshed;
 expect((await f.db.appDelegation.findUniqueOrThrow({where:{id:f.receipt.id}})).storedBytes).toBe(80);

},30000);
it('serializes a shared grant quota across binding publications',async()=>{
 const f=await fixture(),one=await f.bind(),two=await f.bind();
 const results=[one,two].map(b=>f.history.read(f.principal,b.id).then(value=>({value}),error=>({error})));
 const a=await f.claim(),b=await f.claim();
 await f.db.appDelegation.update({where:{id:f.receipt.id},data:{storedBytes:100*1024*1024-100}});
 const published=await Promise.allSettled([a,b].map(job=>f.history.publish(f.ownerId,f.machineId,job.id,{requestId:job.requestId,sessionId:job.sessionId,ciphertext:'q'.repeat(80)})));
 expect(published.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(published.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'resource-busy'}});
 expect((await f.db.appDelegation.findUniqueOrThrow({where:{id:f.receipt.id}})).storedBytes).toBe(100*1024*1024-20);
 await f.db.aIServiceHistoryRequest.updateMany({where:{bindingId:{in:[one.id,two.id]},state:'running'},data:{state:'failed',error:'resource-busy'}});
 await Promise.all(results);
},30000);
it.each(['disabled','revoked','missing-envelope'] as const)('retires a %s queue head and serves the later valid request',async(mode)=>{
 const f=await fixture(),bad=await f.bind();
 const pending=f.history.read(f.principal,bad.id).then(value=>({value}),error=>({error}));
 for(let i=0;i<100;i++){if(await f.db.aIServiceHistoryRequest.count({where:{bindingId:bad.id}}))break;await new Promise(r=>setTimeout(r,5));}
 const service=await f.store.createService(f.ownerId,{name:'Other',config:(await f.store.readService(f.ownerId,f.service.id)).revision.config});
 const grants=createServiceGrants(f.db,f.store),receipt=await grants.issueServiceGrant(f.ownerId,'relationship-advisor',service.id,{...f.principal.scope,serviceId:service.id});
 const principal=await grants.authenticate(receipt.credential),binding=await f.store.resolveBinding(principal,'relationship-advisor',service.id,{});
 await f.db.aIServiceBinding.update({where:{id:binding.id},data:{sessionId:`valid-${binding.id}`}});
 if(mode==='disabled') await f.db.aIService.update({where:{id:f.service.id},data:{enabled:false}});
 if(mode==='revoked') await f.store.revokeAuthorization(f.ownerId,f.receipt.id);
 if(mode==='missing-envelope') await f.db.aIServiceAuthorization.update({where:{id:f.receipt.id},data:{machineEnvelopes:{}}});
 const valid=f.history.read(principal,binding.id),job=await f.claim();
 expect(job.id).toBe(binding.id);
 await f.history.publish(f.ownerId,f.machineId,binding.id,{requestId:job.requestId,sessionId:job.sessionId,ciphertext:'v'.repeat(80)});
 expect(await pending).toMatchObject({error:{code:mode==='disabled'?'service-disabled':mode==='revoked'?'authorization-revoked':'permission-denied'}});
 expect((await valid).ciphertext).toBe('v'.repeat(80));
},30000);
it('exposes admitted work before attachment and explicitly retires protocol 4 accepted turns',async()=>{
 const f=await fixture(),b=await f.bind(false),turn=await f.turns.startBoundTurn(f.principal,b.id,'request',{ciphertext:'i'.repeat(80)});
 expect(await f.history.read(f.principal,b.id)).toMatchObject({sessionId:null,active:true,phase:'connecting'});
 const job=await f.turns.claim(f.ownerId,f.machineId);
 await f.turns.publish(f.ownerId,f.machineId,turn.id,{lease:job!.lease,phase:'preparing'});
 expect(await f.history.read(f.principal,b.id)).toMatchObject({sessionId:null,active:true,phase:'preparing'});
 await f.db.session.create({data:{id:`attached-${b.id}`,accountId:f.ownerId,tag:`app-service:${b.id}`,metadata:'encrypted'}});
 await f.turns.attachSession(f.ownerId,f.machineId,turn.id,{lease:job!.lease,sessionId:`attached-${b.id}`});
 const attached=f.history.read(f.principal,b.id),historyJob=await f.claim();
 await f.history.publish(f.ownerId,f.machineId,b.id,{requestId:historyJob.requestId,sessionId:historyJob.sessionId,ciphertext:'mapped'.repeat(20)});
 expect(await attached).toMatchObject({sessionId:`attached-${b.id}`,ciphertext:'mapped'.repeat(20)});

 await f.db.appChatTurn.update({where:{id:turn.id},data:{minimumProtocol:4,state:'accepted',lease:null,leaseUntil:null}});
 await f.db.appChatWorker.update({where:{machineId:f.machineId},data:{nativeSessions:false}});
 await expect(f.turns.claim('foreign-owner',f.machineId)).rejects.toMatchObject({code:'permission-denied'});
 expect((await f.db.appChatTurn.findUniqueOrThrow({where:{id:turn.id}})).state).toBe('accepted');
 expect(await f.turns.claim(f.ownerId,f.machineId)).toBeNull();
 expect((await f.turns.readBoundTurn(f.principal,b.id,turn.id)).record).toMatchObject({status:'interrupted',error:{code:'protocol-incompatible',retryable:false}});
},30000);

it('preserves a durable native completion observed after cancellation was requested',async()=>{
 const f=await fixture(),b=await f.bind(),turn=await f.turns.startBoundTurn(f.principal,b.id,'late-cancel',{ciphertext:'i'.repeat(80)});
 const job=await f.turns.claim(f.ownerId,f.machineId);
 await f.turns.cancelBoundTurn(f.principal,b.id,turn.id);
 await f.turns.publish(f.ownerId,f.machineId,turn.id,{lease:job!.lease,status:'completed',sequence:1,output:'done'.repeat(20)});
 expect((await f.turns.readBoundTurn(f.principal,b.id,turn.id)).record.status).toBe('completed');
},30000);

it.each(['history-read', 'history-publish', 'turn-start', 'turn-publish'] as const)('reclaims expired A history through %s on B without charging other grants', async operation => {
 const f=await fixture(),other=await fixture(),a=await f.bind(),b=await f.bind(),foreign=await other.bind();
 let historyJob: Awaited<ReturnType<typeof f.claim>> | undefined;
 let historyRead: ReturnType<typeof f.history.read> | undefined;
 let turn: Awaited<ReturnType<typeof f.turns.startBoundTurn>> | undefined;
 let turnJob: Awaited<ReturnType<typeof f.turns.claim>> | undefined;
 if(operation==='history-publish') {historyRead=f.history.read(f.principal,b.id);historyJob=await f.claim();}
 if(operation==='turn-publish') {turn=await f.turns.startBoundTurn(f.principal,b.id,'turn',{ciphertext:'i'.repeat(80)});turnJob=await f.turns.claim(f.ownerId,f.machineId);}
 await f.db.aIServiceHistoryRequest.createMany({data:[
  {id:`expired-${a.id}`,bindingId:a.id,sessionId:`session-${a.id}`,state:'completed',ciphertext:'a'.repeat(80),deadline:new Date(0)},
  {id:`retained-${a.id}`,bindingId:a.id,sessionId:`session-${a.id}`,state:'completed',ciphertext:'live'.repeat(20),deadline:new Date()},
  {id:`foreign-${foreign.id}`,bindingId:foreign.id,sessionId:`session-${foreign.id}`,state:'completed',ciphertext:'foreign'.repeat(20),deadline:new Date(0)},
 ]});
 await f.db.appDelegation.update({where:{id:f.receipt.id},data:{storedBytes:100*1024*1024-20}});
 await f.db.appDelegation.update({where:{id:other.receipt.id},data:{storedBytes:140}});
 if(operation==='history-read') {historyRead=f.history.read(f.principal,b.id);historyJob=await f.claim();}
 if(historyJob){await f.history.publish(f.ownerId,f.machineId,b.id,{requestId:historyJob.requestId,sessionId:historyJob.sessionId,ciphertext:'b'.repeat(80)});await historyRead;}
 if(operation==='turn-start') await f.turns.startBoundTurn(f.principal,b.id,'turn',{ciphertext:'b'.repeat(80)});
 if(turnJob) await f.turns.publish(f.ownerId,f.machineId,turn!.id,{lease:turnJob.lease,output:'b'.repeat(80),sequence:1,status:'completed'});
 expect(await f.db.aIServiceHistoryRequest.findUnique({where:{id:`expired-${a.id}`}})).toBeNull();
 expect(await f.db.aIServiceHistoryRequest.count({where:{id:{in:[`retained-${a.id}`,`foreign-${foreign.id}`]}}})).toBe(2);
 expect((await f.db.appDelegation.findUniqueOrThrow({where:{id:f.receipt.id}})).storedBytes).toBe(100*1024*1024-20);
 expect((await f.db.appDelegation.findUniqueOrThrow({where:{id:other.receipt.id}})).storedBytes).toBe(140);
},30000);
