import { Prisma } from '@prisma/client';
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
const active = (grant: { state: string; expiresAt: Date | null }): boolean => grant.state === 'redeemed' && (grant.expiresAt === null || grant.expiresAt.getTime() > Date.now());

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

export async function createAppPairing(input: { appId: string; publicKey: string; challengeHash: string; protocol?: 1 | 2 | 3 }) {
    if (input.appId !== delegatedApp.id) return denied();
    return inTx(async tx => {
        // Retention also bounds abandoned requests; no caller-provided TTLs.
        await tx.appDelegation.deleteMany({ where: { state: { in: ['pending', 'pending-v2'] }, requestExpiresAt: { lt: new Date() } } });
        if (await tx.appDelegation.count({ where: { state: { in: ['pending', 'pending-v2'] } } }) >= 1000) throw new DelegationError(429, 'Too many pending requests');
        // Approved history survives expiry/revocation; only abandoned requests are disposable.
        await tx.appDelegation.deleteMany({ where: { state: 'approved', requestExpiresAt: { lt: new Date() }, conversations: { none: {} } } });
        const { protocol = 1, ...pairing } = input;
        // Keep the requested capability in the pending state until approval; no envelope exists yet.
        const request = await tx.appDelegation.create({ data: { id: randomUUID(), ...pairing, protocol, state: protocol >= 2 ? 'pending-v2' : 'pending', requestExpiresAt: new Date(Date.now() + 600_000) } });
        return { id: request.id, expiresAt: request.requestExpiresAt.toISOString(), app: delegatedApp };
    });
}

export async function describeAppPairing(id: string) {
    return inTx(async tx => {
        const request = await tx.appDelegation.findUnique({ where: { id } });
        if (!request || !['pending', 'pending-v2'].includes(request.state) || request.requestExpiresAt.getTime() <= Date.now()) return denied();
        return { id, app: { ...delegatedApp, protocol: request.protocol, scope: request.protocol >= 3 ? 'agent:chat' : 'codex:chat' }, supportsPermanent: request.state === 'pending-v2', publicKey: request.publicKey, expiresAt: request.requestExpiresAt.toISOString() };
    });
}

export async function approveAppPairing(accountId: string, id: string, input: { machineId: string; expiresAt: string | null; appEnvelope: string; machineEnvelope: string; protocol?: 3 }) {
    return inTx(async tx => {
        const pairing = await tx.appDelegation.findUnique({ where: { id } });
        if (!pairing || (input.expiresAt === null && pairing.state !== 'pending-v2')) return denied();
        if (pairing.protocol >= 3 && input.protocol !== 3) return conflict('Update Paws to authorize Codex and Claude Code');
        const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
        if (expiresAt !== null && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 7 * 86400_000)) return denied();
        if (await tx.appDelegation.count({ where: { accountId, AND: [
            { OR: [{ state: 'redeemed' }, { state: 'approved', requestExpiresAt: { gt: new Date() } }] },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        ] } }) >= 20) throw new DelegationError(429, 'Active application limit reached');
        if (await tx.appDelegation.count({ where: { accountId } }) >= 100) throw new DelegationError(429, 'Application history limit reached; remove an old connection');
        const machine = await tx.machine.findFirst({ where: { id: input.machineId, accountId, ...(pairing.protocol >= 3 ? {} : { defaultCodexAccountProfileId: { not: null } }) } });
        const worker = await tx.appChatWorker.findFirst({ where: { machineId: input.machineId, accountId, protocol: { in: pairing.protocol >= 3 ? [3] : expiresAt === null ? [2, 3] : [1, 2, 3] }, activeUntil: { gt: new Date() } } });
        if (!machine || !worker) return conflict('Selected machine is offline or needs an updated Paws daemon');
        const result = await tx.appDelegation.updateMany({ where: { id, state: { in: ['pending', 'pending-v2'] }, requestExpiresAt: { gt: new Date() } },
            data: { state: 'approved', accountId, machineId: input.machineId, appEnvelope: input.appEnvelope, machineEnvelope: input.machineEnvelope, expiresAt } });
        if (result.count !== 1) return denied();
        return { approved: true };
    });
}

