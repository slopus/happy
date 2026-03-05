/**
 * Cloud Session Manager
 *
 * Manages cloud chat sessions — conversations that run entirely client-side
 * without requiring a connected machine/daemon. The app calls AI provider APIs
 * directly and stores messages on the server with E2E encryption.
 *
 * Lifecycle:
 *  1. createCloudSession() — generate encryption key, register with server, add to store
 *  2. sendCloudMessage() — encrypt user msg + post to server, call AI API, stream response
 *  3. abort() — cancel the current streaming request
 */

import { randomUUID } from 'expo-crypto';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { apiSocket } from '@/sync/apiSocket';
import { encodeBase64 } from '@/encryption/base64';
import { normalizeRawMessage, type NormalizedMessage, type RawRecord } from '@/sync/typesRaw';
import type { Message } from '@/sync/typesMessage';
import type { CloudMessage, CloudStreamEvent } from './types';
import type { CloudAgentType } from './providerRegistry';
import { getCloudProvider, getCloudProviderId, getCloudConfigFromProfile } from './providerRegistry';
import type { AIBackendProfile } from '@/sync/settings';

/** Active abort controllers per session */
const abortControllers = new Map<string, AbortController>();

/** Track which sessions are cloud sessions (for fast lookup) */
const cloudSessionProfiles = new Map<string, AIBackendProfile>();

/**
 * Create a new cloud chat session.
 *
 * This generates an encryption key, registers the session with the server,
 * initializes local encryption, and adds the session to the Zustand store.
 *
 * @returns The new session ID, or null on failure
 */
export async function createCloudSession(
    agentType: CloudAgentType,
    profile: AIBackendProfile,
): Promise<string | null> {
    const encryption = sync.encryption;
    if (!encryption) {
        console.error('[cloud] No encryption available');
        return null;
    }

    try {
        const sessionId = randomUUID();
        const tag = `cloud-${sessionId}`;
        const providerId = getCloudProviderId(agentType);

        // 1. Generate a 32-byte data encryption key
        const dataEncryptionKey = crypto.getRandomValues(new Uint8Array(32));

        // 2. Encrypt it with the user's content public key
        const encryptedKey = await encryption.encryptEncryptionKey(dataEncryptionKey);

        // 3. Initialize session encryption locally so we can encrypt metadata/messages
        await encryption.initializeSessions(new Map([[sessionId, dataEncryptionKey]]));

        const sessionEncryption = encryption.getSessionEncryption(sessionId);
        if (!sessionEncryption) {
            console.error('[cloud] Failed to initialize session encryption');
            return null;
        }

        // 4. Build cloud metadata
        const metadata = {
            path: 'Cloud Chat',
            host: 'cloud',
            flavor: agentType,
            isCloud: true,
            cloudProvider: providerId,
            cloudProfileId: profile.id,
        };

        const agentState = {
            controlledByUser: true,
            requests: {},
        };

        // 5. Encrypt metadata and agentState
        const encryptedMetadata = await sessionEncryption.encryptMetadata(metadata);
        const encryptedAgentState = await sessionEncryption.encryptAgentState(agentState);

        // 6. POST to server to create the session
        const response = await apiSocket.request('/v1/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tag,
                metadata: encryptedMetadata,
                agentState: encryptedAgentState,
                dataEncryptionKey: encodeBase64(encryptedKey, 'base64'),
            }),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            console.error('[cloud] Failed to create session on server:', response.status, errorText);
            return null;
        }

        const data = await response.json();
        const serverSession = data.session;

        // 7. Add session to the Zustand store
        storage.getState().applySessions([{
            id: serverSession.id ?? sessionId,
            seq: serverSession.seq ?? 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            active: true,
            activeAt: Date.now(),
            metadata,
            metadataVersion: serverSession.metadataVersion ?? 0,
            agentState,
            agentStateVersion: serverSession.agentStateVersion ?? 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        }]);

        // Store the profile for this session
        const finalId = serverSession.id ?? sessionId;
        cloudSessionProfiles.set(finalId, profile);

        return finalId;
    } catch (error) {
        console.error('[cloud] Failed to create cloud session:', error);
        return null;
    }
}

/**
 * Get the stored profile for a cloud session.
 */
export function getCloudSessionProfile(sessionId: string): AIBackendProfile | null {
    return cloudSessionProfiles.get(sessionId) ?? null;
}

/**
 * Set/update the profile for a cloud session (e.g., when loading from settings).
 */
export function setCloudSessionProfile(sessionId: string, profile: AIBackendProfile): void {
    cloudSessionProfiles.set(sessionId, profile);
}

/**
 * Send a message in a cloud chat session.
 *
 * 1. Posts the user message to the server (encrypted) via sync.sendMessage
 * 2. Calls the AI provider API with the full conversation history
 * 3. Streams the response, updating cloudStreaming state in real-time
 * 4. On completion, posts the assistant message to the server (encrypted)
 */
