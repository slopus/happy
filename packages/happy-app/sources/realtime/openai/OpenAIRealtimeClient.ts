/**
 * OpenAI Realtime API client over WebRTC.
 *
 * Manages the peer connection, data channel, audio tracks, and
 * translates OpenAI events into the same callback shape that
 * RealtimeVoiceSession expects.
 *
 * Works in both React Native (via @livekit/react-native-webrtc)
 * and browser (native WebRTC APIs) — caller passes the RTCPeerConnection
 * constructor if needed.
 */

import { OPENAI_TOOL_DEFINITIONS, type OpenAIToolDef } from './toolTranslator';
import { realtimeClientTools } from '../realtimeClientTools';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface OpenAIRealtimeCallbacks {
    onConnect: () => void;
    onDisconnect: (reason?: string) => void;
    onModeChange: (mode: 'speaking' | 'idle') => void;
    onError: (error: Error) => void;
}

export interface OpenAIRealtimeConfig {
    clientSecret?: string;
    apiKey?: string;
    model?: string;
    instructions: string;
    tools?: OpenAIToolDef[];
    voice?: string;
    vadType?: 'semantic_vad' | 'server_vad';
    vadEagerness?: 'low' | 'medium' | 'high' | 'auto';
}

interface PendingEvent {
    type: string;
    [key: string]: any;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const OPENAI_REALTIME_URL = 'https://api.openai.com/v1/realtime';
const OPENAI_SESSIONS_URL = 'https://api.openai.com/v1/realtime/sessions';
const DEFAULT_MODEL = 'gpt-realtime-1.5';
const DEFAULT_VOICE = 'alloy';
const SESSION_MAX_MS = 29 * 60 * 1000; // warn at 29 min (max is 30)

// ────────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────────

export class OpenAIRealtimeClient {
    private callbacks: OpenAIRealtimeCallbacks;
    private pc: RTCPeerConnection | null = null;
    private dc: RTCDataChannel | null = null;
    private localStream: MediaStream | null = null;
    private connected = false;
    private connecting = false;
    private pendingEvents: PendingEvent[] = [];
    private sessionTimer: ReturnType<typeof setTimeout> | null = null;
    private isSpeaking = false;
    private speakingTimeout: ReturnType<typeof setTimeout> | null = null;

    // Caller can override WebRTC constructors (for RN vs browser)
    private RTCPeerConnectionCtor: any;
    private mediaDevicesImpl: any;

    constructor(
        callbacks: OpenAIRealtimeCallbacks,
        options?: { RTCPeerConnection?: any; mediaDevices?: any }
    ) {
        this.callbacks = callbacks;
        this.RTCPeerConnectionCtor = options?.RTCPeerConnection ?? globalThis.RTCPeerConnection;
        this.mediaDevicesImpl = options?.mediaDevices ?? navigator?.mediaDevices;
    }

    // ────────────────────────────────────────────────────────────
    // Public API
    // ────────────────────────────────────────────────────────────

