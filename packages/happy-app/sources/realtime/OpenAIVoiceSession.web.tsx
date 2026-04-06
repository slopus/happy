import React, { useEffect, useRef } from 'react';
import { registerVoiceSession, getCurrentRealtimeSessionId } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    OPENAI_VOICE,
    OPENAI_AUDIO_FORMAT,
    OPENAI_SAMPLE_RATE,
    OPENAI_TRANSCRIPTION_MODEL,
    OPENAI_TTS_MODEL,
    OPENAI_TTS_SPEED,
    OPENAI_TTS_INSTRUCTIONS,
} from './openaiVoiceConfig';
import { stripVoicePrefix } from './hooks/contextFormatters';
import { voicePrompt } from '@/sync/prompt/systemPrompt';
import type { VoiceSession, VoiceSessionConfig } from './types';

/**
 * OpenAI voice session for web.
 * Uses the Realtime transcription API (STT) + REST TTS API.
 * No GPT-4o in the loop — transcribed speech goes directly to Claude Code.
 */

let ws: WebSocket | null = null;
let playbackContext: AudioContext | null = null;
let nextPlayTime = 0;
let mediaStream: MediaStream | null = null;
let workletNode: AudioWorkletNode | null = null;
let recordingContext: AudioContext | null = null;
let pushToTalkMode = false;
let audioChunkCount = 0;
let storedApiKey: string | null = null;
let ttsAbortController: AbortController | null = null;
let ttsQueue: string[] = [];
let ttsPlaying = false;

function humanizeOpenAIError(error: { type?: string; code?: string; message?: string }): string {
    const code = error?.code ?? '';
    const type = error?.type ?? '';
    if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached' || type === 'insufficient_quota') {
        return 'Your OpenAI account has run out of credits. Please add funds at platform.openai.com.';
    }
    if (code === 'rate_limit_exceeded') {
        return 'OpenAI rate limit reached. Please wait a moment and try again.';
    }
    if (code === 'invalid_api_key') {
        return 'Your OpenAI API key is invalid. Please check your settings.';
    }
    if (type === 'server_error') {
        return 'OpenAI voice service is unavailable. This is usually caused by insufficient credits — please check your balance at platform.openai.com.';
    }
    return error?.message ?? 'An unexpected error occurred with the voice service.';
}

function sendWsMessage(data: Record<string, unknown>) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function playPcm16Bytes(bytes: Uint8Array) {
    if (!playbackContext || bytes.length === 0) return;

    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
    }

    const buffer = playbackContext.createBuffer(1, float32.length, OPENAI_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackContext.destination);

    const now = playbackContext.currentTime;
    const startTime = Math.max(now, nextPlayTime);
    source.start(startTime);
    nextPlayTime = startTime + buffer.duration;
}

//
// Permission pattern matching
//

const ALLOW_PATTERNS = /^(yes|yeah|yep|approve|allow|go ahead|do it|ok|okay|sure|go for it)$/i;
const DENY_PATTERNS = /^(no|nope|deny|reject|stop|cancel|don't|do not)$/i;

function tryHandlePermission(transcript: string): boolean {
    const sessionId = getCurrentRealtimeSessionId();
    if (!sessionId) return false;

    const session = storage.getState().sessions[sessionId];
    const requests = session?.agentState?.requests;
    if (!requests || Object.keys(requests).length === 0) return false;

    const requestId = Object.keys(requests)[0];
    const trimmed = transcript.trim();

    if (ALLOW_PATTERNS.test(trimmed)) {
        sessionAllow(sessionId, requestId);
        return true;
    }
    if (DENY_PATTERNS.test(trimmed)) {
        sessionDeny(sessionId, requestId);
        return true;
    }
    return false;
}

//
// TTS
//

async function processTtsQueue() {
    if (ttsPlaying || ttsQueue.length === 0) return;
    ttsPlaying = true;

    while (ttsQueue.length > 0) {
        const text = ttsQueue.shift()!;
        try {
            await speakText(text);
        } catch (error) {
            if ((error as Error).name !== 'AbortError') {
                console.error('[Voice] TTS error:', error);
            }
        }
    }

    ttsPlaying = false;
    storage.getState().setRealtimeMode('idle');
}

async function speakText(text: string) {
    if (!storedApiKey || !playbackContext) return;

    storage.getState().setRealtimeMode('agent-speaking');

    ttsAbortController = new AbortController();

    const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${storedApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: OPENAI_TTS_MODEL,
            voice: OPENAI_VOICE,
            input: text,
            response_format: 'pcm',
            speed: OPENAI_TTS_SPEED,
            instructions: OPENAI_TTS_INSTRUCTIONS,
        }),
        signal: ttsAbortController.signal,
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error('[Voice] TTS request failed:', response.status, errorText);
        return;
    }

    // Web supports streaming response bodies
    if (response.body) {
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                playPcm16Bytes(value);
            }
        }
    } else {
        // Fallback: read full response
        const arrayBuffer = await response.arrayBuffer();
        playPcm16Bytes(new Uint8Array(arrayBuffer));
    }

    ttsAbortController = null;
}

