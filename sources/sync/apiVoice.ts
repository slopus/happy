/**
 * API functions for voice assistant integration.
 *
 * Fetches conversation tokens from the server for ElevenLabs integration.
 * The server handles authentication with ElevenLabs API, keeping credentials secure.
 *
 * Supports two modes:
 * 1. Default: Server uses its own ElevenLabs credentials (production)
 * 2. Custom: Client provides their own ElevenLabs agent ID and API key
 */

import { getServerUrl } from '@/sync/serverConfig';
import { getCurrentAuth } from '@/auth/AuthContext';
import { storage } from '@/sync/storage';

export interface VoiceTokenResponse {
    allowed: boolean;
    token?: string;
    agentId?: string;
    error?: string;
}

export interface VoiceTokenRequest {
    revenueCatPublicKey?: string;
    // Custom ElevenLabs credentials (when user provides their own)
    customAgentId?: string;
    customApiKey?: string;
}

/**
 * Fetch a conversation token from the server for ElevenLabs voice sessions.
 *
 * This uses the private agent flow where:
 * 1. Server holds the ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID (or uses user-provided ones)
 * 2. Server fetches a short-lived conversation token from ElevenLabs
 * 3. Client uses this token to establish WebRTC connection
 *
 * If the user has configured custom ElevenLabs credentials in settings,
 * those will be passed to the server to use instead of the default production agent.
 *
 * @returns Object with allowed status, and if allowed, the token and agentId
 * @throws Error if not authenticated or network failure
 */
export async function fetchVoiceToken(): Promise<VoiceTokenResponse> {
    const auth = getCurrentAuth();
    if (!auth?.credentials?.token) {
        throw new Error('Not authenticated');
    }

    // Check if user has custom ElevenLabs credentials configured
    const settings = storage.getState().settings;
    const useCustomAgent = settings.elevenLabsUseCustomAgent;
    const customAgentId = settings.elevenLabsAgentId;
    const customApiKey = settings.elevenLabsApiKey;

    // Build request body
    const requestBody: VoiceTokenRequest = {};

    // Include custom credentials if user has enabled custom agent
    if (useCustomAgent && customAgentId && customApiKey) {
        requestBody.customAgentId = customAgentId;
        requestBody.customApiKey = customApiKey;
    }

    const serverUrl = getServerUrl();
    const response = await fetch(`${serverUrl}/v1/voice/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${auth.credentials.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        return {
            allowed: false,
            error: errorData.error || `Server error: ${response.status}`
        };
    }

    const data = await response.json();
    return data as VoiceTokenResponse;
}
