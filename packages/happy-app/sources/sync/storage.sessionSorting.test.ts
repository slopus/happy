import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
});

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('expo-modules-core', () => ({
    Platform: { OS: 'web' },
    requireNativeModule: () => ({}),
    requireOptionalNativeModule: () => ({}),
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: { extra: {} } },
}));

vi.mock('expo', () => ({}));

vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
}));

vi.mock('./sync', () => ({
    sync: {},
}));

vi.mock('@/modal', () => ({
    Modal: {},
}));

vi.mock('@/realtime/RealtimeSession', () => ({
    getCurrentRealtimeSessionId: () => null,
    getVoiceSession: () => null,
}));

vi.mock('@/components/tools/knownTools', () => ({
    isMutableTool: () => false,
}));

import { storage } from './storage';
import type { Session } from './storageTypes';

function session(id: string, createdAt: number, updatedAt: number, activeAt = updatedAt): Session {
    return {
        id,
        seq: 1,
        createdAt,
        updatedAt,
        lastMessageAt: updatedAt,
        lastUserMessageAt: updatedAt,
        active: false,
        activeAt,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: updatedAt,
        presence: updatedAt,
    };
}

describe('storage session ordering', () => {
    beforeEach(() => {
        storage.setState({
            sessions: {},
            sessionsData: null,
            sessionListViewData: null,
            sessionMessages: {},
        });
    });

    it('orders legacy session data by latest activity instead of creation time', () => {
        storage.getState().applySessions([
            session('created-today', 200, 100),
            session('continued-today', 100, 200),
        ], { replace: true });

        const sessionIds = storage.getState().sessionsData
            ?.filter((item): item is Session => typeof item !== 'string')
            .map((item) => item.id);

        expect(sessionIds).toEqual(['continued-today', 'created-today']);
    });

    it('keeps a warm yesterday conversation in yesterday despite today heartbeats and metadata', () => {
        const yesterday = new Date(2026, 7, 5, 20).getTime();
        const today = new Date(2026, 7, 6, 10).getTime();
        const warm = { ...session('warm', yesterday - 100, today, today), lastMessageAt: yesterday, active: true };
        storage.getState().applySessions([warm], { replace: true });
        const row = () => storage.getState().sessionListViewData?.find(item => item.type === 'active-sessions');
        expect(row()).toMatchObject({ sessions: [{ activityAt: yesterday }] });
        storage.getState().applySessions([{ ...warm, activeAt: today + 1000, updatedAt: today + 1000 }]);
        expect(row()).toMatchObject({ sessions: [{ activityAt: yesterday }] });
        storage.getState().applySessions([{ ...warm, active: false }]);
        expect(row()).toMatchObject({ sessions: [{ activityAt: yesterday }] });
    });

    it('promotes a continued conversation once and ignores older snapshots and later heartbeats', () => {
        const old = session('continued', 10, 20);
        const recent = session('recent', 25, 30);
        storage.getState().applySessions([old, recent]);
        const order = () => storage.getState().sessionListViewData?.find(item => item.type === 'active-sessions');
        expect(order()).toMatchObject({ sessions: [{ id: 'recent' }, { id: 'continued' }] });
        storage.getState().applySessions([{ ...old, lastMessageAt: 40, lastUserMessageAt: 40 }]);
        expect(order()).toMatchObject({ sessions: [{ id: 'continued' }, { id: 'recent' }] });
        storage.getState().applySessions([{ ...old, activeAt: 1000, updatedAt: 1000 }]);
        expect(order()).toMatchObject({ sessions: [{ id: 'continued', activityAt: 40 }, { id: 'recent' }] });
        expect(storage.getState().sessions.continued.lastMessageAt).toBe(40);
    });
    it('replaces an empty new shell fallback with the older imported conversation clock', () => {
        const shell = { ...session('imported', 1000, 1000), lastMessageAt: null };
        storage.getState().applySessions([shell]);
        storage.getState().applySessions([{ ...shell, lastMessageAt: 20 }]);
        expect(storage.getState().sessions.imported.lastMessageAt).toBe(20);
        expect(storage.getState().sessionListViewData).toMatchObject([{ sessions: [{ activityAt: 20 }] }]);
    });

});


