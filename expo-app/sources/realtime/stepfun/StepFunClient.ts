/**
 * StepFun Realtime API WebSocket Client
 * Handles WebSocket connection, message sending/receiving, and session management
 */

import {
    StepFunClientEvent,
    StepFunServerEvent,
    StepFunTool,
    SessionUpdateEvent,
} from './types';
import { STEPFUN_CONSTANTS } from './constants';

export interface StepFunClientConfig {
    apiKey: string;
    modelId?: string;
    instructions?: string;
    tools?: StepFunTool[];
    voice?: string;
}

export interface StepFunClientCallbacks {
    onSessionCreated: () => void;
    onSessionUpdated: () => void;
    onSpeechStarted: () => void;
    onSpeechStopped: () => void;
    onAudioDelta: (base64Audio: string) => void;
    onAudioDone: () => void;
    onTextDelta: (delta: string) => void;
    onTextDone: (text: string) => void;
    onFunctionCall: (callId: string, name: string, args: string) => Promise<string>;
    onError: (error: Error) => void;
    onDisconnected: () => void;
    // Transcription callbacks
    onUserTranscript?: (transcript: string) => void;
    onAssistantTranscriptDelta?: (delta: string) => void;
    onAssistantTranscriptDone?: (transcript: string) => void;
}

export class StepFunClient {
    private ws: WebSocket | null = null;
    private config: StepFunClientConfig;
    private callbacks: StepFunClientCallbacks;
    private isConnected: boolean = false;
    private reconnectAttempts: number = 0;
    private connectionPromise: Promise<void> | null = null;
    private connectionResolve: (() => void) | null = null;
    private connectionReject: ((error: Error) => void) | null = null;

    constructor(config: StepFunClientConfig, callbacks: StepFunClientCallbacks) {
        this.config = config;
        this.callbacks = callbacks;
    }

