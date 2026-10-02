import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { inTx, type Tx } from '@/storage/inTx';

export const delegatedApp = { id: 'relationship-advisor', name: '狗头军师', origin: process.env.NODE_ENV === 'test' ? 'http://127.0.0.1:4199' : 'https://advisor.paws.rodeo', scope: 'codex:chat', protocol: 1 } as const;
export class DelegationError extends Error {
    constructor(readonly statusCode: number, message: string) { super(message); }
}
export const hashCredential = (value: string): string => createHash('sha256').update(value).digest('hex');
const matches = (value: string, hash: string): boolean => /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(Buffer.from(hashCredential(value), 'hex'), Buffer.from(hash, 'hex'));
const denied = (): never => { throw new DelegationError(403, 'Authorization unavailable or expired'); };
const conflict = (message: string): never => { throw new DelegationError(409, message); };
const active = (grant: { state: string; expiresAt: Date | null }): boolean => grant.state === 'redeemed' && !!grant.expiresAt && grant.expiresAt.getTime() > Date.now();

/** All authority checks and writes share a serializable transaction with revocation. */
export async function withAppGrant<T>(token: string, fn: (tx: Tx, grant: NonNullable<Awaited<ReturnType<Tx['appDelegation']['findUnique']>>>) => Promise<T>): Promise<T> {
    const match = /^paws_app\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) return denied();
    return inTx(async tx => {
        const grant = await tx.appDelegation.findUnique({ where: { id: match[1] } });
        if (!grant || !active(grant) || !grant.credentialHash || !matches(match[2], grant.credentialHash)) return denied();
        return fn(tx, grant);
    });
}

export async function createAppPairing(input: { appId: string; publicKey: string; challengeHash: string }) {
    if (input.appId !== delegatedApp.id) return denied();
    return inTx(async tx => {
        // Retention also bounds abandoned requests; no caller-provided TTLs.
        await tx.appDelegation.deleteMany({ where: { state: 'pending', requestExpiresAt: { lt: new Date() } } });
        if (await tx.appDelegation.count({ where: { state: 'pending' } }) >= 1000) throw new DelegationError(429, 'Too many pending requests');
        await tx.appDelegation.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 7 * 86400_000) } } });
        const request = await tx.appDelegation.create({ data: { id: randomUUID(), ...input, requestExpiresAt: new Date(Date.now() + 600_000) } });
        return { id: request.id, expiresAt: request.requestExpiresAt.toISOString(), app: delegatedApp };
    });
}

export async function describeAppPairing(id: string) {
    return inTx(async tx => {
        const request = await tx.appDelegation.findUnique({ where: { id } });
        if (!request || request.state !== 'pending' || request.requestExpiresAt.getTime() <= Date.now()) return denied();
        return { id, app: delegatedApp, publicKey: request.publicKey, expiresAt: request.requestExpiresAt.toISOString() };
    });
}

export async function approveAppPairing(accountId: string, id: string, input: { machineId: string; expiresAt: string; appEnvelope: string; machineEnvelope: string }) {
    return inTx(async tx => {
        const expiresAt = new Date(input.expiresAt);
        if (expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 7 * 86400_000) return denied();
        if (await tx.appDelegation.count({ where: { accountId } }) >= 20) throw new DelegationError(429, 'Active application limit reached');
        const machine = await tx.machine.findFirst({ where: { id: input.machineId, accountId, defaultCodexAccountProfileId: { not: null } } });
        const worker = await tx.appChatWorker.findFirst({ where: { machineId: input.machineId, accountId, protocol: 1, activeUntil: { gt: new Date() } } });
        if (!machine || !worker) return conflict('Selected machine is offline or needs an updated Paws daemon');
        const result = await tx.appDelegation.updateMany({ where: { id, state: 'pending', requestExpiresAt: { gt: new Date() } },
            data: { state: 'approved', accountId, ...input, expiresAt } });
        if (result.count !== 1) return denied();
        return { approved: true };
    });
}