describe('sidebar status priority and durable user recency', () => {
    beforeEach(() => storage.setState({ sessions: {}, sessionsData: null, sessionListViewData: null, sessionMessages: {} }));
    const ids = () => (storage.getState().sessionListViewData?.find(row => row.type === 'active-sessions') as any)?.sessions.map((row: any) => row.id);
    it('does not swap running rows when Agent messages, heartbeats, and metadata alternate', () => {
        const a = { ...session('a', 1, 100), lastUserMessageAt: 10, active: true,
            agentState: { turnStatus: { status: 'running' as const, updatedAt: 100 } } };
        const b = { ...session('b', 2, 200), lastUserMessageAt: 9, active: true,
            agentState: { turnStatus: { status: 'running' as const, updatedAt: 200 } } };
        storage.getState().applySessions([a, b]);expect(ids()).toEqual(['a', 'b']);
        storage.getState().applySessions([{ ...b, lastMessageAt: 300, activeAt: 300 }]);expect(ids()).toEqual(['a', 'b']);
        storage.getState().applySessions([{ ...a, lastMessageAt: 400, updatedAt: 400 }]);expect(ids()).toEqual(['a', 'b']);
        storage.getState().applySessions([{ ...b, lastUserMessageAt: 11 }]);expect(ids()).toEqual(['b', 'a']);
        storage.getState().applySessions([{ ...b, lastUserMessageAt: 8 }]);expect(ids()).toEqual(['b', 'a']);
    });
    it('keeps execution priority independent of reconnection and settles completion once', () => {
        const running = { ...session('running', 1, 100), active: true, lastUserMessageAt: 10,
            agentState: { turnStatus: { status: 'running' as const, updatedAt: 100 } } };
        const done = { ...session('done', 2, 200), lastUserMessageAt: 20,
            agentState: { turnStatus: { status: 'completed' as const, updatedAt: 200 } } };
        storage.getState().applySessions([done, running]);expect(ids()).toEqual(['running', 'done']);
        storage.getState().applySessions([{ ...running, active: false, presence: 900 }]);expect(ids()).toEqual(['running', 'done']);
        storage.getState().applySessions([{ ...running, agentState: { turnStatus: { status: 'completed', updatedAt: 1000 } } }]);expect(ids()).toEqual(['done', 'running']);
        storage.getState().applySessions([{ ...done, lastMessageAt: 2000 }]);expect(ids()).toEqual(['done', 'running']);
    });
    it('merges the encrypted metadata clock while retaining a newer local verified send', () => {
        const a = { ...session('a', 1, 1000), lastUserMessageAt: 100, metadata: { path: '/r', host: 'h', lastUserMessageAt: 120 } };
        storage.getState().applySessions([a]);expect(storage.getState().sessions.a.lastUserMessageAt).toBe(120);
        storage.getState().applySessions([{ ...a, lastUserMessageAt: 90, metadata: { ...a.metadata, lastUserMessageAt: 80 } }]);
        expect(storage.getState().sessions.a.lastUserMessageAt).toBe(120);
    });
});

describe('logical conversation sidebar projection', () => {
    beforeEach(() => storage.setState({ sessions: {}, sessionsData: null, sessionListViewData: null, sessionMessages: {}, unreadSessionIds: new Set(), currentViewingSessionId: null }));
    const rows = () => storage.getState().sessionListViewData?.flatMap(item => item.type === 'active-sessions' ? item.sessions : item.type === 'session' ? [item.session] : []) ?? [];
    const metadata = { path: '/repo', host: 'mac', machineId: 'machine' };

    it('shows one stable row with the active worker status, root title, and real action identity', () => {
        const root = { ...session('root', 1, 10), metadata: { ...metadata, conversationActiveSessionId: 'target', summary: { text: 'Kept title', updatedAt: 1 } } };
        const target = { ...session('target', 20, 30), active: true, presence: 'online' as const,
            metadata: { ...metadata, conversationRootSessionId: 'root', flavor: 'antigravity', summary: { text: 'Worker title', updatedAt: 30 } },
            agentState: { turnStatus: { status: 'running' as const, updatedAt: 30 } } };
        storage.getState().applySessions([root, target, session('other-chat', 3, 25)]);
        expect(rows().map(row => row.id)).toEqual(['root', 'other-chat']);
        expect(rows()[0]).toMatchObject({ id: 'root', executionSessionId: 'target', name: 'Kept title', flavor: 'antigravity', state: 'running', createdAt: 1, lastUserMessageAt: 30 });
        expect(storage.getState().sessions.root.metadata?.flavor).toBeUndefined();
        expect(storage.getState().sessions.target.id).toBe('target');
        storage.getState().updateSessionDraft('target', 'next request');
        expect(rows()[0].hasDraft).toBe(true);
        storage.getState().updateSessionDraft('target', null);
        expect(rows()[0].hasDraft).toBe(false);
    });

    it('aggregates unread work across segments and clears it by viewing the active worker', () => {
        storage.getState().applySessions([
            { ...session('root', 1, 10), metadata: { ...metadata, conversationActiveSessionId: 'target' } },
            { ...session('previous', 2, 20), metadata: { ...metadata, conversationRootSessionId: 'root' } },
            { ...session('target', 3, 30), metadata: { ...metadata, conversationRootSessionId: 'root' } },
        ]);
        storage.getState().markSessionUnread('previous');
        storage.getState().markSessionUnread('target');
        expect(rows()).toMatchObject([{ id: 'root', hasUnread: true }]);
        storage.getState().setCurrentViewingSession('target');
        expect(storage.getState().currentViewingSessionId).toBe('target');
        expect(rows()[0].hasUnread).toBe(false);
        expect(storage.getState().unreadSessionIds.size).toBe(0);
        storage.getState().markSessionUnread('root');
        storage.getState().markSessionRead('target');
        expect(rows()[0].hasUnread).toBe(false);
    });

    it('keeps a separately requested continuation visible and never hides an inconsistent target', () => {
        storage.getState().applySessions([
            { ...session('root', 1, 10), metadata: { ...metadata, conversationActiveSessionId: 'wrong' } },
            { ...session('wrong', 2, 20), metadata: { ...metadata, conversationRootSessionId: 'elsewhere' } },
            { ...session('separate', 3, 30), metadata: { ...metadata, continuationOfSessionId: 'root' } },
        ]);
        expect(new Set(rows().map(row => row.id))).toEqual(new Set(['root', 'wrong', 'separate']));
    });
});