    async connect(): Promise<void> {
        if (this.connectionPromise) {
            return this.connectionPromise;
        }

        this.connectionPromise = new Promise((resolve, reject) => {
            this.connectionResolve = resolve;
            this.connectionReject = reject;

            const modelId = this.config.modelId || STEPFUN_CONSTANTS.DEFAULT_MODEL;
            const url = `${STEPFUN_CONSTANTS.WEBSOCKET_URL}?model=${modelId}`;

            console.log('[StepFunClient] Connecting to:', url);

            // Create WebSocket with authorization header
            // React Native WebSocket supports custom headers via 3rd parameter
            // Browser WebSocket doesn't support this - will need relay server for web
            // @ts-expect-error React Native WebSocket accepts headers as 3rd param
            this.ws = new WebSocket(url, undefined, {
                headers: {
                    'Authorization': `Bearer ${this.config.apiKey}`,
                },
            });

            this.ws.onopen = () => {
                console.log('[StepFunClient] WebSocket connected');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.initializeSession();
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data) as StepFunServerEvent;
                    this.handleMessage(data);
                } catch (error) {
                    console.error('[StepFunClient] Failed to parse message:', error);
                }
            };

            this.ws.onerror = (error) => {
                console.error('[StepFunClient] WebSocket error:', error);
                this.callbacks.onError(new Error('WebSocket connection error'));
            };

            this.ws.onclose = (event) => {
                console.log('[StepFunClient] WebSocket closed:', event.code, event.reason);
                this.isConnected = false;
                this.connectionPromise = null;

                if (this.connectionReject) {
                    this.connectionReject(new Error('WebSocket closed'));
                    this.connectionReject = null;
                }

                this.callbacks.onDisconnected();

                // Auto-reconnect if not intentionally closed
                if (event.code !== 1000 && this.reconnectAttempts < STEPFUN_CONSTANTS.CONNECTION.MAX_RECONNECT_ATTEMPTS) {
                    this.reconnectAttempts++;
                    const delay = STEPFUN_CONSTANTS.CONNECTION.RECONNECT_DELAY_MS * this.reconnectAttempts;
                    console.log(`[StepFunClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
                    setTimeout(() => this.connect(), delay);
                }
            };

            // Connection timeout
            setTimeout(() => {
                if (!this.isConnected && this.connectionReject) {
                    this.connectionReject(new Error('Connection timeout'));
                    this.connectionReject = null;
                    this.ws?.close();
                }
            }, STEPFUN_CONSTANTS.CONNECTION.TIMEOUT_MS);
        });

        return this.connectionPromise;
    }

    private initializeSession(): void {
        const sessionConfig: SessionUpdateEvent = {
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                instructions: this.config.instructions || '',
                voice: this.config.voice || STEPFUN_CONSTANTS.DEFAULT_VOICE,
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
                input_audio_transcription: {
                    model: 'whisper-1', // Enable input audio transcription
                },
                turn_detection: {
                    type: 'server_vad',
                    prefix_padding_ms: STEPFUN_CONSTANTS.VAD.PREFIX_PADDING_MS,
                    silence_duration_ms: STEPFUN_CONSTANTS.VAD.SILENCE_DURATION_MS,
                    energy_awakeness_threshold: STEPFUN_CONSTANTS.VAD.ENERGY_AWAKENESS_THRESHOLD,
                },
                tools: this.config.tools || [],
                tool_choice: 'auto',
                temperature: 0.8,
            },
        };

        this.send(sessionConfig);
    }

    private handleMessage(event: StepFunServerEvent): void {
        // Log all events for debugging
        if (event.type !== 'response.audio.delta') {
            console.log('[StepFunClient] Received:', event.type, JSON.stringify(event).slice(0, 200));
        } else {
            console.log('[StepFunClient] Received: response.audio.delta (audio data)');
        }

        switch (event.type) {
            case 'session.created':
                console.log('[StepFunClient] Session created:', event.session.id);
                if (this.connectionResolve) {
                    this.connectionResolve();
                    this.connectionResolve = null;
                }
                this.callbacks.onSessionCreated();
                break;

            case 'session.updated':
                console.log('[StepFunClient] Session updated');
                this.callbacks.onSessionUpdated();
                break;

            case 'input_audio_buffer.speech_started':
                console.log('[StepFunClient] User speech started');
                this.callbacks.onSpeechStarted();
                break;

            case 'input_audio_buffer.speech_stopped':
                console.log('[StepFunClient] User speech stopped');
                this.callbacks.onSpeechStopped();
                break;

            case 'response.audio.delta':
                this.callbacks.onAudioDelta(event.delta);
                break;

            case 'response.audio.done':
                console.log('[StepFunClient] Audio response complete');
                this.callbacks.onAudioDone();
                break;

            case 'response.text.delta':
                this.callbacks.onTextDelta(event.delta);
                break;

            case 'response.text.done':
                console.log('[StepFunClient] Text response:', event.text);
                this.callbacks.onTextDone(event.text);
                break;

            case 'response.function_call_arguments.done':
                console.log('[StepFunClient] Function call:', event.name);
                this.handleFunctionCall(event.call_id, event.name, event.arguments);
                break;

            case 'error':
                // Ignore "no ongoing response to cancel" error - this is expected when interrupting
                if (event.error.message === 'no ongoing response to cancel') {
                    console.log('[StepFunClient] No response to cancel (expected during interruption)');
                    break;
                }
                console.error('[StepFunClient] Server error:', event.error);
                this.callbacks.onError(new Error(event.error.message));
                break;

            // Transcription events
            case 'conversation.item.input_audio_transcription.completed':
                console.log('[StepFunClient] User transcript:', event.transcript);
                this.callbacks.onUserTranscript?.(event.transcript);
                break;

            case 'conversation.item.input_audio_transcription.failed':
                console.warn('[StepFunClient] Transcription failed:', event.error);
                break;

            case 'response.audio_transcript.delta':
                this.callbacks.onAssistantTranscriptDelta?.(event.delta);
                break;

            case 'response.audio_transcript.done':
                console.log('[StepFunClient] Assistant transcript:', event.transcript);
                this.callbacks.onAssistantTranscriptDone?.(event.transcript);
                break;

            default:
                // Ignore other events
                break;
        }
    }

    private async handleFunctionCall(callId: string, name: string, args: string): Promise<void> {
        try {
            const result = await this.callbacks.onFunctionCall(callId, name, args);

            // Send function call output back to server
            this.send({
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: callId,
                    output: result,
                },
            });

            // Trigger response generation after function output
            this.send({
                type: 'response.create',
            });
        } catch (error) {
            console.error('[StepFunClient] Function call error:', error);
            // Send error output
            this.send({
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: callId,
                    output: JSON.stringify({ error: String(error) }),
                },
            });

            this.send({
                type: 'response.create',
            });
        }
    }

    private generateEventId(): string {
        return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    send(event: StepFunClientEvent): void {
        if (this.ws && this.isConnected && this.ws.readyState === WebSocket.OPEN) {
            // Add event_id to all events
            const eventWithId = {
                event_id: this.generateEventId(),
                ...event,
            };
            const json = JSON.stringify(eventWithId);
            // Log non-audio events fully, audio events partially
            if (event.type !== 'input_audio_buffer.append') {
                console.log('[StepFunClient] Sending:', json.slice(0, 300));
            }
            this.ws.send(json);
        } else {
            console.warn('[StepFunClient] Cannot send - not connected');
        }
    }

    private audioChunkCount: number = 0;

    sendAudio(base64Audio: string): void {
        this.audioChunkCount++;
        if (this.audioChunkCount <= 3) {
            console.log(`[StepFunClient] Sending audio chunk #${this.audioChunkCount}, base64 prefix: ${base64Audio.slice(0, 30)}...`);
        }
        this.send({
            type: 'input_audio_buffer.append',
            audio: base64Audio,
        });
    }

    sendTextMessage(text: string): void {
        // Create a user message item
        this.send({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: text,
                }],
            },
        });

        // Trigger response
        this.send({
            type: 'response.create',
        });
    }

    sendContextualUpdate(update: string): void {
        // Send as user message for context (StepFun doesn't support system role in conversation items)
        // This is a silent context update, not triggering a response
        this.send({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: `[Context Update]: ${update}`,
                }],
            },
        });
    }

    cancelResponse(): void {
        this.send({
            type: 'response.cancel',
        });
    }

    clearInputAudioBuffer(): void {
        this.send({
            type: 'input_audio_buffer.clear',
        });
    }

    /**
     * Interrupt the current response - stops response generation
     * Note: Don't clear audio buffer as it can cause server errors
     */
    interrupt(): void {
        console.log('[StepFunClient] Interrupting response');
        this.cancelResponse();
        // Don't call clearInputAudioBuffer() - causes server errors with StepFun
    }

    disconnect(): void {
        console.log('[StepFunClient] Disconnecting');
        this.reconnectAttempts = STEPFUN_CONSTANTS.CONNECTION.MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect
        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }
        this.isConnected = false;
        this.connectionPromise = null;
    }

    getIsConnected(): boolean {
        return this.isConnected;
    }
}
