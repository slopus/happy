/**
 * StepFun Voice Provider Adapter
 * Implements VoiceProviderAdapter for StepFun Realtime API
 */

import { storage } from '@/sync/storage';
import { voiceHooks } from './hooks/voiceHooks';
import { StepFunClient, StepFunClientCallbacks } from './stepfun/StepFunClient';
import { StepFunAudioRecorder } from './stepfun/StepFunAudioRecorder';
import { StepFunAudioPlayer } from './stepfun/StepFunAudioPlayer';
import { getStepFunToolDefinitions, executeStepFunTool } from './stepfun/StepFunToolHandler';
import { STEPFUN_CONSTANTS } from './stepfun/constants';
import { onPTTResponseComplete } from './RealtimeSession';
import type {
    VoiceProviderAdapter,
    VoiceProviderType,
    VoiceSession,
    VoiceSessionConfig,
    StepFunConfig
} from './types';

/**
 * StepFun Voice Session Implementation
 */
class StepFunVoiceSession implements VoiceSession {
    private client: StepFunClient | null = null;
    private recorder: StepFunAudioRecorder | null = null;
    private player: StepFunAudioPlayer | null = null;
    private sessionId: string | null = null;

    async startSession(config: VoiceSessionConfig): Promise<void> {
        const stepFunConfig = config as StepFunConfig;

        if (!stepFunConfig.apiKey) {
            console.error('[StepFunVoiceSession] API key not provided');
            storage.getState().setRealtimeStatus('error');
            throw new Error('StepFun API key not provided');
        }

        this.sessionId = config.sessionId;

        try {
            console.log('[StepFunVoiceSession] Starting session for:', config.sessionId);
            storage.getState().setRealtimeStatus('connecting');

            // Get initial context from voice hooks
            const initialPrompt = voiceHooks.onVoiceStarted(config.sessionId);
            const instructions = this.buildInstructions(config.initialContext, initialPrompt);

            // Initialize audio player with callback to pause/resume recording
            this.player = new StepFunAudioPlayer((isPlaying) => {
                storage.getState().setRealtimeMode(isPlaying ? 'speaking' : 'idle');
                // Resume recording when playback stops
                if (!isPlaying) {
                    this.recorder?.resume();
                    // Check if PTT mode should auto-close
                    onPTTResponseComplete();
                }
            });
            await this.player.initialize();

            // Create client with callbacks
            const callbacks: StepFunClientCallbacks = {
                onSessionCreated: () => {
                    console.log('[StepFunVoiceSession] Session created');
                    storage.getState().setRealtimeStatus('connected');
                    storage.getState().setRealtimeMode('idle');
                    this.startRecording();
                },

                onSessionUpdated: () => {
                    console.log('[StepFunVoiceSession] Session updated');
                },

                onSpeechStarted: () => {
                    console.log('[StepFunVoiceSession] User speech started - interrupting');
                    this.player?.stop(); // Barge-in: stop AI audio when user speaks
                    this.client?.interrupt(); // Cancel response and clear audio buffer
                    storage.getState().setRealtimeMode('idle', true); // Immediate mode change
                },

                onSpeechStopped: () => {
                    console.log('[StepFunVoiceSession] User speech stopped');
                },

                onAudioDelta: (base64Audio: string) => {
                    // Pause recording immediately when receiving audio to prevent echo
                    this.recorder?.pause();
                    this.player?.addAudioChunk(base64Audio);
                },

                onAudioDone: () => {
                    console.log('[StepFunVoiceSession] Audio response complete');
                },

                onTextDelta: (delta: string) => {
                    // Could accumulate for display if needed
                },

                onTextDone: (text: string) => {
                    console.log('[StepFunVoiceSession] Text:', text);
                },

                // Transcription callbacks
                onUserTranscript: (transcript: string) => {
                    console.log('[StepFunVoiceSession] User transcript:', transcript);
                    if (this.sessionId && transcript.trim()) {
                        storage.getState().addVoiceMessage(this.sessionId, 'user', transcript);
                    }
                },

                onAssistantTranscriptDone: (transcript: string) => {
                    console.log('[StepFunVoiceSession] Assistant transcript:', transcript);
                    if (this.sessionId && transcript.trim()) {
                        storage.getState().addVoiceMessage(this.sessionId, 'assistant', transcript);
                    }
                },

                onFunctionCall: async (callId: string, name: string, args: string): Promise<string> => {
                    console.log('[StepFunVoiceSession] Function call:', name);
                    return await executeStepFunTool(name, args);
                },

                onError: (error: Error) => {
                    console.error('[StepFunVoiceSession] Error:', error);
                    // Don't set error status for non-critical errors, just log them
                    // Critical errors will trigger disconnect which handles cleanup
                },

                onDisconnected: () => {
                    console.log('[StepFunVoiceSession] Disconnected');
                    storage.getState().setRealtimeStatus('disconnected');
                    storage.getState().setRealtimeMode('idle', true);
                    storage.getState().clearRealtimeModeDebounce();
                    voiceHooks.onVoiceStopped();
                    this.cleanup();
                },
            };

            this.client = new StepFunClient({
                apiKey: stepFunConfig.apiKey,
                modelId: stepFunConfig.modelId || STEPFUN_CONSTANTS.DEFAULT_MODEL,
                instructions,
                tools: getStepFunToolDefinitions(),
                voice: stepFunConfig.voice || STEPFUN_CONSTANTS.DEFAULT_VOICE,
            }, callbacks);

            await this.client.connect();
            console.log('[StepFunVoiceSession] Session started successfully');
        } catch (error) {
            console.error('[StepFunVoiceSession] Failed to start:', error);
            storage.getState().setRealtimeStatus('error');
            this.cleanup();
            throw error;
        }
    }

