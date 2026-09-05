import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
});
const persistedValues = vi.hoisted(() => new Map<string, unknown>());
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return persistedValues.get(key); }
    getNumber(key: string) { return persistedValues.get(key); }
    getBoolean(key: string) { return persistedValues.get(key); }
    set(key: string, value: unknown) { persistedValues.set(key, value); }
    delete(key: string) { persistedValues.delete(key); }
} }));

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
import * as persistence from './persistence';

describe('storage session lifecycle', () => {
    beforeEach(() => {
        storage.setState({
            sessions: {},
            sessionsData: null,
            sessionListViewData: null,
            sessionMessages: {},
        });
    });

    it('restores persisted overrides for later incremental sessions and preserves explicit live clears', async () => {
        persistence.saveSessionDrafts({ 'batch-b': 'saved-draft' });
        persistence.saveSessionPermissionModes({ 'batch-b': 'acceptEdits' });
        persistence.saveSessionModelModes({ 'batch-b': 'saved-model' });
        persistence.saveSessionEffortLevels({ 'batch-b': 'high' });
        persistence.saveSessionFastModes({ 'batch-b': true });
        vi.resetModules();
        const { storage: restored } = await import('./storage');
        const row = (id: string) => ({ id, seq: 0, createdAt: 1, updatedAt: 1,
            active: false, activeAt: 1, metadata: null, metadataVersion: 0,
            agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0 });
        restored.getState().applySessions([row('batch-a')]);
        restored.getState().updateSessionDraft('batch-a', 'live-draft');
        restored.getState().applySessions([row('batch-b')]);
        expect(restored.getState().sessions['batch-b']).toMatchObject({
            draft: 'saved-draft', permissionMode: 'acceptEdits', modelMode: 'saved-model', effortLevel: 'high', fastMode: true,
        });
        expect(persistence.loadSessionDrafts()['batch-b']).toBe('saved-draft');
        restored.getState().updateSessionDraft('batch-b', null);
        restored.getState().updateSessionPermissionMode('batch-b', null);
        restored.getState().updateSessionModelMode('batch-b', null);
        restored.getState().updateSessionEffortLevel('batch-b', null);
        restored.getState().resetSessionAgentOverrides('batch-b');
        restored.getState().applySessions([row('batch-b')]);
        expect(restored.getState().sessions['batch-b']).toMatchObject({
            draft: null, permissionMode: null, modelMode: null, effortLevel: null, fastMode: null,
        });
    });

    it('resetting one loaded session preserves unloaded agent overrides', () => {
        persistence.saveSessionPermissionModes({ unloaded: 'acceptEdits' });
        persistence.saveSessionModelModes({ unloaded: 'saved-model' });
        persistence.saveSessionEffortLevels({ unloaded: 'high' });
        persistence.saveSessionFastModes({ unloaded: true });
        storage.getState().applySessions([{ id: 'loaded', seq: 0, createdAt: 1, updatedAt: 1,
            active: false, activeAt: 1, metadata: null, metadataVersion: 0,
            agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0 }]);
        storage.getState().resetSessionAgentOverrides('loaded');
        expect(persistence.loadSessionPermissionModes().unloaded).toBe('acceptEdits');
        expect(persistence.loadSessionModelModes().unloaded).toBe('saved-model');
        expect(persistence.loadSessionEffortLevels().unloaded).toBe('high');
        expect(persistence.loadSessionFastModes().unloaded).toBe(true);
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
