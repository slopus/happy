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
        storage.getState().applySessions([{ ...old, lastMessageAt: 40 }]);
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
