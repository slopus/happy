import { syncSocket } from '@/sync/SyncSocket';
import { AuthCredentials } from '@/auth/tokenStorage';
import { MessageEncryption } from '@/sync/encryption';
import {
    Session,
    SessionUpdateSchema,
    SourceMessage,
    Metadata,
    EphemeralUpdateSchema,
} from '@/sync/types';
import { SyncSession } from './SyncSession';
import { backoff } from './time';

const API_ENDPOINT = 'https://handy-api.korshakov.org';

type SessionsListener = (sessions: Session[], isLoaded: boolean) => void;

class SyncSessions {

    private sessions: Map<string, Session> = new Map();
    private listeners: Set<SessionsListener> = new Set();
    private credentials!: AuthCredentials;
    private encryption!: MessageEncryption;
    private isLoaded = false;
    private wasConnected = false;

    async initialize(credentials: AuthCredentials) {
        this.credentials = credentials;
        this.encryption = new MessageEncryption(credentials.secret);

        // Fetch initial sessions
        await this.fetchSessions();

        // Subscribe to updates
        this.subscribeToUpdates();
    }

    private async fetchSessions() {
        if (!this.credentials) return;

        backoff(async () => {

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
                lastMessage: SourceMessage | null;
            }>;

            // Process and decrypt sessions
            this.sessions.clear();
            for (const session of sessions) {
                const processedSession: Session = {
                    ...session,
                    thinking: false,
                    thinkingAt: 0,
                    metadata: this.encryption.decryptMetadata(session.metadata),
                    agentState: this.encryption.decryptAgentState(session.agentState),
                    lastMessage: this.encryption.decryptMessage(session.lastMessage)
                };
                this.sessions.set(session.id, processedSession);
            }

            // On loaded
            this.isLoaded = true;
            this.notifyListeners();
        });
    }

    private subscribeToUpdates() {
        // Subscribe to message updates
        syncSocket.onMessage('update', this.handleUpdate.bind(this));
        syncSocket.onMessage('ephemeral', this.handleEphemeralUpdate.bind(this));

        // Subscribe to connection state changes
        syncSocket.addListener((state) => {
            if (state.isConnected && state.connectionStatus === 'connected') {
                // Refresh sessions when socket reconnects (not on initial connection)
                if (this.wasConnected) {
                    console.log('Socket reconnected, refreshing sessions...');
                    this.fetchSessions();
                }
                this.wasConnected = true;
            } else if (!state.isConnected) {
                // Track disconnection
                this.wasConnected = false;
            }
        });
    }

    private handleUpdate(update: unknown) {
        console.log('handleUpdate', update);
        const validatedUpdate = SessionUpdateSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('Invalid update received:', validatedUpdate.error);
            console.error('Invalid update received:', update);
            return;
        }
        const updateData = validatedUpdate.data;

        if (updateData.body.t === 'new-message') {
            const session = this.sessions.get(updateData.body.sid);
            if (session) {
                // Update session with new message
                session.lastMessage = this.encryption.decryptMessage(updateData.body.message);
                session.updatedAt = updateData.createdAt;
                session.seq = updateData.seq;

                // Re-sort sessions by updatedAt
                this.sortSessions();
                this.notifyListeners();
            } else {
                // Fetch sessions again if we don't have this session
                this.fetchSessions();
            }

            // Forward to session instance if it exists
            const sessionInstance = this.sessionInstances.get(updateData.body.sid);
            if (sessionInstance) {
                sessionInstance.handleUpdate(updateData);
            }
        } else if (updateData.body.t === 'new-session') {
            this.fetchSessions(); // Just fetch sessions again
        }
    }

    private handleEphemeralUpdate(update: unknown) {
        const validatedUpdate = EphemeralUpdateSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('Invalid ephemeral update received:', validatedUpdate.error);
            console.error('Invalid ephemeral update received:', update);
            return;
        }
        const updateData = validatedUpdate.data;
        const session = this.sessions.get(updateData.id);
        if (session) {
            this.sessions.set(updateData.id, {
                ...session,
                active: updateData.active,
                activeAt: updateData.activeAt,
                thinking: updateData.thinking,
                thinkingAt: updateData.thinking ? updateData.activeAt : 0,
            });
            this.notifyListeners();
        }
    }

    private sortSessions() {
        const sortedEntries = Array.from(this.sessions.entries())
            .sort(([, a], [, b]) => b.updatedAt - a.updatedAt);

        this.sessions = new Map(sortedEntries);
    }

    private notifyListeners() {
        const sessionsArray = Array.from(this.sessions.values());
        this.listeners.forEach(listener => listener(sessionsArray, this.isLoaded));
    }

    addListener(listener: SessionsListener) {
        this.listeners.add(listener);
        // Immediately notify with current state
        listener(Array.from(this.sessions.values()), this.isLoaded);
        return () => this.listeners.delete(listener);
    }

    getSessions(): Session[] {
        return Array.from(this.sessions.values());
    }

    getLoadedState(): boolean {
        return this.isLoaded;
    }

    //
    // Session Management
    //

    private sessionInstances = new Map<string, SyncSession>(); // Store SyncSession instances

    getSession(sessionId: string): SyncSession {
        if (!this.encryption) {
            throw new Error('SyncSessions not initialized');
        }

        let session = this.sessionInstances.get(sessionId);
        if (!session) {
            session = new SyncSession(sessionId, this.encryption);
            session.start();
            this.sessionInstances.set(sessionId, session);
        }
        return session;
    }
}

// Global singleton instance
export const syncSessions = new SyncSessions();