    private buildInstructions(initialContext?: string, initialPrompt?: string): string {
        // Check for custom system prompt in settings
        const customSystemPrompt = storage.getState().settings.voiceAssistantSystemPrompt;

        if (customSystemPrompt) {
            // Use custom system prompt with context appended
            return `${customSystemPrompt}

Current session context:
${initialContext || ''}

${initialPrompt || ''}`;
        }

        // Default system prompt
        return `You are a helpful voice assistant integrated with Claude Code, an AI coding assistant. Your role is to help users interact with their coding sessions through voice.

You can:
1. Send messages to Claude Code on behalf of the user using the messageClaudeCode tool
2. Approve or deny permission requests from Claude Code using the processPermissionRequest tool

Guidelines:
- Be concise and conversational in your responses
- When the user wants to give instructions to Claude Code, use the messageClaudeCode tool
- When Claude Code requests permission for an action, clearly explain what it wants to do and ask for user confirmation before using processPermissionRequest
- Always confirm actions you've taken
- If you're unsure what the user wants, ask for clarification

Current session context:
${initialContext || ''}

${initialPrompt || ''}`;
    }

    private startRecording(): void {
        this.recorder = new StepFunAudioRecorder({
            onAudioData: (base64Audio: string) => {
                this.client?.sendAudio(base64Audio);
            },
            onError: (error: Error) => {
                console.error('[StepFunVoiceSession] Recorder error:', error);
            },
        });
        this.recorder.start();
    }

    async endSession(): Promise<void> {
        console.log('[StepFunVoiceSession] Ending session');
        this.cleanup();
        voiceHooks.onVoiceStopped();
        storage.getState().setRealtimeStatus('disconnected');
        storage.getState().setRealtimeMode('idle', true);
    }

    sendTextMessage(message: string): void {
        this.client?.sendTextMessage(message);
    }

    sendContextualUpdate(update: string): void {
        this.client?.sendContextualUpdate(update);
    }

    setMuted(muted: boolean): void {
        this.recorder?.setMuted(muted);
    }

    private cleanup(): void {
        this.recorder?.stop();
        this.recorder = null;

        this.player?.dispose();
        this.player = null;

        this.client?.disconnect();
        this.client = null;
    }
}

/**
 * StepFun Voice Provider Adapter
 */
export class StepFunVoiceAdapter implements VoiceProviderAdapter {
    readonly type: VoiceProviderType = 'stepfun';

    async initialize(): Promise<void> {
        console.log('[StepFunVoiceAdapter] Initialized');
        // No initialization needed for StepFun - connection happens per session
    }

    createSession(): VoiceSession {
        return new StepFunVoiceSession();
    }

    dispose(): void {
        console.log('[StepFunVoiceAdapter] Disposed');
    }
}

/**
 * Factory function for creating StepFun adapter
 */
export function createStepFunAdapter(): VoiceProviderAdapter {
    return new StepFunVoiceAdapter();
}
