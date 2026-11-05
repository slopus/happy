import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceSession } from './types';

const mocks = vi.hoisted(() => ({
    capture: vi.fn(),
    fetchVoiceCredentials: vi.fn(),
    requestMicrophonePermission: vi.fn(),
    state: {
        settings: { voiceBypassToken: false, voiceCustomAgentId: 'custom-agent' },
        purchases: { entitlements: { pro: true } },
        localSettings: { voiceUpsellOverride: null, devModeEnabled: false },
        setRealtimeStatus: vi.fn(),
    },
}));

vi.mock('@/track', () => ({ tracking: { capture: mocks.capture } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => mocks.state } }));
vi.mock('@/sync/apiVoice', () => ({ fetchVoiceCredentials: mocks.fetchVoiceCredentials }));
vi.mock('@/sync/sync', () => ({ sync: { presentPaywall: vi.fn() } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: async () => ({ token: 'test' }) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/microphonePermissions', () => ({
    requestMicrophonePermission: mocks.requestMicrophonePermission,
    showMicrophonePermissionDeniedAlert: vi.fn(),
}));
vi.mock('@/sync/persistence', () => ({
    getVoiceMessageCount: () => 3,
    getVoiceOnboardingPromptLoadCount: () => 2,
    getVoiceSoftPaywallShownCount: () => 1,
    incrementVoiceOnboardingPromptLoadCount: vi.fn(),
    incrementVoiceSoftPaywallShown: vi.fn(),
}));
vi.mock('./voiceSystemPrompt', () => ({
    buildVoiceFirstMessage: () => 'Hello',
    buildVoiceSystemPrompt: () => 'System prompt',
}));
vi.mock('./voiceExperiment', () => ({ getVoiceUpsellVariant: () => 'control' }));

import {
    finishRealtimeSession,
    getCurrentRealtimeSessionId,
    getCurrentVoiceConversationId,
    getCurrentVoiceSessionDurationSeconds,
    isVoiceSessionStarted,
    onRealtimeSessionConnected,
    registerVoiceSession,
    setCurrentRealtimeSessionId,
    startRealtimeSession,
    stopRealtimeSession,
} from './RealtimeSession';