/** Pairing proof is consumed once; the durable app bearer has a different secret. */
export async function redeemAppPairing(id: string, verifier: string, credential: string) {
    return inTx(async tx => {
        const grant = await tx.appDelegation.findUnique({ where: { id } });
        if (!grant || !matches(verifier, grant.challengeHash) || grant.requestExpiresAt.getTime() <= Date.now()) return denied();
        if (['pending', 'pending-v2'].includes(grant.state)) return { state: 'pending' as const };
        // A lost response can be retried only with the exact same independent credential.
        if (grant.state === 'redeemed' && (!grant.credentialHash || !matches(credential, grant.credentialHash))) return denied();
        if (!['approved', 'redeemed'].includes(grant.state) || (grant.expiresAt !== null && grant.expiresAt.getTime() <= Date.now())) return denied();
        await tx.appDelegation.update({ where: { id }, data: { state: 'redeemed', credentialHash: hashCredential(credential) } });
        return { state: 'authorized' as const, id, app: delegatedApp, machineId: grant.machineId, expiresAt: grant.expiresAt?.toISOString() ?? null, envelope: grant.appEnvelope };
    });
}

export async function revokeAppGrant(accountId: string, id: string) {
    return inTx(async tx => {
        const grant = await tx.appDelegation.findFirst({ where: { id, accountId, protocol: { lte: 3 } } });
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

export async function appTurns(token: string, conversationId: string, input?: { id: string; input: string; minimumProtocol?: number }, before?: string) {
    return withAppGrant(token, async (tx, grant) => {
        if (!await tx.appChatConversation.findFirst({ where: { id: conversationId, grantId: grant.id } })) return denied();
        if (input) {
            const existing = await tx.appChatTurn.findUnique({ where: { id: input.id } });
            if (existing && existing.conversationId !== conversationId) return denied();
            if (!existing) {
                const worker = await tx.appChatWorker.findFirst({ where: { machineId: grant.machineId!, accountId: grant.accountId!, activeUntil: { gt: new Date() }, protocol: { in: (input.minimumProtocol ?? 1) >= 3 || grant.protocol >= 3 ? [3] : grant.expiresAt === null ? [2, 3] : [1, 2, 3] } } });
                if (!worker) return conflict('Selected machine is unavailable');
                await tx.appChatTurn.updateMany({ where: { conversation: { grantId: grant.id }, state: { in: ['queued', 'running'] }, deadline: { lt: new Date() } }, data: { state: 'failed', lease: null } });
                if (await tx.appChatTurn.count({ where: { conversation: { grantId: grant.id }, state: { in: ['queued', 'running'] } } })) return conflict('A turn is already in progress');
                if (await tx.appChatTurn.count({ where: { conversationId } }) >= 100) throw new DelegationError(429, 'Turn limit reached');
                const bytes = Buffer.byteLength(input.input);
                if (grant.storedBytes + bytes > 100 * 1024 * 1024) throw new DelegationError(429, 'Application storage limit reached');
                await tx.appDelegation.update({ where: { id: grant.id }, data: { storedBytes: { increment: bytes } } });
                await tx.appChatTurn.create({ data: { ...input, minimumProtocol: Math.max(input.minimumProtocol ?? 1, grant.protocol), conversationId, deadline: new Date(Date.now() + 240_000) } });
            }
        }
        return tx.appChatTurn.findMany({ where: { conversationId, ...(input ? { id: input.id } : before ? { createdAt: { lt: new Date(before) } } : {}) }, take: 1, select: { id: true, input: true, output: true, sequence: true, state: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
    });
}

export async function readAppTurn(token: string, id: string) {
    return withAppGrant(token, async (tx, grant) => {
        const turn = await tx.appChatTurn.findFirst({ where: { id, conversation: { grantId: grant.id } }, select: { id: true, input: true, output: true, sequence: true, state: true } });
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
export async function claimAppTurn(accountId: string, machineId: string, protocol: 1 | 2 | 3 = 1, engines: string[] = []) {
    return inTx(async tx => {
        if (!await tx.machine.findFirst({ where: { id: machineId, accountId, ...(protocol >= 3 ? {} : { defaultCodexAccountProfileId: { not: null } }) } })) return denied();
        await tx.appChatWorker.upsert({ where: { machineId }, create: { machineId, accountId, protocol, engines, activeUntil: new Date(Date.now() + 45_000) }, update: { protocol, engines, activeUntil: new Date(Date.now() + 45_000) } });
        const owned = { conversation: { grant: { accountId, machineId } } };
        await tx.appChatTurn.updateMany({ where: { ...owned, state: 'running', leaseUntil: { lt: new Date() } }, data: { state: 'failed', lease: null } });
        await tx.appChatTurn.updateMany({ where: { ...owned, state: { in: ['queued', 'running'] }, deadline: { lt: new Date() } }, data: { state: 'failed', lease: null } });
        if (await tx.appChatTurn.count({ where: { ...owned, state: 'running' } })) return { job: null };
        const turn = await tx.appChatTurn.findFirst({ where: { state: 'queued', minimumProtocol: { lte: protocol }, deadline: { gt: new Date() }, conversation: { grant: { accountId, machineId, state: 'redeemed', protocol: { lte: protocol }, OR: protocol >= 2 ? [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] : [{ expiresAt: { gt: new Date() } }] } } }, orderBy: { createdAt: 'asc' }, include: { conversation: { include: { grant: true } } } });
        if (!turn) return { job: null };
        const lease = randomBytes(32).toString('base64url');
        await tx.appChatTurn.update({ where: { id: turn.id }, data: { state: 'running', lease, leaseUntil: new Date(Date.now() + 15_000) } });
        const grant = turn.conversation.grant;
        return { job: { id: turn.id, conversationId: turn.conversationId, grantId: grant.id, appId: grant.appId, protocol: grant.protocol, machineId, expiresAt: grant.expiresAt?.toISOString() ?? null, envelope: grant.machineEnvelope!, input: turn.input, lease } };
    });
}

/** Lease fencing and grant validity are checked on heartbeat, chunk, and completion. */
export async function publishAppTurn(accountId: string, machineId: string, id: string, input: { lease: string; sequence?: number; output?: string; state?: 'completed' | 'failed' }) {
    return inTx(async tx => {
        const turn = await tx.appChatTurn.findFirst({ where: { id, state: 'running', lease: input.lease, leaseUntil: { gt: new Date() }, deadline: { gt: new Date() }, conversation: { grant: { accountId, machineId, state: 'redeemed', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } } } });
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


/** Owner-only bounded directory. Message ciphertext and grant credentials never leave this endpoint. */
export async function ownerAppConversations(accountId: string, cursor?: string) {
    return inTx(async tx => {
        const anchor = cursor ? await tx.appChatConversation.findFirst({
            where: { id: cursor, grant: { accountId, protocol: { lte: 3 } } },
            select: { id: true, createdAt: true, turns: { take: 1, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { createdAt: true } } },
        }) : null;
        if (cursor && !anchor) return denied();
        const activity = anchor?.turns[0]?.createdAt ?? anchor?.createdAt;
        const boundary = anchor ? Prisma.sql`AND (COALESCE(t."createdAt", c."createdAt"), c."id") < (${activity}, ${anchor.id})` : Prisma.empty;
        const rows = await tx.$queryRaw<{ id: string; grantId: string; createdAt: Date; lastActivityAt: Date; state: string | null; deadline: Date | null; leaseUntil: Date | null }[]>(Prisma.sql`
            SELECT c."id", c."grantId", c."createdAt", COALESCE(t."createdAt", c."createdAt") AS "lastActivityAt", t."state", t."deadline", t."leaseUntil"
            FROM "AppChatConversation" c JOIN "AppDelegation" g ON g."id" = c."grantId"
            LEFT JOIN LATERAL (
                SELECT "state", "createdAt", "deadline", "leaseUntil" FROM "AppChatTurn"
                WHERE "conversationId" = c."id" ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
            ) t ON TRUE
            WHERE g."accountId" = ${accountId} AND g."protocol" <= 3 ${boundary}
            ORDER BY "lastActivityAt" DESC, c."id" DESC LIMIT 51
        `);
        const conversations = rows.slice(0, 50).map(row => ({
            id: row.id, grantId: row.grantId, createdAt: row.createdAt, lastActivityAt: row.lastActivityAt,
            turns: row.state === null ? [] : [{
                state: (['queued', 'running'].includes(row.state) && row.deadline!.getTime() <= Date.now()) || (row.state === 'running' && row.leaseUntil !== null && row.leaseUntil.getTime() <= Date.now()) ? 'failed' : row.state,
                createdAt: row.lastActivityAt,
            }],
        }));
        return { conversations, nextCursor: rows.length > 50 ? conversations.at(-1)!.id : null };
    });
}

/** Explicit owner deletion releases retained history and fences any in-flight worker by cascade. */
export async function deleteOwnedAppGrant(accountId: string, id: string) {
    return inTx(async tx => {
        const grant = await tx.appDelegation.findFirst({ where: { id, accountId, protocol: { lte: 3 } } });
        if (!grant) return denied();
        await tx.appDelegation.delete({ where: { id } });
        return { deleted: true };
    });
}
