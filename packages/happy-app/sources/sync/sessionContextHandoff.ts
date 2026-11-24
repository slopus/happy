import { assertAccountRuntime } from '@/auth/accountRuntime';
import { buildContinuationContext } from './continuationContext';
import { storage } from './storage';
import { sync } from './sync';
import { sessionUpdateMetadata } from './ops';

/** Snapshot a bounded, current excerpt before starting a successor worker. */
export async function prepareSessionContinuationContext(id: string): Promise<string> {
    await sync.ensureMessagesLoaded(id);
    assertAccountRuntime();
    const visible = storage.getState().sessionMessages[id];
    if (visible?.hasMoreNewer || visible?.isAtLatest === false) await sync.jumpToLatestMessages(id);
    assertAccountRuntime();
    const history = storage.getState().sessionMessages[id];
    if (!history?.isLoaded || !history.isAtLatest || history.hasMoreNewer || !storage.getState().sessions[id]) throw new Error('continuation-history-unavailable');
    // A latest wire page can contain only tool events. Retain collected text
    // while walking older pages until a real user request has been included.
    const collected = new Map(history.messages.map(message => [message.id, message]));
    for (let page = 0; page < 5 && ![...collected.values()].some(message => message.kind === 'user-text')
        && storage.getState().sessionMessages[id]?.hasMoreOlder; page++) {
        await sync.loadOlderMessages(id);
        assertAccountRuntime();
        const older = storage.getState().sessionMessages[id];
        if (!older?.isLoaded || !storage.getState().sessions[id]) throw new Error('continuation-history-unavailable');
        for (const message of older.messages) collected.set(message.id, message);
    }
    if (storage.getState().sessionMessages[id]?.hasMoreOlder
        && ![...collected.values()].some(message => message.kind === 'user-text')) throw new Error('continuation-history-unavailable');
    return buildContinuationContext([...collected.values()], storage.getState().sessions[id].metadata?.continuationContext);
}

/** Persist before sending: the normal send pipeline injects this excerpt once. */
export async function attachSessionContinuationContext(targetId: string, sourceId: string, context: string): Promise<void> {
    assertAccountRuntime();
    const target = storage.getState().sessions[targetId];
    if (!target?.metadata) throw new Error('continuation-hydration-failed');
    const updated = await sessionUpdateMetadata(targetId, target.metadata, target.metadataVersion, metadata => ({
        ...metadata, continuationOfSessionId: sourceId, continuationContext: context,
    }));
    assertAccountRuntime();
    storage.getState().applySessions([{ ...storage.getState().sessions[targetId], metadata: updated.metadata, metadataVersion: updated.version }]);
}
