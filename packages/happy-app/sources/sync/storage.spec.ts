import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from './storageTypes';

// storage.ts reaches React Native, MMKV and the sync engine at import time;
// none of them take part in the store's own reducers under test here.
const mmkv = new Map<string, string>();
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return mmkv.get(key); }
        set(key: string, value: string) { mmkv.set(key, value); }
        delete(key: string) { mmkv.delete(key); }
        getNumber(key: string) { const v = mmkv.get(key); return v === undefined ? undefined : Number(v); }
        clearAll() { mmkv.clear(); }
    },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web', select: (options: any) => options.web ?? options.default } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('@/realtime/RealtimeSession', () => ({ getCurrentRealtimeSessionId: () => null, getVoiceSession: () => null }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/tools/knownTools', () => ({ isMutableTool: () => true }));

const { storage } = await import('./storage');

function session(options: { id: string; active?: boolean; lastMeaningfulMessageAt?: number }): Session {
    const active = options.active ?? true;
    return {
        id: options.id,
        seq: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
        active,
        activeAt: active ? 5_000 : 0,
        metadata: {
            path: '/repo',
            host: 'localhost',
            machineId: 'machine-1',
            ...(options.lastMeaningfulMessageAt === undefined ? {} : { lastMeaningfulMessageAt: options.lastMeaningfulMessageAt }),
        },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: active ? 'online' : 0,
    };
}

beforeEach(() => {
    storage.setState({
        sessions: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionMessages: {},
        unreadSessionIds: new Set(),
    });
});

describe('applySessions', () => {
    it('keeps both list views when an event changes nothing a row shows', () => {
        const a = session({ id: 'a', active: true });
        storage.getState().applySessions([a, session({ id: 'b', active: false })]);
        const view = storage.getState().sessionListViewData;
        const legacy = storage.getState().sessionsData;
        expect(view).not.toBeNull();

        // What a new-message event and the activity flush carry for a live session.
        storage.getState().applySessions([{ ...a, updatedAt: 2_000, seq: 7, activeAt: 6_000, thinkingAt: 6_000 }]);
        expect(storage.getState().sessions.a.seq).toBe(7);
        expect(storage.getState().sessionListViewData).toBe(view);
        expect(storage.getState().sessionsData).toBe(legacy);

        // The row's state and its sort key are visible: either one rebuilds.
        storage.getState().applySessions([{ ...a, thinking: true }]);
        const thinkingView = storage.getState().sessionListViewData;
        expect(thinkingView).not.toBe(view);
        storage.getState().applySessions([{ ...a, thinking: true, metadata: { ...a.metadata!, lastMeaningfulMessageAt: 9_000 } }]);
        expect(storage.getState().sessionListViewData).not.toBe(thinkingView);
    });
});