    async connect(config: OpenAIRealtimeConfig): Promise<void> {
        if (this.connecting || this.connected) {
            console.warn('[OpenAIRealtime] Already connected or connecting');
            return;
        }
        this.connecting = true;

        const model = config.model || DEFAULT_MODEL;
        const voice = config.voice || DEFAULT_VOICE;

        try {
            // 1. Get ephemeral key (or use API key directly for dev)
            let bearerToken: string;
            if (config.clientSecret) {
                bearerToken = config.clientSecret;
            } else if (config.apiKey) {
                bearerToken = await this.fetchEphemeralKey(config.apiKey, model, voice);
            } else {
                throw new Error('No clientSecret or apiKey provided');
            }

            // 2. Create peer connection
            this.pc = new this.RTCPeerConnectionCtor() as any;

            // ICE state monitoring
            (this.pc as any).addEventListener('iceconnectionstatechange', () => {
                const state = (this.pc as any)?.iceConnectionState;
                console.log('[OpenAIRealtime] ICE state:', state);
                if (state === 'failed' || state === 'closed') {
                    this.handleDisconnect('ICE ' + state);
                }
            });

            // Remote audio track (model speaking)
            (this.pc as any).addEventListener('track', (event: any) => {
                console.log('[OpenAIRealtime] Remote track:', event.track?.kind);
            });

            // 3. Create data channel
            this.dc = (this.pc as any).createDataChannel('oai-events');
            this.setupDataChannel();

            // 4. Get mic audio
            try {
                if (this.mediaDevicesImpl?.getUserMedia) {
                    this.localStream = await this.mediaDevicesImpl.getUserMedia({ audio: true });
                    if (this.localStream) {
                        const track = this.localStream.getTracks()[0];
                        if (track) (this.pc as any).addTrack(track, this.localStream);
                        console.log('[OpenAIRealtime] Mic track added');
                    }
                } else {
                    console.warn('[OpenAIRealtime] No mediaDevices available');
                }
            } catch (micErr) {
                console.warn('[OpenAIRealtime] Mic not available:', micErr);
                // Continue — data channel still works
            }

            // 5. SDP offer/answer
            const offer = await (this.pc as any).createOffer({ offerToReceiveAudio: true });
            await (this.pc as any).setLocalDescription(offer);

            const sdpResponse = await fetch(`${OPENAI_REALTIME_URL}?model=${model}`, {
                method: 'POST',
                body: offer.sdp,
                headers: {
                    'Authorization': `Bearer ${bearerToken}`,
                    'Content-Type': 'application/sdp',
                },
            });

            if (!sdpResponse.ok) {
                const errText = await sdpResponse.text();
                throw new Error(`SDP exchange failed: ${sdpResponse.status} ${errText}`);
            }

            const answerSdp = await sdpResponse.text();
            await (this.pc as any).setRemoteDescription({ type: 'answer', sdp: answerSdp });

            // 6. Wait for data channel open
            await this.waitForDataChannelOpen(10000);

            // 7. Send session.update
            this.sendEvent({
                type: 'session.update',
                session: {
                    instructions: config.instructions,
                    tools: config.tools || OPENAI_TOOL_DEFINITIONS,
                    tool_choice: 'auto',
                    turn_detection: {
                        type: config.vadType || 'semantic_vad',
                        eagerness: config.vadEagerness || 'low',
                    },
                    voice,
                    input_audio_noise_reduction: { type: 'near_field' },
                },
            });

            this.connected = true;
            this.connecting = false;

            // Session expiry timer
            this.sessionTimer = setTimeout(() => {
                console.warn('[OpenAIRealtime] Session approaching 30-min limit');
                this.callbacks.onDisconnect('session_expiring');
            }, SESSION_MAX_MS);

            this.callbacks.onConnect();

        } catch (err: any) {
            this.connecting = false;
            this.cleanup();
            this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
        }
    }

    disconnect(): void {
        this.handleDisconnect('user_requested');
    }