function cancelTts() {
    ttsQueue = [];
    if (ttsAbortController) {
        ttsAbortController.abort();
        ttsAbortController = null;
    }
    ttsPlaying = false;
    nextPlayTime = 0;
}

//
// Recording
//

async function startRecording() {
    try {
        audioChunkCount = 0;
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordingContext = new AudioContext({ sampleRate: OPENAI_SAMPLE_RATE });
        const source = recordingContext.createMediaStreamSource(mediaStream);

        const workletCode = `
            class PCMProcessor extends AudioWorkletProcessor {
                process(inputs) {
                    const input = inputs[0];
                    if (input.length > 0) {
                        const channelData = input[0];
                        const pcm16 = new Int16Array(channelData.length);
                        for (let i = 0; i < channelData.length; i++) {
                            const s = Math.max(-1, Math.min(1, channelData[i]));
                            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                        }
                        this.port.postMessage({ pcm16 });
                    }
                    return true;
                }
            }
            registerProcessor('pcm-processor', PCMProcessor);
        `;
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await recordingContext.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        workletNode = new AudioWorkletNode(recordingContext, 'pcm-processor');
        workletNode.port.onmessage = (event) => {
            if (event.data.pcm16) {
                audioChunkCount++;
                const bytes = new Uint8Array(event.data.pcm16.buffer);
                let binary = '';
                for (let i = 0; i < bytes.length; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                const base64 = btoa(binary);
                sendWsMessage({ type: 'input_audio_buffer.append', audio: base64 });
            }
        };

        source.connect(workletNode);
    } catch (error) {
        console.error('[Voice] Failed to start recording:', error);
    }
}

function stopRecording() {
    if (workletNode) {
        workletNode.disconnect();
        workletNode = null;
    }
    if (recordingContext) {
        recordingContext.close();
        recordingContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
    }
}

//
// Voice session implementation
//

class RealtimeVoiceSessionImpl implements VoiceSession {

    async startSession(config: VoiceSessionConfig): Promise<void> {
        if (ws) {
            console.warn('[Voice] Session already active');
            return;
        }

        try {
            storage.getState().setRealtimeStatus('connecting');
            storedApiKey = config.apiKey ?? null;

            // Request microphone permission
            try {
                await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (error) {
                console.error('[Voice] Microphone permission denied:', error);
                storage.getState().setRealtimeStatus('error');
                return;
            }

            playbackContext = new AudioContext({ sampleRate: OPENAI_SAMPLE_RATE });
            nextPlayTime = 0;

            pushToTalkMode = config.pushToTalk ?? false;

            const url = `wss://api.openai.com/v1/realtime?intent=transcription`;
            ws = new WebSocket(url, [
                'realtime',
                `openai-insecure-api-key.${config.apiKey}`,
                'openai-beta.realtime-v1',
            ]);

            await new Promise<void>((resolve, reject) => {
                if (!ws) return reject(new Error('WebSocket not created'));

                let settled = false;

                const timeout = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        storage.getState().setRealtimeStatus('error');
                        Modal.alert(
                            t('common.error'),
                            'Could not connect to OpenAI voice service. Please check that your OpenAI account has sufficient credits at platform.openai.com.',
                        );
                        if (ws) {
                            ws.close();
                            ws = null;
                        }
                        reject(new Error('Connection timeout'));
                    }
                }, 10000);

                ws.onmessage = (event: MessageEvent) => {
                    const data = JSON.parse(event.data);

                    if (data.type === 'error') {
                        if (!settled) {
                            settled = true;
                            clearTimeout(timeout);
                            console.error('[Voice] API error during setup:', JSON.stringify(data.error));
                            const message = humanizeOpenAIError(data.error);
                            storage.getState().setRealtimeStatus('error');
                            Modal.alert(t('common.error'), message);
                            reject(new Error(message));
                        } else {
                            console.error('[Voice] API error:', JSON.stringify(data.error));
                        }
                        return;
                    }

                    if (data.type === 'transcription_session.created' || data.type === 'session.created') {
                        // Send transcription session config
                        sendWsMessage({
                            type: 'transcription_session.update',
                            session: {
                                input_audio_format: OPENAI_AUDIO_FORMAT,
                                input_audio_transcription: {
                                    model: OPENAI_TRANSCRIPTION_MODEL,
                                },
                                turn_detection: pushToTalkMode ? null : {
                                    type: 'server_vad',
                                    threshold: 0.7,
                                    prefix_padding_ms: 300,
                                    silence_duration_ms: 700,
                                },
                            },
                        });
                    }

                    if (data.type === 'transcription_session.updated' || data.type === 'session.updated') {
                        if (!settled) {
                            settled = true;
                            clearTimeout(timeout);
                            console.log('[Voice] Transcription session configured');
                            resolve();
                            if (!pushToTalkMode) {
                                startRecording();
                            }
                            storage.getState().setRealtimeStatus('connected');
                            storage.getState().setRealtimeMode('idle');
                        }
                    }

                    if (data.type === 'conversation.item.input_audio_transcription.completed') {
                        const transcript = data.transcript?.trim();
                        if (!transcript) return;

                        console.log('[Voice] Transcription:', transcript);
                        storage.getState().setRealtimeMode('idle');

                        if (tryHandlePermission(transcript)) return;

                        const sessionId = getCurrentRealtimeSessionId();
                        if (sessionId) {
                            sync.sendMessage(sessionId, transcript, undefined, voicePrompt);
                        }
                    }

                    if (data.type === 'input_audio_buffer.speech_started') {
                        console.log('[Voice] Speech detected');
                        cancelTts();
                    }

                    if (data.type === 'input_audio_buffer.speech_stopped') {
                        console.log('[Voice] Speech ended');
                    }
                };

                ws.onerror = (error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    console.error('[Voice] WebSocket error:', error);
                    storage.getState().setRealtimeStatus('error');
                    Modal.alert(
                        t('common.error'),
                        'Could not connect to OpenAI voice service. Please check that your OpenAI account has sufficient credits at platform.openai.com.',
                    );
                    reject(error);
                };

                ws.onclose = () => {
                    console.log('[Voice] WebSocket closed');
                    stopRecording();
                    cancelTts();
                    storage.getState().setRealtimeStatus('disconnected');
                    storage.getState().setRealtimeMode('idle', true);
                    storage.getState().clearRealtimeModeDebounce();
                    ws = null;
                };
            });
        } catch (error) {
            console.error('[Voice] Failed to start session:', error);
            storage.getState().setRealtimeStatus('error');
            if (ws) {
                ws.close();
                ws = null;
            }
        }
    }

    async endSession(): Promise<void> {
        stopRecording();
        cancelTts();
        if (ws) {
            ws.close();
            ws = null;
        }
        if (playbackContext) {
            playbackContext.close();
            playbackContext = null;
        }
        storedApiKey = null;
        storage.getState().setRealtimeStatus('disconnected');
    }

    startTalking(): void {
        if (!pushToTalkMode || !ws || ws.readyState !== WebSocket.OPEN) return;
        cancelTts();
        startRecording();
    }

    stopTalking(): void {
        if (!pushToTalkMode || !ws || ws.readyState !== WebSocket.OPEN) return;
        stopRecording();
        if (audioChunkCount < 5) {
            sendWsMessage({ type: 'input_audio_buffer.clear' });
            return;
        }
        sendWsMessage({ type: 'input_audio_buffer.commit' });
    }

    sendTextMessage(message: string): void {
        let text = stripVoicePrefix(message);
        if (!text) return;
        text = text.replace(/<options>[\s\S]*?<\/options>/g, '').trim();
        if (!text) return;
        ttsQueue.push(text);
        processTtsQueue();
    }

    sendContextualUpdate(update: string): void {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        // Truncate to stay under 1024 character limit
        const prompt = update.length > 900 ? update.slice(0, 900) : update;

        sendWsMessage({
            type: 'transcription_session.update',
            session: {
                input_audio_transcription: {
                    model: OPENAI_TRANSCRIPTION_MODEL,
                    prompt,
                },
            },
        });
    }
}

export const OpenAIVoiceSession: React.FC = () => {
    const hasRegistered = useRef(false);

    useEffect(() => {
        if (!hasRegistered.current) {
            try {
                registerVoiceSession(new RealtimeVoiceSessionImpl());
                hasRegistered.current = true;
                console.log('[Voice] Web voice session registered');
            } catch (error) {
                console.error('[Voice] Failed to register voice session:', error);
            }
        }
    }, []);

    return null;
};
