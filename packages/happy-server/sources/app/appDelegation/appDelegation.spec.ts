import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock('@/storage/db', () => ({ get db() { return state.db; } }));
import { appConversations, appTurns, deleteAppConversation, approveAppPairing, cancelAppTurn, claimAppTurn, createAppPairing, hashCredential, publishAppTurn, readAppTurn, redeemAppPairing, revokeAppGrant, withAppGrant } from './appDelegation';
let engine: PGlite;
const owner = 'test-owner';
const machineId = 'test-machine';
const secret = 'a'.repeat(43);
const credential = 'b'.repeat(43);

beforeAll(async () => {
    engine = new PGlite();
    // Ephemeral test schema from generated Prisma metadata; no production migration.
    for (const name of ['Account', 'Machine']) {
        const model = Prisma.dmmf.datamodel.models.find(m => m.name === name)!;
        const fields = model.fields.filter(f => f.kind !== 'object').map(field => {
            const sqlType = ({ String: 'TEXT', Int: 'INTEGER', BigInt: 'BIGINT', Boolean: 'BOOLEAN', DateTime: 'TIMESTAMP(3)', Bytes: 'BYTEA', Json: 'JSONB', Float: 'DOUBLE PRECISION' } as Record<string, string>)[field.type];
            let value = '';
            if (field.default !== undefined && (typeof field.default !== 'object' || field.default === null)) value = ` DEFAULT '${String(field.default).replace(/'/g, "''")}'`;
            if (field.default && typeof field.default === 'object' && 'name' in field.default && field.default.name === 'now') value = ' DEFAULT CURRENT_TIMESTAMP';
            return `"${field.dbName ?? field.name}" ${sqlType}${field.isList ? '[]' : ''}${field.isId ? ' PRIMARY KEY' : field.isUnique ? ' UNIQUE' : ''}${field.isRequired ? ' NOT NULL' : ''}${value}`;
        });
        await engine.exec(`CREATE TABLE "${model.dbName ?? name}" (${fields.join(',')})`);
    }
    await engine.exec(await readFile(resolve('prisma/migrations/20261003010000_app_delegation/migration.sql'), 'utf8'));
    state.db = new PrismaClient({ adapter: new PrismaPGlite(engine) });
    await state.db.account.create({ data: { id: owner, publicKey: 'test' } });
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
