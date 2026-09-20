import './sessionViewPlatform.testSupport';
import { AppState, Platform } from 'react-native';
import { sessionHistoryPageCache } from './sessionHistoryPageCache';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Native update identity has its own tests; these suites do not host Expo modules.
vi.mock('@/sync/nativeUpdate', () => ({ refreshNativeUpdateStatus: vi.fn(async () => ({ status: 'unsupported', available: false })) }));
import type { ApiMessage, ApiSessionSnapshot } from './apiTypes';
import type { HydratedSession } from './sessionSnapshotHydration';
import { SessionMessageLoadGate } from './sessionMessageLoadGate';
import { SessionMessageRetention } from './sessionMessageRetention';
import { SessionRouteAbandonedError, SessionRouteOwnership } from './sessionRouteOwnership';
import { SessionEncryption } from './encryption/sessionEncryption';
import { EncryptionCache } from './encryption/encryptionCache';
import { createReducer } from './reducer/reducer';
import { installPhase2Probe } from './phase2Probe.testSupport';
import { markSessionCriticalPathAppStage } from './sessionCriticalPathProbeBridge';
import { normalizeRawMessage, type RawRecord } from './typesRaw';
import { apiSocket } from './apiSocket';
import { sessionTextStream, useSessionTextPreviews } from './sessionTextStream';
import { clearSessionWarmCache, loadSessionWarmCache, saveSessionWarmLatestPage, saveSessionWarmSnapshots } from './sessionWarmCache';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openLocalHistory, clearLocalHistoryCaches, type HistoryWindow } from './localHistoryStore';
import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no local declarations.
import TestRenderer from 'react-test-renderer';
import { randomUUID } from 'expo-crypto';
import { useSpawnSession } from '@/hooks/useSpawnSession';
import { SessionView } from '@/-session/SessionView';
import { useTranscriptReading } from '@/components/transcriptReading';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';

vi.hoisted(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    (globalThis as unknown as { expo?: { EventEmitter: unknown } }).expo = {
        EventEmitter: EventTarget,
    };
});

const mocks = vi.hoisted(() => {
    const state = {
        sessions: {} as Record<string, HydratedSession>,
        sessionMessages: {} as Record<string, any>,
        currentViewingSessionId: null as string | null,
        settings: { expImageUpload: false },
        mutableToolCalls: new Set<string>(),
        getActiveSessions: () => Object.values(state.sessions).filter((session) => session.active),
        applySessions: (sessions: HydratedSession[], options?: { replace?: boolean }) => {
            if (options?.replace) state.sessions = {};
            for (const session of sessions) state.sessions[session.id] = session;
        },
        applyMessages: (sessionId: string, messages: any[], latestAppliedSeq?: number) => {
            const existing = state.sessionMessages[sessionId] ?? {
                messages: [],
                messagesMap: {},
                reducerState: {},
                isLoaded: false,
                hasMoreOlder: false,
                isLoadingOlder: false,
            };
            const messagesMap = { ...existing.messagesMap };
            for (const message of messages) messagesMap[message.id] = message;
            state.sessionMessages[sessionId] = {
                ...existing,
                messagesMap,
                messages: Object.values(messagesMap),
                isLoaded: true,
                ...(latestAppliedSeq !== undefined ? { latestAppliedSeq: Math.max(existing.latestAppliedSeq ?? 0, latestAppliedSeq) } : {}),
            };
            return {
                changed: messages.map((message) => message.id),
                hasReadyEvent: messages.some((message) => (
                    message.role === 'event' && message.content?.type === 'ready'
                )),
            };
        },
        applyMessagesLoaded: (sessionId: string) => {
            state.sessionMessages[sessionId] = {
                ...(state.sessionMessages[sessionId] ?? {
                    messages: [],
                    messagesMap: {},
                    reducerState: {},
                    hasMoreOlder: false,
                    isLoadingOlder: false,
                }),
                isLoaded: true,
            };
        },
        applyOlderMessagesPagination: (sessionId: string, info: { hasMore: boolean }) => {
            const existing = state.sessionMessages[sessionId];
            if (existing) existing.hasMoreOlder = info.hasMore;
        },
        applyOlderMessagesLoading: (sessionId: string, loading: boolean) => {
            const existing = state.sessionMessages[sessionId];
            if (existing) existing.isLoadingOlder = loading;
        },
        isMutableToolCall: (sessionId: string, callId: string) => (
            state.mutableToolCalls.has(`${sessionId}:${callId}`)
        ),
    };
    const storage = {
        getState: () => realStorage ? realStorage.getState() : state,
        setState: (update: any) => {
            if (realStorage) return realStorage.setState(update);
            const next = typeof update === 'function' ? update(state) : update;
            Object.assign(state, next);
        },
    };
    let realStorage: any = null;
    return {
        useRealStorage: (value: any) => { realStorage = value; },
        hooks: null as any,
        apiRequest: vi.fn(),
        fetchActive: vi.fn(),
        fetchPage: vi.fn(),
        fetchSnapshot: vi.fn(),
        hydrate: vi.fn(),
        hydrateRoute: vi.fn(),
        sessionEncryptions: new Map<string, any>(),
        runtimeEvents: [] as Array<{ stage: string; sessionId?: string }>,
        gitInvalidate: vi.fn(),
        gitOpenInvalidate: vi.fn(),
        gitClear: vi.fn(),
        navigateToSession: vi.fn(),
        machineSpawnNewSession: vi.fn(),
        state,
        storage,
    };
});

vi.mock('./apiSessions', async importOriginal => ({
    ...await importOriginal<typeof import('./apiSessions')>(),
    fetchActiveSessionSnapshots: mocks.fetchActive,
    fetchSessionSnapshot: mocks.fetchSnapshot,
    fetchSessionSnapshotPage: mocks.fetchPage,
}));
vi.mock('./sessionSnapshotHydration', () => ({
    hydrateSessionSnapshotForRoute: mocks.hydrateRoute,
    hydrateSessionSnapshots: mocks.hydrate,
}));
vi.mock('./storage', () => ({ storage: mocks.storage,
    useSession: (id: string) => mocks.hooks ? mocks.hooks.useSession(id) : mocks.storage.getState().sessions[id],
    useSessionMessages: (id: string) => mocks.hooks ? mocks.hooks.useSessionMessages(id) : mocks.storage.getState().sessionMessages[id],
    useIsDataReady: () => true,
    useLocalSetting: (key: string) => key === 'sidebarOrganization' ? { lists: [], tags: [], sessions: {} } : false,
    useLocalSettingMutable: () => [false, vi.fn()],
    useMachine: () => null,
    useSessionUsage: () => undefined,
    useSetting: (key: string) => key === 'sidebarOrganization' ? { lists: [], tags: [], sessions: {} } : false,
    useSettingUpdater: () => vi.fn(),
}));
vi.mock('./apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn(),
        request: mocks.apiRequest,
        sendAppState: vi.fn(),
    },
    getCurrentAppState: vi.fn(() => 'active'),
    getHappyClientId: vi.fn(() => 'test-client'),
}));
vi.mock('./gitStatusSync', () => ({
    gitStatusSync: {
        invalidate: mocks.gitInvalidate,
        getSync: vi.fn(() => ({ invalidate: mocks.gitOpenInvalidate })),
        clearForSession: mocks.gitClear,
    },
}));
vi.mock('./pushRegistration', () => ({ syncCurrentPushToken: vi.fn() }));
vi.mock('./sessionStartupTraceRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./sessionStartupTraceRuntime')>();
    return {
        ...actual,
        sessionStartupTraceRuntime: actual.createWebStartupTraceRuntime((event) => {
            const recorded = event as { stage: string; sessionId?: string };
            mocks.runtimeEvents.push(recorded);
            if (recorded.stage.startsWith('web.')) markSessionCriticalPathAppStage(recorded.stage as any);
        }),
    };
});
vi.mock('./encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('./revenueCat', () => ({ RevenueCat: {}, LogLevel: {}, PaywallResult: {} }));
vi.mock('./uploadMediaFile', () => ({ uploadMediaFile: vi.fn() }));
vi.mock('./uploadAttachmentForSession', () => ({ uploadAttachmentForSession: vi.fn() }));
vi.mock('./apiAttachments', () => ({ requestAttachmentUpload: vi.fn(), uploadEncryptedBlob: vi.fn() }));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: vi.fn() }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/config', () => ({ config: {} }));
vi.mock('@/track', () => ({
    initializeTracking: vi.fn(),
    trackGitHubConnected: vi.fn(),
    trackMessageSent: vi.fn(),
    tracking: null,
    trackPaywallCancelled: vi.fn(),
    trackPaywallError: vi.fn(),
    trackPaywallPresented: vi.fn(),
    trackPaywallPurchased: vi.fn(),
    trackPaywallRestored: vi.fn(),
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/sync/ops', () => ({ machineSpawnNewSession: mocks.machineSpawnNewSession }));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => mocks.navigateToSession }));
vi.mock('@/realtime/hooks/voiceHooks', () => ({
    voiceHooks: {
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onPermissionRequested: vi.fn(),
        onMessages: vi.fn(),
        onReady: vi.fn(),
        onSessionFocus: vi.fn(),
    },
}));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionQuickActions: () => ({}) }));
vi.mock('@/components/ChatFooter', () => ({ ChatFooter: 'ChatFooter' }));
vi.mock('@/hooks/useGroupedMessages', () => ({
    useGroupedMessages: (messages: any[]) => messages.map(message => ({ type: 'message', id: message.id, message })),
    isSessionTurnActive: () => false,
}));
vi.mock('@/utils/messageForkPoint', () => ({ getAgentMessageForkTargets: () => new Map() }));
vi.mock('@/modal/components/BaseModal', () => ({ BaseModal: 'BaseModal' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/MessageView', () => ({ MessageView: 'MessageView' }));
vi.mock('@/components/ToolGroupView', () => ({ AgentWorkGroupView: 'AgentWorkGroupView', ToolGroupView: 'ToolGroupView' }));
vi.mock('@/components/AttachmentGalleryView', () => ({ AttachmentGalleryView: 'AttachmentGalleryView' }));
vi.mock('@/components/haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('expo-notifications', () => ({}));
vi.mock('expo', () => ({}));
vi.mock('expo-modules-core', () => ({ Platform: { OS: 'web' }, requireNativeModule: () => ({}), requireOptionalNativeModule: () => ({}) }));
vi.mock('@/realtime/RealtimeSession', () => ({ getCurrentRealtimeSessionId: () => null, getVoiceSession: () => null }));
vi.mock('@/components/tools/knownTools', () => ({ isMutableTool: () => false }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn(() => 'test-uuid') }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
}));

import { sync } from './sync';
import { sessionStartupTraceRuntime } from './sessionStartupTraceRuntime';

const syncForTest = sync as any;
const appStateChange = vi.mocked(AppState.addEventListener).mock.calls.find(([event]) => event === 'change')![1];

function snapshot(id: string, seq = 3): ApiSessionSnapshot {
    return {
        id,
        seq,
        metadata: `metadata-${id}`,
        metadataVersion: seq,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: `key-${id}`,
        active: true,
        activeAt: seq * 10,
        createdAt: 10,
        updatedAt: seq * 10,
    };
}

function hydrated(raw: ApiSessionSnapshot): HydratedSession {
    return {
        ...raw,
        metadata: { path: `/${raw.id}`, host: 'test', name: raw.metadata } as any,
        agentState: null,
        thinking: false,
        thinkingAt: 0,
    };
}

function response(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return { promise, resolve, reject };
}

function rawText(text: string) {
    return { role: 'user', content: { type: 'text', text } } as const;
}

// These fixtures model already rendered history, not an ACK-only receipt.
// Keep its applied baseline explicit now that receipt and projection diverge.
function seedProjectedFrontier(sessionId: string, frontier: { latestSeq: number; olderBeforeSeq: number | null; hasMoreOlder: boolean }, isLoaded = true) {
    syncForTest.sessionMessageFrontiers.set(sessionId, frontier);
    mocks.storage.setState((state: any) => ({ sessionMessages: { ...state.sessionMessages,
        [sessionId]: { messages: [], messagesMap: {}, reducerState: createReducer(), isLoaded,
            hasMoreOlder: frontier.hasMoreOlder, isLoadingOlder: false, ...state.sessionMessages[sessionId],
            latestAppliedSeq: frontier.latestSeq },
    } }));
}

function rawToolResult(uuid: string) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'user',
                uuid,
                message: {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }],
                },
            },
        },
    } as const;
}

function apiMessage(seq: number, content: unknown = 'ciphertext'): ApiMessage {
    return {
        id: `message-${seq}`,
        seq,
        localId: null,
        content: { t: 'encrypted', c: String(content) },
        createdAt: seq * 10,
        updatedAt: seq * 10,
    };
}

function newMessageUpdate(sessionId: string, seq: number) {
    return {
        id: `update-${sessionId}-${seq}`,
        seq,
        createdAt: seq * 10,
        body: {
            t: 'new-message',
            sid: sessionId,
            message: apiMessage(seq),
        },
    };
}

function installSession(sessionId: string, decryptMessages?: (messages: ApiMessage[]) => Promise<any[]>) {
    mocks.state.sessions[sessionId] = hydrated(snapshot(sessionId));
    const encryption: any = {
        createDetached() { return this; },
        decryptMessage: vi.fn(async (message: ApiMessage) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: rawText(`realtime-${message.seq}`),
        })),
        decryptMessages: vi.fn(decryptMessages ?? (async (messages: ApiMessage[]) => messages.map((message) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: rawText(`fetched-${message.seq}`),
        })))),
        decryptAgentState: vi.fn(async () => ({ controlledByUser: false, requests: {} })),
        decryptMetadata: vi.fn(async () => ({ name: sessionId })),
    };
    mocks.sessionEncryptions.set(sessionId, encryption);
    return encryption;
}

const loadRealMessageModules = () => Promise.all([
        vi.importActual<typeof import('./storage')>('./storage'),
        vi.importActual<typeof import('./encryption/encryption')>('./encryption/encryption'),
    ]);
let realMessageModules: Awaited<ReturnType<typeof loadRealMessageModules>>;
// Module transformation belongs to suite setup, not a 5s test body. A timed-out
// dynamic import previously resumed in the next case and switched its singleton
// storage/encryption owner, making an unrelated socket test observe no session.
beforeAll(async () => { realMessageModules = await loadRealMessageModules(); }, 30000);
async function useRealMessageComposition() {
    const [{ storage }, { Encryption }] = realMessageModules;
    storage.setState({ sessions: {}, sessionMessages: {}, currentViewingSessionId: null });
    mocks.useRealStorage(storage);
    mocks.hooks = realMessageModules[0];
    // Initialize the real manager's runtime caches without deriving device keys.
    // SessionEncryption below holds only the byte crypto boundary for interleaving.
    syncForTest.encryption = Object.assign(Object.create(Encryption.prototype), {
        sessionEncryptions: mocks.sessionEncryptions,
        sessionBlobKeys: new Map(),
        cache: new EncryptionCache(),
    });
    return storage;
}

async function seedDisconnectedMessageRanges(cachedMax = 100) {
    // These cases exercise the native warm-cache frontier implementation.
    // Web now uses the bounded wire window even when IndexedDB is unavailable.
    Platform.OS = 'android';
    const storage = await useRealMessageComposition();
    storage.getState().applySessions([hydrated(snapshot('range-session', 250))]);
    mocks.sessionEncryptions.set('range-session', new SessionEncryption('range-session', {
        encrypt: async () => [],
        decrypt: async (bytes) => bytes.map(value => rawText(`message-${value[0]}`)),
    }, new EncryptionCache()));
    const page = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => ({
        ...apiMessage(min + i),
        content: { t: 'encrypted' as const, c: Buffer.from([min + i]).toString('base64') },
    }));
    const lease = syncForTest.sessionMessageLoadGate.enter('range-session');
    await syncForTest.applyLatestMessagePage('range-session', { messages: page(1, cachedMax), hasMore: false },
        syncForTest.sessionMessageLoadGate.begin(lease));
    await syncForTest.applyLatestMessagePage('range-session', { messages: page(151, 250), hasMore: true },
        syncForTest.sessionMessageLoadGate.begin(lease));
    return { storage, page, lease };
}

async function seedLocalProjectionSession() {
    const storage = await useRealMessageComposition();
    storage.getState().applySessions([hydrated(snapshot('spawned-session'))]);
    mocks.sessionEncryptions.set('spawned-session', new SessionEncryption('spawned-session', {
        encrypt: async (records) => records.map(record => new TextEncoder().encode(JSON.stringify(record))),
        decrypt: async (bytes) => bytes.map(value => value[0] === 123
            ? JSON.parse(new TextDecoder().decode(value)) : rawText('hello')),
    }, new EncryptionCache()));
    // Sending is external to the projection contract; retain the real encrypted outbox.
    syncForTest.sendSync.set('spawned-session', { invalidate: vi.fn() });
    return storage;
}

async function localHistoryViewHarness(options: { historical?: boolean; holdLocalApply?: boolean } = {}) {
    globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
    const storage = await useRealMessageComposition();
    storage.getState().applySessions([hydrated(snapshot('paint-history', 40))]);
    const history = (await openLocalHistory('paint-server|paint-account'))!;
    syncForTest.localHistory = history;
    const page = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => ({
        ...apiMessage(min + i), content: { t: 'encrypted' as const,
            c: Buffer.from(JSON.stringify(rawText(`message-${min + i}`))).toString('base64') },
    }));
    const localApply = deferred<void>();
    let localApplyStarted = false;
    mocks.sessionEncryptions.set('paint-history', new SessionEncryption('paint-history', {
        encrypt: async () => [],
        decrypt: async bytes => {
            if (options.holdLocalApply && !localApplyStarted) {
                localApplyStarted = true;
                await localApply.promise;
            }
            return bytes.map(value => JSON.parse(new TextDecoder().decode(value)));
        },
    }, new EncryptionCache()));
    await history.commitPage('paint-history', { direction: 'older', boundary: 2147483647,
        messages: options.historical ? page(1, 400) : page(40, 40), hasMore: false });
    const reading = { version: 1 as const, anchorId: 'message-150', anchorSeq: 150, offset: 12, expandedGroupIds: [] };
    if (options.historical) await history.writeReadingState('paint-history', reading);
    else await history.commitReconciliation({ changes: [{ sessionId: 'paint-history', revision: '1', deleted: false,
        lastMessageSeq: 42, metadataVersion: 0, agentStateVersion: 0 }], nextCursor: '1' });
    const probe = installPhase2Probe('deep-link', { mountsRoute: true });
    const marker = vi.fn(probe.markFreshLatestMessageComplete);
    (globalThis as any).__happySessionCriticalPathProbe = { ...probe, markFreshLatestMessageComplete: marker };
    const frames = new Map<number, FrameRequestCallback>();
    let frame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frame, callback); return frame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const open = vi.spyOn(sync, 'openSession');
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SessionView, { id: 'paint-history' })); });
    const opening = open.mock.results[0].value;
    return {
        storage, history, page, marker, probe, renderer, opening, reading, localApply, open,
        localApplyStarted: () => localApplyStarted,
        paint: async () => {
            // Release the production Deferred timer, then its real marker frame.
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
            await act(async () => {
                const callbacks = [...frames.values()]; frames.clear();
                callbacks.forEach(callback => callback(0));
            });
        },
        close: () => {
            act(() => renderer.unmount()); open.mockRestore();
            delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
        },
    };
}

