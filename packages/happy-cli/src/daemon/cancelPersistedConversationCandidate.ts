/** Cancel an authenticated old worker after daemon restart, without signalling a metadata PID. */
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { portableNativeSourceIdentity } from '@slopus/happy-wire';
import { assertConversationLaunchIdle, type ConversationLaunchSnapshot } from './conversationSessionLaunch';
import type { TrackedSession, SessionEncryptionData } from './types';

const RuntimeIdentitySchema = z.object({ agent: z.enum(['codex', 'antigravity']), hostPid: z.number().int().positive() });
const candidateIdentity = (source: ConversationLaunchSnapshot): string => JSON.stringify([
    source.id, source.seq, source.metadata.hostPid, portableNativeSourceIdentity(source.metadata),
    source.metadata.crossAgentRequestId, source.metadata.conversationActiveSessionId,
]);

export async function cancelPersistedConversationCandidate(input: {
    owner: ConversationLaunchSnapshot;
    machineId: string;
    retained: () => TrackedSession | undefined;
    /** Fresh reservation, scope, idle and complete no-user-delivery proof. */
    verify: () => Promise<ConversationLaunchSnapshot>;
    callSessionRpc: (sessionId: string, encryption: SessionEncryptionData, method: 'delegation-context' | 'killSession', body: object) => Promise<unknown>;
    verifyProcessGroup: (pid: number) => Promise<boolean>;
    awaitProcessGroupExit: (pid: number) => Promise<void>;
}): Promise<void> {
    const stored = input.retained();
    const metadata = stored?.happySessionMetadataFromLocalWebhook;
    const original = input.owner;
    const pid = metadata?.hostPid;
    if (!stored || stored.startedBy !== 'persisted' || stored.pid !== 0 || stored.childProcess
        || stored.happySessionId !== original.id || !stored.encryption || stored.encryption.encryptionKey.length !== 32
        || !['legacy', 'dataKey'].includes(stored.encryption.encryptionVariant)
        || !metadata || metadata.machineId !== input.machineId || typeof metadata.path !== 'string' || !isAbsolute(metadata.path)
        || !['codex', 'antigravity'].includes(metadata.flavor ?? '') || metadata.application || metadata.sandbox?.enabled
        || !Number.isSafeInteger(pid) || !pid || pid <= 0) {
        throw new Error('The persisted conversation worker identity cannot be verified.');
    }
    const encryption = { ...stored.encryption, encryptionKey: new Uint8Array(stored.encryption.encryptionKey) };
    const savedIdentity = JSON.stringify([metadata.machineId, metadata.path, metadata.flavor, pid,
        metadata.codexAccountProfileId, metadata.parentSessionId, metadata.crossAgentRequestId]);
    const expected = candidateIdentity(original);
    const checkRetained = (): void => {
        const current = input.retained();
        const m = current?.happySessionMetadataFromLocalWebhook;
        if (!current || current.startedBy !== 'persisted' || current.pid !== 0 || current.childProcess
            || current.happySessionId !== original.id || !current.encryption || !m
            || current.encryption.encryptionVariant !== encryption.encryptionVariant
            || !Buffer.from(current.encryption.encryptionKey).equals(Buffer.from(encryption.encryptionKey))
            || JSON.stringify([m.machineId, m.path, m.flavor, m.hostPid, m.codexAccountProfileId, m.parentSessionId, m.crossAgentRequestId]) !== savedIdentity) {
            throw new Error('The retained conversation worker changed before cancellation.');
        }
    };
    const verifyCurrent = async (): Promise<void> => {
        checkRetained();
        const current = await input.verify();
        checkRetained();
        const m = current.metadata;
        assertConversationLaunchIdle(current, { allowArchived: true });
        if (candidateIdentity(current) !== expected || current.id !== original.id
            || m.machineId !== metadata.machineId || m.path !== metadata.path || m.flavor !== metadata.flavor || m.hostPid !== pid
            || (metadata.codexAccountProfileId !== undefined && m.codexAccountProfileId !== metadata.codexAccountProfileId)
            || (metadata.parentSessionId !== undefined && m.parentSessionId !== metadata.parentSessionId)
            || (metadata.crossAgentRequestId !== undefined && m.crossAgentRequestId !== metadata.crossAgentRequestId)) {
            throw new Error('The persisted conversation candidate scope changed.');
        }
    };
    await verifyCurrent();
    const identity = RuntimeIdentitySchema.safeParse(await input.callSessionRpc(original.id, encryption, 'delegation-context', {}));
    if (!identity.success || identity.data.hostPid !== pid || identity.data.agent !== metadata.flavor) {
        throw new Error('The encrypted conversation worker identity was not confirmed.');
    }
    await verifyCurrent();
    if (!await input.verifyProcessGroup(pid)) throw new Error('The persisted native process group cannot be verified.');
    // Process inspection also awaits: do not kill after input/ownership changed
    // while ps or an encrypted identity request was in flight.
    await verifyCurrent();
    const acknowledgement = z.object({ success: z.literal(true) }).safeParse(
        await input.callSessionRpc(original.id, encryption, 'killSession', {}),
    );
    if (!acknowledgement.success) throw new Error('The persisted conversation worker did not acknowledge cancellation.');
    // killSession acknowledges before cleanup. Only a vanished isolated group
    // plus the caller's post-stop history proof can complete cancellation.
    await input.awaitProcessGroupExit(pid);
}