describe('voice session lifecycle tracking', () => {
    let now: number;
    let voice: VoiceSession;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('__DEV__', false);
        now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.state.settings.voiceBypassToken = false;
        mocks.requestMicrophonePermission.mockResolvedValue({ granted: true });
        mocks.fetchVoiceCredentials.mockResolvedValue({
            allowed: true,
            conversationId: 'conversation-server',
            conversationToken: 'token',
        });
        voice = {
            startSession: vi.fn(async () => {
                now = 5_000;
                onRealtimeSessionConnected(voice);
                return 'conversation-sdk';
            }),
            endSession: vi.fn(async () => {
                now += 2_000;
                finishRealtimeSession('disconnected', voice);
            }),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        };
        registerVoiceSession(voice);
    });

    afterEach(() => {
        finishRealtimeSession('unmount');
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('measures connected time, preserves start IDs across chat switches, and ends once at manual stop', async () => {
        await startRealtimeSession('session-original');
        expect(mocks.capture).toHaveBeenCalledWith('voice_session_started', {
            session_id: 'session-original',
            elevenlabs_conversation_id: 'conversation-server',
            has_pro: true,
            onboarding_prompt_load_count: 2,
            voice_message_count: 3,
        });
        now = 17_345;
        expect(getCurrentVoiceSessionDurationSeconds()).toBe(12);
        setCurrentRealtimeSessionId('session-switched');
        await stopRealtimeSession();
        finishRealtimeSession('unmount', voice);
        expect(mocks.capture.mock.calls.filter(([event]) => event === 'voice_session_ended')).toEqual([
            ['voice_session_ended', {
                session_id: 'session-original',
                elevenlabs_conversation_id: 'conversation-server',
                duration_ms: 12_345,
                duration_seconds: 12.345,
                end_reason: 'manual_stop',
            }],
        ]);
        expect(getCurrentRealtimeSessionId()).toBeNull();
        expect(getCurrentVoiceConversationId()).toBeNull();
        expect(getCurrentVoiceSessionDurationSeconds()).toBeUndefined();
        expect(isVoiceSessionStarted()).toBe(false);
    });

    it.each(['disconnected', 'unmount'] as const)('finalizes %s and allows a fresh conversation', async (reason) => {
        await startRealtimeSession('session-1');
        now = 8_000;
        finishRealtimeSession(reason, voice);
        finishRealtimeSession('disconnected', voice);
        expect(mocks.capture).toHaveBeenLastCalledWith('voice_session_ended', expect.objectContaining({
            duration_ms: 3_000,
            end_reason: reason,
        }));
        await startRealtimeSession('session-2');
        now = 6_000;
        finishRealtimeSession('disconnected', voice);
        expect(mocks.capture.mock.calls.map(([event]) => event)).toEqual([
            'voice_session_started', 'voice_session_ended', 'voice_session_started', 'voice_session_ended',
        ]);
        expect(mocks.capture).toHaveBeenLastCalledWith('voice_session_ended', expect.objectContaining({
            session_id: 'session-2', duration_ms: 1_000,
        }));
    });

    it('pairs a quick disconnect with the SDK ID when startup resolves later', async () => {
        mocks.state.settings.voiceBypassToken = true;
        voice.startSession = vi.fn(async () => {
            now = 1_000;
            onRealtimeSessionConnected(voice);
            now = 1_250;
            finishRealtimeSession('disconnected', voice);
            expect(mocks.capture).not.toHaveBeenCalled();
            now = 9_000;
            return 'conversation-quick';
        });
        expect(await startRealtimeSession('session-quick')).toBeNull();
        expect(mocks.capture.mock.calls.map(([event]) => event)).toEqual(['voice_session_started', 'voice_session_ended']);
        expect(mocks.capture).toHaveBeenLastCalledWith('voice_session_ended', {
            session_id: 'session-quick',
            elevenlabs_conversation_id: 'conversation-quick',
            duration_ms: 250,
            duration_seconds: 0.25,
            end_reason: 'disconnected',
        });
        expect(isVoiceSessionStarted()).toBe(false);
    });

    it('waits for the native connected callback even when SDK startup resolves first', async () => {
        mocks.state.settings.voiceBypassToken = true;
        voice.startSession = vi.fn().mockResolvedValue(null);
        await startRealtimeSession('session-native');
        expect(mocks.capture).not.toHaveBeenCalled();
        expect(getCurrentVoiceSessionDurationSeconds()).toBeUndefined();
        now = 10_000;
        onRealtimeSessionConnected(voice, 'conversation-native');
        expect(mocks.capture).toHaveBeenCalledWith('voice_session_started', expect.objectContaining({
            elevenlabs_conversation_id: 'conversation-native',
        }));
        now = 11_500;
        finishRealtimeSession('disconnected', voice);
        expect(mocks.capture).toHaveBeenLastCalledWith('voice_session_ended', expect.objectContaining({
            elevenlabs_conversation_id: 'conversation-native', duration_ms: 1_500,
        }));
    });

    it('keeps a manual stop during unresolved startup from reviving the session', async () => {
        voice.startSession = vi.fn(async () => {
            now = 1_000;
            onRealtimeSessionConnected(voice);
            now = 1_750;
            await stopRealtimeSession();
            return 'conversation-stopped';
        });
        expect(await startRealtimeSession('session-stopped')).toBeNull();
        expect(mocks.capture.mock.calls.map(([event]) => event)).toEqual(['voice_session_started', 'voice_session_ended']);
        expect(mocks.capture).toHaveBeenLastCalledWith('voice_session_ended', expect.objectContaining({
            duration_ms: 750, end_reason: 'manual_stop',
        }));
        expect(isVoiceSessionStarted()).toBe(false);
    });

    it('does not replace or track the same active conversation twice', async () => {
        await Promise.all([startRealtimeSession('session-first'), startRealtimeSession('session-duplicate')]);
        expect(voice.startSession).toHaveBeenCalledTimes(1);
        expect(mocks.capture).toHaveBeenCalledTimes(1);
        expect(getCurrentRealtimeSessionId()).toBe('session-first');
    });

    it('does not emit events for a rejected connection or denied microphone permission', async () => {
        voice.startSession = vi.fn().mockRejectedValue(new Error('connection failed'));
        expect(await startRealtimeSession('session-failed')).toBeNull();
        expect(mocks.capture).not.toHaveBeenCalled();
        mocks.requestMicrophonePermission.mockResolvedValue({ granted: false });
        await startRealtimeSession('session-denied');
        await stopRealtimeSession();
        expect(mocks.capture).not.toHaveBeenCalled();
    });

    it('ends a connected session if SDK startup subsequently rejects', async () => {
        voice.startSession = vi.fn(async () => {
            now = 1_000;
            onRealtimeSessionConnected(voice);
            now = 1_500;
            throw new Error('startup failed after connect');
        });
        await startRealtimeSession('session-error');
        finishRealtimeSession('disconnected', voice);
        expect(mocks.capture.mock.calls.map(([event]) => event)).toEqual(['voice_session_started', 'voice_session_ended']);
        expect(mocks.capture).toHaveBeenLastCalledWith('voice_session_ended', expect.objectContaining({
            elevenlabs_conversation_id: 'conversation-server', duration_ms: 500, end_reason: 'error',
        }));
    });

    it('ignores callbacks from an old provider and duplicate connect notifications', async () => {
        const oldVoice = { ...voice };
        await startRealtimeSession('session-current');
        now = 8_000;
        onRealtimeSessionConnected(oldVoice);
        finishRealtimeSession('disconnected', oldVoice);
        expect(isVoiceSessionStarted()).toBe(true);
        onRealtimeSessionConnected(voice);
        expect(mocks.capture).toHaveBeenCalledTimes(1);
        finishRealtimeSession('disconnected', voice);
        expect(mocks.capture).toHaveBeenLastCalledWith('voice_session_ended', expect.objectContaining({ duration_ms: 3_000 }));
    });
});