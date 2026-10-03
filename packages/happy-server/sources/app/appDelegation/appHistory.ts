import * as privacyKit from 'privacy-kit';
import { z } from 'zod';
import { inTx, type Tx } from '@/storage/inTx';
import { delegatedApp, DelegationError } from '@/app/appDelegation/appDelegation';

const prefix = 'paws_history.';
const lifetime = 5 * 60_000;
const binding = z.object({
    purpose: z.literal('app-history'), grantId: z.string().uuid(), conversationId: z.string().uuid(),
    createdAt: z.string(), state: z.enum(['redeemed', 'revoked']), expiresAt: z.number().int(),
}).strict();
let tokens: Promise<{ generator: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenGenerator>>; verifier: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenVerifier>> }> | undefined;
function historyTokens() {
    return tokens ??= (async () => {
        if (!process.env.HANDY_MASTER_SECRET) throw new Error('History signing is not configured');
        // Separate signing key/service: these tokens can never authenticate an account.
        const service = 'paws-app-history-v1';
        const generator = await privacyKit.createEphemeralTokenGenerator({ service, seed: process.env.HANDY_MASTER_SECRET, ttl: lifetime });
        const verifier = await privacyKit.createEphemeralTokenVerifier({ service, publicKey: Uint8Array.from(generator.publicKey) });
        return { generator, verifier };
    })();
}
const denied = (): never => { throw new DelegationError(403, 'History access unavailable; reopen the conversation from Paws'); };

async function historyTurns(tx: Tx, conversationId: string) {
    const turns = await tx.appChatTurn.findMany({ where: { conversationId }, orderBy: { createdAt: 'desc' }, take: 1,
        select: { id: true, input: true, output: true, sequence: true, state: true, createdAt: true, deadline: true, leaseUntil: true } });
    return turns.map(({ deadline, leaseUntil, ...turn }) => ({ ...turn,
        state: ['queued', 'running'].includes(turn.state) && (deadline.getTime() <= Date.now() || (turn.state === 'running' && (!leaseUntil || leaseUntil.getTime() <= Date.now()))) ? 'failed' : turn.state,
    }));
}

/** Account-owned reading for Paws itself; no execution or external capability is issued. */
export async function readOwnedAppConversation(accountId: string, conversationId: string) {
    return inTx(async tx => {
        const conversation = await tx.appChatConversation.findUnique({ where: { id: conversationId }, include: { grant: true } });
        const grant = conversation?.grant;
        if (!conversation || !grant || grant.accountId !== accountId || grant.appId !== delegatedApp.id || !['redeemed', 'revoked'].includes(grant.state) || !grant.machineId || !grant.machineEnvelope) return denied();
        return { app: delegatedApp, conversationId, grantId: grant.id, machineId: grant.machineId,
            grantProtocol: grant.protocol, grantExpiresAt: grant.expiresAt?.toISOString() ?? null, machineEnvelope: grant.machineEnvelope,
            createdAt: conversation.createdAt, turns: await historyTurns(tx, conversationId) };
    });
}

/** Owner explicitly grants short-lived reading even after the execution grant has expired/revoked. */
export async function openOwnedAppConversation(accountId: string, conversationId: string) {
    const { generator } = await historyTokens();
    return inTx(async tx => {
        const conversation = await tx.appChatConversation.findUnique({ where: { id: conversationId }, include: { grant: true } });
        const grant = conversation?.grant;
        if (!conversation || !grant || grant.accountId !== accountId || grant.appId !== delegatedApp.id || !['redeemed', 'revoked'].includes(grant.state) || !grant.machineId || !grant.machineEnvelope) return denied();
        const expiresAt = Date.now() + lifetime;
        const token = prefix + await generator.new({ user: accountId, extras: {
            purpose: 'app-history', grantId: grant.id, conversationId, createdAt: conversation.createdAt.toISOString(), state: grant.state, expiresAt,
        } });
        return { app: delegatedApp, conversationId, grantId: grant.id, machineId: grant.machineId,
            grantProtocol: grant.protocol, grantExpiresAt: grant.expiresAt?.toISOString() ?? null, machineEnvelope: grant.machineEnvelope,
            token, expiresAt: new Date(expiresAt).toISOString() };
    });
}

export async function readAppHistory(token: string, conversationId: string) {
    if (!token.startsWith(prefix) || token.length > 4096) return denied();
    const { verifier } = await historyTokens();
    const verified = await verifier.verify(token.slice(prefix.length)).catch(() => null);
    const parsed = binding.safeParse(verified?.extras);
    if (!verified || !parsed.success || parsed.data.conversationId !== conversationId || parsed.data.expiresAt <= Date.now()) return denied();
    const access = parsed.data;
    return inTx(async tx => {
        const conversation = await tx.appChatConversation.findUnique({ where: { id: conversationId }, include: { grant: true } });
        if (!conversation || conversation.grantId !== access.grantId || conversation.createdAt.toISOString() !== access.createdAt || conversation.grant.accountId !== verified.user || conversation.grant.appId !== delegatedApp.id || conversation.grant.state !== access.state) return denied();
        return { conversationId, createdAt: conversation.createdAt, turns: await historyTurns(tx, conversationId) };
    });
}
