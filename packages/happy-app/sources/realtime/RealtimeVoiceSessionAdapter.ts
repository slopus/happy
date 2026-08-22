import type { HookOptions } from '@elevenlabs/react';
import { getElevenLabsCodeFromPreference } from '@/constants/Languages';
import { storage } from '@/sync/storage';
import { VoiceSessionCancellationError, type VoiceSession, type VoiceSessionConfig } from './types';

const CONNECT_TIMEOUT_MS = 20_000;
const DISCONNECT_TIMEOUT_MS = 5_000;

type ConversationController = {
    startSession(options?: HookOptions): void;
    endSession(): void;
    sendUserMessage(message: string): void;
    sendContextualUpdate(update: string): void;
};

type PendingStart = {
    resolve: (conversationId: string) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

type PendingStop = {
    resolve: () => void;
    timeout: ReturnType<typeof setTimeout>;
};

function asError(error: unknown, fallback: string): Error {
    if (error instanceof Error) return error;
    if (typeof error === 'string' && error.trim()) return new Error(error);
    return new Error(fallback);
}

/**
 * Bridges Happy's imperative voice API to ElevenLabs v1's callback-based API.
 * The v1 provider serializes its own connections; this adapter additionally
 * waits for the real onConnect/onDisconnect events before exposing state to the
 * rest of the app.
 */
export class RealtimeVoiceSessionAdapter implements VoiceSession {
    private conversation: ConversationController | null = null;
    private pendingStart: PendingStart | null = null;
    private pendingStop: PendingStop | null = null;
    private stopPromise: Promise<void> | null = null;
    private connected = false;
    private resetRequired = false;
    private resetPromise: Promise<void> | null = null;

    constructor(private readonly resetProvider: () => Promise<void> = () => Promise.resolve()) {}

    setConversation(conversation: ConversationController) {
        this.conversation = conversation;
    }

    async startSession(config: VoiceSessionConfig): Promise<string> {
        if (!this.conversation) {
            throw new Error('Realtime voice session not initialized');
        }
        if (this.pendingStart) {
            throw new Error('Realtime voice session is already connecting');
        }
        if (this.resetRequired) {
            throw new Error('Realtime voice provider is resetting');
        }
        if (this.connected || this.pendingStop) {
            throw new Error('Previous realtime voice session is still active');
        }
        if (!config.conversationToken && !config.agentId) {
            throw new Error('No conversationToken or agentId provided');
        }

        const userLanguagePreference = storage.getState().settings.voiceAssistantLanguage;
        const elevenLabsLanguage = getElevenLabsCodeFromPreference(userLanguagePreference);
        const connection = config.conversationToken
            ? {
                conversationToken: config.conversationToken,
                connectionType: 'webrtc' as const,
            }
            : {
                agentId: config.agentId!,
                connectionType: 'webrtc' as const,
            };
        const sessionConfig: HookOptions = {
            ...connection,
            userId: config.userId,
            dynamicVariables: {
                sessionId: config.sessionId,
                initialConversationContext: config.initialContext || '',
            },
            overrides: {
                agent: {
                    ...(config.systemPrompt ? { prompt: { prompt: config.systemPrompt } } : {}),
                    ...(config.firstMessage ? { firstMessage: config.firstMessage } : {}),
                    language: elevenLabsLanguage,
                },
            },
        };

        storage.getState().setRealtimeStatus('connecting');

        return new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (!this.pendingStart) return;
                this.pendingStart = null;
                storage.getState().setRealtimeStatus('error');
                try {
                    this.conversation?.endSession();
                } catch (error) {
                    console.warn('[Voice] Failed to cancel timed out connection:', error);
                }
                void this.requireProviderReset().finally(() => {
                    reject(new Error(`Voice connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`));
                });
            }, CONNECT_TIMEOUT_MS);

            this.pendingStart = { resolve, reject, timeout };

            try {
                this.conversation!.startSession(sessionConfig);
            } catch (error) {
                this.rejectPendingStart(asError(error, 'Failed to start voice session'));
            }
        });
    }

    async endSession(): Promise<void> {
        if (!this.conversation) return;
        if (this.stopPromise) return this.stopPromise;
        if (!this.connected && !this.pendingStart) {
            return;
        }
        if (this.pendingStart) {
            this.rejectPendingStart(new VoiceSessionCancellationError());
        }

        let resolveStop!: () => void;
        const stopPromise = new Promise<void>((resolve) => {
            resolveStop = resolve;
        });
        this.stopPromise = stopPromise;
        const timeout = setTimeout(() => {
            this.connected = false;
            storage.getState().setRealtimeStatus('disconnected');
            // A provider that never confirms disconnect may still emit callbacks
            // later. Remount it before unlocking retries so that stale callbacks
            // cannot affect the next connection epoch.
            void this.requireProviderReset().finally(() => {
                this.resolvePendingStop();
            });
        }, DISCONNECT_TIMEOUT_MS);
        this.pendingStop = { resolve: resolveStop, timeout };

        try {
            this.conversation.endSession();
        } catch (error) {
            console.warn('[Voice] Failed to end voice session:', error);
            this.resolvePendingStop();
        }
        return stopPromise;
    }

    sendTextMessage(message: string): void {
        if (!this.connected || !this.conversation) return;
        try {
            this.conversation.sendUserMessage(message);
        } catch (error) {
            console.warn('[Voice] Failed to send text message:', error);
        }
    }

    sendContextualUpdate(update: string): void {
        if (!this.connected || !this.conversation) return;
        try {
            this.conversation.sendContextualUpdate(update);
        } catch (error) {
            console.warn('[Voice] Failed to send contextual update:', error);
        }
    }

    handleConnect(conversationId: string) {
        this.connected = true;
        const pending = this.pendingStart;
        if (pending) {
            this.pendingStart = null;
            clearTimeout(pending.timeout);
            pending.resolve(conversationId);
        }
    }

    handleDisconnect(error?: unknown) {
        this.connected = false;
        if (this.pendingStart) {
            this.rejectPendingStart(asError(error, 'Voice session disconnected while connecting'));
        }
        this.resolvePendingStop();
    }

    handleError(error: unknown): boolean {
        if (!this.pendingStart) return false;
        this.rejectPendingStart(asError(error, 'Failed to connect voice session'));
        return true;
    }

    isConnected(): boolean {
        return this.connected;
    }

    dispose() {
        this.connected = false;
        this.rejectPendingStart(new VoiceSessionCancellationError());
        if (this.resetPromise && this.pendingStop) {
            // A keyed provider reset disposes this adapter before the replacement
            // registers. Preserve the stop barrier until that registration has
            // completed instead of letting cleanup unlock a stale retry.
            void this.resetPromise.finally(() => this.resolvePendingStop());
        } else {
            this.resolvePendingStop();
        }
        this.conversation = null;
    }

    private rejectPendingStart(error: Error) {
        const pending = this.pendingStart;
        if (!pending) return;
        this.pendingStart = null;
        clearTimeout(pending.timeout);
        pending.reject(error);
    }

    private resolvePendingStop() {
        const pending = this.pendingStop;
        if (!pending) return;
        this.pendingStop = null;
        this.stopPromise = null;
        clearTimeout(pending.timeout);
        pending.resolve();
    }

    private requireProviderReset(): Promise<void> {
        if (this.resetPromise) return this.resetPromise;
        this.resetRequired = true;
        this.resetPromise = Promise.resolve().then(() => this.resetProvider());
        return this.resetPromise;
    }
}
