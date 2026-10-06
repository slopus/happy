import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDatabase } from '@/app/aiServices/testDatabase';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock('@/storage/db', () => ({ get db() { return state.db; } }));
import { appConversations, appTurns, deleteAppConversation, approveAppPairing, cancelAppTurn, claimAppTurn, createAppPairing, hashCredential, publishAppTurn, readAppTurn, redeemAppPairing, revokeAppGrant, withAppGrant, ownerAppConversations, deleteOwnedAppGrant } from './appDelegation';
let engine: PGlite;
const owner = 'test-owner';
const machineId = 'test-machine';
const secret = 'a'.repeat(43);
const credential = 'b'.repeat(43);

beforeAll(async () => {
    const context = await createTestDatabase();
    engine = context.pg;
    state.db = context.database;
    await state.db.account.create({ data: { id: owner, publicKey: 'test' } });
    await state.db.codexAccountProfile.create({ data: { id: 'managed-test-profile', accountId: owner, displayName: 'Test', externalAccountFingerprint: 'test-identity', credential: Buffer.from('encrypted') } });
    await state.db.machine.create({ data: { id: machineId, accountId: owner, metadata: 'encrypted', defaultCodexAccountProfileId: 'managed-test-profile' } });
}, 30_000);
afterAll(async () => { await state.db?.$disconnect(); await engine?.close(); });

async function authorize() {
    const request = await createAppPairing({ appId: 'relationship-advisor', publicKey: 'A'.repeat(43) + '=', challengeHash: hashCredential(secret) });
    await claimAppTurn(owner, machineId);
    await approveAppPairing(owner, request.id, { machineId, expiresAt: new Date(Date.now() + 600_000).toISOString(), appEnvelope: 'encrypted-app', machineEnvelope: 'encrypted-machine' });
    await redeemAppPairing(request.id, secret, credential);
    const token = `paws_app.${request.id}.${credential}`;
    const conversationId = randomUUID();
    await appConversations(token, conversationId);
    return { id: request.id, token, conversationId };
}

