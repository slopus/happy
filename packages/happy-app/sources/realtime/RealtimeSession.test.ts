import { describe, it, expect, vi } from 'vitest';
import type { VoiceSession } from './types';

// Mock dependencies before importing the module under test
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            setMicrophoneMuted: vi.fn(),
            microphoneMuted: false,
        }),
    },
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/voiceConfig', () => ({
    getVoiceProvider: vi.fn(() => 'elevenlabs'),
    getElevenLabsAgentId: vi.fn(() => 'test-agent-id'),
}));

vi.mock('@/utils/microphonePermissions', () => ({
    requestMicrophonePermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
    showMicrophonePermissionDeniedAlert: vi.fn(),
}));

function createMockVoiceSession(overrides?: Partial<VoiceSession>): VoiceSession {
    return {
        startSession: vi.fn(async () => {}),
        endSession: vi.fn(async () => {}),
        setMicrophoneMuted: vi.fn(async () => {}),
        sendTextMessage: vi.fn(),
        sendContextualUpdate: vi.fn(),
        ...overrides,
    };
}

// Re-import fresh module for each test to reset module-level state
async function freshImport() {
    vi.resetModules();
    const mod = await import('./RealtimeSession');
    return mod;
}

describe('RealtimeSession', () => {
    describe('startRealtimeSession', () => {
        it('should call voiceSession.startSession with correct config', async () => {
            const mod = await freshImport();
            const session = createMockVoiceSession();
            mod.registerVoiceSession(session);

            await mod.startRealtimeSession('session-1', 'hello');

            expect(session.startSession).toHaveBeenCalledWith({
                sessionId: 'session-1',
                initialContext: 'hello',
                agentId: 'test-agent-id',
            });
            expect(mod.isVoiceSessionStarted()).toBe(true);
            expect(mod.getCurrentRealtimeSessionId()).toBe('session-1');
        });

        it('should not start if no voice session registered', async () => {
            const mod = await freshImport();
            // Don't register any session
            await mod.startRealtimeSession('session-1');
            expect(mod.isVoiceSessionStarted()).toBe(false);
        });

        it('should prevent concurrent starts (double-click)', async () => {
            const mod = await freshImport();
            let resolveStart: () => void;
            const startPromise = new Promise<void>((resolve) => {
                resolveStart = resolve;
            });

            const session = createMockVoiceSession({
                startSession: vi.fn(() => startPromise),
            });
            mod.registerVoiceSession(session);

            // First start - will hang on startSession
            const first = mod.startRealtimeSession('session-1');

            // Second start while first is in progress - should be rejected
            await mod.startRealtimeSession('session-2');

            // Only the first call should have invoked startSession
            expect(session.startSession).toHaveBeenCalledTimes(1);
            expect(mod.getCurrentRealtimeSessionId()).toBe('session-1');

            // Resolve the first start
            resolveStart!();
            await first;
        });

        it('should prevent start when already started', async () => {
            const mod = await freshImport();
            const session = createMockVoiceSession();
            mod.registerVoiceSession(session);

            await mod.startRealtimeSession('session-1');
            expect(session.startSession).toHaveBeenCalledTimes(1);

            // Try to start again without stopping
            await mod.startRealtimeSession('session-2');
            expect(session.startSession).toHaveBeenCalledTimes(1); // Still 1
        });

        it('should allow restart after stop', async () => {
            const mod = await freshImport();
            const session = createMockVoiceSession();
            mod.registerVoiceSession(session);

            await mod.startRealtimeSession('session-1');
            await mod.stopRealtimeSession();
            await mod.startRealtimeSession('session-2');

            expect(session.startSession).toHaveBeenCalledTimes(2);
            expect(mod.getCurrentRealtimeSessionId()).toBe('session-2');
        });

        it('should reset starting flag on error', async () => {
            const mod = await freshImport();
            const session = createMockVoiceSession({
                startSession: vi.fn(async () => { throw new Error('connection failed'); }),
            });
            mod.registerVoiceSession(session);

            await mod.startRealtimeSession('session-1');

            // Should be able to try again after failure
            await mod.startRealtimeSession('session-2');
            expect(session.startSession).toHaveBeenCalledTimes(2);
        });
    });

    describe('stopRealtimeSession during start', () => {
        it('should abort before startSession when stop is called during permission check', async () => {
            const mod = await freshImport();
            const session = createMockVoiceSession();
            mod.registerVoiceSession(session);

            // Start (will yield at await requestMicrophonePermission)
            const startResult = mod.startRealtimeSession('session-1');

            // Stop runs while start is awaiting permission — abort is signaled
            await mod.stopRealtimeSession();
            await startResult;

            // startSession should never have been called — abort was caught early
            expect(session.startSession).toHaveBeenCalledTimes(0);
            // endSession called once by stop
            expect(session.endSession).toHaveBeenCalledTimes(1);
        });

        it('should clean up ghost session when stop is called during startSession', async () => {
            const mod = await freshImport();
            let resolveStart: () => void;
            const startPromise = new Promise<void>((resolve) => {
                resolveStart = resolve;
            });

            const session = createMockVoiceSession({
                // startSession hangs until we resolve it
                startSession: vi.fn(() => startPromise),
            });
            mod.registerVoiceSession(session);

            // Start and wait for it to reach the startSession await
            const startResult = mod.startRealtimeSession('session-1');
            // Flush microtasks so start proceeds past permission check to startSession
            await new Promise((r) => setTimeout(r, 0));

            // Now stop while startSession is in progress
            await mod.stopRealtimeSession();

            // Let startSession complete
            resolveStart!();
            await startResult;

            // endSession called by stop (1st) + abort cleanup (2nd)
            expect(session.endSession).toHaveBeenCalledTimes(2);
        });

        it('should allow new start after stop-during-start', async () => {
            const mod = await freshImport();
            const session = createMockVoiceSession();
            mod.registerVoiceSession(session);

            // Start, then immediately stop (abort caught during permission check)
            const firstStart = mod.startRealtimeSession('session-1');
            await mod.stopRealtimeSession();
            await firstStart;

            // Start fresh — should work since flags were properly reset
            await mod.startRealtimeSession('session-2');
            // Only the second call reaches startSession
            expect(session.startSession).toHaveBeenCalledTimes(1);
        });
    });

    describe('stopRealtimeSession', () => {
        it('should reset all state', async () => {
            const mod = await freshImport();
            const session = createMockVoiceSession();
            mod.registerVoiceSession(session);

            await mod.startRealtimeSession('session-1');
            await mod.stopRealtimeSession();

            expect(mod.isVoiceSessionStarted()).toBe(false);
            expect(mod.getCurrentRealtimeSessionId()).toBeNull();
            expect(session.endSession).toHaveBeenCalledTimes(1);
        });

        it('should be safe to call when not started', async () => {
            const mod = await freshImport();
            const session = createMockVoiceSession();
            mod.registerVoiceSession(session);

            // Should not throw
            await mod.stopRealtimeSession();
        });
    });
});