/** Pairing proof is consumed once; the durable app bearer has a different secret. */
export async function redeemAppPairing(id: string, verifier: string, credential: string) {
    return inTx(async tx => {
        const grant = await tx.appDelegation.findUnique({ where: { id } });
        if (!grant || !matches(verifier, grant.challengeHash) || grant.requestExpiresAt.getTime() <= Date.now()) return denied();
        if (grant.state === 'pending') return { state: 'pending' as const };
        // A lost response can be retried only with the exact same independent credential.
        if (grant.state === 'redeemed' && (!grant.credentialHash || !matches(credential, grant.credentialHash))) return denied();
        if (!['approved', 'redeemed'].includes(grant.state) || !grant.expiresAt || grant.expiresAt.getTime() <= Date.now()) return denied();
        await tx.appDelegation.update({ where: { id }, data: { state: 'redeemed', credentialHash: hashCredential(credential) } });
        return { state: 'authorized' as const, id, app: delegatedApp, machineId: grant.machineId, expiresAt: grant.expiresAt.toISOString(), envelope: grant.appEnvelope };
    });
}

export async function revokeAppGrant(accountId: string, id: string) {
    return inTx(async tx => {
        const grant = await tx.appDelegation.findFirst({ where: { id, accountId } });
        if (!grant) return denied();
        await tx.appDelegation.update({ where: { id }, data: { state: 'revoked', credentialHash: null } });
        await tx.appChatTurn.updateMany({ where: { conversation: { grantId: id }, state: { in: ['queued', 'running'] } }, data: { state: 'cancelled', lease: null, leaseUntil: null } });
        return { revoked: true };
    });
}