describe('separate application authority using real serializable database transactions', () => {
    it('rejects wrong proof, duplicate approval, swapped credential, and normal account tokens', async () => {
        const grant = await authorize();
        await expect(redeemAppPairing(grant.id, 'x'.repeat(43), credential)).rejects.toThrow();
        await expect(redeemAppPairing(grant.id, secret, 'x'.repeat(43))).rejects.toThrow();
        await expect(approveAppPairing(owner, grant.id, { machineId, expiresAt: new Date(Date.now() + 60000).toISOString(), appEnvelope: 'a', machineEnvelope: 'b' })).rejects.toThrow();
        await expect(withAppGrant('normal-account-token', async () => true)).rejects.toThrow();
        expect((await redeemAppPairing(grant.id, secret, credential)).state).toBe('authorized');
    });
    it('denies cross-grant conversation and turn access, including cancellation', async () => {
        const a = await authorize(); const b = await authorize();
        const id = randomUUID(); await appTurns(a.token, a.conversationId, { id, input: 'encrypted' });
        await expect(appTurns(b.token, a.conversationId)).rejects.toThrow();
        await expect(readAppTurn(b.token, id)).rejects.toThrow();
        await expect(cancelAppTurn(b.token, id)).rejects.toThrow();
        await cancelAppTurn(a.token, id);
    });
    it('fences stale leases, output sequences, and running revocation', async () => {
        const a = await authorize(); const id = randomUUID();
        await appTurns(a.token, a.conversationId, { id, input: 'encrypted' });
        const { job } = await claimAppTurn(owner, machineId); expect(job?.id).toBe(id);
        await expect(publishAppTurn(owner, machineId, id, { lease: 'wrong', output: 'x', sequence: 1 })).rejects.toThrow();
        await publishAppTurn(owner, machineId, id, { lease: job!.lease, output: 'x', sequence: 1 });
        await expect(publishAppTurn(owner, machineId, id, { lease: job!.lease, output: 'x', sequence: 1 })).rejects.toThrow();
        await revokeAppGrant(owner, a.id);
        await expect(publishAppTurn(owner, machineId, id, { lease: job!.lease, output: 'x', sequence: 2, state: 'completed' })).rejects.toThrow();
        await expect(readAppTurn(a.token, id)).rejects.toThrow();
        expect((await state.db.appChatTurn.findUnique({ where: { id } }))?.state).toBe('cancelled');
    });
    it('does not replay expired leases and refuses stale final writes', async () => {
        const a = await authorize(); const id = randomUUID();
        await appTurns(a.token, a.conversationId, { id, input: 'encrypted' });
        const { job } = await claimAppTurn(owner, machineId);
        await state.db.appChatTurn.update({ where: { id }, data: { leaseUntil: new Date(0) } });
        expect((await claimAppTurn(owner, machineId)).job).toBeNull();
        await expect(publishAppTurn(owner, machineId, id, { lease: job!.lease, state: 'completed', output: 'x', sequence: 1 })).rejects.toThrow();
    });
    it('serializes duplicate claims and rejects writes after a concurrent revoke', async () => {
        const a = await authorize(); const id = randomUUID(); await appTurns(a.token, a.conversationId, { id, input: 'encrypted' });
        const claimed = await Promise.all([claimAppTurn(owner, machineId), claimAppTurn(owner, machineId)]);
        expect(claimed.filter(result => result.job)).toHaveLength(1);
        const job = claimed.find(result => result.job)!.job!;
        await Promise.allSettled([revokeAppGrant(owner, a.id), publishAppTurn(owner, machineId, id, { lease: job.lease, sequence: 1, output: 'x' })]);
        await expect(publishAppTurn(owner, machineId, id, { lease: job.lease, sequence: 2, output: 'late' })).rejects.toThrow();
        expect((await state.db.appChatTurn.findUnique({ where: { id } }))?.state).toBe('cancelled');
    });
    it('deletes only owned conversations, releases storage, and fences their worker', async () => {
        const a = await authorize(); const b = await authorize(); const id = randomUUID();
        await appTurns(a.token, a.conversationId, { id, input: 'encrypted' });
        const { job } = await claimAppTurn(owner, machineId);
        await expect(deleteAppConversation(b.token, a.conversationId)).rejects.toThrow();
        await deleteAppConversation(a.token, a.conversationId);
        expect(await state.db.appChatTurn.findUnique({ where: { id } })).toBeNull();
        expect((await state.db.appDelegation.findUnique({ where: { id: a.id } }))?.storedBytes).toBe(0);
        await expect(publishAppTurn(owner, machineId, id, { lease: job!.lease, output: 'late', sequence: 1 })).rejects.toThrow();
    });
    it('bounds storage and history, and refreshes availability during heartbeat', async () => {
        const a = await authorize();
        const id = randomUUID(); await appTurns(a.token, a.conversationId, { id, input: 'encrypted' });
        const { job } = await claimAppTurn(owner, machineId);
        await state.db.appChatWorker.update({ where: { machineId }, data: { activeUntil: new Date(0) } });
        await publishAppTurn(owner, machineId, id, { lease: job!.lease, state: 'completed', output: 'x', sequence: 1 });
        expect((await state.db.appChatWorker.findUnique({ where: { machineId } }))!.activeUntil.getTime()).toBeGreaterThan(Date.now());
        await state.db.appDelegation.update({ where: { id: a.id }, data: { storedBytes: 100 * 1024 * 1024 } });
        await expect(appTurns(a.token, a.conversationId, { id: randomUUID(), input: 'new' })).rejects.toThrow('storage');
        expect(await appTurns(a.token, a.conversationId)).toHaveLength(1);
    });
});


