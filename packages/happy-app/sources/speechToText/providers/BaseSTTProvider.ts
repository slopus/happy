/**
 * Base STT Provider
 *
 * Abstract base class for STT providers with common functionality.
 */

import {
    ISTTProvider,
    STTProviderType,
    STTProviderConfig,
    STTSessionCallbacks,
    STTSessionState,
    STTSessionStatus,
    STTError,
    TranscriptResult,
    AudioLevelData,
} from '../types';

export abstract class BaseSTTProvider implements ISTTProvider {
    abstract readonly type: STTProviderType;
    abstract readonly isStreaming: boolean;
    abstract readonly supportedLanguages: string[];

    protected config: STTProviderConfig | null = null;
    protected callbacks: STTSessionCallbacks | null = null;
    protected state: STTSessionState = { status: 'idle' };

    // ==========================================================================
    // Abstract Methods (must be implemented by subclasses)
    // ==========================================================================

    protected abstract onInitialize(): Promise<void>;
    protected abstract onDispose(): Promise<void>;
    protected abstract onStartSession(): Promise<void>;
    protected abstract onStopSession(): Promise<string>;
    protected abstract onCancelSession(): void;

    // ==========================================================================
    // Public Interface Implementation
    // ==========================================================================

    async initialize(config: STTProviderConfig): Promise<void> {
        this.config = config;
        await this.onInitialize();
    }

    async dispose(): Promise<void> {
        await this.onDispose();
        this.config = null;
        this.callbacks = null;
        this.setState('idle');
    }

    async startSession(callbacks: STTSessionCallbacks): Promise<void> {
        if (this.state.status !== 'idle') {
            throw this.createError(
                'provider_error',
                'Session already in progress',
                false
            );
        }

        this.callbacks = callbacks;
        this.setState('initializing');

        try {
            await this.onStartSession();
            this.setState('recording');
        } catch (error) {
            const sttError = this.wrapError(error);
            this.emitError(sttError);
            this.setState('error', sttError);
            throw sttError;
        }
    }

    async stopSession(): Promise<string> {
        if (this.state.status !== 'recording' && this.state.status !== 'processing') {
            return '';
        }

        this.setState('processing');

        try {
            const result = await this.onStopSession();
            this.setState('idle');
            return result;
        } catch (error) {
            const sttError = this.wrapError(error);
            this.emitError(sttError);
            this.setState('error', sttError);
            throw sttError;
        }
    }

    cancelSession(): void {
        if (this.state.status === 'idle') {
            return;
        }

        try {
            this.onCancelSession();
        } catch (error) {
            console.warn('Error cancelling session:', error);
        }

        this.setState('idle');
        this.callbacks = null;
    }

    getState(): STTSessionState {
        return { ...this.state };
    }

    isReady(): boolean {
        return this.config !== null;
    }

    // ==========================================================================
    // Protected Helper Methods
    // ==========================================================================

    /**
     * Update session state and notify callback
     */
    protected setState(status: STTSessionStatus, error?: STTError): void {
        this.state = { status, error };
        this.callbacks?.onStateChange?.(this.state);
    }

    /**
     * Emit transcript result to callback
     */
    protected emitTranscript(result: TranscriptResult): void {
        this.callbacks?.onTranscript(result);
    }

    /**
     * Emit audio level to callback
     */
    protected emitAudioLevel(data: AudioLevelData): void {
        this.callbacks?.onAudioLevel?.(data);
    }

    /**
     * Emit error to callback
     */
    protected emitError(error: STTError): void {
        this.callbacks?.onError?.(error);
    }

    /**
     * Create a standardized STT error
     */
    protected createError(
        code: STTError['code'],
        message: string,
        recoverable: boolean,
        cause?: Error
    ): STTError {
        return { code, message, recoverable, cause };
    }

    /**
     * Wrap an unknown error into an STTError
     */
    protected wrapError(error: unknown): STTError {
        if (this.isSTTError(error)) {
            return error;
        }

        const cause = error instanceof Error ? error : undefined;
        const message = cause?.message || String(error);

        return this.createError('unknown', message, true, cause);
    }

    /**
     * Type guard for STTError
     */
    private isSTTError(error: unknown): error is STTError {
        return (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            'message' in error &&
            'recoverable' in error
        );
    }
}
