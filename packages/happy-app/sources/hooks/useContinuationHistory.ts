import * as React from 'react';
import type { HistoryViewportReader } from '@/sync/historyWindowPolicy';
import { useShallow } from 'zustand/react/shallow';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { ensureSessionHydratedWithRetry } from '@/sync/ensureSessionHydratedWithRetry';
import { accountRuntimeCurrent } from '@/auth/accountRuntime';
import { visibleContinuationIds, type ContinuationSection } from '@/components/continuationTranscript';
import { t } from '@/text';

/** Session messages remain in their original encrypted history stores. */
export function useContinuationHistory(currentId: string) {
    const [ids, setIds] = React.useState([currentId]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const busy = React.useRef<object | null>(null);
    const owner = React.useRef({ currentId, live: true });
    React.useEffect(() => {
        const token = { currentId, live: true }; owner.current = token;
        setIds([currentId]); setError(null); setLoading(false);
        return () => { token.live = false; };
    }, [currentId]);
    const snapshots = storage(useShallow(state => ids.map(id => state.sessionMessages[id])));
    const sessions = storage(useShallow(state => ids.map(id => state.sessions[id])));
    const windows = Object.fromEntries(ids.map((id, i) => [id, snapshots[i]]));
    const visibleIds = visibleContinuationIds(ids, windows);
    const visible = new Set(visibleIds);
    const sections: ContinuationSection[] = ids.flatMap((id, i) => visible.has(id)
        ? [{ id, metadata: sessions[i]?.metadata ?? null, messages: snapshots[i]?.messages ?? [] }] : []);
    const oldestId = ids.at(-1)!;
    const oldest = snapshots.at(-1);
    const parentId = sessions.at(-1)?.metadata?.continuationOfSessionId;
    const newestId = visibleIds[0];
    const newest = windows[newestId];
    const run = async (action: (isCurrent: () => boolean) => Promise<void>) => {
        const token = owner.current;
        if (busy.current === token || ids[0] !== currentId) return;
        const isCurrent = () => token.live && owner.current === token && accountRuntimeCurrent();
        if (!isCurrent()) return;
        busy.current = token; setLoading(true); setError(null);
        try { await action(isCurrent); }
        catch (e) { if (isCurrent()) setError(e instanceof Error && e.message === 'cycle' ? t('session.continueCycle') : t('session.continueHistoryError')); }
        finally { if (busy.current === token) busy.current = null; if (isCurrent()) setLoading(false); }
    };
    const loadOlder = (viewport?: HistoryViewportReader) => run(async isCurrent => {
        if (!oldest?.isLoaded) { await sync.ensureMessagesLoaded(oldestId); return; }
        if (oldest.hasMoreOlder) { await sync.loadOlderMessages(oldestId, viewport); return; }
        if (!parentId) return;
        if (ids.includes(parentId)) throw new Error('cycle');
        if (!await ensureSessionHydratedWithRetry(parentId, isCurrent)) throw new Error('missing');
        if (!isCurrent()) return;
        await sync.ensureMessagesLoaded(parentId);
        if (!isCurrent()) return;
        if (!storage.getState().sessionMessages[parentId]?.isLoaded) throw new Error('unreadable');
        if (storage.getState().sessionMessages[parentId]?.hasMoreNewer) await sync.jumpToLatestMessages(parentId);
        if (isCurrent()) setIds(previous => previous.includes(parentId) ? previous : [...previous, parentId]);
    });
    // An empty fresh session still immediately shows the saved conversation.
    React.useEffect(() => {
        if (!loading && ids.length === 1 && oldest?.isLoaded && !oldest.hasMoreOlder && parentId && !error) void loadOlder();
    }, [currentId, oldest?.isLoaded, oldest?.hasMoreOlder, parentId, ids.length, error, loading]);
    const loadNewer = (viewport?: HistoryViewportReader) => run(async () => { await sync.loadNewerMessages(newestId, viewport); });
    const jumpLatest = () => run(async isCurrent => {
        await sync.jumpToLatestMessages(currentId);
        if (isCurrent()) setIds([currentId]);
    });
    return { sections, loadOlder, loadNewer, jumpLatest,
        hasMoreOlder: !oldest?.isLoaded || !!oldest.hasMoreOlder || !!parentId,
        hasMoreNewer: !!newest?.hasMoreNewer,
        isAtLatest: newestId === currentId && newest?.isAtLatest !== false,
        olderCursor: `${oldestId}:${sync.getHistoryBoundarySeq(oldestId, 'older') ?? ''}`,
        newerCursor: `${newestId}:${sync.getHistoryBoundarySeq(newestId, 'newer') ?? ''}`,
        loading, olderError: error ?? oldest?.olderError ?? null,
        newerError: newest?.newerError ?? null,
    };
}