describe('permanent app authorization and owner conversation directory', () => {
    it('requires a compatible worker, redeems an explicit permanent grant, and fences revocation', async () => {
        const pairing = await createAppPairing({ protocol: 2, appId: 'relationship-advisor', publicKey: 'A'.repeat(43) + '=', challengeHash: hashCredential(secret) });
        const approval = { machineId, expiresAt: null, appEnvelope: 'encrypted-app', machineEnvelope: 'encrypted-machine' };
        await claimAppTurn(owner, machineId, 1);
        await expect(approveAppPairing(owner, pairing.id, approval)).rejects.toThrow('updated');
        await claimAppTurn(owner, machineId, 2);
        await approveAppPairing(owner, pairing.id, approval);
        expect((await redeemAppPairing(pairing.id, secret, credential)).expiresAt).toBeNull();
        const token = `paws_app.${pairing.id}.${credential}`;
        const conversationId = randomUUID();
        await appConversations(token, conversationId);
        const id = randomUUID();
        await appTurns(token, conversationId, { id, input: 'private-input' });
        expect((await claimAppTurn(owner, machineId, 1)).job).toBeNull();
        const { job } = await claimAppTurn(owner, machineId, 2);
        expect(job?.expiresAt).toBeNull();
        await publishAppTurn(owner, machineId, id, { lease: job!.lease, sequence: 1, output: 'private-output' });
        await revokeAppGrant(owner, pairing.id);
        await expect(publishAppTurn(owner, machineId, id, { lease: job!.lease, sequence: 2, output: 'late' })).rejects.toThrow();
        await expect(appConversations(token)).rejects.toThrow();
        const directory = await ownerAppConversations(owner);
        const entry = directory.conversations.find(row => row.id === conversationId)!;
        expect(entry.turns[0].state).toBe('cancelled');
        expect(JSON.stringify(directory)).not.toMatch(/private-input|private-output|encrypted-machine|credentialHash|appEnvelope/);
        expect((await ownerAppConversations('other-owner')).conversations).toEqual([]);
        await expect(deleteOwnedAppGrant('other-owner', pairing.id)).rejects.toThrow();
        await deleteOwnedAppGrant(owner, pairing.id);
        expect(await state.db.appChatConversation.findUnique({ where: { id: conversationId } })).toBeNull();
    });
    it('never upgrades an old pairing silently, and keeps QR expiry separate from granted access', async () => {
        const old = await createAppPairing({ appId: 'relationship-advisor', publicKey: 'A'.repeat(43) + '=', challengeHash: hashCredential(secret) });
        await claimAppTurn(owner, machineId, 2);
        const approval = { machineId, expiresAt: null, appEnvelope: 'app', machineEnvelope: 'machine' };
        await expect(approveAppPairing(owner, old.id, approval)).rejects.toThrow();
        const modern = await createAppPairing({ protocol: 2, appId: 'relationship-advisor', publicKey: 'A'.repeat(43) + '=', challengeHash: hashCredential(secret) });
        await approveAppPairing(owner, modern.id, approval);
        await redeemAppPairing(modern.id, secret, credential);
        await state.db.appDelegation.update({ where: { id: modern.id }, data: { requestExpiresAt: new Date(0) } });
        await expect(redeemAppPairing(modern.id, secret, credential)).rejects.toThrow();
        expect(await withAppGrant(`paws_app.${modern.id}.${credential}`, async () => true)).toBe(true);
        await revokeAppGrant(owner, modern.id);
    });
    it('paginates metadata by activity with stable ties and reports expired leases', async () => {
        const grant = await authorize();
        const createdAt = new Date(Date.now() + 1000);
        const ids = Array.from({ length: 52 }, () => randomUUID()).sort().reverse();
        await state.db.appChatConversation.createMany({ data: ids.map(id => ({ id, grantId: grant.id, createdAt })) });
        const first = await ownerAppConversations(owner);
        expect(first.conversations.map(row => row.id)).toEqual(ids.slice(0, 50));
        const next = await ownerAppConversations(owner, first.nextCursor!);
        expect(next.conversations.slice(0, 2).map(row => row.id)).toEqual(ids.slice(50));
        await expect(ownerAppConversations('other-owner', first.nextCursor!)).rejects.toThrow();
        await state.db.appChatTurn.create({ data: { id: randomUUID(), conversationId: grant.conversationId, input: 'hidden', state: 'running', createdAt: new Date(Date.now() + 2000), deadline: new Date(Date.now() + 5000), leaseUntil: new Date(0) } });
        const refreshed = await ownerAppConversations(owner);
        expect(refreshed.conversations[0].id).toBe(grant.conversationId);
        expect(refreshed.conversations[0].turns[0].state).toBe('failed');
        await deleteOwnedAppGrant(owner, grant.id);
    });
    it('keeps expired history during new pairing cleanup and rejects malformed expiry', async () => {
        const grant = await authorize();
        await state.db.appDelegation.update({ where: { id: grant.id }, data: { expiresAt: new Date(0) } });
        const pairing = await createAppPairing({ appId: 'relationship-advisor', publicKey: 'A'.repeat(43) + '=', challengeHash: hashCredential(secret) });
        expect(await state.db.appChatConversation.findUnique({ where: { id: grant.conversationId } })).not.toBeNull();
        await expect(appConversations(grant.token)).rejects.toThrow();
        for (const expiresAt of ['', 'invalid', new Date(Date.now() + 8 * 86400_000).toISOString()]) {
            await expect(approveAppPairing(owner, pairing.id, { machineId, expiresAt, appEnvelope: 'a', machineEnvelope: 'b' })).rejects.toThrow();
        }
    });
});


