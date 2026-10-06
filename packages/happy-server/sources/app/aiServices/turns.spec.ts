import { beforeAll, afterAll, it, expect } from 'vitest';
import { createTestDatabase } from './testDatabase';
import { createAIServiceStore } from './store';
import { createServiceGrants } from './grants';
import { createServiceTurns } from './turns';
import nacl from 'tweetnacl';
let context: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { context = await createTestDatabase(); }, 120000);
afterAll(async () => { await context.database.$disconnect(); await context.pg.close(); });
it('deduplicates turns, fences cancel/completion, and never replays expired leases', async () => {
 const db = context.database;
 await db.account.create({ data: { id: 'turn-owner', publicKey: 'turn-owner' } });
 await db.machine.create({ data: { id: 'turn-machine', accountId: 'turn-owner', metadata: 'cipher' } });
 await db.codexAccountProfile.create({ data: { id: 'turn-profile', accountId: 'turn-owner', displayName: 'A', externalAccountFingerprint: 'A', credential: Buffer.from('cipher') } });
 const target = { machineId: 'turn-machine', engine: 'codex' as const, accountRef: { kind: 'codex-profile' as const, id: 'turn-profile' } };
 const store = createAIServiceStore(db, { readLive: async () => ({ ...target, protocol: 'ai-services/1', observedAt: Date.now(), availability: 'online', completeness: 'complete', defaultModelId: 'm', models: [{ id: 'm', name: 'M', supportsImages: false, reasoning: { supportsDefault: true, values: [], defaultValue: null } }] }) });
 const service = await store.createService('turn-owner', { name: 'A', config: { ...target, modelId: null, reasoning: { mode: 'default' } } });
 await db.appChatWorker.create({ data: { machineId: target.machineId, accountId: 'turn-owner', protocol: 3, serviceProtocol: 'ai-services/1', servicePublicKey: Buffer.from(nacl.box.keyPair().publicKey).toString('base64'), activeUntil: new Date(Date.now()+60000) } });
 const grants = createServiceGrants(db, store);
 const receipt = await grants.issueServiceGrant('turn-owner', 'relationship-advisor', service.id, { appId: 'relationship-advisor', serviceId: service.id, targets: [target], permissions: ['chat'], expiresAt: null });
 const principal = await grants.authenticate(receipt.credential);
 const binding = await store.resolveBinding(principal, 'relationship-advisor', service.id, {});
 const turns = createServiceTurns(db, store);
 const [a,b] = await Promise.all([1,2].map(() => turns.startBoundTurn(principal, binding.id, 'request-1', { ciphertext: 'c'.repeat(80) })));
 expect(a.id).toBe(b.id);
 expect((await turns.readBoundRequest(principal,binding.id,'request-1')).record.id).toBe(a.id);
 await expect(turns.startBoundTurn(principal,binding.id,'request-1',{ ciphertext:'different'.repeat(20) })).rejects.toMatchObject({ code:'invalid-request' });
 const job = await turns.claim('turn-owner', target.machineId);
 expect(job?.record.id).toBe(a.id);
 // A healthy long turn can outlive the worker announcement's 45-second TTL.
 await db.appChatWorker.update({ where: { machineId: target.machineId }, data: { activeUntil: new Date(0) } });
 await expect(turns.publish('turn-owner', target.machineId, a.id, { lease: 'wrong' })).rejects.toMatchObject({ code: 'execution-interrupted' });
 expect((await db.appChatWorker.findUniqueOrThrow({ where: { machineId: target.machineId } })).activeUntil.getTime()).toBe(0);
 await turns.publish('turn-owner', target.machineId, a.id, { lease: job!.lease });
 expect((await db.appChatWorker.findUniqueOrThrow({ where: { machineId: target.machineId } })).activeUntil.getTime()).toBeGreaterThan(Date.now() + 40000);

 await turns.cancelBoundTurn(principal, binding.id, a.id);
 await expect(turns.publish('turn-owner', target.machineId, a.id, { lease: job!.lease, status: 'completed', output: 'c'.repeat(80), sequence: 1 })).rejects.toMatchObject({ code: 'execution-interrupted' });
 expect((await turns.readBoundTurn(principal, binding.id, a.id)).record.status).toBe('cancel-requested');
 await db.appChatTurn.update({ where: { id: a.id }, data: { leaseUntil: new Date(0) } });
 expect(await turns.claim('turn-owner', target.machineId)).toBeNull();
 expect((await turns.readBoundTurn(principal, binding.id, a.id)).record.status).toBe('interrupted');
 const second = await turns.startBoundTurn(principal,binding.id,'request-2',{ ciphertext:'d'.repeat(80) });
 const secondJob = await turns.claim('turn-owner',target.machineId);
 await Promise.allSettled([
  turns.cancelBoundTurn(principal,binding.id,second.id),
  turns.publish('turn-owner',target.machineId,second.id,{ lease:secondJob!.lease,status:'completed',output:'e'.repeat(80),sequence:1 }),
 ]);
 const raced = await turns.readBoundTurn(principal,binding.id,second.id);
 expect(['completed','cancel-requested']).toContain(raced.record.status);
 if(raced.record.status === 'cancel-requested') await turns.publish('turn-owner',target.machineId,second.id,{ lease:secondJob!.lease,status:'cancelled' });
 expect(['completed','cancelled']).toContain((await turns.readBoundTurn(principal,binding.id,second.id)).record.status);
 expect((await turns.readTurns(principal,binding.id,a.id)).turns.map(turn=>turn.record.id)).toEqual([second.id]);
 const cancelled = await turns.startBoundTurn(principal,binding.id,'cancel-before-claim',{ ciphertext:'f'.repeat(80) });
 await turns.cancelBoundTurn(principal,binding.id,cancelled.id);
 expect(await turns.claim('turn-owner',target.machineId)).toBeNull();
 expect((await turns.readBoundTurn(principal,binding.id,cancelled.id)).record.status).toBe('cancelled');
 const expired = await turns.startBoundTurn(principal,binding.id,'expire-before-claim',{ ciphertext:'g'.repeat(80) });
 await db.appChatTurn.update({ where:{ id:expired.id },data:{ deadline:new Date(0) } });
 expect(await turns.claim('turn-owner',target.machineId)).toBeNull();
 expect((await turns.readBoundTurn(principal,binding.id,expired.id)).record.status).toBe('interrupted');
 const racing = createAIServiceStore(db, { readLive: async () => {
  await store.revokeAuthorization('turn-owner', receipt.id);
  return { ...target, protocol: 'ai-services/1', observedAt: Date.now(), availability: 'online', completeness: 'complete', defaultModelId: 'm', models: [{ id: 'm', name: 'M', supportsImages: false, reasoning: { supportsDefault: true, values: [], defaultValue: null } }] };
 } });
 await expect(createServiceTurns(db,racing).startBoundTurn(principal,binding.id,'request-race',{ ciphertext:'r'.repeat(80) })).rejects.toMatchObject({ code:'authorization-revoked' });
 expect(await db.appChatTurn.count({ where:{ bindingId:binding.id,requestId:'request-race' } })).toBe(0);

});
