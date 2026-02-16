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
 * Priority: User settings > App config (env vars)
 */
function determineProviderType(): VoiceProviderType {
    // Check user settings first (highest priority)
    const settings = storage.getState().settings;
    if (settings.voiceProvider && settings.voiceProvider !== 'none') {
        // Verify the provider has required configuration
        if (settings.voiceProvider === 'stepfun' && settings.voiceProviderStepFun?.apiKey) {
            return 'stepfun';
        }
        if (settings.voiceProvider === 'elevenlabs' &&
            (settings.voiceProviderElevenLabs?.agentIdDev || settings.voiceProviderElevenLabs?.agentIdProd)) {
            return 'elevenlabs';
        }
    }

    // Fallback to app config (env vars)
    // Check for StepFun configuration
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
 * Reads from user settings first, falls back to app config
 */
function buildSessionConfig(sessionId: string, initialContext?: string): VoiceSessionConfig & Record<string, any> {
    const providerType = determineProviderType();
    const settings = storage.getState().settings;
    const baseConfig: VoiceSessionConfig = {
        sessionId,
        initialContext,
    };

    switch (providerType) {
        case 'stepfun': {
            // User settings take priority over app config
            const stepFunSettings = settings.voiceProviderStepFun;
            return {
                ...baseConfig,
                provider: 'stepfun',
                apiKey: stepFunSettings?.apiKey || config.stepFunApiKey!,
                modelId: stepFunSettings?.modelId || config.stepFunModelId,
                voice: stepFunSettings?.voice || config.stepFunVoice,
            };
        }

        case 'elevenlabs': {
            // User settings take priority over app config
            const elevenLabsSettings = settings.voiceProviderElevenLabs;
            const agentIdDev = elevenLabsSettings?.agentIdDev || config.elevenLabsAgentIdDev;
            const agentIdProd = elevenLabsSettings?.agentIdProd || config.elevenLabsAgentIdProd;
            return {
                ...baseConfig,
                provider: 'elevenlabs',
                agentId: __DEV__ ? agentIdDev : agentIdProd,
            };
        }

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
 * Set microphone mute state for the current session
 */
export function setRealtimeMuted(muted: boolean): void {
    storage.getState().setRealtimeMuted(muted);
    currentSession?.setMuted?.(muted);
}

/**
 * Toggle microphone mute state
 */
export function toggleRealtimeMuted(): void {
    const current = storage.getState().realtimeMuted;
    setRealtimeMuted(!current);
}

/**
 * Start Push-to-Talk (PTT) recording mode
 * Called when user presses and holds the mic button
 */
export async function startPTTMode(sessionId: string, initialContext?: string): Promise<void> {
    console.log('[RealtimeSession] Starting PTT mode');
    storage.getState().setRealtimePTTMode(true);
    storage.getState().setRealtimePTTWaitingForResponse(false);

    // If not connected, start a new session
    if (storage.getState().realtimeStatus === 'disconnected') {
        await startRealtimeSession(sessionId, initialContext);
    }

    // Unmute to start capturing audio
    setRealtimeMuted(false);
}

/**
 * Stop Push-to-Talk (PTT) recording mode
 * Called when user releases the mic button
 * Mutes mic and waits for AI response, then auto-closes
 */
export function stopPTTMode(): void {
    console.log('[RealtimeSession] Stopping PTT mode, waiting for response');
    storage.getState().setRealtimePTTMode(false);

    // Mute to stop sending audio
    setRealtimeMuted(true);

    // Mark that we're waiting for the AI response
    storage.getState().setRealtimePTTWaitingForResponse(true);
}

/**
 * Called when AI finishes speaking in PTT mode
 * Should auto-close the session
 */
export async function onPTTResponseComplete(): Promise<void> {
    const state = storage.getState();
    if (state.realtimePTTWaitingForResponse && !state.realtimePTTMode) {
        console.log('[RealtimeSession] PTT response complete, closing session');
        storage.getState().setRealtimePTTWaitingForResponse(false);
        await stopRealtimeSession();
    }
}

/**
 * @deprecated Use registerVoiceProvider instead
 * Legacy function for backward compatibility
 */
export function registerVoiceSession(session: VoiceSession) {
    console.warn('[RealtimeSession] registerVoiceSession is deprecated, use registerVoiceProvider instead');
    currentSession = session;
}