export async function sendCloudMessage(
    sessionId: string,
    text: string,
): Promise<void> {
    const profile = cloudSessionProfiles.get(sessionId);
    if (!profile) {
        console.error('[cloud] No profile found for session', sessionId);
        return;
    }

    const session = storage.getState().sessions[sessionId];
    if (!session?.metadata) {
        console.error('[cloud] Session not found or has no metadata', sessionId);
        return;
    }

    const agentType = (session.metadata.flavor ?? 'claude') as CloudAgentType;
    const provider = getCloudProvider(agentType);
    const config = getCloudConfigFromProfile(profile, agentType);

    if (!config) {
        console.error('[cloud] No API key configured for', agentType);
        // Show error in streaming state
        storage.setState((state) => ({
            cloudStreaming: {
                ...state.cloudStreaming,
                [sessionId]: { text: '', isStreaming: false },
            },
        }));
        return;
    }

    // 1. Send user message through normal sync pipeline (encrypts + posts to server)
    await sync.sendMessage(sessionId, text);

    // 2. Build conversation history from stored messages
    const sessionMessages = storage.getState().sessionMessages[sessionId];
    const conversationHistory = buildConversationHistory(sessionMessages?.messages ?? []);

    // 3. Set up streaming state
    const abortController = new AbortController();
    abortControllers.set(sessionId, abortController);

    storage.setState((state) => ({
        cloudStreaming: {
            ...state.cloudStreaming,
            [sessionId]: { text: '', isStreaming: true },
        },
    }));

    let fullText = '';

    try {
        // 4. Call AI provider API with streaming
        await provider.sendMessage(
            conversationHistory,
            config,
            abortController.signal,
            (event: CloudStreamEvent) => {
                switch (event.type) {
                    case 'text-delta':
                        fullText += event.text;
                        storage.setState((state) => ({
                            cloudStreaming: {
                                ...state.cloudStreaming,
                                [sessionId]: { text: fullText, isStreaming: true },
                            },
                        }));
                        break;

                    case 'text-done':
                        fullText = event.text;
                        break;

                    case 'error':
                        console.error('[cloud] Provider error:', event.error);
                        // Add error as a system-level agent message
                        addAgentMessage(sessionId, `Error: ${event.error}`);
                        break;

                    case 'usage':
                        // Usage tracked for display purposes
                        break;
                }
            },
        );

        // 5. Finalize: add the assistant response as a proper message
        if (fullText) {
            addAgentMessage(sessionId, fullText);
        }
    } catch (error) {
        if (!abortController.signal.aborted) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error('[cloud] Send failed:', message);
            addAgentMessage(sessionId, `Error: ${message}`);
        }
    } finally {
        // Clear streaming state
        abortControllers.delete(sessionId);
        storage.setState((state) => ({
            cloudStreaming: {
                ...state.cloudStreaming,
                [sessionId]: { text: '', isStreaming: false },
            },
        }));
    }
}

/**
 * Abort the current streaming request for a cloud session.
 */
export function abortCloudSession(sessionId: string): void {
    const controller = abortControllers.get(sessionId);
    if (controller) {
        controller.abort();
        abortControllers.delete(sessionId);
    }
}

/**
 * Check if a session is currently streaming a cloud response.
 */
export function isCloudSessionStreaming(sessionId: string): boolean {
    return storage.getState().cloudStreaming[sessionId]?.isStreaming ?? false;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Build a CloudMessage[] conversation history from stored messages.
 * Filters to only user text and agent text messages.
 */
function buildConversationHistory(messages: Message[]): CloudMessage[] {
    const history: CloudMessage[] = [];

    // Messages are stored newest-first, so reverse for chronological order
    const chronological = [...messages].reverse();

    for (const msg of chronological) {
        switch (msg.kind) {
            case 'user-text':
                history.push({ role: 'user', content: msg.text });
                break;
            case 'agent-text':
                if (msg.text) {
                    history.push({ role: 'assistant', content: msg.text });
                }
                break;
            // Skip tool calls and mode switches — cloud chat is text-only
        }
    }

    return history;
}

/**
 * Add an agent (assistant) message to the session.
 * Creates a normalized message and enqueues it through the sync pipeline.
 * Also posts the encrypted message to the server for persistence.
 */
function addAgentMessage(sessionId: string, text: string): void {
    const localId = randomUUID();
    const createdAt = Date.now();

    // RawRecord for agent messages must use the 'output' + 'assistant' format
    const rawRecord: RawRecord = {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    model: 'cloud',
                    content: [{ type: 'text', text }],
                },
            },
        },
    };

    const normalized = normalizeRawMessage(localId, localId, createdAt, rawRecord);
    if (normalized) {
        sync.addCloudResponseMessage(sessionId, [normalized]);
    }

    // Also encrypt and post to server for cross-device persistence
    void postEncryptedMessage(sessionId, rawRecord, localId);
}

/**
 * Encrypt a raw record and POST it to the server for persistent storage.
 */
async function postEncryptedMessage(
    sessionId: string,
    rawRecord: RawRecord,
    localId: string,
): Promise<void> {
    try {
        const encryption = sync.encryption;
        if (!encryption) return;

        const sessionEncryption = encryption.getSessionEncryption(sessionId);
        if (!sessionEncryption) return;

        const encrypted = await sessionEncryption.encryptRawRecord(rawRecord);

        await apiSocket.request(`/v3/sessions/${sessionId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{
                    localId,
                    content: encrypted,
                }],
            }),
        });
    } catch (error) {
        console.error('[cloud] Failed to persist message to server:', error);
    }
}