describe('owner-initiated, scoped history reading', () => {
    it('binds owner, conversation, lifecycle and record incarnation without restoring execution', async () => {
        process.env.HANDY_MASTER_SECRET = 'isolated-history-test-secret';
        const { openOwnedAppConversation, readAppHistory } = await import('./appHistory');
        const { auth } = await import('@/app/auth/auth');
        const a = await authorize();
        const second = randomUUID();
        await appConversations(a.token, second);
        await appTurns(a.token, a.conversationId, { id: randomUUID(), input: 'encrypted-history' });
        await expect(openOwnedAppConversation('another-owner', a.conversationId)).rejects.toThrow();
        const access = await openOwnedAppConversation(owner, a.conversationId);
        expect(access.machineEnvelope).toBe('encrypted-machine');
        expect((await readAppHistory(access.token, a.conversationId)).turns[0].input).toBe('encrypted-history');
        expect(await auth.verifyToken(access.token)).toBeNull();
        await expect(readAppHistory(access.token, second)).rejects.toThrow();
        await expect(readAppHistory(a.token, a.conversationId)).rejects.toThrow();
        await expect(readAppHistory(access.token + 'tampered', a.conversationId)).rejects.toThrow();
        await expect(appConversations(access.token)).rejects.toThrow();
        await expect(appTurns(access.token, a.conversationId, { id: randomUUID(), input: 'write' })).rejects.toThrow();
        await state.db.appDelegation.update({ where: { id: a.id }, data: { expiresAt: new Date(0) } });
        expect((await openOwnedAppConversation(owner, a.conversationId)).grantExpiresAt).toBe(new Date(0).toISOString());
        await revokeAppGrant(owner, a.id);
        await expect(readAppHistory(access.token, a.conversationId)).rejects.toThrow();
        const revokedAccess = await openOwnedAppConversation(owner, a.conversationId);
        expect((await readAppHistory(revokedAccess.token, a.conversationId)).turns).toHaveLength(1);
        await expect(appConversations(a.token)).rejects.toThrow();
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse(revokedAccess.expiresAt) + 1);
        try { await expect(readAppHistory(revokedAccess.token, a.conversationId)).rejects.toThrow(); } finally { vi.restoreAllMocks(); }
        await deleteOwnedAppGrant(owner, a.id);
        await expect(readAppHistory(revokedAccess.token, a.conversationId)).rejects.toThrow();
        await expect(openOwnedAppConversation(owner, a.conversationId)).rejects.toThrow();
    });
    it('rejects a deleted and recreated conversation with the same ID', async () => {
        const { openOwnedAppConversation, readAppHistory } = await import('./appHistory');
        const a = await authorize();
        const access = await openOwnedAppConversation(owner, a.conversationId);
        await deleteAppConversation(a.token, a.conversationId);
        await appConversations(a.token, a.conversationId);
        await expect(readAppHistory(access.token, a.conversationId)).rejects.toThrow();
        expect((await readAppHistory((await openOwnedAppConversation(owner, a.conversationId)).token, a.conversationId)).turns).toEqual([]);
        await revokeAppGrant(owner, a.id);
    });
});

