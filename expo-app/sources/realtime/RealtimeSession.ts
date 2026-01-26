/**
 * Realtime Session Manager
 * Manages voice session lifecycle with support for multiple providers
 */

import type { VoiceSession, VoiceSessionConfig, VoiceProviderType, VoiceProviderAdapter } from './types';
import { storage } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { config } from '@/config';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { voiceHooks } from './hooks/voiceHooks';

// ===== Provider Registry =====

const providerRegistry: Map<VoiceProviderType, () => VoiceProviderAdapter> = new Map();
let currentAdapter: VoiceProviderAdapter | null = null;
let currentSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;

/**
 * Register a voice provider adapter factory
 */
export function registerVoiceProvider(
    type: VoiceProviderType,
    factory: () => VoiceProviderAdapter
): void {
    providerRegistry.set(type, factory);
    console.log(`[RealtimeSession] Registered provider: ${type}`);
}

/**
 * Determine which provider to use based on configuration
 */
function determineProviderType(): VoiceProviderType {
    // Check for StepFun configuration first (higher priority)
    if (config.stepFunApiKey) {
        return 'stepfun';
    }

    // Check for ElevenLabs configuration
    if (config.elevenLabsAgentIdDev || config.elevenLabsAgentIdProd) {
        return 'elevenlabs';
    }

    return 'none';
}

/**
 * Get or create the current adapter
 */
function getOrCreateAdapter(): VoiceProviderAdapter | null {
    if (currentAdapter) {
        return currentAdapter;
    }

    const providerType = determineProviderType();
    if (providerType === 'none') {
        console.log('[RealtimeSession] No voice provider configured');
        return null;
    }

    const factory = providerRegistry.get(providerType);
    if (!factory) {
        console.warn(`[RealtimeSession] Provider ${providerType} not registered`);
        return null;
    }

    currentAdapter = factory();
    currentAdapter.initialize().catch((error) => {
        console.error(`[RealtimeSession] Failed to initialize ${providerType}:`, error);
    });

    return currentAdapter;
}

/**
 * Build session configuration based on provider type
 */
function buildSessionConfig(sessionId: string, initialContext?: string): VoiceSessionConfig & Record<string, any> {
    const providerType = determineProviderType();
    const baseConfig: VoiceSessionConfig = {
        sessionId,
        initialContext,
    };

    switch (providerType) {
        case 'stepfun':
            return {
                ...baseConfig,
                provider: 'stepfun',
                apiKey: config.stepFunApiKey!,
                modelId: config.stepFunModelId,
                voice: config.stepFunVoice,
            };

        case 'elevenlabs':
            return {
                ...baseConfig,
                provider: 'elevenlabs',
                agentId: __DEV__ ? config.elevenLabsAgentIdDev : config.elevenLabsAgentIdProd,
            };

        default:
            return baseConfig;
    }
}

// ===== Public API =====

/**
 * Start a realtime voice session
 */
export async function startRealtimeSession(sessionId: string, initialContext?: string) {
    const adapter = getOrCreateAdapter();
    if (!adapter) {
        console.warn('[RealtimeSession] No voice provider available');
        return;
    }

    // Request microphone permission first
    const permissionResult = await requestMicrophonePermission();
    if (!permissionResult.granted) {
        showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
        return;
    }

    try {
        // Create session
        currentSession = adapter.createSession();
        currentSessionId = sessionId;
        voiceSessionStarted = true;

        // Build config and start
        const sessionConfig = buildSessionConfig(sessionId, initialContext);
        await currentSession.startSession(sessionConfig);

        console.log('[RealtimeSession] Session started successfully');
    } catch (error) {
        console.error('[RealtimeSession] Failed to start session:', error);
        currentSession = null;
        currentSessionId = null;
        voiceSessionStarted = false;
        storage.getState().setRealtimeStatus('error');
        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
    }
}

/**
 * Stop the current realtime voice session
 */
export async function stopRealtimeSession() {
    if (!currentSession) {
        return;
    }

    try {
        await currentSession.endSession();
    } catch (error) {
        console.error('[RealtimeSession] Failed to stop session:', error);
    } finally {
        currentSession = null;
        currentSessionId = null;
        voiceSessionStarted = false;
    }
}

/**
 * Check if a voice session is currently active
 */
export function isVoiceSessionStarted(): boolean {
    return voiceSessionStarted;
}

/**
 * Get the current voice session (if any)
 */
export function getVoiceSession(): VoiceSession | null {
    return currentSession;
}

/**
 * Get the current session ID (if any)
 */
export function getCurrentRealtimeSessionId(): string | null {
    return currentSessionId;
}

/**
 * @deprecated Use registerVoiceProvider instead
 * Legacy function for backward compatibility
 */
export function registerVoiceSession(session: VoiceSession) {
    console.warn('[RealtimeSession] registerVoiceSession is deprecated, use registerVoiceProvider instead');
    currentSession = session;
}
