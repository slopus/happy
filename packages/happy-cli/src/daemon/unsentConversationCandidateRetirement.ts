/** Request-bound retirement for a proven unsent candidate, not a native-writer handoff. */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { portableNativeSourceIdentity } from '@slopus/happy-wire';
import { assertConversationLaunchIdle, type ConversationLaunchSnapshot, type ConversationReadyCandidateBinding } from './conversationSessionLaunch';
import { NativeProcessTreeIdentityError, sameNativeProcessTree, type NativeProcessTree } from './nativeProcessTree';
import type { SessionEncryptionData, TrackedSession } from './types';

export type UnsentConversationCandidateRetirementInput = {
    directory: string; binding: ConversationReadyCandidateBinding; owner: ConversationLaunchSnapshot; machineId: string;
    retained(): TrackedSession | undefined;
    /** Fresh reservation, exact candidate scope, idle and complete decrypted user0 proof. */
    verify(): Promise<ConversationLaunchSnapshot>;
    callSessionRpc(id: string, encryption: SessionEncryptionData, method: 'delegation-context' | 'killSession', body: object): Promise<unknown>;
    captureProcessTree(pid: number): Promise<NativeProcessTree>;
    awaitProcessTreeExit(tree: NativeProcessTree): Promise<void>;
};
const pid = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const processSchema = z.object({ pid, ppid: z.number().int().nonnegative(), pgid: pid,
    startedAt: z.string().min(1).max(128).refine(value => Number.isFinite(Date.parse(value))),
}).strict();
const treeSchema = z.object({ rootPid: pid, processes: z.array(processSchema).min(1).max(10000) }).strict().refine(tree => new Set(tree.processes.map(row => row.pid)).size === tree.processes.length
    && tree.processes.some(row => row.pid === tree.rootPid && row.pgid === tree.rootPid));
const payloadSchema = z.object({ version: z.literal(1), scope: z.string(), keySha256: z.string().regex(/^[a-f0-9]{64}$/),
    tree: treeSchema, phase: z.enum(['captured', 'stop-requested', 'acknowledged', 'exited', 'unconfirmed']),
    unconfirmed: z.object({ reason: z.enum(['root-reused', 'new-descendant']), observed: z.array(processSchema).min(1).max(10000) }).strict().optional(),
}).strict();
type Proof = z.infer<typeof payloadSchema>;
const fingerprint = (owner: ConversationLaunchSnapshot) => {
    const m = owner.metadata;
    return JSON.stringify([owner.id, m.machineId, m.path, m.flavor, m.hostPid, portableNativeSourceIdentity(m),
        m.codexAccountProfileId, m.parentSessionId, m.crossAgentRequestId, m.conversationRootSessionId,
        m.continuationOfSessionId, m.portableContext?.id, m.portableContext?.sha256,
        Boolean(m.application), Boolean(m.sandbox?.enabled), Boolean(m.delegatedTask)]);
};

