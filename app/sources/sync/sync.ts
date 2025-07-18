import { apiSocket } from '@/sync/apiSocket';
import { AuthCredentials } from '@/auth/tokenStorage';
import { ApiEncryption } from '@/sync/apiEncryption';
import { storage } from './storage';
import { ApiEphemeralUpdateSchema, ApiMessage, ApiUpdateContainerSchema } from './apiTypes';
import { DecryptedMessage, MessageContent, Session } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { randomUUID } from 'expo-crypto';

export const API_ENDPOINT = process.env.EXPO_PUBLIC_API_ENDPOINT || 'https://handy-api.korshakov.org';

class Sync {

    private credentials!: AuthCredentials;
    private encryption!: ApiEncryption;
    private sessionsSync: InvalidateSync;
    private messagesSync = new Map<string, InvalidateSync>();

    constructor() {
        this.sessionsSync = new InvalidateSync(this.fetchSessions);
    }

    async initialize(credentials: AuthCredentials, encryption: ApiEncryption) {
        this.credentials = credentials;
        this.encryption = encryption;

        // Subscribe to updates
        this.subscribeToUpdates();

        // Invalidate sync
        this.sessionsSync.invalidate();
    }

    abort = async (sessionId: string) => {
        await apiSocket.rpc(sessionId, 'abort', {});
    }

    allow = async (sessionId: string, id: string) => {
        await apiSocket.rpc(sessionId, 'permission', { id, approved: true });
    }

    deny = async (sessionId: string, id: string) => {
        await apiSocket.rpc(sessionId, 'permission', { id, approved: false });
    }

    onSessionVisible = (sessionId: string) => {
        let ex = this.messagesSync.get(sessionId);
        if (!ex) {
            ex = new InvalidateSync(() => this.fetchMessages(sessionId));
            this.messagesSync.set(sessionId, ex);
        }
        ex.invalidate();
    }

    sendMessage(sessionId: string, text: string) {
        // Generate local ID
        const localId = randomUUID();

        // Create user message content
        const content: MessageContent = {
            role: 'user',
            content: {
                type: 'text',
                text
            }
        };
        const encryptedContent = this.encryption.encrypt(content);

        // Add to messages
        storage.getState().applyMessages(sessionId, [{
            id: localId,
            createdAt: Date.now(),
            seq: null,
            content: {
                role: 'user',
                localId: localId,
                content: {
                    type: 'text',
                    text
                }
            }
        }]);

        // Send message
        apiSocket.send('message', { sid: sessionId, message: encryptedContent });
    }

    //
    // Private
    //

    private fetchSessions = async () => {
        if (!this.credentials) return;

        const response = await fetch(`${API_ENDPOINT}/v1/sessions`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch sessions: ${response.status}`);
        }

        const data = await response.json();
        const sessions = data.sessions as Array<{
            id: string;
            tag: string;
            seq: number;
            metadata: string;
            agentState: string | null;
            active: boolean;
            activeAt: number;
            createdAt: number;
            updatedAt: number;
            lastMessage: ApiMessage | null;
        }>;

        // Decrypt sessions
        let decryptedSessions: Session[] = [];
        for (const session of sessions) {
            const processedSession: Session = {
                ...session,
                thinking: false,
                thinkingAt: 0,
                metadata: this.encryption.decryptMetadata(session.metadata),
                agentState: this.encryption.decryptAgentState(session.agentState),
                lastMessage: this.encryption.decryptMessage(session.lastMessage)
            };
            decryptedSessions.push(processedSession);
        }

        // Apply to storage
        storage.getState().applySessions(decryptedSessions);
    }

    private fetchMessages = async (sessionId: string) => {
        const response = await apiSocket.request(`/v1/sessions/${sessionId}/messages`);
        const data = await response.json();

        // Decrypt messages
        let messages: DecryptedMessage[] = [];
        for (const msg of [...data.messages as ApiMessage[]].reverse()) {
            messages.push(this.encryption.decryptMessage(msg)!);
        }

        // Apply to storage
        storage.getState().applyMessages(sessionId, messages);
    }

    private subscribeToUpdates = () => {
        // Subscribe to message updates
        apiSocket.onMessage('update', this.handleUpdate.bind(this));
        apiSocket.onMessage('ephemeral', this.handleEphemeralUpdate.bind(this));

        // Subscribe to connection state changes
        apiSocket.onReconnected(() => {
            this.sessionsSync.invalidate();
            const sessionsData = storage.getState().sessionsData;
            if (sessionsData) {
                for (const item of sessionsData) {
                    if (typeof item !== 'string') {
                        this.messagesSync.get(item.id)?.invalidate();
                    }
                }
            }
        });

        // Recalculate online sessions
        setInterval(() => {
            storage.getState().recalculateOnline();
        }, 15000);
    }

    private handleUpdate = (update: unknown) => {
        console.log('handleUpdate', update);
        const validatedUpdate = ApiUpdateContainerSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('Invalid update received:', validatedUpdate.error);
            console.error('Invalid update received:', update);
            return;
        }
        const updateData = validatedUpdate.data;

        if (updateData.body.t === 'new-message') {
            const decryptedMessage = this.encryption.decryptMessage(updateData.body.message)!;

            // Update session
            const session = storage.getState().sessions[updateData.body.sid];
            if (session) {
                storage.getState().applySessions([{
                    ...session,
                    lastMessage: decryptedMessage,
                    updatedAt: updateData.createdAt,
                    seq: updateData.seq,
                }])
            } else {
                // Fetch sessions again if we don't have this session
                this.fetchSessions();
            }

            // Update messages
            storage.getState().applyMessages(updateData.body.sid, [decryptedMessage]);

            // Ping session
            // NOTE: @kirill Might fetch all messages again?
            this.onSessionVisible(updateData.body.sid);

        } else if (updateData.body.t === 'new-session') {
            this.fetchSessions(); // Just fetch sessions again
        } else if (updateData.body.t === 'update-session') {
            const session = storage.getState().sessions[updateData.body.id];
            if (session) {
                storage.getState().applySessions([{
                    ...session,
                    agentState: this.encryption.decryptAgentState(updateData.body.agentState?.value),
                    updatedAt: updateData.createdAt,
                    seq: updateData.seq,
                }])
            }
        }
    }

    private handleEphemeralUpdate = (update: unknown) => {
        const validatedUpdate = ApiEphemeralUpdateSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('Invalid ephemeral update received:', validatedUpdate.error);
            console.error('Invalid ephemeral update received:', update);
            return;
        }
        const updateData = validatedUpdate.data;
        const session = storage.getState().sessions[updateData.id];
        if (session) {
            storage.getState().applySessions([{
                ...session,
                active: updateData.active,
                activeAt: updateData.activeAt,
                thinking: updateData.thinking,
                thinkingAt: updateData.thinking ? updateData.activeAt : 0,
            }])
        }
    }
}

// Global singleton instance
export const sync = new Sync();

//
// Init sequence
//

let isInitialized = false;
export async function syncInit(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }

    // Initialize sync engine
    const encryption = new ApiEncryption(credentials.secret);

    // Initialize socket connection
    apiSocket.initialize({ endpoint: API_ENDPOINT, token: credentials.token }, encryption);

    // Initialize sessions engine
    await sync.initialize(credentials, encryption);

    isInitialized = true;
}