export async function appConversations(token: string, createId?: string) {
    return withAppGrant(token, async (tx, grant) => {
        if (createId) {
            const existing = await tx.appChatConversation.findUnique({ where: { id: createId } });
            if (existing && existing.grantId !== grant.id) return denied();
            if (!existing) {
                if (await tx.appChatConversation.count({ where: { grantId: grant.id } }) >= 100) throw new DelegationError(429, 'Conversation limit reached');
                await tx.appChatConversation.create({ data: { id: createId, grantId: grant.id } });
            }
        }
        return tx.appChatConversation.findMany({ where: { grantId: grant.id }, select: { id: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
    });
}

export async function appTurns(token: string, conversationId: string, input?: { id: string; input: string }, before?: string) {
    return withAppGrant(token, async (tx, grant) => {
        if (!await tx.appChatConversation.findFirst({ where: { id: conversationId, grantId: grant.id } })) return denied();
        if (input) {
            const existing = await tx.appChatTurn.findUnique({ where: { id: input.id } });
            if (existing && existing.conversationId !== conversationId) return denied();
            if (!existing) {
                const worker = await tx.appChatWorker.findFirst({ where: { machineId: grant.machineId!, accountId: grant.accountId!, activeUntil: { gt: new Date() }, protocol: 1 } });
                if (!worker) return conflict('Selected machine is unavailable');
                await tx.appChatTurn.updateMany({ where: { conversation: { grantId: grant.id }, state: { in: ['queued', 'running'] }, deadline: { lt: new Date() } }, data: { state: 'failed', lease: null } });
                if (await tx.appChatTurn.count({ where: { conversation: { grantId: grant.id }, state: { in: ['queued', 'running'] } } })) return conflict('A turn is already in progress');
                if (await tx.appChatTurn.count({ where: { conversationId } }) >= 100) throw new DelegationError(429, 'Turn limit reached');
                const bytes = Buffer.byteLength(input.input);
                if (grant.storedBytes + bytes > 100 * 1024 * 1024) throw new DelegationError(429, 'Application storage limit reached');
                await tx.appDelegation.update({ where: { id: grant.id }, data: { storedBytes: { increment: bytes } } });
                await tx.appChatTurn.create({ data: { ...input, conversationId, deadline: new Date(Date.now() + 240_000) } });
            }
        }
        return tx.appChatTurn.findMany({ where: { conversationId, ...(input ? { id: input.id } : before ? { createdAt: { lt: new Date(before) } } : {}) }, take: 1, select: { id: true, input: true, output: true, sequence: true, state: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
    });
}

export async function readAppTurn(token: string, id: string) {
    return withAppGrant(token, async (tx, grant) => {
        const turn = await tx.appChatTurn.findFirst({ where: { id, conversation: { grantId: grant.id } }, select: { id: true, output: true, sequence: true, state: true } });
        if (!turn) return denied();
        return turn;
    });
}

export async function cancelAppTurn(token: string, id: string) {
    return withAppGrant(token, async (tx, grant) => {
        const turn = await tx.appChatTurn.findFirst({ where: { id, conversation: { grantId: grant.id } } });
        if (!turn) return denied();
        await tx.appChatTurn.updateMany({ where: { id, state: { in: ['queued', 'running'] } }, data: { state: 'cancelled', lease: null, leaseUntil: null } });
        return { cancelled: true };
    });
}

/** The worker publishes availability only after its restricted runtime passes preflight. */
export async function claimAppTurn(accountId: string, machineId: string) {
    return inTx(async tx => {
        if (!await tx.machine.findFirst({ where: { id: machineId, accountId, defaultCodexAccountProfileId: { not: null } } })) return denied();
        await tx.appChatWorker.upsert({ where: { machineId }, create: { machineId, accountId, protocol: 1, activeUntil: new Date(Date.now() + 45_000) }, update: { protocol: 1, activeUntil: new Date(Date.now() + 45_000) } });
        const owned = { conversation: { grant: { accountId, machineId } } };
        await tx.appChatTurn.updateMany({ where: { ...owned, state: 'running', leaseUntil: { lt: new Date() } }, data: { state: 'failed', lease: null } });
        await tx.appChatTurn.updateMany({ where: { ...owned, state: { in: ['queued', 'running'] }, deadline: { lt: new Date() } }, data: { state: 'failed', lease: null } });
        if (await tx.appChatTurn.count({ where: { ...owned, state: 'running' } })) return { job: null };
        const turn = await tx.appChatTurn.findFirst({ where: { state: 'queued', deadline: { gt: new Date() }, conversation: { grant: { accountId, machineId, state: 'redeemed', expiresAt: { gt: new Date() } } } }, orderBy: { createdAt: 'asc' }, include: { conversation: { include: { grant: true } } } });
        if (!turn) return { job: null };
        const lease = randomBytes(32).toString('base64url');
        await tx.appChatTurn.update({ where: { id: turn.id }, data: { state: 'running', lease, leaseUntil: new Date(Date.now() + 15_000) } });
        const grant = turn.conversation.grant;
        return { job: { id: turn.id, conversationId: turn.conversationId, grantId: grant.id, appId: grant.appId, machineId, expiresAt: grant.expiresAt!.toISOString(), envelope: grant.machineEnvelope!, input: turn.input, lease } };
    });
}

/** Lease fencing and grant validity are checked on heartbeat, chunk, and completion. */
export async function publishAppTurn(accountId: string, machineId: string, id: string, input: { lease: string; sequence?: number; output?: string; state?: 'completed' | 'failed' }) {
    return inTx(async tx => {
        const turn = await tx.appChatTurn.findFirst({ where: { id, state: 'running', lease: input.lease, leaseUntil: { gt: new Date() }, deadline: { gt: new Date() }, conversation: { grant: { accountId, machineId, state: 'redeemed', expiresAt: { gt: new Date() } } } } });
        if (!turn) return denied();
        if (input.output && (!input.sequence || input.sequence <= turn.sequence)) return conflict('Stale output sequence');
        if (input.state === 'completed' && !input.output && !turn.output) return conflict('Missing output');
        if (input.output) {
            const conversation = await tx.appChatConversation.findUniqueOrThrow({ where: { id: turn.conversationId }, include: { grant: true } });
            const growth = Buffer.byteLength(input.output) - Buffer.byteLength(turn.output ?? '');
            if (conversation.grant.storedBytes + growth > 100 * 1024 * 1024) throw new DelegationError(429, 'Application storage limit reached');
            await tx.appDelegation.update({ where: { id: conversation.grantId }, data: { storedBytes: { increment: growth } } });
        }
        await tx.appChatWorker.updateMany({ where: { machineId, accountId }, data: { activeUntil: new Date(Date.now() + 45_000) } });
        await tx.appChatTurn.update({ where: { id }, data: { ...(input.output ? { output: input.output, sequence: input.sequence } : {}), state: input.state ?? 'running', leaseUntil: new Date(Date.now() + 15_000) } });
        return { accepted: true };
    });
}

/** Deletion cancels queued/running work by removing the fenced turn rows. */
export async function deleteAppConversation(token: string, id: string) {
    return withAppGrant(token, async (tx, grant) => {
        if (!await tx.appChatConversation.findFirst({ where: { id, grantId: grant.id } })) return denied();
        const rows = await tx.$queryRaw<{ bytes: bigint }[]>`SELECT COALESCE(SUM(OCTET_LENGTH("input") + COALESCE(OCTET_LENGTH("output"), 0)), 0)::bigint AS bytes FROM "AppChatTurn" WHERE "conversationId" = ${id}`;
        await tx.appChatConversation.delete({ where: { id } });
        await tx.appDelegation.update({ where: { id: grant.id }, data: { storedBytes: { decrement: Number(rows[0].bytes) } } });
        return { deleted: true };
    });
}
