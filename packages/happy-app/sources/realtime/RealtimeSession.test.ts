import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceSession } from './types';

const mocks = vi.hoisted(() => ({
    requestMicrophonePermission: vi.fn(),
    showMicrophonePermissionDeniedAlert: vi.fn(),
    setRealtimeStatus: vi.fn(),
    resetVoiceProvider: vi.fn(),
    settings: {
        voiceBypassToken: true,
        voiceCustomAgentId: 'agent_test123',
    },
}));

vi.mock('@/sync/apiVoice', () => ({ fetchVoiceCredentials: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: { presentPaywall: vi.fn() } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/microphonePermissions', () => ({
    requestMicrophonePermission: mocks.requestMicrophonePermission,
    showMicrophonePermissionDeniedAlert: mocks.showMicrophonePermissionDeniedAlert,
}));
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            settings: mocks.settings,
            localSettings: { devModeEnabled: false },
            purchases: { entitlements: {} },
            setRealtimeStatus: mocks.setRealtimeStatus,
            resetVoiceProvider: mocks.resetVoiceProvider,
        }),
    },
}));
vi.mock('@/sync/persistence', () => ({
    getVoiceMessageCount: () => 0,
    getVoiceOnboardingPromptLoadCount: () => 0,
    getVoiceSoftPaywallShownCount: () => 0,
    incrementVoiceOnboardingPromptLoadCount: vi.fn(),
    incrementVoiceSoftPaywallShown: vi.fn(),
}));
vi.mock('./voiceSystemPrompt', () => ({
    buildVoiceFirstMessage: vi.fn(),
    buildVoiceSystemPrompt: vi.fn(),
}));
vi.mock('./voiceExperiment', () => ({
    getVoiceUpsellVariant: () => 'control',
}));

import {
    registerVoiceSession,
    resetVoiceProviderAndWait,
    startRealtimeSession,
    stopRealtimeSession,
    unregisterVoiceSession,
} from './RealtimeSession';

describe('RealtimeSession orchestration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not open the microphone after Stop cancels an unfinished permission flow', async () => {
        let resolvePermission!: (result: { granted: boolean; canAskAgain: boolean }) => void;
        mocks.requestMicrophonePermission.mockReturnValueOnce(new Promise((resolve) => {
            resolvePermission = resolve;
        }));

        const voiceSession: VoiceSession = {
            startSession: vi.fn(async () => 'conv_should_not_start'),
            endSession: vi.fn(async () => undefined),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        };
        registerVoiceSession(voiceSession);

        const start = startRealtimeSession('session-1');
        await stopRealtimeSession();
        resolvePermission({ granted: true, canAskAgain: true });

        await expect(start).resolves.toBeNull();
        expect(voiceSession.startSession).not.toHaveBeenCalled();
        expect(voiceSession.endSession).toHaveBeenCalledOnce();
        expect(mocks.setRealtimeStatus).toHaveBeenLastCalledWith('disconnected');

        unregisterVoiceSession(voiceSession);
    });

    it('waits for teardown before starting the next session', async () => {
        mocks.requestMicrophonePermission.mockResolvedValue({ granted: true, canAskAgain: true });
        let resolveEnd!: () => void;
        const voiceSession: VoiceSession = {
            startSession: vi.fn()
                .mockResolvedValueOnce('conv_first')
                .mockResolvedValueOnce('conv_second'),
            endSession: vi.fn(() => new Promise<void>((resolve) => {
                resolveEnd = resolve;
            })),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        };
        registerVoiceSession(voiceSession);

        await expect(startRealtimeSession('session-1')).resolves.toBe('conv_first');
        const stop = stopRealtimeSession();
        const restart = startRealtimeSession('session-2');
        await Promise.resolve();
        expect(voiceSession.startSession).toHaveBeenCalledTimes(1);

        resolveEnd();
        await stop;
        await expect(restart).resolves.toBe('conv_second');
        expect(voiceSession.startSession).toHaveBeenCalledTimes(2);

        unregisterVoiceSession(voiceSession);
    });

    it('holds the reset barrier until a replacement provider registers', async () => {
        const oldSession: VoiceSession = {
            startSession: vi.fn(),
            endSession: vi.fn(),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        };
        const newSession: VoiceSession = {
            startSession: vi.fn(),
            endSession: vi.fn(),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        };
        registerVoiceSession(oldSession);

        let resetFinished = false;
        const reset = resetVoiceProviderAndWait().then(() => {
            resetFinished = true;
        });
        await Promise.resolve();
        expect(mocks.resetVoiceProvider).toHaveBeenCalledOnce();
        expect(resetFinished).toBe(false);

        unregisterVoiceSession(oldSession);
        registerVoiceSession(newSession);
        await reset;
        expect(resetFinished).toBe(true);

        unregisterVoiceSession(newSession);
    });
});