describe('message visibility synchronization', () => {
    it.each(['projection', 'historical-receipt', 'native-compaction-receipt'] as const)('renders socket text previews and retires them on %s', async completion => {
        const id = 'live-preview';
        const encryption = { decryptRaw: async () => ({ type: 'text-delta', turnId: 'turn', itemId: 'item', delta: 'Hello', text: 'Hello' }) };
        mocks.sessionEncryptions.set(id, encryption);
        mocks.state.sessions[id] = hydrated(snapshot(id));
        const owner = sync.beginSessionRoute(id);
        sync.promoteSessionRoute(owner);
        syncForTest.subscribeToUpdates();
        const receive = vi.mocked(apiSocket.onMessage).mock.calls.find(([event]) => event === 'session-stream')?.[1];
        expect(typeof receive).toBe('function');
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        function PreviewProbe() { return JSON.stringify(useSessionTextPreviews(id).map(p => p.text)); }
        let view: any;
        const cleanups: Array<() => void> = [];
        try {
            await act(async () => { view = TestRenderer.create(React.createElement(PreviewProbe)); });
            await act(async () => { await receive!({ sid: id, content: { t: 'encrypted', c: 'cipher' } }); });
            expect(view.toJSON()).toBe('["Hello"]');
            const raw = { role: 'session', content: { type: 'session', data: {
                id: 'final', role: 'agent', time: 100, turn: 'turn', codexItemId: 'item', ev: { t: 'text', text: 'Hello final' },
            } } } as RawRecord;
            if (completion === 'projection') {
                const message = normalizeRawMessage('wire', null, 100, raw)!;
                await act(async () => { syncForTest.applyMessages(id, [message]); });
            } else {
                Object.assign(encryption, { createDetached: () => ({ decryptMessage: async () => ({
                    id: 'wire', localId: null, createdAt: 100, content: raw,
                }) }) });
                if (completion === 'native-compaction-receipt') {
                    Platform.OS = 'android';
                    const bounded = { messages: [apiMessage(1)], oldestSeq: 1, newestSeq: 1, isAtLatest: false };
                    const ownerSpy = vi.spyOn(syncForTest, 'captureHistoryOwner').mockReturnValue({
                        isCurrent: () => true,
                        history: { appendMessages: async () => true,
                            readWindow: async (_sid: string, options: { anchorSeq?: number }) => options.anchorSeq ? bounded : {
                                messages: Array.from({ length: 300 }, (_, i) => apiMessage(i + 2)), oldestSeq: 2,
                                newestSeq: 301, isAtLatest: true,
                            }, readReadingState: async () => ({ anchorSeq: 1 }) },
                    });
                    const projectionSpy = vi.spyOn(syncForTest, 'applyHistoryWindow').mockImplementation(async () => {
                        mocks.state.sessionMessages[id] = { messages: [], isAtLatest: false };
                        return true;
                    });
                    cleanups.push(() => ownerSpy.mockRestore(), () => projectionSpy.mockRestore());
                    syncForTest.historyWindows.set(id, { messages: Array.from({ length: 300 }, (_, i) => apiMessage(i + 1)),
                        oldestSeq: 1, newestSeq: 300, isAtLatest: true });
                    seedProjectedFrontier(id, { latestSeq: 300, olderBeforeSeq: null, hasMoreOlder: false });
                    syncForTest.sessionMessageLoadGate.enter(id);
                    await act(async () => { await syncForTest.handleUpdate(newMessageUpdate(id, 301)); });
                    expect(projectionSpy).toHaveBeenCalledWith(id, bounded, expect.anything());
                } else {
                    syncForTest.historyWindows.set(id, { messages: [], isAtLatest: false });
                    mocks.state.sessionMessages[id] = { messages: [], isAtLatest: false };
                    await act(async () => { await syncForTest.handleUpdate(newMessageUpdate(id, 100)); });
                }
                // Receipt must retire previews even though no latest projection is applied.
                expect(mocks.state.sessionMessages[id].isAtLatest).toBe(false);
            }
            expect(view.toJSON()).toBe('[]');
            await act(async () => { await receive!({ sid: id, content: { t: 'encrypted', c: 'late' } }); });
            expect(view.toJSON()).toBe('[]');
        } finally {
            cleanups.forEach(cleanup => cleanup());
            act(() => { view?.unmount(); sync.leaveSessionRoute(owner); sessionTextStream.activate(null); });
            delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
        }
    });
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        mocks.useRealStorage(null);
        mocks.hooks = null;
        syncForTest.sessionEventCursors.clear();
        syncForTest.sessionHydrations.clear();
        syncForTest.inFlightSessionRefreshes.clear();
        syncForTest.sessionDeletionMutationGenerations.clear();
        vi.clearAllMocks();
        const originalConsoleError = console.error;
        consoleError = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
        mocks.state.sessions = {};
        mocks.state.sessionMessages = {};
        mocks.state.currentViewingSessionId = null;
        mocks.state.mutableToolCalls.clear();
        mocks.sessionEncryptions.clear();
        mocks.runtimeEvents = [];
        mocks.apiRequest.mockReset().mockResolvedValue(response({ messages: [], hasMore: false }));
        mocks.fetchSnapshot.mockResolvedValue(null);
        mocks.fetchPage.mockResolvedValue({ sessions: [], hasNext: false, nextCursor: null });
        mocks.hydrate.mockImplementation(async (items: ApiSessionSnapshot[]) => items.map(hydrated));
        mocks.hydrateRoute.mockImplementation(async (raw: ApiSessionSnapshot) => ({
            session: hydrated(raw),
            commitEncryption: () => true,
        }));
        syncForTest.credentials = { token: 'test-token', secret: 'test-secret' };
        syncForTest.encryption = {
            getSessionEncryption: vi.fn((id: string) => mocks.sessionEncryptions.get(id) ?? null),
            removeSessionEncryption: vi.fn(),
        };
        syncForTest.messagesSync = new Map();
        syncForTest.sessionMessageFrontiers = new Map();
        syncForTest.sessionCachedMessageSeqs = new Map();
        syncForTest.sessionMessageLocks = new Map();
        syncForTest.sessionMessageQueue = new Map();
        syncForTest.sessionQueueProcessing = new Map();
        syncForTest.sessionOlderLoadingTokens = new Map();
        syncForTest.sessionMessageCacheGenerations = new Map();
        syncForTest.acceptedLocalMessageReceipts = new Map();
        syncForTest.observedLocalMessageIds = new Map();
        syncForTest.sessionMessageLoadGate = new SessionMessageLoadGate();
        syncForTest.sessionMessageRetention = new SessionMessageRetention(3);
        syncForTest.activeOpenSession = null;
        syncForTest.sessionRouteOwnership = new SessionRouteOwnership();
        syncForTest.sessionWarmCacheAccountKey = null;
        syncForTest.localHistory = null;
        syncForTest.historyWindows = new Map();
        syncForTest.historyWindowLoads = new Map();
        syncForTest.historyBoundaryLoadingTokens = new Map();
        syncForTest.pendingHistoryTargets = new Map();
        syncForTest.changesInFlight = null;
        syncForTest.changesSupported = null;
        syncForTest.pendingOutbox = new Map();
        syncForTest.sendSync = new Map();
    });

    afterEach(() => {
        syncForTest.historyPrefetch.stop();
        Platform.OS = 'web';
        consoleError.mockRestore();
        vi.unstubAllGlobals();
        syncForTest.localHistory?.close();
        syncForTest.localHistory = null;
        clearSessionWarmCache();
        syncForTest.serverID = undefined;
        syncForTest.sessionWarmCacheAccountKey = null;
        delete (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe;
        mocks.useRealStorage(null);
        for (const messageSync of syncForTest.messagesSync.values()) {
            messageSync.stop();
        }
    });

    it.each(['web', 'ios', 'android'] as const)('archives history after opening on %s without changing the visible transcript', async platform => {
        Platform.OS = platform;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const deferredWork = vi.spyOn(syncForTest, 'releaseDeferredSessionWork').mockImplementation(() => undefined);
        syncForTest.appState = 'active';
        installSession('prefetch');
        mocks.state.currentViewingSessionId = 'prefetch';
        if (platform === 'web') {
            globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
            syncForTest.localHistory = await openLocalHistory('prefetch-scope');
        } else syncForTest.sessionWarmCacheAccountKey = 'prefetch-account';
        mocks.apiRequest
            .mockResolvedValueOnce(response({ messages: [apiMessage(201), apiMessage(202)], hasMore: true }))
            .mockImplementationOnce(async () => {
                if (platform === 'android') sessionHistoryPageCache.remove('prefetch-account', 'unrelated');
                return response({ messages: [apiMessage(101), apiMessage(200)], hasMore: true });
            })
            .mockResolvedValueOnce(response({ messages: [apiMessage(1), apiMessage(100)], hasMore: false }));
        const owner = sync.beginSessionRoute('prefetch');
        try {
            await expect(sync.openSession('prefetch', owner)).resolves.toBe('ready');
            const visible = mocks.state.sessionMessages.prefetch;
            const reading = { version: 1 as const, anchorId: 'message-201', anchorSeq: 201, offset: 12, expandedGroupIds: [] };
            await sync.saveSessionReadingState('prefetch', reading);
            sync.promoteSessionRoute(owner);
            await vi.waitFor(async () => {
                const cached = platform === 'web'
                    ? await syncForTest.localHistory.readOlderPage('prefetch', 101)
                    : sessionHistoryPageCache.readOlder('prefetch-account', 'prefetch', 101);
                expect(cached?.messages.map((message: ApiMessage) => message.seq)).toEqual([1, 100]);
            }, { timeout: 4500, interval: 100 });
            expect(mocks.state.sessionMessages.prefetch.messages).toBe(visible.messages);
            if (platform === 'web') expect(await sync.readSessionReadingState('prefetch')).toEqual(reading);
            expect(mocks.apiRequest).toHaveBeenCalledTimes(3);
            await sync.loadOlderMessages('prefetch');
            expect(mocks.apiRequest).toHaveBeenCalledTimes(3);
        } finally {
            sync.leaveSessionRoute(owner);
            await Promise.resolve();
            deferredWork.mockRestore();
            vi.useRealTimers();
        }
    });

    it.each([
        ['web', 'scroll'], ['android', 'scroll'],
        ['web', 'leave'], ['android', 'leave'],
        ['web', 'background'], ['android', 'background'],
        ['web', 'reset'], ['android', 'reset'],
        ['web', 'account'], ['android', 'account'],
    ] as const)('coordinates a pending background page with %s %s', async (platform, action) => {
        Platform.OS = platform;
        syncForTest.appState = 'active';
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const deferredWork = vi.spyOn(syncForTest, 'releaseDeferredSessionWork').mockImplementation(() => undefined);
        installSession('pending-prefetch');
        if (platform === 'web') {
            globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
            syncForTest.localHistory = await openLocalHistory('pending-prefetch-scope');
        } else syncForTest.sessionWarmCacheAccountKey = 'pending-prefetch-account';
        const history = syncForTest.localHistory;
        const held = deferred<Response>();
        let signal: AbortSignal | undefined;
        mocks.apiRequest
            .mockResolvedValueOnce(response({ messages: [apiMessage(201), apiMessage(202)], hasMore: true }))
            .mockImplementationOnce((_url: string, options: RequestInit) => { signal = options.signal!; return held.promise; });
        const owner = sync.beginSessionRoute('pending-prefetch');
        try {
            await sync.openSession('pending-prefetch', owner);
            sync.promoteSessionRoute(owner);
            await vi.waitFor(() => expect(signal).toBeDefined(), { timeout: 3500, interval: 100 });
            let foreground: Promise<void> | undefined;
            if (action === 'scroll') foreground = sync.loadOlderMessages('pending-prefetch');
            if (action === 'leave') sync.leaveSessionRoute(owner);
            if (action === 'background') appStateChange('background');
            if (action === 'reset') await sync.resetLocalHistory();
            if (action === 'account') {
                syncForTest.sessionWarmCacheAccountKey = 'other-account';
                await syncForTest.initializeLocalHistory();
            }
            if (action !== 'scroll') expect(signal!.aborted).toBe(true);
            held.resolve(response({ messages: [apiMessage(1), apiMessage(200)], hasMore: false }));
            await foreground;
            await vi.advanceTimersByTimeAsync(1000);
            const cached = platform === 'web' ? await history.readOlderPage('pending-prefetch', 201)
                : sessionHistoryPageCache.readOlder('pending-prefetch-account', 'pending-prefetch', 201);
            expect(cached?.messages.map((message: ApiMessage) => message.seq) ?? null)
                .toEqual(action === 'scroll' ? [1, 200] : null);
            expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
        } finally {
            sync.leaveSessionRoute(owner);
            await Promise.resolve();
            deferredWork.mockRestore();
            syncForTest.appState = 'active';
            vi.useRealTimers();
        }
    });

    it('renders anchored local history through Deferred without a verified-latest marker', async () => {
        const view = await localHistoryViewHarness({ historical: true });
        try {
            await act(async () => { await expect(view.opening).resolves.toBe('ready'); });
            await view.paint();
            expect(view.renderer.root.findAllByType('FlatList')).toHaveLength(1);
            expect(view.renderer.root.findByType('FlatList').props.data).toContainEqual(expect.objectContaining({
                message: expect.objectContaining({ kind: 'user-text', text: 'message-150' }),
            }));
            expect(view.storage.getState().sessionMessages['paint-history']).toMatchObject({
                isAtLatest: false, latestVerifiedOwnerEpoch: null,
            });
            expect(view.storage.getState().sessionMessages['paint-history'].messages.some(message =>
                message.kind === 'user-text' && message.text === 'message-150')).toBe(true);
            expect(await view.history.readReadingState('paint-history')).toEqual(view.reading);
            expect(view.marker).not.toHaveBeenCalled();
            expect(mocks.apiRequest).not.toHaveBeenCalled();
        } finally { view.close(); }
    });

    it('updates the retained Deferred consumer only after failed stale-tail verification is retried and committed', async () => {
        const tail = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(tail.promise);
        const view = await localHistoryViewHarness();
        try {
            await act(async () => { await expect(view.opening).resolves.toBe('ready'); });
            await view.paint();
            await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledWith('/v3/sessions/paint-history/messages?after_seq=40&limit=100'));
            const chat = view.renderer.root.findByType('FlatList');
            expect(chat.props.data).toContainEqual(expect.objectContaining({
                message: expect.objectContaining({ kind: 'user-text', text: 'message-40' }),
            }));
            expect(view.storage.getState().sessionMessages['paint-history'].latestVerifiedOwnerEpoch).toBeNull();
            expect(view.storage.getState().sessionMessages['paint-history'].messages).toContainEqual(expect.objectContaining({ text: 'message-40' }));
            expect(view.marker).not.toHaveBeenCalled();
            await act(async () => {
                const pending = syncForTest.historyWindowLoads.get('paint-history');
                tail.resolve(response({}, 503)); await pending;
            });
            await view.paint();
            expect(view.renderer.root.findByType('FlatList')).toBe(chat);
            expect(view.marker).not.toHaveBeenCalled();
            expect(view.storage.getState().sessionMessages['paint-history'].latestVerifiedOwnerEpoch).toBeNull();
            mocks.apiRequest.mockResolvedValueOnce(response({ messages: view.page(41, 42), hasMore: false }));
            await act(async () => { await sync.jumpToLatestMessages('paint-history'); });
            expect(view.storage.getState().sessionMessages['paint-history']).toMatchObject({
                isAtLatest: true, latestVerifiedOwnerEpoch: syncForTest.activeOpenSession.owner.ownerEpoch,
            });
            await view.paint(); await view.paint();
            expect(view.renderer.root.findByType('FlatList')).toBe(chat);
            expect(view.marker).toHaveBeenCalledTimes(1);
            expect(view.open).toHaveBeenCalledTimes(1);
            expect(view.probe.collect().samples).toHaveLength(1);
        } finally { tail.resolve(response({}, 503)); view.close(); }
    });

    it.each(['latest', 'stale', 'historical', 'abandoned'] as const)('rejects a superseded local apply at the real paint boundary (winner: %s)', async winner => {
        const view = await localHistoryViewHarness({ holdLocalApply: true, historical: winner === 'historical' });
        const tail = deferred<Response>();
        try {
            await vi.waitFor(() => expect(view.localApplyStarted()).toBe(true));
            mocks.apiRequest.mockReturnValueOnce(tail.promise);
            let catchingUp!: Promise<void>;
            if (winner === 'historical') {
                const window = await view.history.readWindow('paint-history', { anchorSeq: 150 });
                const lease = syncForTest.sessionMessageLoadGate.currentLease('paint-history');
                await act(async () => {
                    catchingUp = syncForTest.applyHistoryWindow('paint-history', window, syncForTest.sessionMessageLoadGate.begin(lease));
                    await catchingUp;
                });
            } else {
                await act(async () => { catchingUp = sync.jumpToLatestMessages('paint-history'); });
                await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
            }
            if (winner === 'stale') await view.history.commitReconciliation({ changes: [{
                sessionId: 'paint-history', revision: '2', deleted: false, lastMessageSeq: 45,
                metadataVersion: 0, agentStateVersion: 0,
            }], nextCursor: '2' });
            if (winner === 'abandoned') sync.leaveSessionRoute(syncForTest.activeOpenSession.owner);
            await act(async () => {
                tail.resolve(response({ messages: view.page(41, 42), hasMore: false })); await catchingUp;
            });
            await view.paint();
            expect(view.marker).not.toHaveBeenCalled();
            const winningCache = view.storage.getState().sessionMessages['paint-history'];
            await act(async () => {
                view.localApply.resolve();
                if (winner === 'abandoned') await expect(view.opening).rejects.toThrow('abandoned');
                else await expect(view.opening).resolves.toBe('ready');
            });
            await view.paint(); await view.paint();
            if (winner !== 'abandoned') {
                expect(view.storage.getState().sessionMessages['paint-history'].messages).toContainEqual(expect.objectContaining({
                    text: winner === 'historical' ? 'message-150' : 'message-42',
                }));
            }
            expect(view.marker).toHaveBeenCalledTimes(winner === 'latest' ? 1 : 0);
            if (winner === 'stale') expect(winningCache.latestVerifiedOwnerEpoch).toBeNull();
            if (winner === 'historical') expect(await view.history.readReadingState('paint-history')).toEqual(view.reading);
        } finally { tail.resolve(response({}, 503)); view.localApply.resolve(); view.close(); }
    });

    it('restores an archived reading window and navigates cached history with zero body requests', async () => {
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = IDBKeyRange;
        installSession('archive');
        const history = await openLocalHistory('server|account');
        await history!.commitPage('archive', { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 400 }, (_, i) => apiMessage(i + 1)), hasMore: false });
        await history!.writeReadingState('archive', { version: 1, anchorId: 'message-150',
            anchorSeq: 150, offset: 12, expandedGroupIds: [] });
        syncForTest.localHistory = history;
        await expect(syncForTest.openSession('archive')).resolves.toBe('ready');
        expect(mocks.state.sessionMessages.archive.isAtLatest).toBe(false);
        expect(mocks.state.sessionMessages.archive.messages.length).toBeLessThanOrEqual(300);
        await syncForTest.loadNewerMessages('archive');
        await syncForTest.jumpToLatestMessages('archive');
        expect(mocks.state.sessionMessages.archive.isAtLatest).toBe(true);
        await syncForTest.loadOlderMessages('archive');
        expect(mocks.apiRequest).not.toHaveBeenCalled();
        expect(mocks.state.sessionMessages.archive.messages.length).toBeGreaterThan(300);
        expect(mocks.state.sessionMessages.archive.messages.length).toBeLessThanOrEqual(500);
    }, 20000);

    it('bounds a large Web projection and keeps both evicted boundaries reloadable', async () => {
        Platform.OS = 'web';
        installSession('bounded-web');
        const lease = syncForTest.sessionMessageLoadGate.enter('bounded-web');
        await syncForTest.applyHistoryWindow('bounded-web', {
            messages: Array.from({ length: 2000 }, (_, i) => apiMessage(i + 1)),
            oldestSeq: 1, newestSeq: 2000, hasMoreOlder: false, hasMoreNewer: false, isAtLatest: true,
        }, syncForTest.sessionMessageLoadGate.begin(lease));
        const window = syncForTest.historyWindows.get('bounded-web');
        expect(window.messages).toHaveLength(500);
        expect(window).toMatchObject({ oldestSeq: 1501, newestSeq: 2000, hasMoreOlder: true, hasMoreNewer: false, isAtLatest: true });
        expect(mocks.state.sessionMessages['bounded-web'].messages).toHaveLength(500);
    });

    it('bounds Web history without IndexedDB and reloads evicted newer rows from the server', async () => {
        Platform.OS = 'web'; installSession('web-memory-only');
        syncForTest.localHistory = null;
        const lease = syncForTest.sessionMessageLoadGate.enter('web-memory-only');
        await syncForTest.applyLatestMessagePage('web-memory-only', {
            messages: Array.from({ length: 600 }, (_, i) => apiMessage(i + 1)), hasMore: false,
        }, syncForTest.sessionMessageLoadGate.begin(lease));
        expect(syncForTest.historyWindows.get('web-memory-only')?.messages.length).toBeLessThanOrEqual(500);
        mocks.apiRequest.mockImplementation(async (url: string) => {
            const query = new URL(url, 'https://example.com').searchParams;
            const before = Number(query.get('before_seq'));
            const after = Number(query.get('after_seq'));
            const start = before ? Math.max(1, before - 100) : after + 1;
            const end = before ? before - 1 : Math.min(600, after + 100);
            return response({ messages: Array.from({ length: end - start + 1 }, (_, i) => apiMessage(start + i)),
                hasMore: before ? start > 1 : end < 600 });
        });
        for (let page = 0; page < 6 && syncForTest.historyWindows.get('web-memory-only').hasMoreOlder; page++) {
            await syncForTest.loadOlderMessages('web-memory-only');
        }
        expect(syncForTest.historyWindows.get('web-memory-only')).toMatchObject({ oldestSeq: 1, hasMoreNewer: true });
        for (let page = 0; page < 6 && syncForTest.historyWindows.get('web-memory-only').hasMoreNewer; page++) {
            await syncForTest.loadNewerMessages('web-memory-only');
        }
        expect(syncForTest.historyWindows.get('web-memory-only')).toMatchObject({ newestSeq: 600, isAtLatest: true });
        expect(mocks.state.sessionMessages['web-memory-only'].messages.length).toBeLessThanOrEqual(500);
    });

    it.each([false, true])('preserves the reading anchor during live compaction without IndexedDB and clears it on release (modern: %s)', async modern => {
        Platform.OS = 'web';
        const decrypt = async (rows: ApiMessage[]) => rows.map(row => ({ ...row, content: modern ? {
            role: 'session', content: { type: 'session', data: { id: `envelope-${row.seq}`, time: row.createdAt,
                role: 'user', ev: { t: 'text', text: `modern-${row.seq}` } } },
        } : rawText(`fetched-${row.seq}`) }));
        const encryption = installSession('web-memory-anchor', decrypt);
        encryption.decryptMessage.mockImplementation(async (row: ApiMessage) => (await decrypt([row]))[0]);
        syncForTest.localHistory = null;
        const lease = syncForTest.sessionMessageLoadGate.enter('web-memory-anchor');
        await syncForTest.applyLatestMessagePage('web-memory-anchor', {
            messages: Array.from({ length: 500 }, (_, i) => apiMessage(i + 1)), hasMore: false,
        }, syncForTest.sessionMessageLoadGate.begin(lease));
        const rendered = mocks.state.sessionMessages['web-memory-anchor'].messages.find((row: any) => row.text === (modern ? 'modern-20' : 'fetched-20'));
        expect(rendered).toBeDefined();
        expect(sync.getMessageWireId('web-memory-anchor', rendered.id)).toBe('message-20');
        expect(sync.getMessageWireSeq('web-memory-anchor', rendered.id)).toBe(20);
        expect(sync.resolveRenderedMessageId('web-memory-anchor', 'message-20')).toBe(rendered.id);
        const adapter = { key: 'web-memory-anchor', read: () => sync.readSessionReadingState('web-memory-anchor'),
            save: (state: any) => sync.saveSessionReadingState('web-memory-anchor', state),
            wireId: (id: string) => sync.getMessageWireId('web-memory-anchor', id),
            wireSeq: (id: string) => sync.getMessageWireSeq('web-memory-anchor', id) };
        let reading: ReturnType<typeof useTranscriptReading>;
        function ReadingProbe() {
            reading = useTranscriptReading({ adapter, items: [], inverted: false, isAtLatest: true,
                listRef: { current: null }, viewportRef: { current: { measureInWindow: (cb: any) => cb(0, 100, 800, 600) } },
                expanded: [], restoreExpanded: () => {} });
            return null;
        }
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(React.createElement(ReadingProbe)); });
        reading!.markers!.register(rendered.id, { measureInWindow: (cb: any) => cb(0, 85, 800, 200) }, 0);
        reading!.cancelRestore('older');
        await reading!.capture();
        expect(await adapter.read()).toMatchObject({ anchorId: 'message-20', anchorSeq: 20, offset: -15, followLatest: false });
        act(() => renderer.unmount());
        await syncForTest.handleUpdate(newMessageUpdate('web-memory-anchor', 501));
        const anchored = syncForTest.historyWindows.get('web-memory-anchor');
        expect(anchored.messages.some((message: ApiMessage) => message.seq === 20)).toBe(true);
        expect(anchored).toMatchObject({ hasMoreNewer: true, isAtLatest: false });
        const replayed = sync.resolveRenderedMessageId('web-memory-anchor', 'message-20');
        expect(replayed).not.toBeNull();
        expect(sync.getMessageWireSeq('web-memory-anchor', replayed!)).toBe(20);
        await syncForTest.handleUpdate(newMessageUpdate('web-memory-anchor', 502));
        expect(syncForTest.historyWindows.get('web-memory-anchor')).toBe(anchored);
        syncForTest.releaseSessionMessageCache('web-memory-anchor');
        expect(await sync.readSessionReadingState('web-memory-anchor')).toBeNull();
    });

    it('bounds thousands of consecutive live rows without replaying each append', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web';
        const encryption = installSession('web-live-bound');
        const history = (await openLocalHistory('server|web-live-bound'))!;
        await history.commitPage('web-live-bound', { direction: 'older', boundary: 2147483647,
            messages: [apiMessage(1)], hasMore: false });
        syncForTest.localHistory = history;
        await syncForTest.openSession('web-live-bound');
        const replay = vi.spyOn(syncForTest, 'applyHistoryWindow');
        for (let seq = 2; seq <= 2000; seq++) {
            await syncForTest.handleUpdate(newMessageUpdate('web-live-bound', seq));
            expect(syncForTest.historyWindows.get('web-live-bound').messages.length).toBeLessThanOrEqual(500);
        }
        expect(replay.mock.calls.length).toBeLessThan(20);
        expect(syncForTest.historyWindows.get('web-live-bound')).toMatchObject({ newestSeq: 2000, hasMoreOlder: true, isAtLatest: true });
        expect((await history.readOlderPage('web-live-bound', 100))?.messages.some(message => message.seq === 99)).toBe(true);
        expect(encryption).toBeTruthy();
    }, 30000);

    it.each(['web', 'android'] as const)('shows live assistant output on %s before a held history request resolves', async platform => {
        Platform.OS = platform;
        const storage = await useRealMessageComposition();
        const encryption = installSession('live-before-http');
        storage.getState().applySessions([hydrated(snapshot('live-before-http'))]);
        storage.setState({ currentViewingSessionId: 'live-before-http' });
        const lease = syncForTest.sessionMessageLoadGate.enter('live-before-http');
        await syncForTest.applyLatestMessagePage('live-before-http', { messages: [apiMessage(1)], hasMore: false },
            syncForTest.sessionMessageLoadGate.begin(lease));
        const http = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(http.promise);
        const fetching = syncForTest.fetchMessages('live-before-http', syncForTest.sessionMessageLoadGate.begin(lease));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        const answer = {
            role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'live-answer',
                message: { role: 'assistant', model: 'test', content: [{ type: 'text', text: 'The final answer is visible.' }] } } },
        };
        encryption.decryptMessage.mockResolvedValueOnce({ ...apiMessage(2), content: answer });
        // Replay must decode the same wire record to the same content.
        encryption.decryptMessages.mockImplementation(async (rows: ApiMessage[]) => rows.map(row => ({
            ...row, content: row.seq === 2 ? answer : rawText(`fetched-${row.seq}`),
        })));
        try {
            await syncForTest.handleUpdate(newMessageUpdate('live-before-http', 2));
            await vi.waitFor(() => expect(storage.getState().sessionMessages['live-before-http'].messages
                .some(message => message.kind === 'agent-text' && message.text === 'The final answer is visible.')).toBe(true), { timeout: 300 });
        } finally {
            http.resolve(response({ messages: [], hasMore: false }));
            await fetching;
        }
        expect(storage.getState().sessionMessages['live-before-http'].messages
            .filter(message => message.kind === 'agent-text' && message.text === 'The final answer is visible.')).toHaveLength(1);
    });

    it('does not resurrect evicted realtime rows when a held foreground fetch releases its message lock', async () => {
        Platform.OS = 'web';
        const storage = await useRealMessageComposition();
        installSession('web-queued-compaction');
        storage.getState().applySessions([hydrated(snapshot('web-queued-compaction'))]);
        storage.setState({ currentViewingSessionId: 'web-queued-compaction' });
        const lease = syncForTest.sessionMessageLoadGate.enter('web-queued-compaction');
        await syncForTest.applyLatestMessagePage('web-queued-compaction', { messages: [apiMessage(1)], hasMore: false },
            syncForTest.sessionMessageLoadGate.begin(lease));
        vi.mocked(voiceHooks.onMessages).mockClear();
        const http = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(http.promise);
        const fetching = syncForTest.fetchMessages('web-queued-compaction', syncForTest.sessionMessageLoadGate.begin(lease));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        try {
            for (let seq = 2; seq <= 1200; seq++) await syncForTest.handleUpdate(newMessageUpdate('web-queued-compaction', seq));
        } finally {
            http.resolve(response({ messages: [], hasMore: false }));
            await fetching;
            await syncForTest.getSessionMessageLock('web-queued-compaction').inLock(() => undefined);
        }
        const cache = storage.getState().sessionMessages['web-queued-compaction'];
        const window = syncForTest.historyWindows.get('web-queued-compaction');
        expect(cache.messages.length).toBeLessThanOrEqual(500);
        expect(cache.messages.map(row => sync.getMessageWireId('web-queued-compaction', row.id)).sort())
            .toEqual(window.messages.map((row: ApiMessage) => row.id).sort());
        expect(cache.messages.every(row => sync.getMessageWireSeq('web-queued-compaction', row.id) !== null)).toBe(true);
        const liveNotifications = vi.mocked(voiceHooks.onMessages).mock.calls.flatMap(([, rows]) =>
            rows.flatMap(row => row.kind === 'user-text' ? [row.text] : []));
        expect(liveNotifications).toEqual(Array.from({ length: 1199 }, (_, i) => `realtime-${i + 2}`));
    });

    it('keeps the displayed frontier behind a known live gap until the missing page commits', async () => {
        Platform.OS = 'web';
        const storage = await useRealMessageComposition();
        installSession('projection-gap');
        storage.getState().applySessions([hydrated(snapshot('projection-gap'))]);
        storage.setState({ currentViewingSessionId: 'projection-gap' });
        const lease = syncForTest.sessionMessageLoadGate.enter('projection-gap');
        await syncForTest.applyLatestMessagePage('projection-gap', { messages: [apiMessage(100)], hasMore: true },
            syncForTest.sessionMessageLoadGate.begin(lease));
        expect(storage.getState().sessionMessages['projection-gap'].latestAppliedSeq).toBe(100);
        const http = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(http.promise);
        try {
            await syncForTest.handleUpdate(newMessageUpdate('projection-gap', 103));
            await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
            expect(storage.getState().sessions['projection-gap'].seq).toBe(103);
            expect(storage.getState().sessionMessages['projection-gap'].latestAppliedSeq).toBe(100);
        } finally {
            http.resolve(response({ messages: [apiMessage(101), apiMessage(102), apiMessage(103)], hasMore: false }));
            await syncForTest.getMessagesSync('projection-gap').invalidateAndAwait(103);
        }
        expect(storage.getState().sessionMessages['projection-gap'].latestAppliedSeq).toBe(103);
        expect(storage.getState().sessionMessages['projection-gap'].messages).toHaveLength(4);
    });

    it.each([
        ['memory', 'history-first'], ['memory', 'forward-first'],
        ['disk', 'history-first'], ['disk', 'forward-first'],
    ])('finishes a live result gap after an older history load supersedes its request (%s, %s)', async (cache, order) => {
        Platform.OS = 'web';
        const id = 'superseded-result-gap';
        if (cache === 'disk') {
            vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
            syncForTest.localHistory = await openLocalHistory('server|superseded-result-gap');
        }
        installSession(id);
        mocks.state.currentViewingSessionId = id;
        const lease = syncForTest.sessionMessageLoadGate.enter(id);
        await syncForTest.applyLatestMessagePage(id, { messages: [apiMessage(100)], hasMore: true },
            syncForTest.sessionMessageLoadGate.begin(lease));
        const forward = deferred<Response>();
        const older = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(forward.promise)
            .mockReturnValueOnce(older.promise)
            .mockResolvedValueOnce(response({ messages: [apiMessage(101), apiMessage(103)], hasMore: false }));

        await syncForTest.handleUpdate(newMessageUpdate(id, 103));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        const loading = sync.loadOlderMessages(id);
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(2));
        if (order === 'history-first') {
            older.resolve(response({ messages: [apiMessage(99)], hasMore: true }));
            await loading;
        }
        forward.resolve(response({ messages: [apiMessage(101), apiMessage(103)], hasMore: false }));
        if (order === 'forward-first') {
            await syncForTest.getSessionMessageLock(id).inLock(() => undefined);
            expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
            older.resolve(response({ messages: [apiMessage(99)], hasMore: true }));
            await loading;
        }
        await syncForTest.messagesSync.get(id).awaitQueue();

        expect(mocks.state.sessionMessages[id].latestAppliedSeq).toBe(103);
        expect(syncForTest.historyWindows.get(id).messages.map((message: ApiMessage) => message.seq))
            .toEqual([99, 100, 101, 103]);
        expect(mocks.apiRequest).toHaveBeenCalledTimes(3);
    });

    it.each(['android', 'ios'] as const)('finishes both native older history and the superseded result gap on %s without IndexedDB', async platform => {
        Platform.OS = platform;
        const id = 'native-result-gap';
        installSession(id);
        mocks.state.currentViewingSessionId = id;
        const lease = syncForTest.sessionMessageLoadGate.enter(id);
        await syncForTest.applyLatestMessagePage(id, { messages: [apiMessage(100)], hasMore: true },
            syncForTest.sessionMessageLoadGate.begin(lease));
        const forward = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(forward.promise).mockImplementation(async (url: string) => response({
            messages: url.includes('before_seq=') ? [apiMessage(99)] : [apiMessage(101), apiMessage(103)], hasMore: false,
        }));
        await syncForTest.handleUpdate(newMessageUpdate(id, 103));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        const older = sync.loadOlderMessages(id);
        forward.resolve(response({ messages: [apiMessage(101), apiMessage(103)], hasMore: false }));
        await older;
        await syncForTest.messagesSync.get(id).awaitQueue();
        expect(mocks.state.sessionMessages[id].messagesMap['message-99']).toBeDefined();
        expect(mocks.state.sessionMessages[id].messagesMap['message-103']).toBeDefined();
        expect(mocks.state.sessionMessages[id].latestAppliedSeq).toBe(103);
        expect(mocks.state.sessionMessages[id].olderError).toBeNull();
        expect(mocks.apiRequest).toHaveBeenCalledTimes(3);
    });

    it.each(['historical', 'evicted', 'account'])('does not resume superseded result sync after %s navigation', async terminal => {
        Platform.OS = 'android';
        vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
        const id = 'abandoned-result-gap';
        const history = (await openLocalHistory('server|abandoned-result-gap'))!;
        syncForTest.localHistory = history;
        installSession(id);
        mocks.state.currentViewingSessionId = id;
        await history.commitPage(id, { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 400 }, (_, i) => apiMessage(i + 1)), hasMore: false });
        const lease = syncForTest.sessionMessageLoadGate.enter(id);
        await syncForTest.applyHistoryWindow(id, await history.readWindow(id, { limit: 300 }),
            syncForTest.sessionMessageLoadGate.begin(lease));
        const forward = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(forward.promise);
        await syncForTest.handleUpdate(newMessageUpdate(id, 403));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        const pending = syncForTest.messagesSync.get(id).awaitQueue();
        if (terminal === 'historical') await sync.loadOlderMessages(id);
        else if (terminal === 'evicted') syncForTest.releaseSessionMessageCache(id);
        else syncForTest.encryption = { ...syncForTest.encryption };
        forward.resolve(response({ messages: [apiMessage(401), apiMessage(403)], hasMore: false }));
        await pending;
        await syncForTest.getSessionMessageLock(id).inLock(() => undefined);
        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
        expect(mocks.state.sessionMessages[id]?.messages.some((message: any) => message.text === 'fetched-403') ?? false).toBe(false);
        if (terminal === 'historical') {
            expect(syncForTest.historyWindows.get(id).isAtLatest).toBe(false);
            expect(mocks.state.sessionMessages[id].latestAppliedSeq).toBeLessThan(400);
        }
    });

    it.each([101, 102])('does not confuse ACK %s with a committed remote projection', async ackSeq => {
        Platform.OS = 'web';
        const storage = await seedLocalProjectionSession();
        storage.setState({ currentViewingSessionId: 'spawned-session' });
        const lease = syncForTest.sessionMessageLoadGate.enter('spawned-session');
        await syncForTest.applyLatestMessagePage('spawned-session', { messages: [apiMessage(100)], hasMore: true },
            syncForTest.sessionMessageLoadGate.begin(lease));
        const receipt = await sync.sendMessage('spawned-session', 'local message', { source: 'chat' });
        mocks.apiRequest.mockResolvedValueOnce(response({ messages: [{ ...apiMessage(ackSeq), localId: receipt.localIds[0] }] }));
        await syncForTest.flushOutbox('spawned-session');
        const afterAck = storage.getState().sessionMessages['spawned-session'].latestAppliedSeq;
        expect(afterAck).toBe(100);
        const incomingSeq = ackSeq === 101 ? 101 : 103;
        const http = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(http.promise);
        try {
            await syncForTest.handleUpdate(newMessageUpdate('spawned-session', incomingSeq));
            if (ackSeq === 101) {
                await vi.waitFor(() => expect(storage.getState().sessionMessages['spawned-session'].latestAppliedSeq).toBe(101), { timeout: 300 });
            } else {
                expect(storage.getState().sessionMessages['spawned-session'].latestAppliedSeq).toBe(100);
                await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenLastCalledWith('/v3/sessions/spawned-session/messages?after_seq=100&limit=100'));
            }
        } finally {
            http.resolve(response({ messages: [apiMessage(101), apiMessage(102), apiMessage(103)], hasMore: false }));
            if (ackSeq === 102) await syncForTest.getMessagesSync('spawned-session').awaitQueue();
        }
        expect(storage.getState().sessionMessages['spawned-session'].latestAppliedSeq).toBe(incomingSeq);
    });

    it('cancels an old projection callback without draining or unlocking a remounted queue', async () => {
        const storage = await useRealMessageComposition();
        installSession('projection-remount');
        storage.getState().applySessions([hydrated(snapshot('projection-remount'))]);
        const scheduled: Array<() => void> = [];
        vi.stubGlobal('queueMicrotask', (callback: () => void) => scheduled.push(callback));
        syncForTest.enqueueMessages('projection-remount', [normalizeRawMessage('old', null, 1, rawText('old'))!]);
        syncForTest.releaseSessionMessageCache('projection-remount');
        syncForTest.enqueueMessages('projection-remount', [normalizeRawMessage('new', null, 2, rawText('new'))!]);
        scheduled[0]();
        expect(storage.getState().sessionMessages['projection-remount']).toBeUndefined();
        // A third entry must join the remounted task, not schedule another one.
        syncForTest.enqueueMessages('projection-remount', [normalizeRawMessage('newer', null, 3, rawText('newer'))!]);
        expect(scheduled).toHaveLength(2);
        scheduled[1]();
        expect(storage.getState().sessionMessages['projection-remount'].messages.map(message =>
            message.kind === 'user-text' ? message.text : '')).toEqual(['newer', 'new']);
    });

    it('requires an initial latest page when an ACK arrives before any verified projection', async () => {
        const storage = await seedLocalProjectionSession();
        storage.setState({ currentViewingSessionId: 'spawned-session' });
        const receipt = await sync.sendMessage('spawned-session', 'local message', { source: 'chat' });
        mocks.apiRequest.mockResolvedValueOnce(response({ messages: [{ ...apiMessage(100), localId: receipt.localIds[0] }] }));
        await syncForTest.flushOutbox('spawned-session');
        const http = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(http.promise);
        try {
            await syncForTest.handleUpdate(newMessageUpdate('spawned-session', 101));
            expect(storage.getState().sessionMessages['spawned-session'].latestAppliedSeq).toBeUndefined();
            await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenLastCalledWith('/v3/sessions/spawned-session/messages?before_seq=2147483647&limit=25'));
        } finally {
            http.resolve(response({ messages: [apiMessage(99), apiMessage(100), apiMessage(101)], hasMore: true }));
            await syncForTest.getMessagesSync('spawned-session').awaitQueue();
        }
        expect(storage.getState().sessionMessages['spawned-session'].latestAppliedSeq).toBe(101);
    });

    it('does not let a newer ACK discard the initial projection baseline', async () => {
        const storage = await seedLocalProjectionSession();
        const receipt = await sync.sendMessage('spawned-session', 'local message', { source: 'chat' });
        mocks.apiRequest.mockResolvedValueOnce(response({ messages: [{ ...apiMessage(101), localId: receipt.localIds[0] }] }));
        await syncForTest.flushOutbox('spawned-session');
        const lease = syncForTest.sessionMessageLoadGate.enter('spawned-session');
        await syncForTest.applyLatestMessagePage('spawned-session', { messages: [apiMessage(100)], hasMore: true },
            syncForTest.sessionMessageLoadGate.begin(lease));
        expect(storage.getState().sessionMessages['spawned-session'].latestAppliedSeq).toBe(100);
    });

    it('fetches a real initial page when opening an ACK-only optimistic cache', async () => {
        const storage = await seedLocalProjectionSession();
        const receipt = await sync.sendMessage('spawned-session', 'local message', { source: 'chat' });
        mocks.apiRequest.mockResolvedValueOnce(response({ messages: [{ ...apiMessage(100), localId: receipt.localIds[0] }] }));
        await syncForTest.flushOutbox('spawned-session');
        expect(storage.getState().sessionMessages['spawned-session'].isLoaded).toBe(true);
        const http = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(http.promise);
        const opening = syncForTest.openSession('spawned-session');
        try {
            await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenLastCalledWith('/v3/sessions/spawned-session/messages?before_seq=2147483647&limit=25'));
            expect(storage.getState().sessionMessages['spawned-session'].latestAppliedSeq).toBeUndefined();
        } finally {
            http.resolve(response({ messages: [apiMessage(99), apiMessage(100)], hasMore: true }));
            await opening;
        }
        expect(storage.getState().sessionMessages['spawned-session'].latestAppliedSeq).toBe(100);
    });

    it('revalidates disconnected warm rows before admitting a newer live sequence', async () => {
        Platform.OS = 'android';
        const storage = await seedLocalProjectionSession();
        storage.setState({ currentViewingSessionId: 'spawned-session' });
        const lease = syncForTest.sessionMessageLoadGate.enter('spawned-session');
        await syncForTest.applyLatestMessagePage('spawned-session', { messages: [apiMessage(100), apiMessage(102)], hasMore: true },
            syncForTest.sessionMessageLoadGate.begin(lease), 'warm-cache');
        expect(storage.getState().sessionMessages['spawned-session'].messages).toHaveLength(2);
        const http = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(http.promise);
        try {
            await syncForTest.handleUpdate(newMessageUpdate('spawned-session', 103));
            expect(storage.getState().sessionMessages['spawned-session'].latestAppliedSeq).toBeUndefined();
            await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenLastCalledWith('/v3/sessions/spawned-session/messages?before_seq=2147483647&limit=25'));
        } finally {
            http.resolve(response({ messages: [apiMessage(100), apiMessage(101), apiMessage(102), apiMessage(103)], hasMore: true }));
            await syncForTest.messagesSync.get('spawned-session')?.awaitQueue();
        }
        expect(storage.getState().sessionMessages['spawned-session'].latestAppliedSeq).toBe(103);
        expect(storage.getState().sessionMessages['spawned-session'].messages).toHaveLength(4);
    });

    it('does not certify a native latest gap by loading an older page below an isolated ACK', async () => {
        Platform.OS = 'android';
        const storage = await seedLocalProjectionSession();
        const lease = syncForTest.sessionMessageLoadGate.enter('spawned-session');
        await syncForTest.applyLatestMessagePage('spawned-session', { messages: [apiMessage(100)], hasMore: true },
            syncForTest.sessionMessageLoadGate.begin(lease));
        const receipt = await sync.sendMessage('spawned-session', 'local message', { source: 'chat' });
        mocks.apiRequest.mockResolvedValueOnce(response({ messages: [{ ...apiMessage(1000), localId: receipt.localIds[0] }] }));
        await syncForTest.flushOutbox('spawned-session');
        mocks.apiRequest.mockResolvedValueOnce(response({ messages: [apiMessage(998), apiMessage(999)], hasMore: true }));
        await syncForTest.loadOlderMessages('spawned-session');
        expect(storage.getState().sessionMessages['spawned-session'].latestAppliedSeq).toBe(100);
    });

    it('resolves modern live envelope rows to outer wire sequences before the next replay', async () => {
        Platform.OS = 'web';
        const storage = await useRealMessageComposition();
        const decrypt = async (rows: ApiMessage[]) => rows.map(row => ({ ...row, content: {
            role: 'session', content: { type: 'session', data: { id: `envelope-${row.seq}`, time: row.createdAt,
                role: 'user', ev: { t: 'text', text: `modern-${row.seq}` } } },
        } }));
        const encryption = installSession('web-modern-live', decrypt);
        encryption.decryptMessage.mockImplementation(async (row: ApiMessage) => (await decrypt([row]))[0]);
        storage.getState().applySessions([hydrated(snapshot('web-modern-live'))]);
        const lease = syncForTest.sessionMessageLoadGate.enter('web-modern-live');
        await syncForTest.applyLatestMessagePage('web-modern-live', { messages: [apiMessage(1)], hasMore: false },
            syncForTest.sessionMessageLoadGate.begin(lease));
        await syncForTest.handleUpdate(newMessageUpdate('web-modern-live', 2));
        await vi.waitFor(() => {
            const rendered = storage.getState().sessionMessages['web-modern-live'].messages.find((row: any) => row.text === 'modern-2');
            expect(rendered).toBeDefined();
            expect(sync.getMessageWireId('web-modern-live', rendered!.id)).toBe('message-2');
            expect(sync.getMessageWireSeq('web-modern-live', rendered!.id)).toBe(2);
        });
    });

    it('keeps cached Web history additive within the bounded window', async () => {
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web';
        installSession('web-history');
        const history = await openLocalHistory('server|web-history');
        await history!.commitPage('web-history', { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 500 }, (_, i) => apiMessage(i + 1)), hasMore: false });
        syncForTest.localHistory = history;

        await expect(syncForTest.openSession('web-history')).resolves.toBe('ready');
        await syncForTest.loadOlderMessages('web-history');
        await syncForTest.loadOlderMessages('web-history');

        expect(syncForTest.historyWindows.get('web-history').messages.map((message: ApiMessage) => message.seq))
            .toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
        expect(mocks.apiRequest).not.toHaveBeenCalled();
    }, 20000);

    it('repeatedly traverses older and newer cached pages with a bounded contiguous Web projection', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web'; installSession('web-traverse');
        const history = (await openLocalHistory('server|web-traverse'))!;
        await history.commitPage('web-traverse', { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 2000 }, (_, i) => apiMessage(i + 1)), hasMore: false });
        syncForTest.localHistory = history;
        await syncForTest.openSession('web-traverse');
        for (let cycle = 0; cycle < 2; cycle++) {
            for (const direction of ['older', 'newer'] as const) {
                for (let page = 0; page < 30; page++) {
                    const before = syncForTest.historyWindows.get('web-traverse');
                    if (!(direction === 'older' ? before.hasMoreOlder : before.hasMoreNewer)) break;
                    await syncForTest.loadHistoryBoundary('web-traverse', direction);
                    const after = syncForTest.historyWindows.get('web-traverse');
                    expect(after.messages.length).toBeLessThanOrEqual(500);
                    expect(after.newestSeq - after.oldestSeq + 1).toBe(after.messages.length);
                    if (direction === 'older') expect(after.oldestSeq).toBeLessThan(before.oldestSeq);
                    else expect(after.newestSeq).toBeGreaterThan(before.newestSeq);
                }
                const final = syncForTest.historyWindows.get('web-traverse');
                expect(direction === 'older' ? final.oldestSeq : final.newestSeq).toBe(direction === 'older' ? 1 : 2000);
            }
        }
        expect(mocks.apiRequest).not.toHaveBeenCalled();
    }, 60000);

    it('bounds forward catch-up between pages instead of retaining every fetched row until completion', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web'; const encryption = installSession('web-catchup-bound');
        const history = (await openLocalHistory('server|web-catchup-bound'))!;
        await history.commitPage('web-catchup-bound', { direction: 'older', boundary: 2147483647,
            messages: [apiMessage(1)], hasMore: false });
        syncForTest.localHistory = history;
        await syncForTest.openSession('web-catchup-bound');
        mocks.apiRequest.mockImplementation(async (url: string) => {
            expect(syncForTest.historyWindows.get('web-catchup-bound').messages.length).toBeLessThanOrEqual(500);
            expect(mocks.state.sessionMessages['web-catchup-bound'].messages.length).toBeLessThanOrEqual(500);
            const after = Number(new URL(url, 'https://example.com').searchParams.get('after_seq'));
            return response({ messages: Array.from({ length: 100 }, (_, i) => apiMessage(after + i + 1)), hasMore: after < 1901 });
        });
        const lease = syncForTest.sessionMessageLoadGate.currentLease('web-catchup-bound')!;
        await syncForTest.fetchForwardSince('web-catchup-bound', encryption, 1, syncForTest.sessionMessageLoadGate.begin(lease));
        expect(syncForTest.historyWindows.get('web-catchup-bound')).toMatchObject({ newestSeq: 2001, isAtLatest: true, hasMoreOlder: true });
        expect(mocks.state.sessionMessages['web-catchup-bound'].messages.length).toBeLessThanOrEqual(500);
    }, 30000);

    it('keeps visited Web history when a latest-window forward sync returns no new rows', async () => {
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web';
        const encryption = installSession('web-forward-history');
        const history = await openLocalHistory('server|web-forward-history');
        await history!.commitPage('web-forward-history', { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 301 }, (_, i) => apiMessage(i + 1)), hasMore: false });
        syncForTest.localHistory = history;

        await expect(syncForTest.openSession('web-forward-history')).resolves.toBe('ready');
        await syncForTest.loadOlderMessages('web-forward-history');
        const before = syncForTest.historyWindows.get('web-forward-history');
        expect(before.isAtLatest).toBe(true);
        expect(before.messages).toHaveLength(301);
        mocks.apiRequest.mockResolvedValue(response({ messages: [], hasMore: false }));

        const lease = syncForTest.sessionMessageLoadGate.currentLease('web-forward-history')!;
        await syncForTest.fetchForwardSince('web-forward-history', encryption, 301,
            syncForTest.sessionMessageLoadGate.begin(lease));

        const after = syncForTest.historyWindows.get('web-forward-history');
        expect(after.messages.map((message: ApiMessage) => message.seq))
            .toEqual(before.messages.map((message: ApiMessage) => message.seq));
        expect(mocks.apiRequest).toHaveBeenCalledWith('/v3/sessions/web-forward-history/messages?after_seq=301&limit=100');
    }, 20000);

    it('keeps visited Web history when a consecutive realtime row reaches the latest window', async () => {
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web';
        installSession('web-realtime-history');
        const history = await openLocalHistory('server|web-realtime-history');
        await history!.commitPage('web-realtime-history', { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 301 }, (_, i) => apiMessage(i + 1)), hasMore: false });
        syncForTest.localHistory = history;

        await expect(syncForTest.openSession('web-realtime-history')).resolves.toBe('ready');
        await syncForTest.loadOlderMessages('web-realtime-history');
        const before = syncForTest.historyWindows.get('web-realtime-history').messages.map((message: ApiMessage) => message.seq);

        await syncForTest.handleUpdate(newMessageUpdate('web-realtime-history', 302));

        const after = syncForTest.historyWindows.get('web-realtime-history');
        expect(after.messages.map((message: ApiMessage) => message.seq)).toEqual([...before, 302]);
        expect(mocks.state.sessionMessages['web-realtime-history'].messages).toHaveLength(302);
    }, 20000);

    it('keeps visited Web history when reconciliation discovers a newer latest row', async () => {
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web';
        installSession('web-reconciled-history');
        const history = await openLocalHistory('server|web-reconciled-history');
        await history!.commitPage('web-reconciled-history', { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 301 }, (_, i) => apiMessage(i + 1)), hasMore: false });
        syncForTest.localHistory = history;

        await expect(syncForTest.openSession('web-reconciled-history')).resolves.toBe('ready');
        await syncForTest.loadOlderMessages('web-reconciled-history');
        const before = syncForTest.historyWindows.get('web-reconciled-history').messages.map((message: ApiMessage) => message.seq);
        mocks.state.currentViewingSessionId = 'web-reconciled-history';
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ changes: [{
            sessionId: 'web-reconciled-history', revision: '1', deleted: false,
            lastMessageSeq: 302, metadataVersion: 0, agentStateVersion: 0,
        }], nextCursor: '1', hasMore: false }))));
        mocks.apiRequest.mockResolvedValue(response({ messages: [apiMessage(302)], hasMore: false }));

        await syncForTest.reconcileHistory();

        const after = syncForTest.historyWindows.get('web-reconciled-history');
        expect(after.messages.map((message: ApiMessage) => message.seq)).toEqual([...before, 302]);
        expect(mocks.apiRequest).toHaveBeenCalledWith('/v3/sessions/web-reconciled-history/messages?after_seq=301&limit=100');
    }, 20000);

    it('keeps a restored Web history island reachable when a disconnected latest window is applied', async () => {
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web';
        installSession('web-disconnected-retention');
        const history = await openLocalHistory('server|web-disconnected-retention');
        await history!.commitPage('web-disconnected-retention', { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 30 }, (_, i) => apiMessage(i + 1)), hasMore: false });
        syncForTest.localHistory = history;
        const lease = syncForTest.sessionMessageLoadGate.enter('web-disconnected-retention');
        const restored = await history!.readWindow('web-disconnected-retention', { anchorSeq: 5, limit: 10 });
        const latest = await history!.readWindow('web-disconnected-retention', { limit: 10 });
        expect(restored?.messages.map(message => message.seq)).toEqual(
            Array.from({ length: 10 }, (_, i) => i + 1),
        );
        expect(latest?.messages.map(message => message.seq)).toEqual(
            Array.from({ length: 10 }, (_, i) => i + 21),
        );

        await syncForTest.applyHistoryWindow('web-disconnected-retention', restored,
            syncForTest.sessionMessageLoadGate.begin(lease));
        await syncForTest.applyHistoryWindow('web-disconnected-retention', latest,
            syncForTest.sessionMessageLoadGate.begin(lease), { retainCurrentWebRows: true });

        const retained = syncForTest.historyWindows.get('web-disconnected-retention');
        expect(retained.messages.map((message: ApiMessage) => message.seq)).toEqual(
            Array.from({ length: 10 }, (_, i) => i + 1),
        );
        expect(retained).toMatchObject({
            oldestSeq: 1,
            newestSeq: 10,
            hasMoreOlder: false,
            hasMoreNewer: true,
            isAtLatest: false,
        });

        await syncForTest.loadNewerMessages('web-disconnected-retention');
        expect(syncForTest.historyWindows.get('web-disconnected-retention').messages
            .some((message: ApiMessage) => message.seq === 11)).toBe(true);
        expect(mocks.apiRequest).not.toHaveBeenCalled();
    }, 20000);

    it('does not let a stale Web older projection overwrite a concurrent realtime row', async () => {
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web';
        const encryption = installSession('web-older-race');
        const history = await openLocalHistory('server|web-older-race');
        syncForTest.localHistory = history;
        const lease = syncForTest.sessionMessageLoadGate.enter('web-older-race');
        const currentMessages = Array.from({ length: 1_100 }, (_, i) => apiMessage(i + 101));
        await syncForTest.applyHistoryWindow('web-older-race', {
            messages: currentMessages, oldestSeq: 101, newestSeq: 1_200,
            hasMoreOlder: true, hasMoreNewer: false, isAtLatest: true,
        }, syncForTest.sessionMessageLoadGate.begin(lease));
        vi.spyOn(history!, 'readOlderPage').mockResolvedValue({
            direction: 'older', boundary: 101,
            messages: Array.from({ length: 100 }, (_, i) => apiMessage(i + 1)), hasMore: false,
        });
        const expanded = deferred<HistoryWindow>();
        vi.spyOn(history!, 'readWindow').mockReturnValueOnce(expanded.promise);
        const decryptStarted = deferred<void>();
        const resumeDecrypt = deferred<void>();
        encryption.decryptMessages.mockImplementationOnce(async (messages: ApiMessage[]) => {
            decryptStarted.resolve();
            await resumeDecrypt.promise;
            return messages.map((message: ApiMessage) => ({
                id: message.id, localId: message.localId, createdAt: message.createdAt,
                content: rawText(`fetched-${message.seq}`),
            }));
        });

        const loading = syncForTest.loadOlderMessages('web-older-race');
        await vi.waitFor(() => expect(history!.readWindow).toHaveBeenCalledOnce());
        expanded.resolve({
            messages: Array.from({ length: 1_000 }, (_, i) => apiMessage(i + 1)),
            oldestSeq: 1, newestSeq: 1_000, hasMoreOlder: false, hasMoreNewer: true, isAtLatest: false,
        });
        await decryptStarted.promise;
        await syncForTest.handleUpdate(newMessageUpdate('web-older-race', 1_201));
        resumeDecrypt.resolve();
        await loading;

        const after = syncForTest.historyWindows.get('web-older-race');
        expect(after.messages.map((message: ApiMessage) => message.seq))
            .toEqual(Array.from({ length: 400 }, (_, i) => i + 802));
        expect(after).toMatchObject({ hasMoreOlder: true, hasMoreNewer: false, isAtLatest: true });
    }, 20000);

    it('does not let a stale Web forward projection overwrite a concurrent realtime row', async () => {
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web';
        const encryption = installSession('web-forward-race');
        const history = await openLocalHistory('server|web-forward-race');
        await history!.commitPage('web-forward-race', { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 301 }, (_, i) => apiMessage(i + 1)), hasMore: true });
        syncForTest.localHistory = history;
        const lease = syncForTest.sessionMessageLoadGate.enter('web-forward-race');
        await syncForTest.applyHistoryWindow('web-forward-race', {
            messages: Array.from({ length: 301 }, (_, i) => apiMessage(i + 1)),
            oldestSeq: 1, newestSeq: 301, hasMoreOlder: true, hasMoreNewer: false, isAtLatest: true,
        }, syncForTest.sessionMessageLoadGate.begin(lease));
        const forward = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(forward.promise);

        const syncing = syncForTest.fetchForwardSince('web-forward-race', encryption, 301,
            syncForTest.sessionMessageLoadGate.begin(lease));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledOnce());
        await syncForTest.handleUpdate(newMessageUpdate('web-forward-race', 302));
        forward.resolve(response({ messages: [], hasMore: false }));
        await syncing;

        const after = syncForTest.historyWindows.get('web-forward-race');
        expect(after.messages.map((message: ApiMessage) => message.seq))
            .toEqual(Array.from({ length: 302 }, (_, i) => i + 1));
        expect(after).toMatchObject({ hasMoreOlder: true, hasMoreNewer: false, isAtLatest: true });
    }, 20000);

    it('reads the current viewport after a delayed history decrypt before committing the window', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web';
        const encrypted = installSession('moving-viewport');
        const history = await openLocalHistory('server|moving-viewport');
        await history!.commitPage('moving-viewport', { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 1000 }, (_, i) => apiMessage(i + 1)), hasMore: false });
        syncForTest.localHistory = history;
        const lease = syncForTest.sessionMessageLoadGate.enter('moving-viewport');
        const initial = await history!.readWindow('moving-viewport', { anchorSeq: 250, limit: 500 });
        await syncForTest.applyHistoryWindow('moving-viewport', initial, syncForTest.sessionMessageLoadGate.begin(lease));
        const started = deferred<void>(); const release = deferred<void>();
        encrypted.decryptMessages.mockImplementationOnce(async (messages: ApiMessage[]) => {
            started.resolve(); await release.promise;
            return messages.map(message => ({ id: message.id, localId: message.localId, createdAt: message.createdAt,
                content: rawText(`fetched-${message.seq}`) }));
        });
        let visible = { firstSeq: 450, lastSeq: 490 };
        const loading = syncForTest.loadNewerMessages('moving-viewport', () => visible);
        await started.promise;
        visible = { firstSeq: 10, lastSeq: 500 };
        release.resolve(); await loading;
        const window = syncForTest.historyWindows.get('moving-viewport');
        expect(window.oldestSeq).toBeLessThanOrEqual(10);
        expect(window.newestSeq).toBeGreaterThan(500);
        expect(window.messages.length).toBeLessThanOrEqual(5000);
    }, 20000);

    it('keeps the existing projection on capacity deferral and advances on explicit continuation', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web'; installSession('viewport-capacity');
        const history = await openLocalHistory('server|viewport-capacity');
        const first = apiMessage(1, 'x'.repeat(4 * 1024 * 1024));
        await history!.commitPage('viewport-capacity', { direction: 'older', boundary: 2147483647,
            messages: [first, apiMessage(2)], hasMore: false });
        syncForTest.localHistory = history;
        const lease = syncForTest.sessionMessageLoadGate.enter('viewport-capacity');
        await syncForTest.applyHistoryWindow('viewport-capacity', { messages: [first], oldestSeq: 1, newestSeq: 1,
            hasMoreOlder: false, hasMoreNewer: true, isAtLatest: false }, syncForTest.sessionMessageLoadGate.begin(lease));
        const before = mocks.state.sessionMessages['viewport-capacity'].messages;
        await syncForTest.loadNewerMessages('viewport-capacity', () => ({ firstSeq: 1, lastSeq: 1 }));
        expect(mocks.state.sessionMessages['viewport-capacity'].messages).toBe(before);
        expect(mocks.state.sessionMessages['viewport-capacity'].newerError).toBe('history-window-capacity');
        expect(syncForTest.historyWindows.get('viewport-capacity').newestSeq).toBe(1);
        await syncForTest.loadNewerMessages('viewport-capacity');
        expect(syncForTest.historyWindows.get('viewport-capacity').newestSeq).toBe(2);
        expect(mocks.state.sessionMessages['viewport-capacity'].newerError).toBeFalsy();
    }, 20000);

    it('moves past a stale restored anchor with bounded pagination and reloads it on newer navigation', async () => {
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web';
        installSession('anchored-web-history');
        const history = await openLocalHistory('server|anchored-web-history');
        await history!.commitPage('anchored-web-history', { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 1_100 }, (_, i) => apiMessage(i + 1)), hasMore: false });
        await history!.writeReadingState('anchored-web-history', { version: 1,
            anchorId: 'message-1050', anchorSeq: 1050, offset: 16, expandedGroupIds: [], followLatest: false });
        syncForTest.localHistory = history;

        await expect(syncForTest.openSession('anchored-web-history')).resolves.toBe('ready');
        const initialWindow = syncForTest.historyWindows.get('anchored-web-history');
        await syncForTest.loadOlderMessages('anchored-web-history');
        await syncForTest.loadOlderMessages('anchored-web-history');

        const window = syncForTest.historyWindows.get('anchored-web-history');
        expect(window.oldestSeq).toBeLessThan(initialWindow.oldestSeq);
        expect(window.messages.length).toBeGreaterThan(initialWindow.messages.length);
        expect(window.messages.length).toBeLessThanOrEqual(500);
        expect(window.messages.some((message: ApiMessage) => message.seq === 1050)).toBe(false);
        expect(window).toMatchObject({ hasMoreNewer: true, isAtLatest: false });
        await syncForTest.loadNewerMessages('anchored-web-history');
        await syncForTest.loadNewerMessages('anchored-web-history');
        expect(syncForTest.historyWindows.get('anchored-web-history').messages.some((message: ApiMessage) => message.seq === 1050)).toBe(true);
        expect(mocks.apiRequest).not.toHaveBeenCalled();
    }, 20000);

    it('keeps native cached history navigation bounded to 300 raw events', async () => {
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'android';
        installSession('native-history');
        const history = await openLocalHistory('server|native-history');
        await history!.commitPage('native-history', { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 500 }, (_, i) => apiMessage(i + 1)), hasMore: false });
        syncForTest.localHistory = history;

        await expect(syncForTest.openSession('native-history')).resolves.toBe('ready');
        await syncForTest.loadOlderMessages('native-history');

        expect(syncForTest.historyWindows.get('native-history').messages.length).toBeGreaterThan(0);
        expect(syncForTest.historyWindows.get('native-history').messages.length).toBeLessThanOrEqual(300);
        expect(mocks.apiRequest).not.toHaveBeenCalled();
    }, 20000);

    it('jumps from a stale cached tail by requesting only newer records', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        installSession('archive');
        const history = (await openLocalHistory('server|account'))!;
        await history.commitPage('archive', { direction: 'older', boundary: 2147483647, messages: [apiMessage(40)], hasMore: false });
        await history.commitReconciliation({ changes: [{ sessionId: 'archive', revision: '1', deleted: false,
            lastMessageSeq: 42, metadataVersion: 1, agentStateVersion: 0 }], nextCursor: '1' });
        syncForTest.localHistory = history;
        await syncForTest.openSession('archive');
        mocks.apiRequest.mockResolvedValue(response({ messages: [apiMessage(41), apiMessage(42)], hasMore: false }));
        await syncForTest.jumpToLatestMessages('archive');
        expect(mocks.apiRequest).toHaveBeenCalledWith('/v3/sessions/archive/messages?after_seq=40&limit=100');
        expect(mocks.state.sessionMessages.archive.isAtLatest).toBe(true);
        expect(syncForTest.historyWindows.get('archive').messages.map((m: ApiMessage) => m.seq)).toEqual([40, 41, 42]);
        expect(mocks.state.sessionMessages.archive.latestVerifiedOwnerEpoch).not.toBeNull();
    });

    it('does not certify a stale tail when reconciliation advances during catch-up', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        installSession('advancing-tail');
        const history = (await openLocalHistory('server|account'))!;
        await history.commitPage('advancing-tail', { direction: 'older', boundary: 2147483647,
            messages: [apiMessage(40)], hasMore: false });
        await history.commitReconciliation({ changes: [{ sessionId: 'advancing-tail', revision: '1', deleted: false,
            lastMessageSeq: 42, metadataVersion: 1, agentStateVersion: 0 }], nextCursor: '1' });
        syncForTest.localHistory = history;
        await expect(syncForTest.openSession('advancing-tail')).resolves.toBe('ready');
        const tail = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(tail.promise);
        const catchingUp = syncForTest.jumpToLatestMessages('advancing-tail');
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledWith(
            '/v3/sessions/advancing-tail/messages?after_seq=40&limit=100',
        ));
        await history.commitReconciliation({ changes: [{ sessionId: 'advancing-tail', revision: '2', deleted: false,
            lastMessageSeq: 45, metadataVersion: 1, agentStateVersion: 0 }], nextCursor: '2' });
        tail.resolve(response({ messages: [apiMessage(41), apiMessage(42)], hasMore: false }));
        await catchingUp;
        expect(mocks.state.sessionMessages['advancing-tail']).toMatchObject({ isAtLatest: false, latestVerifiedOwnerEpoch: null });
    });

    it('jumps over a large cached gap to the server tail instead of stopping at one newer page', async () => {
        Platform.OS = 'web';
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        installSession('jump-large-gap');
        const history = (await openLocalHistory('server|jump-large-gap'))!;
        await history.commitPage('jump-large-gap', { direction: 'older', boundary: 2147483647,
            messages: [apiMessage(2000)], hasMore: true });
        await history.appendMessages('jump-large-gap', [apiMessage(4000)]);
        await history.commitReconciliation({ changes: [{ sessionId: 'jump-large-gap', revision: '1', deleted: false,
            lastMessageSeq: 4000, metadataVersion: 1, agentStateVersion: 0 }], nextCursor: '1' });
        syncForTest.localHistory = history;
        const lease = syncForTest.sessionMessageLoadGate.enter('jump-large-gap');
        await syncForTest.applyHistoryWindow('jump-large-gap', await history.readWindow('jump-large-gap'),
            syncForTest.sessionMessageLoadGate.begin(lease));
        mocks.apiRequest
            .mockResolvedValueOnce(response({ messages: Array.from({ length: 100 }, (_, i) => apiMessage(2001 + i)), hasMore: true }))
            .mockResolvedValueOnce(response({ messages: Array.from({ length: 25 }, (_, i) => apiMessage(4000 - i)), hasMore: true }));
        await sync.jumpToLatestMessages('jump-large-gap');
        expect(syncForTest.historyWindows.get('jump-large-gap')).toMatchObject({ newestSeq: 4000, isAtLatest: true, hasMoreNewer: false });
        expect(sync.resolveRenderedMessageId('jump-large-gap', 'message-4000')).not.toBeNull();
        expect(mocks.apiRequest.mock.calls.map(([url]) => url)).toEqual([
            '/v3/sessions/jump-large-gap/messages?after_seq=2000&limit=100',
            '/v3/sessions/jump-large-gap/messages?before_seq=2147483647&limit=25',
        ]);
    });

    it('does not certify a tail when its catch-up request fails', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        installSession('failed-tail');
        const history = (await openLocalHistory('server|account'))!;
        await history.commitPage('failed-tail', { direction: 'older', boundary: 2147483647,
            messages: [apiMessage(40)], hasMore: false });
        await history.commitReconciliation({ changes: [{ sessionId: 'failed-tail', revision: '1', deleted: false,
            lastMessageSeq: 42, metadataVersion: 1, agentStateVersion: 0 }], nextCursor: '1' });
        syncForTest.localHistory = history;
        await expect(syncForTest.openSession('failed-tail')).resolves.toBe('ready');
        mocks.apiRequest.mockResolvedValueOnce(response({}, 503));
        await syncForTest.jumpToLatestMessages('failed-tail');
        expect(mocks.state.sessionMessages['failed-tail'].latestVerifiedOwnerEpoch).toBeNull();
    });

    it('drops corrupt archived page coverage and retries from the network', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        const encryption = installSession('archive');
        encryption.decryptMessages.mockResolvedValueOnce([null]);
        const history = (await openLocalHistory('server|account'))!;
        await history.commitPage('archive', { direction: 'older', boundary: 2147483647, messages: [apiMessage(40)], hasMore: false });
        syncForTest.localHistory = history;
        mocks.apiRequest.mockResolvedValue(response({ messages: [apiMessage(40)], hasMore: false }));
        await expect(syncForTest.openSession('archive')).resolves.toBe('ready');
        expect(mocks.apiRequest.mock.calls.map(([url]) => url)).toEqual(['/v3/sessions/archive/messages?before_seq=2147483647&limit=25']);
        expect(mocks.state.sessionMessages.archive.isLoaded).toBe(true);
    });

    it('makes zero body requests across ten cached opens, visibility signals and unchanged reconnect reconciliations', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        installSession('budget');
        const history = (await openLocalHistory('server|account'))!;
        await history.writeSnapshots([snapshot('budget')]);
        await history.commitPage('budget', { direction: 'older', boundary: 2147483647, messages: [apiMessage(40)], hasMore: false });
        await history.commitReconciliation({ changes: [{ sessionId: 'budget', revision: '1', deleted: false,
            lastMessageSeq: 40, metadataVersion: 0, agentStateVersion: 0 }], nextCursor: '1' });
        let reconciliations = 0;
        vi.stubGlobal('fetch', async (url: string) => {
            expect(url).toContain('/v3/sessions/changes?');
            reconciliations++;
            return new Response(JSON.stringify({ changes: [], nextCursor: '1', hasMore: false }));
        });
        syncForTest.localHistory = history;
        mocks.state.currentViewingSessionId = 'budget';
        for (let i = 0; i < 10; i++) {
            await syncForTest.openSession('budget');
            syncForTest.onSessionVisible('budget');
            await syncForTest.getMessagesSync('budget').awaitQueue();
            await syncForTest.fetchSessions(); // reconnect's existing invalidator target
        }
        expect(reconciliations).toBe(10);
        expect(mocks.apiRequest).not.toHaveBeenCalled();
        expect(mocks.fetchSnapshot).not.toHaveBeenCalled();
        expect(mocks.state.sessionMessages.budget.isLoaded).toBe(true);
        syncForTest.releaseSessionMessageCache('budget');
        await syncForTest.ensureMessagesLoaded('budget');
        expect(mocks.apiRequest).not.toHaveBeenCalled();
    });

    it('keeps realtime tail windows bounded and gives replayed rows stable wire identity', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'android';
        installSession('bounded');
        const history = (await openLocalHistory('server|account'))!;
        await history.commitPage('bounded', { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 300 }, (_, i) => apiMessage(i + 1)), hasMore: false });
        syncForTest.localHistory = history;
        await syncForTest.jumpToLatestMessages('bounded');
        const lease = syncForTest.sessionMessageLoadGate.currentLease('bounded');
        await syncForTest.applyHistoryWindow('bounded', await history.readWindow('bounded', { limit: 300 }), syncForTest.sessionMessageLoadGate.begin(lease));
        const rendered = syncForTest.resolveRenderedMessageId('bounded', 'message-300');
        expect(syncForTest.getMessageWireSeq('bounded', rendered)).toBe(300);
        await syncForTest.handleUpdate(newMessageUpdate('bounded', 301));
        await syncForTest.handleUpdate(newMessageUpdate('bounded', 302));
        expect(syncForTest.historyWindows.get('bounded').messages.length).toBeLessThanOrEqual(300);
        expect(mocks.state.sessionMessages.bounded.messages.length).toBeLessThanOrEqual(300);
        expect(mocks.apiRequest).not.toHaveBeenCalled();
    }, 20000);

    it('assigns stable source-block identities to same-wire text and thinking rows across replay', async () => {
        const encryption = installSession('blocks');
        encryption.decryptMessages.mockImplementation(async (rows: ApiMessage[]) => rows.map(row => ({ ...row, content: {
            role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'assistant-wire', message: {
                role: 'assistant', model: 'test', content: [{ type: 'text', text: 'first long block' }, { type: 'thinking', thinking: 'second long block' }],
            } } },
        } })));
        const lease = syncForTest.sessionMessageLoadGate.enter('blocks');
        const window = { messages: [apiMessage(1)], oldestSeq: 1, newestSeq: 1, hasMoreOlder: false, hasMoreNewer: false, isAtLatest: true };
        await syncForTest.applyHistoryWindow('blocks', window, syncForTest.sessionMessageLoadGate.begin(lease));
        const oldRows = mocks.state.sessionMessages.blocks.messages;
        expect(oldRows).toHaveLength(2);
        const keys = oldRows.map((row: any) => syncForTest.getMessageWireBlockKey('blocks', row.id));
        expect(new Set(keys).size).toBe(2);
        await syncForTest.applyHistoryWindow('blocks', window, syncForTest.sessionMessageLoadGate.begin(lease));
        const newRows = mocks.state.sessionMessages.blocks.messages;
        expect(newRows.map((row: any) => row.id)).not.toEqual(oldRows.map((row: any) => row.id));
        expect(newRows.map((row: any) => syncForTest.getMessageWireBlockKey('blocks', row.id))).toEqual(keys);
    });

    it('persists encrypted metadata updates received while the session is off screen', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        installSession('metadata');
        const history = (await openLocalHistory('server|account'))!;
        await history.writeSnapshots([snapshot('metadata')]);
        syncForTest.localHistory = history;
        await syncForTest.handleUpdate({ id: 'event', seq: 100, createdAt: 100, body: {
            t: 'update-session', id: 'metadata', metadata: { value: 'new-cipher', version: 99 },
        } });
        expect((await history.readSnapshot('metadata'))?.metadata).toBe('new-cipher');
        expect((await history.readSnapshot('metadata'))?.metadataVersion).toBe(99);
    });

    it('archives acknowledged outbound ciphertext without certifying an unseen sequence gap', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        installSession('outbound');
        const history = (await openLocalHistory('server|account'))!;
        syncForTest.localHistory = history;
        syncForTest.pendingOutbox.set('outbound', [{ localId: 'local', content: 'sent-cipher' }]);
        mocks.apiRequest.mockResolvedValue(response({ messages: [{ id: 'ack', seq: 5, localId: 'local', createdAt: 5, updatedAt: 5 }] }));
        await syncForTest.flushOutbox('outbound');
        expect((await history.readWindow('outbound', { anchorSeq: 5 }))?.messages[0].content.c).toBe('sent-cipher');
        expect(await history.readNewerPage('outbound', 0)).toBeNull();
    });

    it('falls back to the point snapshot when a cached encryption key cannot be hydrated', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        installSession('bad-key');
        delete mocks.state.sessions['bad-key'];
        const history = (await openLocalHistory('server|account'))!;
        await history.writeSnapshots([snapshot('bad-key')]);
        syncForTest.localHistory = history;
        mocks.hydrateRoute.mockResolvedValueOnce(null);
        mocks.fetchSnapshot.mockResolvedValue(snapshot('bad-key'));
        await expect(syncForTest.ensureSessionHydrated('bad-key')).resolves.toBe(true);
        expect(mocks.fetchSnapshot).toHaveBeenCalledOnce();
    });

    it('keeps new network content readable when persistence fails at a stale tail', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        installSession('quota');
        const history = (await openLocalHistory('server|account'))!;
        await history.commitPage('quota', { direction: 'older', boundary: 2147483647, messages: [apiMessage(40)], hasMore: false });
        await history.commitReconciliation({ changes: [{ sessionId: 'quota', revision: '1', deleted: false,
            lastMessageSeq: 41, metadataVersion: 1, agentStateVersion: 0 }], nextCursor: '1' });
        syncForTest.localHistory = history;
        await syncForTest.openSession('quota');
        vi.spyOn(history, 'commitPage').mockResolvedValue(false);
        mocks.apiRequest.mockResolvedValue(response({ messages: [apiMessage(41)], hasMore: false }));
        await syncForTest.jumpToLatestMessages('quota');
        expect(syncForTest.historyWindows.get('quota').newestSeq).toBe(41);
        expect(mocks.state.sessionMessages.quota.isAtLatest).toBe(true);
        expect((await history.readWindow('quota'))?.newestSeq).toBe(40);
    });

    it('keeps live permission updates outside a historical window and preserves its boundary flags', async () => {
        const actual = await useRealMessageComposition();
        actual.getState().applySessions([hydrated(snapshot('past'))]);
        actual.getState().applyMessagesLoaded('past');
        actual.setState(state => ({ sessionMessages: { ...state.sessionMessages, past: {
            ...state.sessionMessages.past, isAtLatest: false, hasMoreNewer: true,
        } } }));
        actual.getState().applySessions([{ ...actual.getState().sessions.past, agentStateVersion: 99,
            agentState: { controlledByUser: false, requests: { request: { tool: 'Bash', arguments: { command: 'pwd' }, createdAt: 100 } } },
        }]);
        expect(actual.getState().sessionMessages.past.isAtLatest).toBe(false);
        expect(actual.getState().sessionMessages.past.hasMoreNewer).toBe(true);
        expect(actual.getState().sessionMessages.past.messages).toEqual([]);
    });

    it.each(['account', 'reset', 'logout', 'session-delete'] as const)(
        'fences delayed forward JSON before persistence after %s', async transition => {
            globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
            const encryption = installSession('delayed');
            const original = (await openLocalHistory('server|original'))!;
            await original.commitPage('delayed', { direction: 'older', boundary: 2147483647, messages: [apiMessage(40)], hasMore: false });
            syncForTest.localHistory = original;
            const body = deferred<{ messages: ApiMessage[]; hasMore: boolean }>();
            const parsing = deferred<void>();
            mocks.apiRequest.mockResolvedValue({ ok: true, status: 200,
                json: () => { parsing.resolve(); return body.promise; } });
            const lease = syncForTest.sessionMessageLoadGate.enter('delayed');
            const pending = syncForTest.fetchForwardSince('delayed', encryption, 40, syncForTest.sessionMessageLoadGate.begin(lease));
            await parsing.promise;
            if (transition === 'reset') await syncForTest.resetLocalHistory();
            if (transition === 'logout') await clearLocalHistoryCaches();
            if (transition === 'session-delete') await original.deleteSession('delayed');
            const replacement = transition === 'session-delete' ? original
                : (await openLocalHistory(transition === 'reset' ? 'server|original' : 'server|next'))!;
            syncForTest.localHistory = replacement;
            body.resolve({ messages: [apiMessage(41)], hasMore: false });
            await pending;
            expect(await replacement.readWindow('delayed')).toBeNull();
            if (transition === 'account') {
                expect((await original.readWindow('delayed'))?.newestSeq).toBe(40);
                original.close();
            }
        });

    it.each(['socket', 'socket-recovery', 'forward'] as const)('retains new %s records in a full window when persistence fails', async source => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'android';
        const encryption = installSession('failed-write');
        const history = (await openLocalHistory('server|quota'))!;
        await history.commitPage('failed-write', { direction: 'older', boundary: 2147483647,
            messages: Array.from({ length: 300 }, (_, i) => apiMessage(i + 1)), hasMore: false });
        syncForTest.localHistory = history;
        const lease = syncForTest.sessionMessageLoadGate.enter('failed-write');
        await syncForTest.applyHistoryWindow('failed-write', await history.readWindow('failed-write', { limit: 300 }), syncForTest.sessionMessageLoadGate.begin(lease));
        if (source !== 'forward') {
            const append = vi.spyOn(history, 'appendMessages');
            if (source === 'socket-recovery') append.mockResolvedValueOnce(false);
            else append.mockResolvedValue(false);
            await syncForTest.handleUpdate(newMessageUpdate('failed-write', 301));
            await syncForTest.handleUpdate(newMessageUpdate('failed-write', 302));
        } else {
            vi.spyOn(history, 'commitPage').mockResolvedValue(false);
            mocks.apiRequest.mockResolvedValue(response({ messages: [apiMessage(301), apiMessage(302)], hasMore: false }));
            await syncForTest.fetchForwardSince('failed-write', encryption, 300, syncForTest.sessionMessageLoadGate.begin(lease));
        }
        const window = syncForTest.historyWindows.get('failed-write');
        expect(window.newestSeq).toBe(302);
        expect(window.messages.map((message: ApiMessage) => message.seq)).toContain(301);
        expect(window.messages.length).toBeLessThanOrEqual(300);
        expect(mocks.state.sessionMessages['failed-write'].messages.length).toBeLessThanOrEqual(300);
        expect(syncForTest.resolveRenderedMessageId('failed-write', 'message-302')).not.toBeNull();
        expect((await history.readWindow('failed-write'))?.newestSeq).toBe(300);
        expect(await history.readWindow('failed-write', { anchorSeq: 301 })).toBeNull();
    }, 20000);

    it('keeps a realtime row projected while the initial latest window is still replaying', async () => {
        Platform.OS = 'web';
        const replay = deferred<any[]>();
        let decryptCall = 0;
        const encryption = installSession('initial-live-race', async messages => {
            const decrypted = messages.map(message => ({
                id: message.id,
                localId: message.localId,
                createdAt: message.createdAt,
                content: rawText(`fetched-${message.seq}`),
            }));
            decryptCall += 1;
            return decryptCall === 2 ? replay.promise : decrypted;
        });
        mocks.state.currentViewingSessionId = 'initial-live-race';
        const lease = syncForTest.sessionMessageLoadGate.enter('initial-live-race');
        const applying = syncForTest.applyLatestMessagePage(
            'initial-live-race',
            { messages: [apiMessage(1)], hasMore: false },
            syncForTest.sessionMessageLoadGate.begin(lease),
        );
        await vi.waitFor(() => expect(encryption.decryptMessages).toHaveBeenCalledTimes(2));

        await syncForTest.handleUpdate(newMessageUpdate('initial-live-race', 2));
        await vi.waitFor(() => {
            expect(mocks.state.sessionMessages['initial-live-race']?.latestAppliedSeq).toBe(2);
            expect(mocks.state.sessionMessages['initial-live-race']?.messagesMap['message-2']).toBeDefined();
        });

        replay.resolve([{
            id: 'message-1',
            localId: null,
            createdAt: 10,
            content: rawText('fetched-1'),
        }]);
        await applying;

        const cache = mocks.state.sessionMessages['initial-live-race'];
        expect(cache.latestAppliedSeq).toBe(2);
        expect(cache.messages.filter((message: any) => (
            syncForTest.getMessageWireId('initial-live-race', message.id) === 'message-2'
        ))).toHaveLength(1);
        expect(syncForTest.historyWindows.get('initial-live-race')).toMatchObject({
            newestSeq: 2,
            isAtLatest: true,
        });
    });

    it('keeps the first realtime row when an empty initial page fails delayed persistence', async () => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        Platform.OS = 'web';
        installSession('empty-initial-live-race');
        const history = (await openLocalHistory('server|empty-initial-live-race'))!;
        const persistence = deferred<boolean>();
        vi.spyOn(history, 'commitPage').mockReturnValueOnce(persistence.promise);
        syncForTest.localHistory = history;
        mocks.state.currentViewingSessionId = 'empty-initial-live-race';
        const lease = syncForTest.sessionMessageLoadGate.enter('empty-initial-live-race');
        const applying = syncForTest.applyLatestMessagePage(
            'empty-initial-live-race',
            { messages: [], hasMore: false },
            syncForTest.sessionMessageLoadGate.begin(lease),
        );
        await vi.waitFor(() => expect(history.commitPage).toHaveBeenCalledOnce());

        await syncForTest.handleUpdate(newMessageUpdate('empty-initial-live-race', 1));
        await vi.waitFor(() => {
            expect(mocks.state.sessionMessages['empty-initial-live-race']?.latestAppliedSeq).toBe(1);
            expect(mocks.state.sessionMessages['empty-initial-live-race']?.messagesMap['message-1']).toBeDefined();
        });

        persistence.resolve(false);
        await applying;

        const cache = mocks.state.sessionMessages['empty-initial-live-race'];
        expect(cache.latestAppliedSeq).toBe(1);
        expect(cache.messages.filter((message: any) => (
            syncForTest.getMessageWireId('empty-initial-live-race', message.id) === 'message-1'
        ))).toHaveLength(1);
        expect(syncForTest.historyWindows.get('empty-initial-live-race')).toMatchObject({
            oldestSeq: 1,
            newestSeq: 1,
            isAtLatest: true,
        });
    });

    it('bounds a retained native initial replay after merging concurrent realtime rows', async () => {
        Platform.OS = 'android';
        installSession('native-initial-retention-bound');
        syncForTest.historyWindows.set('native-initial-retention-bound', {
            messages: Array.from({ length: 226 }, (_, index) => apiMessage(index + 76)),
            oldestSeq: 76,
            newestSeq: 301,
            hasMoreOlder: true,
            hasMoreNewer: false,
            isAtLatest: true,
        });
        const lease = syncForTest.sessionMessageLoadGate.enter('native-initial-retention-bound');

        await syncForTest.applyHistoryWindow('native-initial-retention-bound', {
            messages: Array.from({ length: 100 }, (_, index) => apiMessage(index + 1)),
            oldestSeq: 1,
            newestSeq: 100,
            hasMoreOlder: false,
            hasMoreNewer: false,
            isAtLatest: true,
        }, syncForTest.sessionMessageLoadGate.begin(lease), { retainCurrentRows: true });

        const window = syncForTest.historyWindows.get('native-initial-retention-bound');
        expect(window.messages).toHaveLength(300);
        expect(window).toMatchObject({
            oldestSeq: 2,
            newestSeq: 301,
            hasMoreOlder: true,
            hasMoreNewer: false,
            isAtLatest: true,
        });
        expect(mocks.state.sessionMessages['native-initial-retention-bound'].messages).toHaveLength(300);
    });

    it('projects accepted local receipts and remote rows while HTTP owns the message lock', async () => {
        const storage = await seedLocalProjectionSession();
        const lease = syncForTest.sessionMessageLoadGate.enter('spawned-session');
        await syncForTest.applyLatestMessagePage('spawned-session', { messages: [apiMessage(1)], hasMore: false },
            syncForTest.sessionMessageLoadGate.begin(lease));
        const http = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(http.promise);
        const loading = syncForTest.fetchMessages('spawned-session', syncForTest.sessionMessageLoadGate.begin(lease));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        const update = newMessageUpdate('spawned-session', 2);
        update.body.message = apiMessage(2, Buffer.from(JSON.stringify(rawText('remote'))).toString('base64'));
        await syncForTest.handleUpdate(update);
        vi.mocked(randomUUID).mockReturnValueOnce('local-a').mockReturnValueOnce('local-b');
        const first = await sync.sendMessage('spawned-session', 'hello', { source: 'new_session' });
        const second = await sync.sendMessage('spawned-session', 'next', { source: 'new_session' });
        try {
            let projected: boolean | undefined;
            const projection = sync.awaitLocalMessageProjection(first.sessionId, [...first.localIds, ...second.localIds])
                .then(value => { projected = value; });
            for (let i = 0; i < 10; i++) await Promise.resolve();
            expect(projected).toBe(true);
            await projection;
            const cache = storage.getState().sessionMessages['spawned-session'];
            expect(Object.values(cache.messagesMap).flatMap(message => message.kind === 'user-text' && message.localId
                ? [message.localId] : [])).toEqual(['local-a', 'local-b']);
            expect(cache.messages.filter(message => message.kind === 'user-text' && message.text === 'remote')).toHaveLength(1);
            for (const id of [...first.localIds, ...second.localIds]) {
                expect(cache.messagesMap[cache.reducerState.localIds.get(id)!]).toMatchObject({ localId: id });
            }
            expect(syncForTest.sessionMessageQueue.get('spawned-session')).toHaveLength(0);
            expect(syncForTest.pendingOutbox.get('spawned-session').map((message: any) => message.localId)).toEqual(['local-a', 'local-b']);
            expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
        } finally {
            http.resolve(response({ messages: [], hasMore: false }));
            await loading;
            await syncForTest.getSessionMessageLock('spawned-session').inLock(() => undefined);
        }
        expect(storage.getState().sessionMessages['spawned-session'].messages.some(message => message.kind === 'user-text' && message.text === 'remote')).toBe(true);
    });

    it.each(['deleted', 'evicted'] as const)('projects attachment and text receipts once and rejects a subsequently %s cache', async (terminal) => {
        const storage = await seedLocalProjectionSession();
        const http = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(http.promise);
        const loading = syncForTest.ensureMessagesLoaded('spawned-session');
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        const upload = vi.spyOn(syncForTest, 'uploadAttachmentsForSession').mockResolvedValue({
            uploaded: [{ ref: 'encrypted-file', name: 'photo.png', size: 1, width: 10, height: 10, thumbhash: 'thumbhash' }], failed: 0,
        });
        vi.mocked(randomUUID).mockReturnValueOnce('00000000-0000-4000-8000-000000000001').mockReturnValueOnce('local-file').mockReturnValueOnce('local-text');
        try {
            const receipt = await sync.sendMessage('spawned-session', 'hello', {
                source: 'new_session', attachments: [{ id: 'attachment' }] as any,
            });
            expect(receipt.localIds).toEqual(['local-file', 'local-text']);
            await expect(sync.awaitLocalMessageProjection(receipt.sessionId, receipt.localIds)).resolves.toBe(true);
            await expect(sync.awaitLocalMessageProjection(receipt.sessionId, receipt.localIds)).resolves.toBe(true);
            const cache = storage.getState().sessionMessages['spawned-session'];
            expect(cache.messages).toHaveLength(2);
            const fileId = cache.reducerState.toolIdToMessageId.get('00000000-0000-4000-8000-000000000001')!;
            expect(cache.reducerState.messages.get(fileId)?.realID).toBe('00000000-0000-4000-8000-000000000001');
            expect(cache.messagesMap[fileId]).toMatchObject({ kind: 'tool-call', tool: { name: 'file', state: 'completed' } });
            expect(cache.messagesMap[cache.reducerState.localIds.get('local-text')!]).toMatchObject({ localId: 'local-text', text: 'hello' });
            expect(syncForTest.pendingOutbox.get('spawned-session')).toHaveLength(2);
            expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
            const pending = sync.awaitLocalMessageProjection(receipt.sessionId, receipt.localIds);
            if (terminal === 'deleted') sync.removeSessionLocally(receipt.sessionId);
            else syncForTest.releaseSessionMessageCache(receipt.sessionId);
            await expect(pending).resolves.toBe(false);
            expect(storage.getState().sessionMessages[receipt.sessionId]).toBeUndefined();
        } finally {
            upload.mockRestore();
            http.resolve(response({ messages: [], hasMore: false }));
            await loading;
        }
    });

    it('keeps an accepted text and attachment receipt across an empty latest history replacement', async () => {
        // Catches a live/latest archive rebuild replacing the reducer with only
        // pre-ACK rows, which must not erase the already accepted local receipt.
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        const storage = await seedLocalProjectionSession();
        const history = (await openLocalHistory('server|account'))!;
        syncForTest.localHistory = history;
        const upload = vi.spyOn(syncForTest, 'uploadAttachmentsForSession').mockResolvedValue({
            uploaded: [{ ref: 'encrypted-file', name: 'photo.png', size: 1, width: 10, height: 10 }], failed: 0,
        });
        vi.mocked(randomUUID).mockReturnValueOnce('00000000-0000-4000-8000-000000000001').mockReturnValueOnce('local-file').mockReturnValueOnce('local-text');
        try {
            const receipt = await sync.sendMessage('spawned-session', 'hello', {
                source: 'new_session', attachments: [{ id: 'attachment' }] as any,
            });
            await expect(sync.awaitLocalMessageProjection(receipt.sessionId, receipt.localIds, receipt)).resolves.toBe(true);
            const lease = syncForTest.sessionMessageLoadGate.enter(receipt.sessionId);
            await syncForTest.applyLatestMessagePage(receipt.sessionId, { messages: [], hasMore: false },
                syncForTest.sessionMessageLoadGate.begin(lease));

            const cache = storage.getState().sessionMessages[receipt.sessionId];
            expect(cache.messages).toHaveLength(2);
            expect(cache.messagesMap[cache.reducerState.localIds.get('local-text')!]).toMatchObject({
                kind: 'user-text', localId: 'local-text', text: 'hello',
            });
            expect(cache.messagesMap[cache.reducerState.toolIdToMessageId.get('00000000-0000-4000-8000-000000000001')!]).toMatchObject({
                kind: 'tool-call', tool: { name: 'file' },
            });
            await expect(sync.awaitLocalMessageProjection(receipt.sessionId, receipt.localIds, receipt)).resolves.toBe(true);
        } finally {
            upload.mockRestore();
        }
    });

    it.each([false, true])('recovers a real echoed text/file spawn after full release with one handoff (fresh retain: %s)', async (retain) => {
        globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
        const storage = await seedLocalProjectionSession();
        syncForTest.localHistory = (await openLocalHistory('server|account'))!;
        syncForTest.sendSync.delete('spawned-session');
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 'spawned-session' });
        const acknowledgement = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(acknowledgement.promise);
        const upload = vi.spyOn(syncForTest, 'uploadAttachmentsForSession').mockResolvedValue({
            uploaded: [{ ref: 'encrypted-file', name: 'photo.png', size: 1, width: 10, height: 10 }], failed: 0,
        });
        vi.mocked(randomUUID).mockReturnValueOnce('trace-id').mockReturnValueOnce('00000000-0000-4000-8000-000000000001').mockReturnValueOnce('local-file').mockReturnValueOnce('local-text');
        const send = vi.spyOn(sync, 'sendMessage');
        const project = sync.awaitLocalMessageProjection.bind(sync);
        let receipt!: Awaited<ReturnType<typeof sync.sendMessage>>;
        let echoed: ApiMessage[] = [];
        const assertTextAndFile = () => {
            const cache = storage.getState().sessionMessages['spawned-session'];
            expect(cache.messages).toHaveLength(2);
            expect(cache.messages.filter(message => message.kind === 'user-text')).toHaveLength(1);
            expect(cache.messagesMap[cache.reducerState.localIds.get('local-text')!]).toMatchObject({
                kind: 'user-text', localId: 'local-text', text: 'hello',
            });
            const fileId = cache.reducerState.toolIdToMessageId.get('00000000-0000-4000-8000-000000000001')!;
            expect(cache.reducerState.messages.get(fileId)?.realID).toBe('00000000-0000-4000-8000-000000000001');
            expect(cache.messagesMap[fileId]).toMatchObject({ kind: 'tool-call', tool: { name: 'file', state: 'completed' } });
        };
        const projection = vi.spyOn(sync, 'awaitLocalMessageProjection').mockImplementationOnce(async (...args) => {
            receipt = args[2]!;
            await expect(project(...args)).resolves.toBe(true);
            await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
            // Echo the exact encrypted outbox contents, including the session/file
            // envelope. A text-only decryptor would fail the file identity checks.
            echoed = syncForTest.pendingOutbox.get(receipt.sessionId).map((entry: any, i: number) => ({
                ...apiMessage(10 + i), id: i === 0 ? 'remote-file' : 'remote-text',
                localId: entry.localId, content: { t: 'encrypted', c: entry.content },
            }));
            const lease = syncForTest.sessionMessageLoadGate.currentLease(receipt.sessionId)
                ?? syncForTest.sessionMessageLoadGate.enter(receipt.sessionId);
            await syncForTest.applyLatestMessagePage(receipt.sessionId, { messages: [], hasMore: false },
                syncForTest.sessionMessageLoadGate.begin(lease));
            assertTextAndFile();
            const generation = syncForTest.sessionMessageCacheGenerations.get(receipt.sessionId);
            // Inject loss of the display reducer while retaining the live
            // generation and receipt, so retry must execute actual recovery.
            storage.setState(state => ({ sessionMessages: { ...state.sessionMessages, [receipt.sessionId]: {
                ...state.sessionMessages[receipt.sessionId], messages: [], messagesMap: {}, reducerState: createReducer(),
            } } }));
            expect(storage.getState().sessionMessages[receipt.sessionId].messages).toHaveLength(0);
            expect(storage.getState().sessionMessages[receipt.sessionId].isAtLatest).toBe(true);
            expect(syncForTest.sessionMessageCacheGenerations.get(receipt.sessionId)).toBe(generation);
            await expect(project(...args)).resolves.toBe(true);
            assertTextAndFile();
            acknowledgement.resolve(response({ messages: [
                { id: 'remote-file', seq: 10, localId: 'local-file', createdAt: 100, updatedAt: 100 },
                { id: 'remote-text', seq: 11, localId: 'local-text', createdAt: 110, updatedAt: 110 },
            ] }));
            await vi.waitFor(() => expect(syncForTest.pendingOutbox.get(receipt.sessionId)).toBeUndefined());
            expect(generation.pendingLocalMessages.size).toBe(2);
            await syncForTest.applyLatestMessagePage(receipt.sessionId, { messages: echoed, hasMore: false },
                syncForTest.sessionMessageLoadGate.begin(lease));
            assertTextAndFile();
            const echoedCache = storage.getState().sessionMessages[receipt.sessionId];
            const textId = echoedCache.reducerState.localIds.get('local-text')!;
            expect(echoedCache.reducerState.messageIds.get('remote-text')).toBe(textId);
            expect(echoedCache.reducerState.messages.get(textId)?.realID).toBe('remote-text');
            expect(generation.pendingLocalMessages.size).toBe(0);
            expect(syncForTest.observedLocalMessageIds.get(receipt.sessionId).size).toBe(2);
            // The projection is unfinished when full cache loss crosses its
            // settlement boundary. The hook must keep the original receipt.
            const pending = project(...args);
            syncForTest.releaseSessionMessageCache(receipt.sessionId);
            if (retain) syncForTest.retainSessionMessageCache(receipt.sessionId);
            return pending;
        });
        const transferred = vi.fn();
        let hook!: ReturnType<typeof useSpawnSession>;
        function Harness() { hook = useSpawnSession(); return null; }
        let renderer: any;
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        try {
            await act(async () => { renderer = TestRenderer.create(React.createElement(Harness)); });
            await act(async () => {
                expect(await hook.spawn({
                    machineId: 'machine', machine: { id: 'machine', active: true, metadata: { homeDir: '/test' } } as any,
                    path: '/test', agent: 'codex', worktreeKey: null, prompt: 'hello',
                    images: [{ id: 'attachment' }] as any,
                }, false, transferred)).toBe(false);
            });
            expect(transferred).not.toHaveBeenCalled();
            expect(mocks.navigateToSession).not.toHaveBeenCalled();
            await expect(projection.mock.results[0].value).resolves.toBe(false);
            expect(storage.getState().sessionMessages[receipt.sessionId]).toBeUndefined();
            await act(async () => { expect(await hook.retryHydration()).toBe(true); });
            assertTextAndFile();
            expect(projection.mock.calls[1][2]).toBe(receipt);
            await act(async () => { expect(await hook.retryHydration()).toBe(false); });
            expect(send).toHaveBeenCalledTimes(1);
            expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
            expect(transferred).toHaveBeenCalledTimes(1);
            expect(mocks.navigateToSession.mock.calls).toEqual([['spawned-session']]);
            expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
            expect(syncForTest.pendingOutbox.get(receipt.sessionId)).toBeUndefined();

            const lease = syncForTest.sessionMessageLoadGate.enter(receipt.sessionId);
            await act(async () => {
                await syncForTest.applyLatestMessagePage(receipt.sessionId, { messages: echoed, hasMore: false },
                    syncForTest.sessionMessageLoadGate.begin(lease));
                assertTextAndFile();
                await syncForTest.applyLatestMessagePage(receipt.sessionId, {
                    messages: Array.from({ length: 300 }, (_, index) => apiMessage(index + 100)), hasMore: false,
                }, syncForTest.sessionMessageLoadGate.begin(lease));
            });
            const assertEvicted = () => {
                const cache = storage.getState().sessionMessages[receipt.sessionId];
                expect(cache.reducerState.localIds.has('local-text')).toBe(false);
                expect(cache.messages.some(message => message.kind === 'user-text' && message.localId === 'local-text')).toBe(false);
                expect(cache.reducerState.toolIdToMessageId.has('00000000-0000-4000-8000-000000000001')).toBe(false);
                expect(cache.messages.some(message => message.kind === 'tool-call' && message.tool.name === 'file')).toBe(false);
            };
            assertEvicted();
            await expect(project(receipt.sessionId, receipt.localIds, receipt)).resolves.toBe(false);
            assertEvicted();
            expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
        } finally {
            act(() => renderer?.unmount());
            acknowledgement.resolve(response({ messages: [] }));
            upload.mockRestore(); projection.mockRestore(); send.mockRestore();
            delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
        }
    });

    it.each([[], [''], [' '], ['missing'], ['test-uuid', 'missing'], ['__proto__'], ['constructor']].map(ids => ({ ids })))(
        'rejects unprojected or malformed literal receipt IDs $ids', async ({ ids }) => {
            const storage = await seedLocalProjectionSession();
            await sync.sendMessage('spawned-session', 'hello', { source: 'new_session' });
            await expect(sync.awaitLocalMessageProjection('spawned-session', ids)).resolves.toBe(false);
            expect(storage.getState().sessionMessages['spawned-session']?.messages.some(message => message.kind === 'user-text' && message.localId === 'test-uuid')).toBe(true);
            expect(mocks.apiRequest).not.toHaveBeenCalled();
        },
    );

    it.each(['before', 'during'] as const)('rejects deletion %s projection without recreating the cache', async (when) => {
        const storage = await seedLocalProjectionSession();
        const receipt = await sync.sendMessage('spawned-session', 'hello', { source: 'new_session' });
        if (when === 'before') sync.removeSessionLocally('spawned-session');
        const projection = sync.awaitLocalMessageProjection(receipt.sessionId, receipt.localIds);
        if (when === 'during') sync.removeSessionLocally('spawned-session');
        await expect(projection).resolves.toBe(false);
        expect(storage.getState().sessionMessages['spawned-session']).toBeUndefined();
        expect(storage.getState().sessions['spawned-session']).toBeUndefined();
        expect(mocks.apiRequest).not.toHaveBeenCalled();
    });

    it('rejects a cache generation replaced during projection even if the same IDs reappear', async () => {
        const storage = await seedLocalProjectionSession();
        const receipt = await sync.sendMessage('spawned-session', 'hello', { source: 'new_session' });
        const projection = sync.awaitLocalMessageProjection(receipt.sessionId, receipt.localIds);
        syncForTest.releaseSessionMessageCache('spawned-session');
        syncForTest.retainSessionMessageCache('spawned-session');
        storage.getState().applyMessages('spawned-session', [normalizeRawMessage('test-uuid', 'test-uuid', 1, rawText('replacement'))!]);
        await expect(projection).resolves.toBe(false);
    });

    it('restores an accepted receipt into a fresh empty generation without another send', async () => {
        const storage = await seedLocalProjectionSession();
        const receipt = await sync.sendMessage('spawned-session', 'hello', { source: 'new_session' });
        syncForTest.releaseSessionMessageCache(receipt.sessionId);
        syncForTest.retainSessionMessageCache(receipt.sessionId);

        await expect(sync.awaitLocalMessageProjection(receipt.sessionId, receipt.localIds, receipt)).resolves.toBe(true);
        expect(storage.getState().sessionMessages[receipt.sessionId].messages).toHaveLength(1);
        expect(mocks.apiRequest).not.toHaveBeenCalled();
        expect(syncForTest.pendingOutbox.get(receipt.sessionId)).toHaveLength(1);
    });

    it('rejects first submission queue acceptance when its owner changes during upload', async () => {
        await seedLocalProjectionSession();
        let current = true;
        const upload = vi.spyOn(syncForTest, 'uploadAttachmentsForSession').mockImplementation(async () => {
            current = false;
            return { uploaded: [{ ref: 'encrypted-file', name: 'photo.png', size: 1, width: 10, height: 10 }], failed: 0 };
        });
        try {
            await expect(sync.sendMessage('spawned-session', 'hello', {
                source: 'new_session', attachments: [{ id: 'attachment' }] as any, isCurrent: () => current,
            })).rejects.toThrow('local-message-session-unavailable');
            expect(syncForTest.pendingOutbox.get('spawned-session') ?? []).toEqual([]);
        } finally { upload.mockRestore(); }
    });

    it.each([false, true])('restores accepted attachment and text receipts after eviction (remote acknowledgement: %s)', async (acknowledged) => {
        // Losing generation-local provenance must not strand an accepted spawn.
        const storage = await seedLocalProjectionSession();
        const upload = vi.spyOn(syncForTest, 'uploadAttachmentsForSession').mockResolvedValue({
            uploaded: [{ ref: 'encrypted-file', name: 'photo.png', size: 1, width: 10, height: 10 }], failed: 0,
        });
        vi.mocked(randomUUID).mockReturnValueOnce('00000000-0000-4000-8000-000000000001').mockReturnValueOnce('local-file').mockReturnValueOnce('local-text');
        try {
            const receipt = await sync.sendMessage('spawned-session', 'hello', {
                source: 'new_session', attachments: [{ id: 'attachment' }] as any,
            });
            const accepted = [...syncForTest.pendingOutbox.get(receipt.sessionId)];
            const gap = newMessageUpdate(receipt.sessionId, 7);
            gap.body.message.content = { t: 'encrypted', c: 'AQ==' };
            await syncForTest.handleUpdate(gap);
            expect(storage.getState().sessionMessages[receipt.sessionId]).toBeUndefined();
            await expect(sync.awaitLocalMessageProjection(receipt.sessionId, ['local-file', 'local-file'], receipt)).resolves.toBe(false);
            expect(storage.getState().sessionMessages[receipt.sessionId]).toBeUndefined();
            if (acknowledged) {
                syncForTest.pendingOutbox.get(receipt.sessionId).splice(0);
                // The remote echo can use a different transport ID, but keeps
                // the exact accepted local ID and file envelope identity.
                storage.getState().applyMessages(receipt.sessionId, [
                    normalizeRawMessage('remote-text', 'local-text', 20, rawText('hello'))!,
                ]);
            }
            await expect(sync.awaitLocalMessageProjection(receipt.sessionId, receipt.localIds, receipt)).resolves.toBe(true);
            await expect(sync.awaitLocalMessageProjection(receipt.sessionId, receipt.localIds, receipt)).resolves.toBe(true);
            const cache = storage.getState().sessionMessages[receipt.sessionId];
            expect(cache.messages).toHaveLength(2);
            expect(cache.messagesMap[cache.reducerState.localIds.get('local-text')!]).toMatchObject({ kind: 'user-text', localId: 'local-text', text: 'hello' });
            expect(cache.messagesMap[cache.reducerState.toolIdToMessageId.get('00000000-0000-4000-8000-000000000001')!]).toMatchObject({ kind: 'tool-call', tool: { name: 'file' } });
            expect(syncForTest.pendingOutbox.get(receipt.sessionId)).toEqual(acknowledged ? [] : accepted);
            expect(mocks.apiRequest).not.toHaveBeenCalled();
        } finally {
            upload.mockRestore();
        }
    });

    it('does not recover a forged receipt or revive a deleted receipt after the same session ID returns', async () => {
        const storage = await seedLocalProjectionSession();
        const receipt = await sync.sendMessage('spawned-session', 'hello', { source: 'new_session' });
        syncForTest.releaseSessionMessageCache(receipt.sessionId);
        await expect(sync.awaitLocalMessageProjection(receipt.sessionId, receipt.localIds, { ...receipt })).resolves.toBe(false);
        sync.removeSessionLocally(receipt.sessionId);
        storage.getState().applySessions([hydrated(snapshot(receipt.sessionId))]);
        await expect(sync.awaitLocalMessageProjection(receipt.sessionId, receipt.localIds, receipt)).resolves.toBe(false);
        expect(storage.getState().sessionMessages[receipt.sessionId]).toBeUndefined();
        expect(mocks.apiRequest).not.toHaveBeenCalled();
    });

    it('retries an evicted accepted spawn with one real send, one accepted message and one navigation', async () => {
        const storage = await seedLocalProjectionSession();
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 'spawned-session' });
        const send = vi.spyOn(sync, 'sendMessage');
        const project = sync.awaitLocalMessageProjection.bind(sync);
        const projection = vi.spyOn(sync, 'awaitLocalMessageProjection').mockImplementationOnce((...args) => {
            const pending = project(...args);
            syncForTest.releaseSessionMessageCache('spawned-session');
            return pending;
        });
        const transferred = vi.fn();
        let hook!: ReturnType<typeof useSpawnSession>;
        function Harness() { hook = useSpawnSession(); return null; }
        let renderer: any;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        const originalConsoleError = console.error;
        const consoleError = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
        try {
            await act(async () => { renderer = TestRenderer.create(React.createElement(Harness)); });
            await act(async () => {
                expect(await hook.spawn({
                    machineId: 'machine', machine: { id: 'machine', active: true, metadata: { homeDir: '/test' } } as any,
                    path: '/test', agent: 'codex', worktreeKey: null, prompt: 'hello',
                }, false, transferred)).toBe(false);
            });
            expect(mocks.navigateToSession).not.toHaveBeenCalled();
            expect(transferred).not.toHaveBeenCalled();
            expect(storage.getState().sessionMessages['spawned-session']).toBeUndefined();
            await act(async () => { expect(await hook.retryHydration()).toBe(true); });
            await act(async () => { expect(await hook.retryHydration()).toBe(false); });
            expect(send).toHaveBeenCalledTimes(1);
            expect(mocks.machineSpawnNewSession).toHaveBeenCalledTimes(1);
            expect(mocks.navigateToSession.mock.calls).toEqual([['spawned-session']]);
            expect(transferred).toHaveBeenCalledTimes(1);
            expect(syncForTest.pendingOutbox.get('spawned-session')).toHaveLength(1);
            expect(storage.getState().sessionMessages['spawned-session'].messages).toHaveLength(1);
            expect(mocks.apiRequest).not.toHaveBeenCalled();
        } finally {
            act(() => renderer?.unmount());
            projection.mockRestore();
            send.mockRestore();
            consoleError.mockRestore();
            delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
        }
    });

    it('emits one final store milestone for snapshot plus latest-page opening, after both complete', async () => {
        installSession('attribution-session');
        delete mocks.state.sessions['attribution-session'];
        mocks.state.currentViewingSessionId = 'attribution-session';
        mocks.fetchSnapshot.mockResolvedValue(snapshot('attribution-session'));
        mocks.apiRequest.mockResolvedValue(response({ messages: [apiMessage(1)], hasMore: false }));
        const stages: string[] = [];
        (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe = {
            markAppStage: (stage: string) => stages.push(stage),
        };

        await expect(syncForTest.openSession('attribution-session')).resolves.toBe('ready');
        expect(mocks.state.sessionMessages['attribution-session'].messages.some((message: any) =>
            sync.getMessageWireId('attribution-session', message.id) === 'message-1')).toBe(true);
        expect(stages).toEqual([
            'web.messages.latest_started',
            'web.session.snapshot_started',
            'web.session.snapshot_completed',
            'web.messages.latest_completed',
            'web.session.store_committed',
        ]);
    });

    it('bounds the initial latest page while preserving 100-message explicit older pagination', async () => {
        installSession('bounded-initial');
        mocks.state.currentViewingSessionId = 'bounded-initial';
        mocks.apiRequest
            .mockResolvedValueOnce(response({ messages: [apiMessage(101), apiMessage(102)], hasMore: true }))
            .mockResolvedValueOnce(response({ messages: [apiMessage(1)], hasMore: false }));

        await expect(syncForTest.openSession('bounded-initial')).resolves.toBe('ready');
        await syncForTest.loadOlderMessages('bounded-initial');

        expect(mocks.apiRequest).toHaveBeenNthCalledWith(1,
            '/v3/sessions/bounded-initial/messages?before_seq=2147483647&limit=25');
        expect(mocks.apiRequest).toHaveBeenNthCalledWith(2,
            '/v3/sessions/bounded-initial/messages?before_seq=101&limit=100');
        expect(syncForTest.sessionMessageFrontiers.get('bounded-initial')?.olderBeforeSeq).toBe(1);
    });

    it('revalidates an already loaded route incrementally instead of downloading the latest page again', async () => {
        installSession('warm-route');
        mocks.state.sessionMessages['warm-route'] = {
            messages: [], messagesMap: {}, reducerState: {}, isLoaded: true,
            hasMoreOlder: false, isLoadingOlder: false,
        };
        seedProjectedFrontier('warm-route', {
            latestSeq: 42, olderBeforeSeq: 1, hasMoreOlder: false,
        });
        mocks.apiRequest.mockResolvedValue(response({ messages: [], hasMore: false }));

        await expect(syncForTest.openSession('warm-route')).resolves.toBe('ready');

        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
        expect(mocks.apiRequest).toHaveBeenCalledWith(
            '/v3/sessions/warm-route/messages?after_seq=42&limit=100',
        );
        expect(mocks.state.sessionMessages['warm-route'].latestVerifiedOwnerEpoch).not.toBeNull();
    });

    it('removes an offline-deleted cached session when incremental sync returns 404', async () => {
        const storage = await useRealMessageComposition();
        syncForTest.serverID = 'account';
        syncForTest.sessionWarmCacheAccountKey = 'account';
        mocks.sessionEncryptions.set('gone', new SessionEncryption('gone', {
            encrypt: async () => [], decrypt: async () => [],
        }, new EncryptionCache()));
        storage.getState().applySessions([hydrated(snapshot('gone'))]);
        storage.getState().applyMessagesLoaded('gone');
        seedProjectedFrontier('gone', { latestSeq: 42, olderBeforeSeq: 1, hasMoreOlder: false });
        saveSessionWarmSnapshots('account', [snapshot('gone')]);
        saveSessionWarmLatestPage('account', 'gone', { messages: [apiMessage(42)], hasMore: false });
        mocks.apiRequest.mockResolvedValue({ ok: false, status: 404 });

        await expect(syncForTest.openSession('gone')).rejects.toBeInstanceOf(SessionRouteAbandonedError);
        expect(storage.getState().sessions.gone).toBeUndefined();
        expect(loadSessionWarmCache('account')).toEqual({ snapshots: [], latestPages: {} });
        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
    });

    it('persists multiple incremental pages and restores their latest frontier', async () => {
        installSession('warm');
        syncForTest.serverID = 'account';
        syncForTest.sessionWarmCacheAccountKey = 'account';
        saveSessionWarmLatestPage('account', 'warm', { messages: [apiMessage(40)], hasMore: true });
        const lease = syncForTest.sessionMessageLoadGate.enter('warm');
        mocks.apiRequest
            .mockResolvedValueOnce(response({ messages: [apiMessage(41)], hasMore: true }))
            .mockResolvedValueOnce(response({ messages: [apiMessage(42)], hasMore: false }));
        await syncForTest.fetchForwardSince('warm', mocks.sessionEncryptions.get('warm'), 40,
            syncForTest.sessionMessageLoadGate.begin(lease));
        const page = loadSessionWarmCache('account').latestPages.warm;
        expect(page.messages.map(message => message.seq)).toEqual([40, 41, 42]);
        delete mocks.state.sessionMessages.warm;
        syncForTest.sessionMessageFrontiers.clear();
        await syncForTest.applyLatestMessagePage('warm', page, syncForTest.sessionMessageLoadGate.begin(lease));
        expect(syncForTest.getSessionLastMessageSeq('warm')).toBe(42);
    });

    it.each(['cached', 'shared'] as const)('attributes a route snapshot satisfied by %s hydration exactly once', async (source) => {
        installSession('prehydrated-session');
        mocks.state.currentViewingSessionId = 'prehydrated-session';
        const stages: string[] = [];
        (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe = {
            markAppStage: (stage: string) => stages.push(stage),
        };
        const shared = deferred<ApiSessionSnapshot | null>();
        let hydrating: Promise<boolean> | undefined;
        if (source === 'shared') {
            delete mocks.state.sessions['prehydrated-session'];
            mocks.fetchSnapshot.mockReturnValue(shared.promise);
            hydrating = syncForTest.ensureSessionHydrated('prehydrated-session');
        }
        const opening = syncForTest.openSession('prehydrated-session');
        if (source === 'shared') {
            await Promise.resolve();
            expect(stages).toEqual(['web.messages.latest_started', 'web.session.snapshot_started']);
            shared.resolve(snapshot('prehydrated-session'));
            await hydrating;
        }
        await expect(opening).resolves.toBe('ready');
        expect(mocks.fetchSnapshot).toHaveBeenCalledTimes(source === 'shared' ? 1 : 0);
        expect(stages).toEqual([
            'web.messages.latest_started', 'web.session.snapshot_started', 'web.session.snapshot_completed',
            'web.messages.latest_completed', 'web.session.store_committed',
        ]);
    });

    it('does not complete the snapshot span when a route awaiting shared hydration is abandoned', async () => {
        installSession('abandoned-hydration');
        delete mocks.state.sessions['abandoned-hydration'];
        const shared = deferred<ApiSessionSnapshot | null>();
        mocks.fetchSnapshot.mockReturnValue(shared.promise);
        const stages: string[] = [];
        (globalThis as { __happySessionCriticalPathProbe?: unknown }).__happySessionCriticalPathProbe = {
            markAppStage: (stage: string) => stages.push(stage),
        };
        const hydrating = syncForTest.ensureSessionHydrated('abandoned-hydration');
        const opening = syncForTest.openSession('abandoned-hydration');
        const rejected = expect(opening).rejects.toBeInstanceOf(SessionRouteAbandonedError);
        syncForTest.abandonSessionRoute('abandoned-hydration', opening);
        shared.resolve(snapshot('abandoned-hydration'));
        await hydrating;
        await rejected;
        expect(stages).toEqual(['web.messages.latest_started', 'web.session.snapshot_started']);
    });

    it('reuses downloaded older pages after all session memory is released', async () => {
        Platform.OS = 'android';
        const { storage, page } = await seedDisconnectedMessageRanges();
        syncForTest.sessionWarmCacheAccountKey = 'native-server|native-account';
        mocks.apiRequest.mockResolvedValue(response({ messages: page(51, 150), hasMore: true }));
        await syncForTest.loadOlderMessages('range-session');
        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);

        syncForTest.releaseSessionMessageCache('range-session');
        const lease = syncForTest.sessionMessageLoadGate.enter('range-session');
        await syncForTest.applyLatestMessagePage('range-session', { messages: page(151, 250), hasMore: true },
            syncForTest.sessionMessageLoadGate.begin(lease));
        mocks.apiRequest.mockClear();
        const loading = vi.spyOn(storage.getState(), 'applyOlderMessagesLoading');
        await syncForTest.loadOlderMessages('range-session');

        expect(mocks.apiRequest).not.toHaveBeenCalled();
        expect(loading).not.toHaveBeenCalledWith('range-session', true);
        loading.mockRestore();
        expect(storage.getState().sessionMessages['range-session'].messages).toHaveLength(200);
        expect(syncForTest.sessionMessageFrontiers.get('range-session').olderBeforeSeq).toBe(51);
    });

    it('retries unreadable native ciphertext from the network instead of trapping the reader on cached errors', async () => {
        Platform.OS = 'android';
        const { page } = await seedDisconnectedMessageRanges();
        syncForTest.sessionWarmCacheAccountKey = 'native-server|native-account';
        sessionHistoryPageCache.save('native-server|native-account', 'range-session', 151, {
            messages: [{ ...apiMessage(150), content: { t: 'encrypted', c: 'invalid ciphertext' } }], hasMore: true,
        });
        const encryption = mocks.sessionEncryptions.get('range-session');
        const detached = encryption.createDetached.bind(encryption);
        vi.spyOn(encryption, 'createDetached').mockImplementation(() => {
            const result = detached();
            const decrypt = result.decryptMessages.bind(result);
            result.decryptMessages = async (messages: ApiMessage[]) => messages.some(row => row.content.t === 'encrypted' && row.content.c === 'invalid ciphertext')
                ? messages.map(() => null) : decrypt(messages);
            return result;
        });
        mocks.apiRequest.mockResolvedValue(response({ messages: page(51, 150), hasMore: true }));
        await expect(syncForTest.loadOlderMessages('range-session')).resolves.toBeUndefined();
        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
        expect(sessionHistoryPageCache.readOlder('native-server|native-account', 'range-session', 151)?.messages).toHaveLength(100);
    });

    it('does not certify sparse startup warm messages as durable complete history', async () => {
        Platform.OS = 'android';
        const { page } = await seedDisconnectedMessageRanges();
        syncForTest.sessionWarmCacheAccountKey = 'native-server|native-account';
        saveSessionWarmSnapshots('native-server|native-account', [snapshot('range-session', 250)]);
        saveSessionWarmLatestPage('native-server|native-account', 'range-session', {
            messages: [...page(80, 80), ...page(150, 150)], hasMore: true,
        });
        syncForTest.releaseSessionMessageCache('range-session');
        await syncForTest.restoreSessionWarmCache();
        // A socket jump in the small startup cache proves neither the gap
        // 81..149 nor any earlier page; it must not acquire durable coverage.
        expect(sessionHistoryPageCache.readOlder('native-server|native-account', 'range-session', 151)).toBeNull();
    });

    it('does not repopulate native history from a latest HTTP request started before cache clearing', async () => {
        Platform.OS = 'android';
        const { page } = await seedDisconnectedMessageRanges();
        syncForTest.sessionWarmCacheAccountKey = 'native-server|native-account';
        const pending = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(pending.promise);
        const latest = syncForTest.fetchLatestMessagePageRaw('range-session');
        clearSessionWarmCache();
        pending.resolve(response({ messages: page(151, 250), hasMore: true }));
        const data = await latest;
        const lease = syncForTest.sessionMessageLoadGate.currentLease('range-session');
        await syncForTest.applyLatestMessagePage('range-session', data, syncForTest.sessionMessageLoadGate.begin(lease));
        expect(sessionHistoryPageCache.readOlder('native-server|native-account', 'range-session', 251)).toBeNull();
    });

    it('reaches a gap between cached history and the latest page exactly once', async () => {
        const { storage, page } = await seedDisconnectedMessageRanges();
        expect(Object.keys(storage.getState().sessionMessages['range-session'].messagesMap)).toHaveLength(200);
        mocks.apiRequest.mockResolvedValue(response({ messages: page(51, 150), hasMore: true }));

        await syncForTest.loadOlderMessages('range-session');

        expect(mocks.apiRequest).toHaveBeenCalledWith('/v3/sessions/range-session/messages?before_seq=151&limit=100');
        const ids = storage.getState().sessionMessages['range-session'].messages.map(message => message.id);
        expect(ids).toHaveLength(250);
        expect(new Set(ids).size).toBe(250);
        const normalizedIds = [...storage.getState().sessionMessages['range-session'].reducerState.messageIds.keys()];
        expect(normalizedIds.sort()).toEqual(Array.from({ length: 250 }, (_, i) => `message-${i + 1}`).sort());
        expect(storage.getState().sessionMessages['range-session'].hasMoreOlder).toBe(false);
        expect(syncForTest.getSessionLastMessageSeq('range-session')).toBe(250);
        await syncForTest.loadOlderMessages('range-session');
        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
    });

    it.each(['superseded', 'evicted', 'deleted'] as const)(
        'rejects a %s older response before bridging cached ranges', async (terminal) => {
            const { storage, page, lease } = await seedDisconnectedMessageRanges();
            const olderPage = deferred<Response>();
            mocks.apiRequest.mockReturnValueOnce(olderPage.promise);
            const loading = syncForTest.loadOlderMessages('range-session');
            await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledWith(
                '/v3/sessions/range-session/messages?before_seq=151&limit=100',
            ));
            if (terminal === 'superseded') {
                await syncForTest.applyLatestMessagePage('range-session', { messages: page(151, 250), hasMore: true },
                    syncForTest.sessionMessageLoadGate.begin(lease));
            } else if (terminal === 'evicted') {
                syncForTest.releaseSessionMessageCache('range-session');
            } else {
                await syncForTest.handleUpdate({ id: 'delete-range', seq: 9000, createdAt: 9000,
                    body: { t: 'delete-session', sid: 'range-session' } });
            }
            olderPage.resolve(response({ messages: page(51, 150), hasMore: true }));
            await loading;
            if (terminal === 'superseded') {
                expect(syncForTest.sessionMessageFrontiers.get('range-session')).toEqual({
                    latestSeq: 250, olderBeforeSeq: 151, hasMoreOlder: true,
                });
                expect(storage.getState().sessionMessages['range-session'].messages).toHaveLength(200);
                expect(storage.getState().sessionMessages['range-session'].isLoadingOlder).toBe(false);
                expect(syncForTest.sessionCachedMessageSeqs.get('range-session').has(101)).toBe(false);
            } else {
                expect(storage.getState().sessionMessages['range-session']).toBeUndefined();
                expect(syncForTest.sessionMessageFrontiers.has('range-session')).toBe(false);
                expect(syncForTest.sessionCachedMessageSeqs.has('range-session')).toBe(false);
            }
        },
    );

    it('does not let a send acknowledgement bridge an unseen message gap', async () => {
        const { page, lease } = await seedDisconnectedMessageRanges();
        syncForTest.pendingOutbox.set('range-session', [{ localId: 'sent-message', content: 'ciphertext' }]);
        mocks.apiRequest.mockResolvedValueOnce(response({ messages: [{ seq: 350 }] }));
        await syncForTest.flushOutbox('range-session');
        await syncForTest.applyLatestMessagePage('range-session', { messages: page(301, 400), hasMore: true },
            syncForTest.sessionMessageLoadGate.begin(lease));
        mocks.apiRequest.mockResolvedValueOnce(response({ messages: page(201, 300), hasMore: true }));

        await syncForTest.loadOlderMessages('range-session');

        expect(mocks.apiRequest).toHaveBeenLastCalledWith('/v3/sessions/range-session/messages?before_seq=301&limit=100');
        expect(syncForTest.getSessionLastMessageSeq('range-session')).toBe(400);
    });

    it('advances through sparse older pages and exhausts without skipping a cached island gap', async () => {
        const { storage, page } = await seedDisconnectedMessageRanges(20);
        mocks.apiRequest
            .mockResolvedValueOnce(response({ messages: page(50, 149), hasMore: true }))
            .mockResolvedValueOnce(response({ messages: page(21, 48), hasMore: false }));

        await syncForTest.loadOlderMessages('range-session');

        expect(mocks.apiRequest).toHaveBeenNthCalledWith(1, '/v3/sessions/range-session/messages?before_seq=151&limit=100');
        expect(syncForTest.sessionMessageFrontiers.get('range-session')).toEqual({
            latestSeq: 250, olderBeforeSeq: 50, hasMoreOlder: true,
        });
        await syncForTest.loadOlderMessages('range-session');
        expect(mocks.apiRequest).toHaveBeenNthCalledWith(2, '/v3/sessions/range-session/messages?before_seq=50&limit=100');
        expect(syncForTest.sessionMessageFrontiers.get('range-session')).toEqual({
            latestSeq: 250, olderBeforeSeq: 1, hasMoreOlder: false,
        });
        const messages = storage.getState().sessionMessages['range-session'];
        expect(messages.messages).toHaveLength(248);
        expect(new Set(messages.messages.map(message => message.id)).size).toBe(248);
        expect([...messages.reducerState.messageIds.keys()].sort()).toEqual([
            ...Array.from({ length: 48 }, (_, i) => `message-${i + 1}`),
            ...Array.from({ length: 100 }, (_, i) => `message-${i + 50}`),
            ...Array.from({ length: 100 }, (_, i) => `message-${i + 151}`),
        ].sort());
        expect(messages.hasMoreOlder).toBe(false);
        await syncForTest.loadOlderMessages('range-session');
        expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
    });

    it.each(['evicted', 'remounted'] as const)(
        'completes a deferred acknowledgement without changing the %s message cache', async (terminal) => {
            const { storage, page } = await seedDisconnectedMessageRanges();
            syncForTest.onSessionVisible('range-session', { loadMessages: false });
            syncForTest.pendingOutbox.set('range-session', [{ localId: 'deferred-send', content: 'ciphertext' }]);
            const acknowledgement = deferred<Response>();
            mocks.apiRequest.mockReturnValueOnce(acknowledgement.promise);
            const sending = syncForTest.flushOutbox('range-session');
            await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
            syncForTest.releaseSessionMessageCache('range-session');
            if (terminal === 'remounted') {
                syncForTest.onSessionVisible('range-session', { loadMessages: false });
                const lease = syncForTest.sessionMessageLoadGate.enter('range-session');
                await syncForTest.applyLatestMessagePage('range-session', { messages: page(301, 400), hasMore: false },
                    syncForTest.sessionMessageLoadGate.begin(lease));
            }

            acknowledgement.resolve(response({ messages: [{ seq: 500 }] }));
            await sending;

            expect(syncForTest.pendingOutbox.has('range-session')).toBe(false);
            expect(syncForTest.sendAbortControllers.has('range-session')).toBe(false);
            if (terminal === 'evicted') {
                expect(syncForTest.sessionMessageFrontiers.has('range-session')).toBe(false);
                expect(syncForTest.sessionMessageCacheGenerations.has('range-session')).toBe(false);
                expect(storage.getState().sessionMessages['range-session']).toBeUndefined();
            } else {
                expect(syncForTest.sessionMessageFrontiers.get('range-session')).toEqual({
                    latestSeq: 400, olderBeforeSeq: 301, hasMoreOlder: false,
                });
                expect(storage.getState().sessionMessages['range-session']).toMatchObject({
                    isLoaded: true, hasMoreOlder: false, isLoadingOlder: false,
                });
            }
        },
    );

    it('keeps a sparse older response bound to its requested frontier after an acknowledgement advances it', async () => {
        const { page } = await seedDisconnectedMessageRanges();
        const olderPage = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(olderPage.promise);
        const loading = syncForTest.loadOlderMessages('range-session');
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledWith(
            '/v3/sessions/range-session/messages?before_seq=151&limit=100',
        ));
        syncForTest.pendingOutbox.set('range-session', [{ localId: 'during-older', content: 'ciphertext' }]);
        mocks.apiRequest.mockResolvedValueOnce(response({ messages: [{ seq: 350 }] }));
        await syncForTest.flushOutbox('range-session');

        olderPage.resolve(response({ messages: page(50, 149), hasMore: false }));
        await loading;

        expect(syncForTest.sessionMessageFrontiers.get('range-session')).toEqual({
            latestSeq: 350, olderBeforeSeq: 350, hasMoreOlder: true,
        });
    });

    it.each([
        { order: 'latest-first', cold: false, terminal: '' },
        { order: 'catch-up-first', cold: false, terminal: '' },
        { order: 'latest-first', cold: true, terminal: '' },
        { order: 'catch-up-first', cold: true, terminal: '' },
        { order: 'latest-first', cold: false, terminal: '', retryCatchUp: true },
        { order: 'latest-first', cold: false, terminal: 'abandoned' },
        { order: 'catch-up-first', cold: false, terminal: 'deleted' },
    ])(
        'waits for a committed foreground page while opening ($order, cold=$cold, terminal=$terminal, retry=$retryCatchUp)', async ({ order, cold, terminal, retryCatchUp = false }) => {
            const probe = installPhase2Probe('deep-link');
            // Real storage/reducer + SessionEncryption; only the byte decrypt boundary is held.
            const storage = await useRealMessageComposition();
            storage.getState().applySessions([hydrated(snapshot('opening-session'))]);
            if (!cold) seedProjectedFrontier('opening-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false }, false);
            const latestDecrypt = deferred<void>();
            const forwardDecrypt = deferred<void>();
            let latestStarted = false;
            let forwardStarted = false;
            const encryption = new SessionEncryption('opening-session', {
                encrypt: async () => [],
                decrypt: async (bytes) => {
                    const seqs = bytes.map(value => value[0]);
                    if (seqs[0] === 7) {
                        if (!latestStarted) { latestStarted = true; await latestDecrypt.promise; }
                        else { forwardStarted = true; await forwardDecrypt.promise; }
                    }
                    if (seqs[0] === 5) { forwardStarted = true; await forwardDecrypt.promise; }
                    return seqs.map(seq => rawText(`message-${seq}`));
                },
            }, new EncryptionCache());
            mocks.sessionEncryptions.set('opening-session', encryption);
            const encrypted = (seq: number, id = `message-${seq}`): ApiMessage => ({
                ...apiMessage(seq), id,
                content: { t: 'encrypted', c: Buffer.from([seq]).toString('base64') },
            });
            let latestRequests = 0;
            let forwardRequests = 0;
            mocks.apiRequest.mockImplementation(async (url: string) => {
                if (url.includes('before_seq=')) {
                    latestRequests++;
                    return response({ messages: [encrypted(7)], hasMore: true });
                }
                if (retryCatchUp && forwardRequests++ === 0) throw new Error('synthetic catch-up failure');
                return response({ messages: [encrypted(5), encrypted(9, 'latest-visible-message')], hasMore: false });
            });
            const oldOwner = syncForTest.beginSessionRoute('opening-session');
            const owner = syncForTest.beginSessionRoute('opening-session');
            let outcome = 'pending';
            const opening = syncForTest.openSession('opening-session', owner);
            void opening.then((value: string) => { outcome = value; }, () => { outcome = 'rejected'; });
            await vi.waitFor(() => expect(latestStarted).toBe(true));
            const event = newMessageUpdate('opening-session', 9);
            event.body.message = encrypted(9);
            await syncForTest.handleUpdate(event);
            // Without opening ownership realtime drops this cache as background.
            await vi.waitFor(() => expect(forwardStarted).toBe(true), { timeout: 3000 });
            expect(storage.getState().currentViewingSessionId).toBeNull();
            // A cleanup belonging to the previous same-ID mount cannot stop this catch-up.
            expect(syncForTest.leaveSessionRoute(oldOwner)).toBe(false);
            const foregroundSync = syncForTest.messagesSync.get('opening-session');
            if (terminal === 'abandoned') syncForTest.leaveSessionRoute(owner);
            if (terminal === 'deleted') {
                await syncForTest.handleUpdate({ id: 'delete', seq: 10, createdAt: 100, body: { t: 'delete-session', sid: 'opening-session' } });
                expect(syncForTest.promoteSessionRoute(owner)).toBeNull();
            }
            if (order === 'latest-first') {
                latestDecrypt.resolve();
                await new Promise(resolve => setTimeout(resolve, 0));
                if (!terminal) expect(outcome).toBe('pending');
                forwardDecrypt.resolve();
            } else {
                forwardDecrypt.resolve();
                await foregroundSync.awaitQueue();
                latestDecrypt.resolve();
            }
            if (terminal) {
                await expect(opening).rejects.toThrow('abandoned');
                await foregroundSync.awaitQueue();
                expect(outcome).toBe('rejected');
                if (terminal === 'deleted') {
                    expect(storage.getState().sessionMessages['opening-session']).toBeUndefined();
                    expect(syncForTest.getSessionLastMessageSeq('opening-session')).toBeNull();
                }
                return;
            }
            await expect(opening).resolves.toBe('ready');
            expect(latestRequests).toBe(1);
            expect(storage.getState().sessionMessages['opening-session'].isLoaded).toBe(true);
            expect(storage.getState().sessionMessages['opening-session'].messages).toContainEqual(
                expect.objectContaining({ kind: 'user-text', text: 'message-9' }),
            );
            expect(storage.getState().sessionMessages['opening-session'].reducerState.messageIds.has('latest-visible-message')).toBe(true);
            expect(storage.getState().sessionMessages['opening-session'].latestVerifiedOwnerEpoch).not.toBeNull();
            expect(storage.getState().currentViewingSessionId).toBeNull();
            probe.markFreshLatestMessageComplete();
            expect(probe.collect().samples).toHaveLength(1);
            expect(probe.collect().samples[0].retryCount).toBe(retryCatchUp ? 1 : 0);
        },
    );

    it.each(['ready', 'exhausted', 'abandoned', 'deleted', 'abandoned-network', 'deleted-network'] as const)(
        'bounds latest-page recovery under the same live owner (%s)', async (result) => {
            const probe = installPhase2Probe('spawn');
            probe.startNewTextSession();
            probe.markNewSessionEvent(); probe.markLocalQueue(); probe.markAppStage('web.session.navigated');
            const storage = await useRealMessageComposition();
            storage.getState().applySessions([hydrated(snapshot('recovering-session'))]);
            seedProjectedFrontier('recovering-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false }, false);
            const latestDecrypt = deferred<void>();
            const forwardDecrypt = deferred<void>();
            const recoveryPage = deferred<Response>();
            let latestStarted = false;
            let forwardStarted = false;
            const encryption = new SessionEncryption('recovering-session', {
                encrypt: async () => [],
                decrypt: async (bytes) => {
                    const seqs = bytes.map(value => value[0]);
                    if (seqs[0] === 7) { latestStarted = true; await latestDecrypt.promise; }
                    if (seqs[0] === 8) { forwardStarted = true; await forwardDecrypt.promise; }
                    return seqs.map(seq => rawText(`message-${seq}`));
                },
            }, new EncryptionCache());
            mocks.sessionEncryptions.set('recovering-session', encryption);
            const encrypted = (seq: number): ApiMessage => ({
                ...apiMessage(seq), content: { t: 'encrypted', c: Buffer.from([seq]).toString('base64') },
            });
            let latestRequests = 0;
            mocks.apiRequest.mockImplementation((url: string) => {
                if (url.includes('before_seq=')) {
                    latestRequests++;
                    return latestRequests === 1
                        ? Promise.resolve(response({ messages: [encrypted(7)], hasMore: true }))
                        : recoveryPage.promise;
                }
                return Promise.resolve(response({ messages: url.includes('after_seq=4&') ? [encrypted(8)] : [], hasMore: false }));
            });
            const owner = syncForTest.beginSessionRoute('recovering-session');
            const opening = syncForTest.openSession('recovering-session', owner);
            const operation = syncForTest.activeOpenSession;
            const lease = syncForTest.sessionMessageLoadGate.currentLease('recovering-session');
            let outcome = 'pending';
            void opening.then(() => { outcome = 'ready'; }, () => { outcome = 'rejected'; });
            await vi.waitFor(() => expect(latestStarted).toBe(true));
            const update = newMessageUpdate('recovering-session', 9);
            update.body.message = encrypted(9);
            await syncForTest.handleUpdate(update);
            await vi.waitFor(() => expect(forwardStarted).toBe(true));
            latestDecrypt.resolve();
            forwardDecrypt.resolve();
            await vi.waitFor(() => expect(latestRequests).toBe(2));
            expect(outcome).toBe('pending');
            expect(syncForTest.sessionRouteOwnership.current()).toBe(owner);
            expect(syncForTest.activeOpenSession).toBe(operation);
            expect(syncForTest.sessionMessageLoadGate.currentLease('recovering-session')).toBe(lease);
            expect(storage.getState().currentViewingSessionId).toBeNull();
            if (result.startsWith('abandoned')) syncForTest.leaveSessionRoute(owner);
            if (result.startsWith('deleted')) {
                await syncForTest.handleUpdate({ id: 'delete', seq: 10, createdAt: 100, body: { t: 'delete-session', sid: 'recovering-session' } });
            }
            if (result.endsWith('-network')) recoveryPage.reject(new Error('recovery network unavailable'));
            else recoveryPage.resolve(response({ messages: [encrypted(result === 'exhausted' ? 8 : 9)], hasMore: false }));
            if (result === 'ready') {
                await expect(opening).resolves.toBe('ready');
                expect(storage.getState().sessionMessages['recovering-session'].messages).toContainEqual(
                    expect.objectContaining({ kind: 'user-text', text: 'message-9' }),
                );
                probe.markRouteNavigation(); probe.markProcessorReady(); probe.markFirstAgentEvent(); probe.markTurnCompletion();
                expect(probe.collect().samples[0].retryCount).toBe(1);
            } else if (result === 'exhausted') {
                await expect(opening).rejects.toMatchObject({ name: 'SessionRouteCoordinationError' });
            } else {
                await expect(opening).rejects.toThrow('abandoned');
                expect(storage.getState().sessionMessages['recovering-session']?.reducerState.messageIds.has('message-9')).not.toBe(true);
            }
            if (result === 'ready' || result === 'exhausted') {
                expect(syncForTest.sessionRouteOwnership.current()).toBe(owner);
                expect(syncForTest.activeOpenSession).toBe(operation);
            }
            expect(latestRequests).toBe(2);
            expect(storage.getState().currentViewingSessionId).toBeNull();
        },
    );

    it('exports the actual failed latest request and succeeding target-route retry as nonzero spawn evidence', async () => {
        const probe = installPhase2Probe('spawn');
        probe.startNewTextSession();
        probe.markNewSessionEvent(); probe.markLocalQueue(); probe.markAppStage('web.session.navigated');
        installSession('retry-target');
        mocks.apiRequest.mockRejectedValueOnce(new Error('synthetic-network-failure'))
            .mockResolvedValueOnce(response({ messages: [apiMessage(1)], hasMore: false }));
        const first = syncForTest.beginSessionRoute('retry-target');
        await expect(syncForTest.openSession('retry-target', first)).rejects.toThrow('synthetic-network-failure');
        syncForTest.leaveSessionRoute(first);
        const retry = syncForTest.beginSessionRoute('retry-target');
        await expect(syncForTest.openSession('retry-target', retry, { retry: true })).resolves.toBe('ready');
        probe.markRouteNavigation(); probe.markProcessorReady(); probe.markFirstAgentEvent(); probe.markTurnCompletion();
        const evidence = JSON.parse(JSON.stringify(probe.collect()));
        expect(evidence.samples[0].retryCount).toBe(1);
        expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
        const { evaluatePhase2CriticalPath } = await vi.importActual<any>('../../scripts/check-session-critical-path.mjs');
        expect(() => evaluatePhase2CriticalPath(evidence)).toThrow('RETRY_DETECTED');
    });

    it('keeps unrelated message fetches out of the measured route milestone set', async () => {
        const probe = installPhase2Probe('deep-link');
        installSession('unrelated'); installSession('measured');
        const lease = syncForTest.sessionMessageLoadGate.enter('unrelated');
        await syncForTest.fetchMessages('unrelated', syncForTest.sessionMessageLoadGate.begin(lease));
        await expect(syncForTest.openSession('measured')).resolves.toBe('ready');
        probe.markFreshLatestMessageComplete();
        const stages = probe.collect().samples[0].stages.map((entry: any) => entry.stage);
        expect(stages.filter((stage: string) => stage === 'web.messages.latest_started')).toHaveLength(1);
        expect(stages.filter((stage: string) => stage === 'web.session.store_committed')).toHaveLength(1);
    });

    it('does not fetch messages or git for an off-screen new-message event', async () => {
        installSession('visible-session');
        installSession('background-session');
        mocks.state.currentViewingSessionId = 'visible-session';

        await syncForTest.handleUpdate(newMessageUpdate('background-session', 8));
        await Promise.resolve();

        expect(mocks.apiRequest).not.toHaveBeenCalled();
        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
        expect(mocks.gitOpenInvalidate).not.toHaveBeenCalled();
        expect(mocks.state.sessions['background-session']).toMatchObject({ updatedAt: 80, seq: 8 });
    });

    it('clears viewing on deletion even after route ownership is revoked', async () => {
        const storage = await useRealMessageComposition();
        const encryption = new SessionEncryption('deleted-route', {
            encrypt: async () => [], decrypt: async () => [],
        }, new EncryptionCache());
        mocks.sessionEncryptions.set('deleted-route', encryption);
        storage.getState().applySessions([hydrated(snapshot('deleted-route'))]);
        const owner = syncForTest.beginSessionRoute('deleted-route');
        await syncForTest.openSession('deleted-route', owner);
        syncForTest.promoteSessionRoute(owner);
        storage.getState().setCurrentViewingSession('deleted-route');
        await syncForTest.handleUpdate({ id: 'delete', seq: 10, createdAt: 100, body: { t: 'delete-session', sid: 'deleted-route' } });
        expect(syncForTest.leaveSessionRoute(owner)).toBe(false);
        expect(storage.getState().currentViewingSessionId).toBeNull();
    });

    it('appends a consecutive visible message without an HTTP refresh', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        seedProjectedFrontier('visible-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false });

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 5));
        await vi.waitFor(() => {
            expect(mocks.state.sessionMessages['visible-session']?.messagesMap['message-5']).toBeDefined();
        });

        expect(mocks.apiRequest).not.toHaveBeenCalled();
        expect(syncForTest.getSessionLastMessageSeq('visible-session')).toBe(5);
    });

    it('receives encrypted startup ready before unowned spawn hydration finishes and never replays history as receipt', async () => {
        const probe = installPhase2Probe('spawn');
        const handle = sessionStartupTraceRuntime.begin('00000000-0000-4000-8000-000000000012', 0);
        sessionStartupTraceRuntime.mark(handle, 'web.spawn.clicked');
        sessionStartupTraceRuntime.bindSession(handle, 'pending-spawn');
        const encryption = installSession('pending-spawn');
        // Compose has bound the RPC result but is still waiting for encryption/hydration.
        delete mocks.state.sessions['pending-spawn'];
        const hydration = deferred<ApiSessionSnapshot | null>();
        mocks.fetchSnapshot.mockReturnValue(hydration.promise);
        const hydrating = syncForTest.ensureSessionHydrated('pending-spawn');
        await vi.waitFor(() => expect(mocks.fetchSnapshot).toHaveBeenCalled());
        // Realtime bootstrap has independently supplied the minimum decryption context.
        mocks.state.sessions['pending-spawn'] = hydrated(snapshot('pending-spawn'));
        const ready: RawRecord = { role: 'agent', content: { type: 'event', id: 'ready', data: { type: 'ready' } } };
        encryption.decryptMessage.mockResolvedValue({ id: 'ready', localId: null, createdAt: 50, content: ready });
        await syncForTest.handleUpdate(newMessageUpdate('pending-spawn', 1));
        expect(mocks.state.currentViewingSessionId).toBeNull();
        expect(syncForTest.sessionRouteOwnership.current()).toBeNull();
        expect(mocks.runtimeEvents.filter(event => event.stage === 'web.processor.ready_received')).toHaveLength(1);
        hydration.resolve(snapshot('pending-spawn'));
        await hydrating;
        sessionStartupTraceRuntime.mark(handle, 'web.session.hydrated');
        sessionStartupTraceRuntime.mark(handle, 'web.first_message.queued');
        sessionStartupTraceRuntime.mark(handle, 'web.session.navigated');
        probe.markRouteNavigation();
        sessionStartupTraceRuntime.markSessionStage('pending-spawn', 'web.first_agent_event_received');
        sessionStartupTraceRuntime.markSessionStage('pending-spawn', 'web.turn.completed');
        expect(probe.collect().samples).toHaveLength(1);

        delete (globalThis as any).__happySessionCriticalPathProbe;
        const replay = sessionStartupTraceRuntime.begin('00000000-0000-4000-8000-000000000013', 0);
        sessionStartupTraceRuntime.bindSession(replay, 'pending-spawn');
        mocks.runtimeEvents = [];
        syncForTest.applyMessages('pending-spawn', [normalizeRawMessage('ready', null, 50, ready)]);
        expect(mocks.runtimeEvents).toEqual([]);
        sessionStartupTraceRuntime.finish(replay);
    });

    it('records first agent activity before a combined catch-up batch closes the real runtime/probe', async () => {
        const probe = installPhase2Probe('spawn');
        const handle = sessionStartupTraceRuntime.begin('00000000-0000-4000-8000-000000000014', 0);
        for (const stage of ['web.spawn.clicked', 'web.session.hydrated', 'web.first_message.queued', 'web.session.navigated'] as const) {
            sessionStartupTraceRuntime.mark(handle, stage);
        }
        sessionStartupTraceRuntime.bindSession(handle, 'batch-session');
        probe.markRouteNavigation();
        const encryption = installSession('batch-session');
        const ready: RawRecord = { role: 'agent', content: { type: 'event', id: 'ready', data: { type: 'ready' } } };
        encryption.decryptMessage.mockResolvedValue({ id: 'ready', localId: null, createdAt: 1, content: ready });
        // A real realtime receipt is required; the same ready packet may also occur in catch-up.
        mocks.state.currentViewingSessionId = 'batch-session';
        seedProjectedFrontier('batch-session', { latestSeq: 0, olderBeforeSeq: null, hasMoreOlder: false });
        await syncForTest.handleUpdate(newMessageUpdate('batch-session', 1));
        await vi.waitFor(() => expect(mocks.runtimeEvents.some(e => e.stage === 'web.processor.ready_received')).toBe(true));
        const agent: RawRecord = { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'agent', message: { role: 'assistant', model: 'test-model', content: [{ type: 'text', text: 'test output' }] } } } };
        const terminal: RawRecord = { role: 'agent', content: { type: 'session', data: { id: 'end', time: 3, role: 'agent', turn: 'turn', ev: { t: 'turn-end', status: 'completed' } } } };
        syncForTest.applyMessages('batch-session', [ready, agent, terminal].map((raw, i) => normalizeRawMessage(`batch-${i}`, null, i, raw)));
        expect(mocks.runtimeEvents.map(e => e.stage).slice(-3)).toEqual([
            'web.processor.ready_received', 'web.first_agent_event_received', 'web.turn.completed',
        ]);
        expect(probe.collect().samples).toHaveLength(1);
    });

    it.each(['before', 'after'] as const)('collects live ready/agent/terminal stages without waiting for the fetch lock when route paint is %s completion', async (paint) => {
        const probe = installPhase2Probe('spawn');
        const handle = sessionStartupTraceRuntime.begin('00000000-0000-4000-8000-000000000015', 0);
        for (const stage of ['web.spawn.clicked', 'web.session.hydrated', 'web.first_message.queued', 'web.session.navigated'] as const) {
            sessionStartupTraceRuntime.mark(handle, stage);
        }
        sessionStartupTraceRuntime.bindSession(handle, 'queued-batch');
        const encryption = installSession('queued-batch');
        mocks.state.currentViewingSessionId = 'queued-batch';
        seedProjectedFrontier('queued-batch', { latestSeq: 0, olderBeforeSeq: null, hasMoreOlder: false });
        const packets = [
            { role: 'agent', content: { type: 'event', id: 'ready', data: { type: 'ready' } } },
            { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'output', message: { role: 'assistant', model: 'test', content: [{ type: 'text', text: 'test output' }] } } } },
            { role: 'agent', content: { type: 'session', data: { id: 'end', time: 3, role: 'agent', turn: 'turn', ev: { t: 'turn-end', status: 'completed' } } } },
        ];
        encryption.decryptMessage.mockImplementation(async (message: ApiMessage) => ({
            id: message.id, localId: null, createdAt: message.createdAt, content: packets[message.seq - 1],
        }));
        const release = deferred<void>();
        const holding = syncForTest.getSessionMessageLock('queued-batch').inLock(() => release.promise);
        if (paint === 'before') probe.markRouteNavigation();
        for (let seq = 1; seq <= 3; seq++) await syncForTest.handleUpdate(newMessageUpdate('queued-batch', seq));
        expect(syncForTest.sessionMessageQueue.get('queued-batch')).toHaveLength(0);
        expect(mocks.runtimeEvents.at(-1)?.stage).toBe('web.turn.completed');
        release.resolve(); await holding;
        await vi.waitFor(() => expect(mocks.runtimeEvents.at(-1)?.stage).toBe('web.turn.completed'));
        if (paint === 'after') probe.markRouteNavigation();
        expect(mocks.runtimeEvents.map(event => event.stage).slice(-3)).toEqual([
            'web.processor.ready_received', 'web.first_agent_event_received', 'web.turn.completed',
        ]);
        expect(probe.collect().samples).toHaveLength(1);
    });

    it('marks only processor readiness for a normalized encrypted ready event', async () => {
        // Catches a terminal lifecycle event being mistaken for startup processor readiness.
        const encryption = installSession('trace-session');
        mocks.state.currentViewingSessionId = 'trace-session';
        seedProjectedFrontier('trace-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false });
        const handle = sessionStartupTraceRuntime.begin('00000000-0000-4000-8000-000000000010', 0);
        sessionStartupTraceRuntime.bindSession(handle, 'trace-session');
        encryption.decryptMessage.mockResolvedValue({
            id: 'message-5',
            localId: null,
            createdAt: 50,
            content: {
                role: 'agent',
                content: {
                    type: 'event',
                    id: 'processor-ready',
                    data: { type: 'ready' },
                },
            },
        });

        await syncForTest.handleUpdate(newMessageUpdate('trace-session', 5));
        await vi.waitFor(() => {
            expect(mocks.runtimeEvents.map((event) => event.stage)).toContain('web.processor.ready_received');
        });
        expect(mocks.runtimeEvents.map((event) => event.stage)).not.toContain('web.turn.completed');

        await syncForTest.handleUpdate(newMessageUpdate('trace-session', 6));
        expect(mocks.runtimeEvents.filter((event) => event.stage === 'web.processor.ready_received')).toHaveLength(1);
        sessionStartupTraceRuntime.finish(handle);
    });

    it('marks turn completion without consuming a processor-ready milestone', async () => {
        // Catches a terminal turn-end falsely satisfying processor-ready startup latency.
        const encryption = installSession('terminal-session');
        mocks.state.currentViewingSessionId = 'terminal-session';
        seedProjectedFrontier('terminal-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false });
        const handle = sessionStartupTraceRuntime.begin('00000000-0000-4000-8000-000000000011', 0);
        sessionStartupTraceRuntime.bindSession(handle, 'terminal-session');
        encryption.decryptMessage.mockResolvedValue({
            id: 'message-5',
            localId: null,
            createdAt: 50,
            content: {
                role: 'agent',
                content: {
                    type: 'session',
                    data: {
                        id: 'turn-end-envelope',
                        time: 50,
                        role: 'agent',
                        turn: 'turn-1',
                        ev: { t: 'turn-end', status: 'completed' },
                    },
                },
            },
        });

        await syncForTest.handleUpdate(newMessageUpdate('terminal-session', 5));
        await vi.waitFor(() => {
            expect(mocks.runtimeEvents.map((event) => event.stage)).toContain('web.turn.completed');
        });
        expect(mocks.runtimeEvents.map((event) => event.stage)).not.toContain('web.processor.ready_received');
    });

    it('fills one sequence gap only for the visible session', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        seedProjectedFrontier('visible-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false });
        mocks.apiRequest.mockResolvedValue(response({
            messages: [apiMessage(5), apiMessage(6), apiMessage(7)],
            hasMore: false,
        }));

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        await vi.waitFor(() => {
            expect(mocks.state.sessionMessages['visible-session']?.messagesMap['message-7']).toBeDefined();
        });

        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
        expect(mocks.apiRequest).toHaveBeenCalledWith(
            '/v3/sessions/visible-session/messages?after_seq=4&limit=100',
        );
    });

    it('coalesces concurrent visible gaps into one forward operation', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        seedProjectedFrontier('visible-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false });
        const firstPage = deferred<Response>();
        mocks.apiRequest
            .mockReturnValueOnce(firstPage.promise)
            .mockResolvedValue(response({ messages: [], hasMore: false }));

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 8));
        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);

        firstPage.resolve(response({
            messages: [apiMessage(5), apiMessage(6), apiMessage(7), apiMessage(8)],
            hasMore: false,
        }));
        await syncForTest.messagesSync.get('visible-session').awaitQueue();

        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
        expect(syncForTest.getSessionLastMessageSeq('visible-session')).toBe(8);
    });

    it('runs one follow-up forward operation when an in-flight response misses a newer gap target', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        seedProjectedFrontier('visible-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false });
        const firstPage = deferred<Response>();
        mocks.apiRequest
            .mockReturnValueOnce(firstPage.promise)
            .mockResolvedValueOnce(response({ messages: [apiMessage(8)], hasMore: false }));

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 8));
        firstPage.resolve(response({
            messages: [apiMessage(5), apiMessage(6), apiMessage(7)],
            hasMore: false,
        }));

        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(2));
        await syncForTest.messagesSync.get('visible-session').awaitQueue();

        expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
        expect(mocks.apiRequest).toHaveBeenNthCalledWith(
            2,
            '/v3/sessions/visible-session/messages?after_seq=7&limit=100',
        );
        expect(mocks.state.sessionMessages['visible-session']?.messagesMap['message-8']).toBeDefined();
        expect(syncForTest.getSessionLastMessageSeq('visible-session')).toBe(8);
    });

    it.each([
        ['equal duplicate', 8],
        ['lower out-of-order', 7],
    ])('ignores a visible %s without history or git refresh', async (_label, incomingSeq) => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        seedProjectedFrontier('visible-session', { latestSeq: 8, olderBeforeSeq: null, hasMoreOlder: false });
        const previousCache = mocks.state.sessionMessages['visible-session'];

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', incomingSeq));
        await Promise.resolve();

        expect(mocks.apiRequest).not.toHaveBeenCalled();
        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
        expect(syncForTest.getSessionLastMessageSeq('visible-session')).toBe(8);
        expect(mocks.state.sessionMessages['visible-session']).toBe(previousCache);
    });

    it('keeps the newest realtime anchor when an older forward page returns later', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        seedProjectedFrontier('visible-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false });
        const page = deferred<Response>();
        mocks.apiRequest
            .mockReturnValueOnce(page.promise)
            .mockResolvedValue(response({ messages: [], hasMore: false }));

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 5));
        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 6));
        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        page.resolve(response({ messages: [apiMessage(5)], hasMore: false }));
        await syncForTest.messagesSync.get('visible-session').awaitQueue();

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 8));
        await Promise.resolve();

        expect(syncForTest.getSessionLastMessageSeq('visible-session')).toBe(8);
        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
    });

    it('does not fill a background gap and releases only its message cache', async () => {
        installSession('visible-session');
        const backgroundEncryption = installSession('background-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        mocks.state.sessionMessages['background-session'] = {
            messages: [{ id: 'cached' }],
            messagesMap: { cached: { id: 'cached' } },
            isLoaded: true,
            hasMoreOlder: true,
            isLoadingOlder: false,
        };
        seedProjectedFrontier('background-session', { latestSeq: 4, olderBeforeSeq: 2, hasMoreOlder: true });

        await syncForTest.handleUpdate(newMessageUpdate('background-session', 7));
        await Promise.resolve();

        expect(mocks.apiRequest).not.toHaveBeenCalled();
        expect(mocks.state.sessionMessages['background-session']).toBeUndefined();
        expect(syncForTest.getSessionLastMessageSeq('background-session')).toBeNull();
        expect(syncForTest.sessionMessageFrontiers.has('background-session')).toBe(false);
        expect(mocks.state.sessions['background-session']).toBeDefined();
        expect(syncForTest.encryption.getSessionEncryption('background-session')).toBe(backgroundEncryption);
    });

    it('refreshes git for a mutable tool result only while its session is visible', async () => {
        const visibleEncryption = installSession('visible-session');
        const backgroundEncryption = installSession('background-session');
        visibleEncryption.decryptMessage.mockImplementation(async (message: ApiMessage) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: rawToolResult('uuid-visible-session'),
        }));
        backgroundEncryption.decryptMessage.mockImplementation(async (message: ApiMessage) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: rawToolResult('uuid-background-session'),
        }));
        mocks.state.mutableToolCalls.add('visible-session:call-1');
        mocks.state.mutableToolCalls.add('background-session:call-1');
        seedProjectedFrontier('visible-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false });
        seedProjectedFrontier('background-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false });
        mocks.state.currentViewingSessionId = 'visible-session';

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 5));
        await syncForTest.handleUpdate(newMessageUpdate('background-session', 5));

        expect(mocks.gitInvalidate).toHaveBeenCalledTimes(1);
        expect(mocks.gitInvalidate).toHaveBeenCalledWith('visible-session');
    });

    it.each(['live', 'forward'] as const)('refreshes visible git when %s compaction keeps an older reading anchor', async source => {
        Platform.OS = 'web';
        const encryption = installSession('compact-git', async rows => rows.map(row => ({ ...row,
            content: row.seq === 501 ? rawToolResult('compact-tool-result') : rawText(`fetched-${row.seq}`),
        })));
        encryption.decryptMessage.mockImplementation(async (row: ApiMessage) => ({ ...row, content: rawToolResult('compact-tool-result') }));
        const lease = syncForTest.sessionMessageLoadGate.enter('compact-git');
        await syncForTest.applyLatestMessagePage('compact-git', {
            messages: Array.from({ length: 500 }, (_, i) => apiMessage(i + 1)), hasMore: false,
        }, syncForTest.sessionMessageLoadGate.begin(lease));
        mocks.state.currentViewingSessionId = 'compact-git';
        mocks.state.mutableToolCalls.add('compact-git:call-1');
        await sync.saveSessionReadingState('compact-git', { version: 1, anchorId: 'message-20', anchorSeq: 20,
            offset: 0, expandedGroupIds: [], followLatest: false });
        if (source === 'live') await syncForTest.handleUpdate(newMessageUpdate('compact-git', 501));
        else {
            mocks.apiRequest.mockResolvedValueOnce(response({ messages: [apiMessage(501)], hasMore: false }));
            await syncForTest.fetchForwardSince('compact-git', encryption, 500, syncForTest.sessionMessageLoadGate.begin(lease));
        }
        expect(syncForTest.historyWindows.get('compact-git')).toMatchObject({ isAtLatest: false, hasMoreNewer: true });
        expect(mocks.gitInvalidate).toHaveBeenCalledTimes(1);
        expect(mocks.gitInvalidate).toHaveBeenCalledWith('compact-git');
    });

    it('refreshes git once when a visible gap contains a fetched mutable tool result', async () => {
        installSession('visible-session', async (messages) => messages.map((message) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: message.seq === 5 ? rawToolResult('uuid-gap-tool') : rawText(`fetched-${message.seq}`),
        })));
        mocks.state.currentViewingSessionId = 'visible-session';
        mocks.state.mutableToolCalls.add('visible-session:call-1');
        seedProjectedFrontier('visible-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false });
        mocks.apiRequest.mockResolvedValue(response({
            messages: [apiMessage(5), apiMessage(6), apiMessage(7)],
            hasMore: false,
        }));

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        await vi.waitFor(() => {
            expect(mocks.state.sessionMessages['visible-session']?.messagesMap['message-7']).toBeDefined();
        });

        expect(mocks.gitInvalidate).toHaveBeenCalledTimes(1);
        expect(mocks.gitInvalidate).toHaveBeenCalledWith('visible-session');
    });

    it('refreshes git once when a later forward page fails after a mutable page was applied', async () => {
        const random = vi.spyOn(Math, 'random').mockReturnValue(0);
        const firstFailedPageRefresh = deferred<void>();
        mocks.gitInvalidate.mockImplementationOnce(() => { firstFailedPageRefresh.resolve(); });
        installSession('visible-session', async (messages) => messages.map((message) => ({
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            content: rawToolResult(`uuid-partial-${message.seq}`),
        })));
        mocks.state.currentViewingSessionId = 'visible-session';
        mocks.state.mutableToolCalls.add('visible-session:call-1');
        seedProjectedFrontier('visible-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false });
        mocks.apiRequest
            .mockResolvedValueOnce(response({ messages: [apiMessage(5)], hasMore: true }))
            .mockRejectedValueOnce(new Error('second page unavailable'));

        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 7));
        const messageSync = syncForTest.messagesSync.get('visible-session');
        try {
            // Observe the first failure's finally boundary before any retry.
            // Polling can miss exactly-two requests when random backoff is 0ms.
            await firstFailedPageRefresh.promise;
            expect(mocks.apiRequest).toHaveBeenCalledTimes(2);

            expect(mocks.state.sessionMessages['visible-session']?.messagesMap['message-5']).toBeDefined();
            expect(syncForTest.getSessionLastMessageSeq('visible-session')).toBe(5);
            expect(mocks.gitInvalidate).toHaveBeenCalledTimes(1);
        } finally {
            syncForTest.releaseSessionMessageCache('visible-session');
            await messageSync.awaitQueue();
            random.mockRestore();
        }
    });

    it('does not refresh git for an agent-state update without message tool-result semantics', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';

        await syncForTest.handleUpdate({
            id: 'agent-state-update',
            seq: 8,
            createdAt: 80,
            body: {
                t: 'update-session',
                id: 'visible-session',
                metadata: null,
                agentState: { version: 8, value: 'agent-state-ciphertext' },
            },
        });

        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
    });

    it('refreshes git when the user explicitly opens a session', () => {
        installSession('visible-session');

        syncForTest.onSessionVisible('visible-session', { loadMessages: false });

        expect(mocks.gitOpenInvalidate).toHaveBeenCalledTimes(1);
    });

    it('evicts exactly the least recently viewed message cache and all of its message runtime', () => {
        installSession('session-a');
        const evictedEncryption = installSession('session-b');
        installSession('session-c');
        installSession('session-d');
        for (const sessionId of ['session-a', 'session-b', 'session-c', 'session-d']) {
            mocks.state.sessionMessages[sessionId] = { messages: [], messagesMap: {}, isLoaded: true };
            seedProjectedFrontier(sessionId, { latestSeq: 9, olderBeforeSeq: 2, hasMoreOlder: true });
            syncForTest.sessionMessageLocks.set(sessionId, {});
            syncForTest.sessionMessageQueue.set(sessionId, []);
        }
        const evictedLease = syncForTest.sessionMessageLoadGate.enter('session-b');
        const evictedOperation = syncForTest.sessionMessageLoadGate.begin(evictedLease);
        const evictedSync = { stop: vi.fn() };
        syncForTest.messagesSync.set('session-b', evictedSync);
        syncForTest.sessionQueueProcessing.set('session-b', {});

        syncForTest.onSessionVisible('session-a', { loadMessages: false });
        syncForTest.onSessionVisible('session-b', { loadMessages: false });
        syncForTest.onSessionVisible('session-c', { loadMessages: false });
        syncForTest.onSessionVisible('session-a', { loadMessages: false });
        syncForTest.onSessionVisible('session-d', { loadMessages: false });

        expect(mocks.state.sessionMessages['session-b']).toBeUndefined();
        expect(syncForTest.sessionMessageFrontiers.has('session-b')).toBe(false);
        expect(syncForTest.sessionCachedMessageSeqs.has('session-b')).toBe(false);
        expect(syncForTest.sessionMessageLocks.has('session-b')).toBe(false);
        expect(syncForTest.sessionMessageQueue.has('session-b')).toBe(false);
        expect(syncForTest.sessionQueueProcessing.has('session-b')).toBe(false);
        expect(syncForTest.messagesSync.has('session-b')).toBe(false);
        expect(evictedSync.stop).toHaveBeenCalledTimes(1);
        expect(mocks.state.sessionMessages['session-a']).toBeDefined();
        expect(mocks.state.sessionMessages['session-c']).toBeDefined();
        expect(mocks.state.sessionMessages['session-d']).toBeDefined();
        expect(mocks.state.sessions['session-b']).toBeDefined();
        expect(syncForTest.encryption.getSessionEncryption('session-b')).toBe(evictedEncryption);
        expect(syncForTest.sessionMessageLoadGate.isCurrent(evictedOperation)).toBe(false);
    });

    it('ignores an initial response invalidated while message decryption is in flight', async () => {
        const decrypted = deferred<any[]>();
        const encryption = installSession('stale-session', async () => decrypted.promise);
        mocks.state.currentViewingSessionId = 'stale-session';
        mocks.apiRequest.mockResolvedValue(response({ messages: [apiMessage(9)], hasMore: true }));

        const loading = syncForTest.ensureMessagesLoaded('stale-session');
        await vi.waitFor(() => expect(encryption.decryptMessages).toHaveBeenCalledTimes(1));
        syncForTest.releaseSessionMessageCache('stale-session');
        decrypted.resolve([{
            id: 'message-9',
            localId: null,
            createdAt: 90,
            content: rawText('stale'),
        }]);
        await loading;
        await Promise.resolve();

        expect(mocks.state.sessionMessages['stale-session']).toBeUndefined();
        expect(syncForTest.getSessionLastMessageSeq('stale-session')).toBeNull();
        expect(syncForTest.sessionMessageFrontiers.has('stale-session')).toBe(false);
    });

    it('invalidates a route-owned forward decrypt when that mount leaves', async () => {
        const encryption = installSession('leased-session');
        mocks.state.currentViewingSessionId = 'leased-session';
        mocks.apiRequest.mockResolvedValue(response({ messages: [], hasMore: false }));
        const opening = syncForTest.openSession('leased-session');
        await expect(opening).resolves.toBe('ready');
        seedProjectedFrontier('leased-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false });
        mocks.apiRequest.mockClear();
        const decrypted = deferred<any[]>();
        encryption.decryptMessages.mockImplementation(async () => decrypted.promise);
        mocks.state.mutableToolCalls.add('leased-session:call-1');
        mocks.apiRequest.mockResolvedValue(response({ messages: [apiMessage(5), apiMessage(6), apiMessage(7)], hasMore: false }));

        await syncForTest.handleUpdate(newMessageUpdate('leased-session', 7));
        await vi.waitFor(() => expect(encryption.decryptMessages).toHaveBeenCalledTimes(1));
        await syncForTest.handleUpdate(newMessageUpdate('leased-session', 8));
        const messageSync = syncForTest.messagesSync.get('leased-session');
        syncForTest.abandonSessionRoute('leased-session', opening);
        mocks.state.currentViewingSessionId = null;
        decrypted.resolve([{
            id: 'message-5',
            localId: null,
            createdAt: 50,
            content: rawToolResult('uuid-stale-route'),
        }]);
        await messageSync.awaitQueue();

        expect(mocks.state.sessionMessages['leased-session']?.messagesMap['message-5']).toBeUndefined();
        expect(syncForTest.getSessionLastMessageSeq('leased-session')).toBe(4);
        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
    });

    it('keeps a newer same-id open owned when an older route cleanup runs', async () => {
        const oldSnapshot = deferred<ApiSessionSnapshot | null>();
        mocks.fetchSnapshot
            .mockReturnValueOnce(oldSnapshot.promise)
            .mockResolvedValueOnce(snapshot('same-session', 20));
        mocks.apiRequest.mockResolvedValue(response({ messages: [], hasMore: false }));
        mocks.hydrateRoute.mockImplementation(async (raw: ApiSessionSnapshot) => {
            const encryption = {
                createDetached() { return this; },
                decryptMessage: vi.fn(async (message: ApiMessage) => ({
                    id: message.id,
                    localId: message.localId,
                    createdAt: message.createdAt,
                    content: rawText(`realtime-${message.seq}`),
                })),
                decryptMessages: vi.fn(async (messages: ApiMessage[]) => messages.map((message) => ({
                    id: message.id,
                    localId: message.localId,
                    createdAt: message.createdAt,
                    content: rawText(`fetched-${message.seq}`),
                }))),
            };
            return {
                session: hydrated(raw),
                commitEncryption: () => {
                    mocks.sessionEncryptions.set(raw.id, encryption);
                    return true;
                },
            };
        });

        const oldOpening = syncForTest.openSession('same-session');
        const newOpening = syncForTest.openSession('same-session');
        await expect(newOpening).resolves.toBe('ready');
        seedProjectedFrontier('same-session', { latestSeq: 4, olderBeforeSeq: null, hasMoreOlder: false });
        mocks.state.currentViewingSessionId = 'same-session';
        const forwardPage = deferred<Response>();
        mocks.apiRequest.mockClear();
        mocks.apiRequest.mockReturnValue(forwardPage.promise);
        await syncForTest.handleUpdate(newMessageUpdate('same-session', 7));
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        const messageSync = syncForTest.messagesSync.get('same-session');
        syncForTest.abandonSessionRoute('same-session', oldOpening);
        forwardPage.resolve(response({
            messages: [apiMessage(5), apiMessage(6), apiMessage(7)],
            hasMore: false,
        }));
        await messageSync.awaitQueue();
        oldSnapshot.resolve(snapshot('same-session', 2));

        await expect(oldOpening).rejects.toThrow('abandoned');
        expect(mocks.state.sessions['same-session']).toMatchObject({ seq: 20 });
        expect(mocks.state.sessionMessages['same-session']).toMatchObject({ isLoaded: true });
        expect(mocks.state.sessionMessages['same-session'].messages.some((message: any) =>
            sync.getMessageWireId('same-session', message.id) === 'message-7')).toBe(true);
        expect(syncForTest.getSessionLastMessageSeq('same-session')).toBe(7);
    });

    async function installHistoricalBoundary(scope: string, retainedHistory?: NonNullable<Awaited<ReturnType<typeof openLocalHistory>>>) {
        const history = retainedHistory ?? (await openLocalHistory(scope))!;
        syncForTest.localHistory = history;
        installSession('visible-session');
        await history.commitPage('visible-session', { direction: 'older', boundary: 103,
            messages: [apiMessage(100), apiMessage(101), apiMessage(102)], hasMore: true });
        const lease = syncForTest.sessionMessageLoadGate.currentLease('visible-session') ?? syncForTest.sessionMessageLoadGate.enter('visible-session');
        await syncForTest.applyHistoryWindow('visible-session', await history.readWindow('visible-session', { anchorSeq: 101 }),
            syncForTest.sessionMessageLoadGate.begin(lease));
        return history;
    }

    async function mountBoundaryChat(direction: 'older' | 'newer') {
        const { ChatList } = await import('@/components/ChatList');
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        // The store double exposes sync's actual writes. Re-render publishes
        // each settled write to the mounted ChatList, without mocking paging.
        const render = () => React.createElement(ChatList, { session: { ...mocks.state.sessions['visible-session'] } as any });
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(render()); });
        return {
            renderer,
            update: async () => { await act(async () => { renderer.update(render()); }); },
            reach: () => act(() => {
                const list = renderer.root.findByType('FlatList');
                list.props.onScrollBeginDrag();
                list.props.onScroll({ nativeEvent: {
                    contentOffset: { y: (direction === 'older') === list.props.inverted ? 4500 : 0 },
                    contentSize: { height: 5000 }, layoutMeasurement: { height: 500 },
                } });
            }),
            retry: () => act(() => renderer.root.findByProps({ testID: `history-${direction}-retry` }).props.onPress()),
            unmount: () => act(() => renderer.unmount()),
        };
    }

    it.each(['older', 'newer'] as const)('releases superseded Web %s loading and retries the same boundary through mounted ChatList', async direction => {
        vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
        await installHistoricalBoundary(`server|web-${direction}`);
        const originalRows = mocks.state.sessionMessages['visible-session'].messages;
        const firstPage = deferred<Response>();
        mocks.apiRequest.mockReturnValueOnce(firstPage.promise)
            .mockResolvedValueOnce(response({ messages: [apiMessage(direction === 'older' ? 99 : 103)], hasMore: false }));
        const chat = await mountBoundaryChat(direction);
        try {
            chat.reach();
            await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
            const first = syncForTest.historyWindowLoads.get('visible-session');
            const field = direction === 'older' ? 'isLoadingOlder' : 'isLoadingNewer';
            expect(mocks.state.sessionMessages['visible-session'][field]).toBe(true);
            await chat.update();
            syncForTest.onSessionVisible('visible-session');
            await syncForTest.messagesSync.get('visible-session').awaitQueue(); // historical foreground no-op, but new loadEpoch
            firstPage.resolve(response({ messages: [], hasMore: true }));
            await first;
            expect(mocks.state.sessionMessages['visible-session'][field]).toBe(false);
            expect(mocks.state.sessionMessages['visible-session'].messages).toBe(originalRows);
            await chat.update();
            // Normal repeated scrolling is bounded; explicit Retry bypasses the
            // transcript's attempted-boundary latch for the identical edge.
            chat.reach(); expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
            chat.retry();
            await syncForTest.historyWindowLoads.get('visible-session');
            await chat.update();
            expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
            expect(mocks.apiRequest.mock.calls[1][0]).toBe(mocks.apiRequest.mock.calls[0][0]);
            expect(mocks.state.sessionMessages['visible-session'][field]).toBe(false);
            expect(mocks.state.sessionMessages['visible-session'][`${direction}Error`] ?? null).toBeNull();
            expect(syncForTest.historyWindows.get('visible-session').messages.some((row: ApiMessage) => row.seq === (direction === 'older' ? 99 : 103))).toBe(true);
            expect(chat.renderer.root.findAllByProps({ testID: `history-${direction}-retry` })).toHaveLength(0);
        } finally { chat.unmount(); }
    });

    it.each([['older', 'remount'], ['newer', 'remount'], ['older', 'account'], ['newer', 'account']] as const)(
        'does not let stale Web %s cleanup alter a %s replacement cache', async (direction, replacement) => {
            vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
            const oldHistory = await installHistoricalBoundary('server|old-boundary');
            const oldPage = deferred<Response>(); const newPage = deferred<Response>();
            mocks.apiRequest.mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(newPage.promise);
            const load = () => direction === 'older' ? sync.loadOlderMessages('visible-session') : sync.loadNewerMessages('visible-session');
            const oldLoading = load(); await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
            if (replacement === 'remount') syncForTest.releaseSessionMessageCache('visible-session');
            else syncForTest.encryption = { ...syncForTest.encryption };
            await installHistoricalBoundary(`server|${replacement}-replacement`, replacement === 'remount' ? oldHistory : undefined);
            const newLoading = load(); await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(2));
            oldPage.reject(new Error('stale owner failed'));
            await oldLoading;
            const field = direction === 'older' ? 'isLoadingOlder' : 'isLoadingNewer';
            expect(mocks.state.sessionMessages['visible-session'][field]).toBe(true);
            expect(mocks.state.sessionMessages['visible-session'][`${direction}Error`]).toBeNull();
            newPage.resolve(response({ messages: [apiMessage(direction === 'older' ? 99 : 103)], hasMore: false }));
            await newLoading;
            expect(mocks.state.sessionMessages['visible-session'][field]).toBe(false);
            expect(syncForTest.historyWindows.get('visible-session').messages.some((row: ApiMessage) => row.seq === (direction === 'older' ? 99 : 103))).toBe(true);
            oldHistory.close();
        });

    it.each(['web', 'android'] as const)('renders a retryable no-IDB older failure on %s through mounted ChatList and clears it after retry', async platform => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        (Platform as any).OS = platform;
        vi.stubGlobal('indexedDB', undefined);
        expect(await openLocalHistory('server|unavailable')).toBeNull();
        installSession('visible-session');
        const readingMessage = { id: 'message-103', kind: 'user-text', text: 'reading', createdAt: 1, localId: null };
        const originalRows = [readingMessage];
        mocks.state.sessionMessages['visible-session'] = {
            messages: originalRows,
            reducerState: createReducer(),
            messagesMap: { 'message-103': readingMessage }, isLoaded: true, hasMoreOlder: true, isLoadingOlder: false, isAtLatest: true,
        };
        seedProjectedFrontier('visible-session', { latestSeq: 109, olderBeforeSeq: 103, hasMoreOlder: true });
        mocks.apiRequest.mockRejectedValueOnce(new Error('offline older page'))
            .mockResolvedValueOnce(response({ messages: [apiMessage(90)], hasMore: false }));
        const chat = await mountBoundaryChat('older');
        try {
            chat.reach();
            await vi.waitFor(() => expect(mocks.state.sessionMessages['visible-session'].isLoadingOlder).toBe(false));
            await chat.update();
            expect(chat.renderer.root.findAllByProps({ testID: 'history-older-retry' })).toHaveLength(1);
            expect(mocks.state.sessionMessages['visible-session'].messages).toBe(originalRows);
            chat.reach(); expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
            chat.retry();
            await vi.waitFor(() => expect(mocks.state.sessionMessages['visible-session'].messagesMap['message-90']).toBeDefined());
            await chat.update();
            expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
            expect(mocks.apiRequest.mock.calls[1][0]).toBe('/v3/sessions/visible-session/messages?before_seq=103&limit=100');
            expect(mocks.state.sessionMessages['visible-session'].olderError).toBeNull();
            expect(mocks.state.sessionMessages['visible-session'].messagesMap['message-103']).toBe(readingMessage);
            expect(chat.renderer.root.findAllByProps({ testID: 'history-older-retry' })).toHaveLength(0);
        } finally { chat.unmount(); (Platform as any).OS = previousPlatform; }
    });

    it('releases an older-page loading lock when a forward load supersedes it in the same cache', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        mocks.state.sessionMessages['visible-session'] = {
            messages: [],
            messagesMap: {},
            isLoaded: true,
            hasMoreOlder: true,
            isLoadingOlder: false,
        };
        seedProjectedFrontier('visible-session', { latestSeq: 109, olderBeforeSeq: 103, hasMoreOlder: true });
        const firstOlderPage = deferred<Response>();
        let olderRequests = 0;
        mocks.apiRequest.mockImplementation((url: string) => {
            if (url.includes('before_seq=')) {
                olderRequests += 1;
                return olderRequests === 1
                    ? firstOlderPage.promise
                    : Promise.resolve(response({ messages: [apiMessage(90)], hasMore: false }));
            }
            return Promise.resolve(response({
                messages: [apiMessage(110), apiMessage(111), apiMessage(112)],
                hasMore: false,
            }));
        });

        const olderLoading = syncForTest.loadOlderMessages('visible-session');
        await vi.waitFor(() => expect(olderRequests).toBe(1));
        await syncForTest.handleUpdate(newMessageUpdate('visible-session', 112));
        firstOlderPage.resolve(response({ messages: [], hasMore: true }));
        await olderLoading;
        await syncForTest.messagesSync.get('visible-session').awaitQueue();

        expect(mocks.state.sessionMessages['visible-session'].isLoadingOlder).toBe(false);
        await syncForTest.loadOlderMessages('visible-session');
        expect(olderRequests).toBe(2);
        expect(mocks.state.sessionMessages['visible-session'].messagesMap['message-90']).toBeDefined();
    });

    it('does not let an evicted older-page cleanup clear a remounted cache loading lock', async () => {
        installSession('same-session');
        mocks.state.currentViewingSessionId = 'same-session';
        const installMessageCache = () => {
            mocks.state.sessionMessages['same-session'] = {
                messages: [],
                messagesMap: {},
                isLoaded: true,
                hasMoreOlder: true,
                isLoadingOlder: false,
            };
            seedProjectedFrontier('same-session', { latestSeq: 109, olderBeforeSeq: 103, hasMoreOlder: true });
        };
        installMessageCache();
        const oldPage = deferred<Response>();
        const newPage = deferred<Response>();
        mocks.apiRequest
            .mockReturnValueOnce(oldPage.promise)
            .mockReturnValueOnce(newPage.promise);

        const oldLoading = syncForTest.loadOlderMessages('same-session');
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(1));
        syncForTest.releaseSessionMessageCache('same-session');
        installMessageCache();
        syncForTest.onSessionVisible('same-session', { loadMessages: false });
        const newLoading = syncForTest.loadOlderMessages('same-session');
        await vi.waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledTimes(2));

        oldPage.resolve(response({ messages: [], hasMore: true }));
        await oldLoading;
        expect(mocks.state.sessionMessages['same-session'].isLoadingOlder).toBe(true);

        newPage.resolve(response({ messages: [apiMessage(90)], hasMore: false }));
        await newLoading;
        expect(mocks.state.sessionMessages['same-session'].isLoadingOlder).toBe(false);
    });

    it('keeps explicit scroll-to-top pagination as the only older-page entry point', async () => {
        installSession('visible-session');
        mocks.state.currentViewingSessionId = 'visible-session';
        mocks.state.sessionMessages['visible-session'] = {
            messages: [],
            messagesMap: {},
            isLoaded: true,
            hasMoreOlder: true,
            isLoadingOlder: false,
        };
        seedProjectedFrontier('visible-session', { latestSeq: 109, olderBeforeSeq: 103, hasMoreOlder: true });
        mocks.apiRequest.mockResolvedValue(response({ messages: [apiMessage(90)], hasMore: true }));

        await syncForTest.loadOlderMessages('visible-session');

        expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
        expect(mocks.apiRequest).toHaveBeenCalledWith(
            '/v3/sessions/visible-session/messages?before_seq=103&limit=100',
        );
        expect(mocks.state.sessionMessages['visible-session'].messagesMap['message-90']).toBeDefined();
        expect(syncForTest.sessionMessageFrontiers.get('visible-session')?.olderBeforeSeq).toBe(90);
    });
});
