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
import { startVoiceForegroundService, stopVoiceForegroundService } from './foregroundService';
import { fetch as expoFetch } from 'expo/fetch';
import {
    AudioContext as RNAudioContext,
    AudioRecorder,
    AudioBuffer as RNAudioBuffer,
    AudioManager,
} from 'react-native-audio-api';

/**
 * OpenAI voice session for React Native.
 * Uses the Realtime transcription API (STT) + REST TTS API.
 * No GPT-4o in the loop — transcribed speech goes directly to Claude Code.
 */

let ws: WebSocket | null = null;
let playbackContext: RNAudioContext | null = null;
let nextPlayTime = 0;
let recorder: AudioRecorder | null = null;
let pushToTalkMode = false;
let storedApiKey: string | null = null;
let ttsAbortController: AbortController | null = null;
let ttsQueue: string[] = [];
let ttsPlaying = false;
let pcmLeftover: Uint8Array | null = null;
let pcmAccumulator: Uint8Array[] = [];
let pcmAccumulatorBytes = 0;
// Minimum bytes to accumulate before scheduling playback (4800 samples * 2 bytes = 200ms at 24kHz)
const PCM_MIN_BUFFER_BYTES = 9600;

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
    if (code === 'session_expired') {
        return 'Your voice session has expired. Please start a new session.';
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

function schedulePcmBuffer(data: Uint8Array) {
    if (!playbackContext || data.length === 0) return;

    // Ensure even byte count for Int16Array alignment
    const usableLength = data.length - (data.length % 2);
    if (usableLength === 0) return;

    const aligned = data.slice(0, usableLength);
    const int16 = new Int16Array(aligned.buffer, aligned.byteOffset, usableLength / 2);
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

function flushPcmAccumulator() {
    if (pcmAccumulatorBytes === 0) return;

    // Merge accumulated chunks
    const merged = new Uint8Array(pcmAccumulatorBytes);
    let offset = 0;
    for (const chunk of pcmAccumulator) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    pcmAccumulator = [];
    pcmAccumulatorBytes = 0;

    schedulePcmBuffer(merged);
}

function playPcm16Bytes(bytes: Uint8Array) {
    if (!playbackContext || bytes.length === 0) return;

    // Prepend any leftover byte from a previous chunk
    let data: Uint8Array;
    if (pcmLeftover) {
        data = new Uint8Array(pcmLeftover.length + bytes.length);
        data.set(pcmLeftover);
        data.set(bytes, pcmLeftover.length);
        pcmLeftover = null;
    } else {
        data = bytes;
    }

    // Save trailing odd byte for next chunk
    if (data.length % 2 !== 0) {
        pcmLeftover = data.slice(data.length - 1);
        data = data.slice(0, data.length - 1);
        if (data.length === 0) return;
    }

    // Accumulate chunks until we have enough for smooth playback
    pcmAccumulator.push(data);
    pcmAccumulatorBytes += data.length;

    if (pcmAccumulatorBytes >= PCM_MIN_BUFFER_BYTES) {
        flushPcmAccumulator();
    }
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

    const response = await expoFetch('https://api.openai.com/v1/audio/speech', {
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
        let parsed: { error?: { code?: string; type?: string; message?: string } } | null = null;
        try { parsed = JSON.parse(errorText); } catch {}
        if (parsed?.error) {
            const message = humanizeOpenAIError(parsed.error);
            Modal.alert(t('common.error'), message);
        }
        return;
    }

    // Stream audio chunks as they arrive
    if (response.body) {
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                playPcm16Bytes(value);
            }
        }
        // Flush any remaining accumulated audio
        flushPcmAccumulator();
    } else {
        // Fallback: read full response
        const arrayBuffer = await response.arrayBuffer();
        playPcm16Bytes(new Uint8Array(arrayBuffer));
        flushPcmAccumulator();
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
    pcmLeftover = null;
    pcmAccumulator = [];
    pcmAccumulatorBytes = 0;
}

//
// Recording
//

let audioChunkCount = 0;
let isRecording = false;

function startRecording() {
    try {
        stopRecording();
        audioChunkCount = 0;
        isRecording = true;
        recorder = new AudioRecorder({
            sampleRate: OPENAI_SAMPLE_RATE,
            bufferLengthInSamples: 2400,
        });

        recorder.onAudioReady((event: { buffer: RNAudioBuffer; numFrames: number; when: number }) => {
            if (!isRecording) return;
            const channelData = event.buffer.getChannelData(0);
            if (channelData.length === 0) return;
            audioChunkCount++;
            if (audioChunkCount <= 3 || audioChunkCount % 100 === 0) {
                console.log(`[Voice] Audio chunk #${audioChunkCount} - frames: ${event.numFrames}, channels: ${event.buffer.numberOfChannels}`);
            }
            const base64 = float32ToBase64Pcm16(channelData);
            sendWsMessage({ type: 'input_audio_buffer.append', audio: base64 });
        });

        recorder.start();
        console.log('[Voice] AudioRecorder started');
    } catch (error) {
        console.error('[Voice] Failed to start recording:', error);
    }
}

function stopRecording() {
    isRecording = false;
    if (recorder) {
        recorder.stop();
        recorder = null;
    }
}

function float32ToBase64Pcm16(float32: Float32Array): string {
    const pcm16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    const bytes = new Uint8Array(pcm16.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
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
            const permStatus = await AudioManager.requestRecordingPermissions();
            if (permStatus !== 'Granted') {
                console.error('[Voice] Microphone permission denied:', permStatus);
                storage.getState().setRealtimeStatus('error');
                return;
            }

            playbackContext = new RNAudioContext({ sampleRate: OPENAI_SAMPLE_RATE });
            nextPlayTime = 0;

            // Get ephemeral token for transcription session
            const tokenResponse = await fetch('https://api.openai.com/v1/realtime/transcription_sessions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    input_audio_format: OPENAI_AUDIO_FORMAT,
                    input_audio_transcription: {
                        model: OPENAI_TRANSCRIPTION_MODEL,
                    },
                    turn_detection: config.pushToTalk ? null : {
                        type: 'server_vad',
                        threshold: 0.7,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 700,
                    },
                }),
            });

            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text();
                console.error('[Voice] Failed to get transcription token:', tokenResponse.status, errorText);
                storage.getState().setRealtimeStatus('error');
                let parsed: { error?: { code?: string; type?: string; message?: string } } | null = null;
                try { parsed = JSON.parse(errorText); } catch {}
                const message = parsed?.error
                    ? humanizeOpenAIError(parsed.error)
                    : t('errors.voiceServiceUnavailable');
                Modal.alert(t('common.error'), message);
                return;
            }

            const tokenData = await tokenResponse.json();
            const ephemeralKey = tokenData.client_secret?.value;
            if (!ephemeralKey) {
                console.error('[Voice] No ephemeral key in response:', JSON.stringify(tokenData));
                storage.getState().setRealtimeStatus('error');
                return;
            }

            console.log('[Voice] Got transcription token, connecting WebSocket...');

            pushToTalkMode = config.pushToTalk ?? false;

            const url = `wss://api.openai.com/v1/realtime?intent=transcription`;
            ws = new WebSocket(url, [
                'realtime',
                `openai-insecure-api-key.${ephemeralKey}`,
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
                            const message = humanizeOpenAIError(data.error);
                            Modal.alert(t('common.error'), message);
                        }
                        return;
                    }

                    if (data.type === 'transcription_session.created' || data.type === 'session.created') {
                        console.log('[Voice] Transcription session created');
                        if (!settled) {
                            settled = true;
                            clearTimeout(timeout);
                            resolve();
                            if (!pushToTalkMode) {
                                startRecording();
                            }
                            startVoiceForegroundService();
                            storage.getState().setRealtimeStatus('connected');
                            storage.getState().setRealtimeMode('idle');
                        }
                    }

                    if (data.type === 'conversation.item.input_audio_transcription.completed') {
                        const transcript = data.transcript?.trim();
                        if (!transcript) return;

                        console.log('[Voice] Transcription:', transcript);
                        storage.getState().setRealtimeMode('idle');

                        // Check for permission response first
                        if (tryHandlePermission(transcript)) return;

                        // Forward to Claude Code
                        const sessionId = getCurrentRealtimeSessionId();
                        if (sessionId) {
                            sync.sendMessage(sessionId, transcript, undefined, voicePrompt);
                        }
                    }

                    if (data.type === 'input_audio_buffer.speech_started') {
                        console.log('[Voice] Speech detected');
                        // Cancel any playing TTS when user starts speaking
                        cancelTts();
                    }

                    if (data.type === 'input_audio_buffer.speech_stopped') {
                        console.log('[Voice] Speech ended');
                    }
                };

                ws.onerror = (error: any) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    console.error('[Voice] WebSocket error:', JSON.stringify(error));
                    storage.getState().setRealtimeStatus('error');
                    Modal.alert(
                        t('common.error'),
                        'Could not connect to OpenAI voice service. Please check that your OpenAI account has sufficient credits at platform.openai.com.',
                    );
                    reject(error);
                };

                ws.onclose = (event: any) => {
                    console.log('[Voice] WebSocket closed - code:', event?.code, 'reason:', event?.reason);
                    stopRecording();
                    stopVoiceForegroundService();
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
        stopVoiceForegroundService();
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
        sendWsMessage({ type: 'input_audio_buffer.clear' });
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
        // Strip [CLAUDE] prefixes and <options> blocks, then speak via TTS
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

        // Update the transcription prompt with the glossary
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
                console.log('[Voice] Native voice session registered');
            } catch (error) {
                console.error('[Voice] Failed to register voice session:', error);
            }
        }
    }, []);

    return null;
};
