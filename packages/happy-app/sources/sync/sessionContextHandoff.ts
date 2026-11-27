import { digestStringAsync, CryptoDigestAlgorithm, randomUUID } from 'expo-crypto';
import { PortableContextArchiveSchema, PortableContextDescriptorSchema, type PortableContextArchive, type PortableContextDescriptor, type PortableContextHead } from '@slopus/happy-wire';
import { assertAccountRuntime } from '@/auth/accountRuntime';
import { storage } from './storage';
import { sync } from './sync';
import { apiSocket } from './apiSocket';
import { sessionUpdateMetadata } from './ops';
import { assertPortableContextSourceScope, buildPortableContextPreview } from './portableContext';
import type { Metadata } from './storageTypes';
import { hasConversationClaim, resolveConversationRootSessionId } from './conversationSession';

export { assertPortableContextSourceScope, buildPortableContextPreview } from './portableContext';
export type PreparedSessionContinuationContext = {
    context: string; archive: PortableContextArchive; sha256: string;
    assertCurrent: () => void; assertIdentityCurrent: () => void; verifyCurrent: () => Promise<void>;
};

/** Wire parsing may reorder object properties; segment identity and bounds must match. */
function sameHistoryHeads(actual: PortableContextHead[], expected: PortableContextHead[]): boolean {
    return actual.length === expected.length && actual.every((head, index) => {
        const other = expected[index];
        return head.sessionId === other.sessionId && head.afterSeq === other.afterSeq && head.throughSeq === other.throughSeq;
    });
}

/** Read the immutable inherited prefix, not the parent's later live history. */
async function readFrozenPrefix(machineId: string, rootId: string, predecessor: string, assertCurrent: () => void): Promise<PortableContextArchive> {
    let offset = 0;
    const chunks: string[] = [];
    let descriptor: PortableContextDescriptor | undefined;
    for (;;) {
        const page = await apiSocket.machineRPC<{ success: boolean; chunk?: string; nextTextOffset?: number | null;
            descriptor?: PortableContextDescriptor }, object>(machineId, 'read-conversation-context', { sourceSessionId: rootId, textOffset: offset });
        assertCurrent();
        if (!page?.success || typeof page.chunk !== 'string') throw new Error('portable-context-inherited-history-unavailable');
        const parsed = PortableContextDescriptorSchema.safeParse(page.descriptor);
        if (!parsed.success || (descriptor && JSON.stringify(descriptor) !== JSON.stringify(parsed.data))
            || (page.nextTextOffset !== null && (!Number.isSafeInteger(page.nextTextOffset)
                || page.nextTextOffset !== offset + page.chunk.length || page.nextTextOffset <= offset))) throw new Error('portable-context-invalid-inherited-page');
        descriptor = parsed.data;
        chunks.push(page.chunk);
        if (page.nextTextOffset === null) break;
        offset = page.nextTextOffset!;
    }
    const text = chunks.join('');
    const sha256 = await digestStringAsync(CryptoDigestAlgorithm.SHA256, text);
    assertCurrent();
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error('portable-context-invalid-inherited-history'); }
    const parsed = PortableContextArchiveSchema.safeParse(value);
    if (!parsed.success || sha256 !== descriptor!.sha256 || parsed.data.snapshot.id !== descriptor!.id
        || parsed.data.snapshot.sourceSessionId !== predecessor
        || !sameHistoryHeads(parsed.data.snapshot.heads, descriptor!.heads)) throw new Error('portable-context-invalid-inherited-history');
    return parsed.data;
}

/** Read every live logical segment and reuse any independent branch's frozen prefix. */
export async function prepareSessionContinuationContext(id: string): Promise<PreparedSessionContinuationContext> {
    assertAccountRuntime();
    assertPortableContextSourceScope(storage.getState().sessions[id]?.metadata);
    const segments: Awaited<ReturnType<typeof sync.readPortableContextSegment>>[] = [];
    const seen = new Set<string>();
    let current: string | undefined = id;
    let rootSessionId = id;
    let machineId: string | undefined;
    let path: string | undefined;
    let inheritedFrom: string | undefined;
    while (current) {
        if (seen.has(current) || seen.size >= 1000) throw new Error('portable-context-invalid-lineage');
        seen.add(current);
        const segment = await sync.readPortableContextSegment(current);
        assertAccountRuntime();
        const metadata: Metadata | null | undefined = storage.getState().sessions[current]?.metadata;
        if (!metadata?.machineId || !metadata.path) throw new Error('portable-context-source-unavailable');
        assertPortableContextSourceScope(metadata);
        if (current === id) {
            const claims = Object.values(storage.getState().sessions).filter(session => session.metadata?.conversationActiveSessionId === id);
            if (claims.length > 1) throw new Error('portable-context-ambiguous-conversation');
            rootSessionId = metadata.conversationRootSessionId ?? claims[0]?.id ?? id;
            machineId = metadata.machineId; path = metadata.path;
        } else if (metadata.machineId !== machineId || metadata.path !== path) throw new Error('portable-context-lineage-mismatch');
        segments.push(segment);
        if (segment.boundary) break;
        if (current === rootSessionId) {
            inheritedFrom = metadata.continuationOfSessionId;
            if (inheritedFrom && seen.has(inheritedFrom)) throw new Error('portable-context-invalid-lineage');
            break;
        }
        if (!metadata.continuationOfSessionId) throw new Error('portable-context-incomplete-conversation');
        current = metadata.continuationOfSessionId;
    }
    const resolvedRoot = resolveConversationRootSessionId(storage.getState().sessions, id);
    if ((!resolvedRoot && hasConversationClaim(storage.getState().sessions, id)) || (resolvedRoot && resolvedRoot !== rootSessionId)) throw new Error('portable-context-ambiguous-conversation');
    const assertCurrent = () => { assertAccountRuntime(); segments.forEach(segment => segment.assertCurrent()); };
    const assertIdentityCurrent = () => { assertAccountRuntime(); segments.forEach(segment => segment.assertIdentityCurrent()); };
    const verifyCurrent = async () => {
        assertCurrent();
        for (const segment of segments) await segment.verifyCurrent();
        assertCurrent();
    };
    assertCurrent();
    const prefix = inheritedFrom ? await readFrozenPrefix(machineId!, rootSessionId, inheritedFrom, assertCurrent) : undefined;
    const ordered = [...segments].reverse();
    const heads = [...(prefix?.snapshot.heads ?? []), ...ordered.map(segment => segment.head)];
    if (new Set(heads.map(head => head.sessionId)).size !== heads.length) throw new Error('portable-context-invalid-lineage');
    const snapshot: PortableContextArchive['snapshot'] = {
        version: 1, id: randomUUID(), rootSessionId, sourceSessionId: id, heads,
        items: [...(prefix?.snapshot.items ?? []), ...ordered.flatMap(segment => segment.items)],
    };
    const archive: PortableContextArchive = { snapshot, blobKeys: { ...prefix?.blobKeys } };
    for (const segment of segments) {
        if (segment.blobKey && segment.items.some(item => item.attachments?.some(file => file.encrypted))) archive.blobKeys[segment.head.sessionId] = segment.blobKey;
    }
    const sha256 = await digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify(archive));
    assertCurrent();
    return { context: buildPortableContextPreview(snapshot), archive, sha256, assertCurrent, assertIdentityCurrent, verifyCurrent };
}

