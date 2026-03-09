import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl, getWhisperUrl } from './serverConfig';
import { config } from '@/config';
import { storage } from './storage';

// ---- ElevenLabs (assistant mode) ----

export interface VoiceTokenResponse {
    allowed: boolean;
    token?: string;
    agentId?: string;
}

export async function fetchVoiceToken(
    credentials: AuthCredentials,
    sessionId: string
): Promise<VoiceTokenResponse> {
    const serverUrl = getServerUrl();
    const userId = storage.getState().profile.id;
    console.log(`[Voice] User ID: ${userId}`);

    // Get agent ID from config
    const agentId = __DEV__
        ? config.elevenLabsAgentIdDev
        : config.elevenLabsAgentIdProd;

    if (!agentId) {
        throw new Error('Agent ID not configured');
    }

    const response = await fetch(`${serverUrl}/v1/voice/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            sessionId,
            agentId
        })
    });

    if (!response.ok) {
        // 400 means the endpoint doesn't exist yet on this server.
        // Allow voice anyway to not break users on experimental/custom servers
        // that haven't been updated with the token endpoint yet.
        if (response.status === 400) {
            return { allowed: true };
        }
        throw new Error(`Voice token request failed: ${response.status}`);
    }

    return await response.json();
}

// ---- Whisper (dictation mode) ----

export interface TranscriptionResponse {
    text: string;
}

function filenameForBlob(blob: Blob): string {
    const t = blob.type;
    if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return 'recording.m4a';
    if (t.includes('ogg')) return 'recording.ogg';
    if (t.includes('webm')) return 'recording.webm';
    return 'recording.bin';
}

export async function transcribeAudio(audioUri: string): Promise<TranscriptionResponse> {
    const whisperUrl = getWhisperUrl();
    console.log('[Whisper] URL:', whisperUrl, 'audioUri:', audioUri?.slice(0, 80));

    const formData = new FormData();

    // Fetch the audio file and create a blob for upload
    let blob: Blob;
    try {
        const response = await fetch(audioUri);
        blob = await response.blob();
        console.log('[Whisper] Blob loaded:', blob.size, 'bytes, type:', blob.type);
    } catch (e) {
        throw new Error(`Audio blob fetch failed: ${e instanceof Error ? e.message : e}`);
    }

    if (blob.size === 0) {
        throw new Error('Recording is empty (0 bytes)');
    }

    const filename = filenameForBlob(blob);
    console.log('[Whisper] Upload filename:', filename);
    formData.append('file', blob, filename);
    formData.append('model', 'Systran/faster-whisper-base');
    formData.append('response_format', 'json');
    formData.append('language', 'en');
    formData.append('prompt', 'Debian, GlusterFS, Portainer, macvlan, Wazuh, VLAN, Proxmox, erying, nginx, Milvus, Claude, Whisper, Fastify, Prisma, MinIO, Tailscale');

    let result: Response;
    try {
        result = await fetch(`${whisperUrl}/v1/audio/transcriptions`, {
            method: 'POST',
            body: formData,
        });
    } catch (e) {
        throw new Error(`Whisper fetch failed (${whisperUrl}): ${e instanceof Error ? e.message : e}`);
    }

    if (!result.ok) {
        const errorText = await result.text();
        throw new Error(`Transcription failed (${result.status}): ${errorText}`);
    }

    return await result.json();
}