describe('multi-engine protocol compatibility', () => {
    it('requires new consent and fences old workers from new grants and model selections', async () => {
        const request = await createAppPairing({ appId: 'relationship-advisor', publicKey: 'A'.repeat(43) + '=', challengeHash: hashCredential(secret), protocol: 3 });
        await claimAppTurn(owner, machineId, 3, ['codex', 'claude']);
        const approval = { machineId, expiresAt: null, appEnvelope: 'encrypted-app', machineEnvelope: 'encrypted-machine' };
        await expect(approveAppPairing(owner, request.id, approval)).rejects.toThrow('Update Paws');
        await approveAppPairing(owner, request.id, { ...approval, protocol: 3 });
        await redeemAppPairing(request.id, secret, credential);
        const token = `paws_app.${request.id}.${credential}`, conversationId = randomUUID(), id = randomUUID();
        await appConversations(token, conversationId);
        await appTurns(token, conversationId, { id, input: 'sealed-settings', minimumProtocol: 3 });
        expect((await claimAppTurn(owner, machineId, 2)).job).toBeNull();
        const { job } = await claimAppTurn(owner, machineId, 3, ['codex', 'claude']);
        expect(job).toMatchObject({ id, protocol: 3 });
        await cancelAppTurn(token, id);
    });
    it('allows model selection on legacy Codex grants only on a protocol 3 worker', async () => {
        const a = await authorize(), id = randomUUID();
        await expect(appTurns(a.token, a.conversationId, { id, input: 'sealed', minimumProtocol: 3 })).rejects.toThrow('unavailable');
        await claimAppTurn(owner, machineId, 3, ['codex']);
        await appTurns(a.token, a.conversationId, { id, input: 'sealed', minimumProtocol: 3 });
        expect((await claimAppTurn(owner, machineId, 1)).job).toBeNull();
        expect((await claimAppTurn(owner, machineId, 3, ['codex'])).job?.id).toBe(id);
        await cancelAppTurn(a.token, id);
    });
});


describe('Paws inline account-owned history', () => {
    it('reads only owned ciphertext, retains revoked history, and denies deleted history without issuing capabilities', async () => {
        const { readOwnedAppConversation } = await import('./appHistory');
        const a = await authorize();
        await appTurns(a.token, a.conversationId, { id: randomUUID(), input: 'inline-encrypted-history' });
        const result = await readOwnedAppConversation(owner, a.conversationId);
        expect(result.machineEnvelope).toBe('encrypted-machine');
        expect(result.turns[0].input).toBe('inline-encrypted-history');
        expect(result).not.toHaveProperty('token');
        await expect(readOwnedAppConversation('another-owner', a.conversationId)).rejects.toThrow();
        await state.db.appDelegation.update({ where: { id: a.id }, data: { expiresAt: new Date(0) } });
        expect((await readOwnedAppConversation(owner, a.conversationId)).turns).toHaveLength(1);
        await revokeAppGrant(owner, a.id);
        expect((await readOwnedAppConversation(owner, a.conversationId)).turns).toHaveLength(1);
        await expect(appConversations(a.token)).rejects.toThrow();
        await deleteOwnedAppGrant(owner, a.id);
        await expect(readOwnedAppConversation(owner, a.conversationId)).rejects.toThrow();
    });
});