/** Wait for a real MCP-ready capability event; never probe an old worker with fallback text. */
async function awaitPortableContextCapability(id: string, assertCurrent: () => void): Promise<void> {
    const check = () => { assertCurrent(); return storage.getState().sessions[id]?.metadata?.portableContextProtocol === 1; };
    if (check()) return;
    await new Promise<void>((resolve, reject) => {
        let unsubscribe = () => {};
        const timer = setTimeout(() => { unsubscribe(); reject(new Error('portable-context-worker-upgrade-required')); }, 20_000);
        const onChange = () => {
            try { if (!check()) return; clearTimeout(timer); unsubscribe(); resolve(); }
            catch (error) { clearTimeout(timer); unsubscribe(); reject(error); }
        };
        unsubscribe = storage.subscribe(onChange);
        onChange();
    });
}

/** Commit a complete encrypted archive before persisting its model-visible reference. */
export async function attachSessionContinuationContext(targetId: string, sourceId: string, prepared: PreparedSessionContinuationContext): Promise<void> {
    const initialTarget = storage.getState().sessions[targetId];
    if (!initialTarget?.metadata || prepared.archive.snapshot.sourceSessionId !== sourceId) throw new Error('portable-context-target-unavailable');
    const assertCurrent = () => {
        prepared.assertCurrent();
        const target = storage.getState().sessions[targetId];
        if (!target?.metadata || target.metadata.machineId !== initialTarget.metadata!.machineId || target.metadata.path !== initialTarget.metadata!.path
            || target.metadata.portableContextBoundary || target.metadata.conversationDeletePlan
            || ['archived', 'archiveRequested'].includes(target.metadata.lifecycleState ?? '')) throw new Error('portable-context-target-changed');
    };
    await prepared.verifyCurrent();
    await awaitPortableContextCapability(targetId, assertCurrent);
    const text = JSON.stringify(prepared.archive);
    const snapshotId = prepared.archive.snapshot.id;
    const chunks = Math.ceil(text.length / 48000);
    for (let index = 0; index < chunks; index++) {
        assertCurrent();
        const result = await apiSocket.sessionRPC<{ success: boolean }, object>(targetId, 'portable-context-upload', {
            action: 'append', snapshotId, index, chunk: text.slice(index * 48000, (index + 1) * 48000),
        });
        assertCurrent();
        if (!result?.success) throw new Error('portable-context-upload-failed');
    }
    const result = await apiSocket.sessionRPC<{ success: boolean; descriptor?: PortableContextDescriptor }, object>(targetId, 'portable-context-upload', {
        action: 'commit', snapshotId, chunks, sha256: prepared.sha256,
    });
    assertCurrent();
    const descriptor = PortableContextDescriptorSchema.parse(result?.descriptor);
    if (!result.success || descriptor.id !== snapshotId || descriptor.sha256 !== prepared.sha256
        || descriptor.rootSessionId !== prepared.archive.snapshot.rootSessionId || descriptor.sourceSessionId !== sourceId
        || !sameHistoryHeads(descriptor.heads, prepared.archive.snapshot.heads)) throw new Error('portable-context-commit-unconfirmed');
    await prepared.verifyCurrent();
    const target = storage.getState().sessions[targetId];
    if (!target?.metadata) throw new Error('portable-context-target-unavailable');
    const updated = await sessionUpdateMetadata(targetId, target.metadata, target.metadataVersion, metadata => {
        assertCurrent();
        if (metadata.portableContextBoundary) throw new Error('portable-context-target-changed');
        return { ...metadata, continuationOfSessionId: sourceId, continuationContext: prepared.context, portableContext: descriptor };
    });
    assertCurrent();
    const live = storage.getState().sessions[targetId];
    if (!live) throw new Error('portable-context-target-unavailable');
    if (live.metadataVersion <= updated.version) storage.getState().applySessions([{ ...live, metadata: updated.metadata, metadataVersion: updated.version }]);
}