    /**
     * Inject context without triggering a model response.
     * Maps to ElevenLabs sendContextualUpdate.
     */
    injectContext(text: string): void {
        if (!this.connected || !this.dc) return;
        this.sendEvent({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: `[CONTEXT UPDATE - do not respond to this] ${text}` }],
            },
        });
        // No response.create — model sees the context but doesn't speak
    }

    /**
     * Send a user-facing message that triggers a spoken model response.
     * Maps to ElevenLabs sendUserMessage.
     */
    sendMessage(text: string): void {
        if (!this.connected || !this.dc) return;
        this.sendEvent({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text }],
            },
        });
        this.sendEvent({ type: 'response.create' });
    }

    // ────────────────────────────────────────────────────────────
    // Private
    // ────────────────────────────────────────────────────────────

    private async fetchEphemeralKey(apiKey: string, model: string, voice: string): Promise<string> {
        console.log('[OpenAIRealtime] Fetching ephemeral key...');
        const res = await fetch(OPENAI_SESSIONS_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model, voice }),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Ephemeral key fetch failed: ${res.status} ${text}`);
        }
        const data = await res.json();
        return data.client_secret.value;
    }

    private setupDataChannel(): void {
        if (!this.dc) return;
        const dc = this.dc as any;

        dc.addEventListener('message', (e: any) => {
            try {
                const data = JSON.parse(e.data);
                this.handleServerEvent(data);
            } catch {
                console.warn('[OpenAIRealtime] Unparseable event:', e.data?.slice?.(0, 100));
            }
        });

        dc.addEventListener('close', () => {
            console.log('[OpenAIRealtime] DataChannel closed');
            this.handleDisconnect('datachannel_closed');
        });

        dc.addEventListener('error', (e: any) => {
            console.error('[OpenAIRealtime] DataChannel error:', e);
            this.callbacks.onError(new Error('DataChannel error'));
        });
    }

    private handleServerEvent(event: any): void {
        switch (event.type) {
            case 'session.created':
                console.log('[OpenAIRealtime] Session created:', event.session?.id);
                break;

            case 'response.audio.delta':
                this.setSpeaking(true);
                break;

            case 'response.audio.done':
            case 'response.done':
                this.setSpeaking(false);
                break;

            case 'response.cancelled':
                this.setSpeaking(false);
                break;

            case 'input_audio_buffer.speech_started':
                // User started talking — model should stop
                this.setSpeaking(false);
                break;

            case 'response.function_call_arguments.done':
                this.handleToolCall(event);
                break;

            case 'error':
                console.error('[OpenAIRealtime] Server error:', event.error);
                this.callbacks.onError(new Error(event.error?.message || 'OpenAI server error'));
                break;

            case 'session.ended':
                console.log('[OpenAIRealtime] Session ended by server');
                this.handleDisconnect('session_ended');
                break;
        }
    }

    private async handleToolCall(event: any): Promise<void> {
        const { name, arguments: argsJson, call_id } = event;
        console.log(`[OpenAIRealtime] Tool call: ${name}`, argsJson);

        const tool = (realtimeClientTools as any)[name];
        if (!tool) {
            console.error(`[OpenAIRealtime] Unknown tool: ${name}`);
            this.sendToolResult(call_id, `error: unknown tool "${name}"`);
            return;
        }

        try {
            const args = JSON.parse(argsJson);
            const result = await tool(args);
            this.sendToolResult(call_id, typeof result === 'string' ? result : JSON.stringify(result));
        } catch (err: any) {
            console.error(`[OpenAIRealtime] Tool "${name}" failed:`, err);
            this.sendToolResult(call_id, `error: ${err.message}`);
        }
    }

    private sendToolResult(callId: string, output: string): void {
        this.sendEvent({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output,
            },
        });
        // Trigger the model to continue speaking with the result
        this.sendEvent({ type: 'response.create' });
    }

    private setSpeaking(speaking: boolean): void {
        if (this.speakingTimeout) {
            clearTimeout(this.speakingTimeout);
            this.speakingTimeout = null;
        }

        if (speaking && !this.isSpeaking) {
            this.isSpeaking = true;
            this.callbacks.onModeChange('speaking');
        } else if (!speaking && this.isSpeaking) {
            // Debounce idle transition to avoid flicker
            this.speakingTimeout = setTimeout(() => {
                this.isSpeaking = false;
                this.callbacks.onModeChange('idle');
            }, 300);
        }
    }

    private sendEvent(event: PendingEvent): void {
        if (!this.dc || (this.dc as any).readyState !== 'open') {
            this.pendingEvents.push(event);
            return;
        }
        try {
            (this.dc as any).send(JSON.stringify(event));
        } catch (err) {
            console.error('[OpenAIRealtime] Failed to send event:', err);
        }
    }

    private flushPendingEvents(): void {
        while (this.pendingEvents.length > 0) {
            const event = this.pendingEvents.shift()!;
            this.sendEvent(event);
        }
    }

    private waitForDataChannelOpen(timeoutMs: number): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.dc) return reject(new Error('No data channel'));
            if ((this.dc as any).readyState === 'open') {
                this.flushPendingEvents();
                return resolve();
            }
            const timeout = setTimeout(() => reject(new Error('DataChannel open timeout')), timeoutMs);
            (this.dc as any).addEventListener('open', () => {
                clearTimeout(timeout);
                this.flushPendingEvents();
                resolve();
            });
        });
    }

    private handleDisconnect(reason: string): void {
        if (!this.connected && !this.connecting) return;
        console.log('[OpenAIRealtime] Disconnecting:', reason);
        this.cleanup();
        this.callbacks.onDisconnect(reason);
    }

    private cleanup(): void {
        this.connected = false;
        this.connecting = false;
        this.isSpeaking = false;
        this.pendingEvents = [];

        if (this.speakingTimeout) {
            clearTimeout(this.speakingTimeout);
            this.speakingTimeout = null;
        }
        if (this.sessionTimer) {
            clearTimeout(this.sessionTimer);
            this.sessionTimer = null;
        }
        if (this.dc) {
            try { (this.dc as any).close(); } catch {}
            this.dc = null;
        }
        if (this.localStream) {
            try { this.localStream.getTracks().forEach(t => t.stop()); } catch {}
            this.localStream = null;
        }
        if (this.pc) {
            try { (this.pc as any).close(); } catch {}
            this.pc = null;
        }
    }
}
