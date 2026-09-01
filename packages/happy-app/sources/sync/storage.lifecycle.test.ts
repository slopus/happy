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

describe('storage session lifecycle', () => {
    beforeEach(() => {
        storage.setState({
            sessions: {},
            sessionsData: null,
            sessionListViewData: null,
            sessionMessages: {},
        });
    });

    it('clears thinking when a fetched ready event closes the turn', () => {
        storage.getState().applySessions([{
            id: 'session-1',
            seq: 2,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                turnStatus: { status: 'failed', updatedAt: 2, turnId: 'turn-1' },
            },
            agentStateVersion: 2,
            thinking: true,
            thinkingAt: 2,
            presence: 'online',
        }], { replace: true });

        const result = storage.getState().applyMessages('session-1', [{
            id: 'turn-end-1',
            localId: null,
            createdAt: 3,
            role: 'event',
            content: { type: 'ready' },
            isSidechain: false,
        }]);

        expect(result.hasReadyEvent).toBe(true);
        expect(storage.getState().sessions['session-1']?.thinking).toBe(false);
    });

    it('keeps thinking when a fetched ready event predates the current turn', () => {
        storage.getState().applySessions([{
            id: 'session-1',
            seq: 3,
            createdAt: 1,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                turnStatus: { status: 'running', updatedAt: 10, turnId: 'turn-2' },
            },
            agentStateVersion: 3,
            thinking: true,
            thinkingAt: 10,
            presence: 'online',
        }], { replace: true });

        const result = storage.getState().applyMessages('session-1', [{
            id: 'turn-end-1',
            localId: null,
            createdAt: 3,
            role: 'event',
            content: { type: 'ready' },
            isSidechain: false,
        }]);

        expect(result.hasReadyEvent).toBe(true);
        expect(storage.getState().sessions['session-1']?.thinking).toBe(true);
    });
});