export async function retireUnsentConversationCandidate(input: UnsentConversationCandidateRetirementInput): Promise<void> {
    const { binding, owner } = input;
    const original = fingerprint(owner); const hostPid = owner.metadata.hostPid;
    if (!isAbsolute(input.directory) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(binding.requestId)
        || binding.phase !== 'ready' || binding.targetSessionId !== owner.id || binding.targetAgent !== owner.metadata.flavor
        || owner.id === binding.rootSessionId || owner.id === binding.sourceSessionId
        || !Number.isSafeInteger(hostPid) || !hostPid || hostPid <= 0
        || !['codex', 'antigravity'].includes(owner.metadata.flavor ?? '') || owner.metadata.machineId !== input.machineId
        || !binding.rootSessionId || !binding.sourceSessionId || !isAbsolute(owner.metadata.path)
        || (owner.metadata.parentSessionId !== undefined && owner.metadata.parentSessionId !== binding.sourceSessionId)
        || (owner.metadata.crossAgentRequestId !== undefined && owner.metadata.crossAgentRequestId !== binding.requestId)
        || (owner.metadata.conversationRootSessionId !== undefined && owner.metadata.conversationRootSessionId !== binding.rootSessionId)
        || (owner.metadata.continuationOfSessionId !== undefined && owner.metadata.continuationOfSessionId !== binding.sourceSessionId)
        || owner.metadata.application || owner.metadata.sandbox?.enabled || owner.metadata.delegatedTask) {
        throw new Error('Only a durably ready, owned, unsent conversation candidate may retire.');
    }
    const retained = input.retained(); const key = retained?.encryption;
    if (!key || key.encryptionKey.length !== 32 || !['legacy', 'dataKey'].includes(key.encryptionVariant)) {
        throw new Error('The candidate encryption identity is unavailable.');
    }
    const encryption = { ...key, encryptionKey: new Uint8Array(key.encryptionKey) };
    const keySha256 = createHash('sha256').update(encryption.encryptionKey).digest('hex');
    const scope = JSON.stringify([binding.rootSessionId, binding.sourceSessionId, binding.requestId,
        binding.targetSessionId, binding.targetAgent, original, encryption.encryptionVariant]);
    const checkRetained = () => {
        const current = input.retained(); const metadata = current?.happySessionMetadataFromLocalWebhook;
        const tracked = current?.startedBy === 'daemon' && current.pid === hostPid && current.childProcess?.pid === hostPid;
        const persisted = current?.startedBy === 'persisted' && current.pid === 0 && !current.childProcess;
        if ((!tracked && !persisted) || current?.happySessionId !== owner.id || !metadata || !current.encryption
            || current.encryption.encryptionVariant !== encryption.encryptionVariant
            || !Buffer.from(current.encryption.encryptionKey).equals(Buffer.from(encryption.encryptionKey))
            || fingerprint({ ...owner, metadata }) !== original) throw new Error('The retained candidate worker or encryption identity changed.');
    };
    const verifyCurrent = async () => {
        checkRetained(); const current = await input.verify(); checkRetained();
        assertConversationLaunchIdle(current, { allowArchived: true });
        if (fingerprint(current) !== original) throw new Error('The unsent conversation candidate scope changed.');
    };
    checkRetained(); await verifyCurrent();
    const firstCreated = await mkdir(input.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(input.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) throw new Error('Candidate retirement proof directory is unsafe.');
    if (firstCreated) {
        for (let path = input.directory; ; path = dirname(path)) {
            const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
            if (path === dirname(firstCreated)) break;
        }
    }
    const path = join(input.directory, `${binding.requestId}.json`);
    const signature = (payload: unknown) => createHmac('sha256', encryption.encryptionKey).update(JSON.stringify(payload)).digest('hex');
    const save = async (payload: Proof) => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
            const handle = await open(temporary, 'wx', 0o600);
            try { await handle.writeFile(JSON.stringify({ payload, signature: signature(payload) })); await handle.sync(); }
            finally { await handle.close(); }
            await rename(temporary, path);
            const parent = await open(input.directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
        } catch {
            await rm(temporary, { force: true }).catch(() => {});
            throw new Error('Candidate retirement proof could not be durably saved; cancellation remains pending.');
        }
    };
    let proof: Proof | undefined;
    try {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const info = await handle.stat();
            if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 2 * 1024 * 1024) throw new Error('Unsafe retirement proof');
            const raw: unknown = JSON.parse(await handle.readFile('utf8'));
            const signed = z.object({ payload: z.unknown(), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw);
            if (!timingSafeEqual(Buffer.from(signed.signature, 'hex'), Buffer.from(signature(signed.payload), 'hex'))) throw new Error('Invalid retirement proof signature');
            proof = payloadSchema.parse(signed.payload);
            if (proof.scope !== scope || proof.keySha256 !== keySha256 || proof.tree.rootPid !== hostPid) throw new Error('Retirement proof belongs to another candidate');
        } finally { await handle.close(); }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Candidate retirement proof is unreadable, unsafe or does not match the retained identity.');
    }
    await verifyCurrent();
    if (proof?.phase === 'unconfirmed') throw new Error(`Recorded native process identity remains unconfirmed (${proof.unconfirmed?.reason ?? 'unknown'}); cancellation is pending.`);
    if (!proof || proof.phase === 'captured') {
        const identity = z.object({ agent: z.enum(['codex', 'antigravity']), hostPid: pid }).safeParse(
            await input.callSessionRpc(owner.id, encryption, 'delegation-context', {}));
        if (!identity.success || identity.data.hostPid !== hostPid || identity.data.agent !== owner.metadata.flavor) {
            throw new Error('The encrypted candidate runtime identity was not confirmed.');
        }
        await verifyCurrent();
        if (!proof) {
            const tree = treeSchema.parse(await input.captureProcessTree(hostPid));
            if (tree.rootPid !== hostPid) throw new Error('The captured candidate host changed.');
            proof = { version: 1, scope, keySha256, tree, phase: 'captured' }; await save(proof);
        }
        await verifyCurrent();
        const latest = treeSchema.parse(await input.captureProcessTree(hostPid));
        checkRetained();
        if (!sameNativeProcessTree(proof.tree, latest)) throw new Error('The candidate process subtree changed before retirement; cancellation is pending.');
        proof.phase = 'stop-requested'; await save(proof);
        await verifyCurrent();
        const immediatelyBeforeStop = treeSchema.parse(await input.captureProcessTree(hostPid));
        checkRetained();
        if (!sameNativeProcessTree(proof.tree, immediatelyBeforeStop)) throw new Error('The candidate process subtree changed before retirement; cancellation is pending.');
        await verifyCurrent();
        const acknowledged = z.object({ success: z.literal(true) }).safeParse(
            await input.callSessionRpc(owner.id, encryption, 'killSession', {}));
        if (!acknowledged.success) throw new Error('The candidate shutdown was not acknowledged; only recorded lifetime observation may resume.');
        proof.phase = 'acknowledged'; await save(proof);
    }
    // A restart or a lost ACK resumes observation only. Never resend an
    // uncertain stop, signal a metadata PID, or reconstruct an empty dead-root tree.
    try { await input.awaitProcessTreeExit(proof.tree); }
    catch (error) {
        if (error instanceof NativeProcessTreeIdentityError) {
            proof.phase = 'unconfirmed'; proof.unconfirmed = { reason: error.reason, observed: error.observed }; await save(proof);
        }
        throw error;
    }
    await verifyCurrent();
    proof.phase = 'exited'; await save(proof);
}
