import { syncEngine } from '@/sync/SyncEngine';
import { AuthCredentials } from '@/auth/tokenStorage';
import { MessageEncryption } from '@/sync/encryption';
import {
    Session,
    EncryptedMessage,
    DecryptedMessage,
    MessageContent,
    MessageContentSchema,
    SessionUpdateSchema,
} from '@/sync/types';

const API_ENDPOINT = 'https://handy-api.korshakov.org';

type SessionsListener = (sessions: Session[], isLoaded: boolean) => void;

class SessionsEngine {
    private sessions: Map<string, Session> = new Map();
    private listeners: Set<SessionsListener> = new Set();
    private credentials: AuthCredentials | null = null;
    private encryption: MessageEncryption | null = null;
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

        try {
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
                createdAt: number;
                updatedAt: number;
                lastMessage: EncryptedMessage | null;
            }>;

            // Process and decrypt sessions
            this.sessions.clear();
            for (const session of sessions) {
                const processedSession: Session = {
                    ...session,
                    lastMessage: session.lastMessage ? session.lastMessage.content.t === 'encrypted' ? this.decryptContent(session.lastMessage.content.c) : null : null
                };
                this.sessions.set(session.id, processedSession);
            }

            this.isLoaded = true;
            this.notifyListeners();
        } catch (error) {
            console.error('Failed to fetch sessions:', error);
            this.isLoaded = true; // Set to true even on error to indicate loading attempt completed
            this.notifyListeners();
        }
    }

    private subscribeToUpdates() {
        // Subscribe to message updates
        syncEngine.onMessage('update', this.handleUpdate.bind(this));

        // Subscribe to connection state changes
        syncEngine.addListener((state) => {
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
        const validatedUpdate = SessionUpdateSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.error('Invalid update received:', update);
            return;
        }
        const updateData = validatedUpdate.data;

        if (updateData.content.t === 'new-message') {
            const session = this.sessions.get(updateData.content.sid);
            if (session) {
                // Update session with new message
                const decryptedContent: MessageContent | null = updateData.content.c.t === 'encrypted' ? this.decryptContent(updateData.content.c.c) : null;

                session.lastMessage = decryptedContent;
                session.updatedAt = updateData.createdAt;
                session.seq = updateData.seq;

                // Re-sort sessions by updatedAt
                this.sortSessions();
                this.notifyListeners();
            } else {
                // Fetch sessions again if we don't have this session
                this.fetchSessions();
            }
        }
    }

    private decryptContent(encryptedContent: string): MessageContent | null {
        if (!this.encryption) return null;

        const decrypted = this.encryption.decrypt(encryptedContent);
        if (!decrypted) return null;

        let result = MessageContentSchema.safeParse(decrypted);
        if (!result.success) {
            console.error('Invalid content received:', decrypted);
            return null;
        }

        return result.data;
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

    getLoadedState(): boolean {
        return this.isLoaded;
    }

    async createSession(tag: string): Promise<Session | null> {
        if (!this.credentials) return null;

        try {
            const response = await fetch(`${API_ENDPOINT}/v1/sessions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.credentials.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ tag })
            });

            if (!response.ok) {
                throw new Error(`Failed to create session: ${response.status}`);
            }

            const data = await response.json();
            const session: Session = {
                id: data.id,
                seq: data.seq,
                createdAt: data.createdAt,
                updatedAt: data.updatedAt,
                lastMessage: data.lastMessage && data.lastMessage.content.t === 'encrypted' ? this.decryptContent(data.lastMessage.content.c) : null
            };

            this.sessions.set(session.id, session);
            this.sortSessions();
            this.notifyListeners();

            return session;
        } catch (error) {
            console.error('Failed to create session:', error);
            return null;
        }
    }

    async sendMessage(sessionId: string, content: MessageContent): Promise<boolean> {
        if (!this.credentials || !this.encryption) return false;

        try {
            const encryptedContent = this.encryption.encrypt(content);

            const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.credentials.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    content: {
                        t: 'encrypted',
                        c: encryptedContent
                    }
                })
            });

            return response.ok;
        } catch (error) {
            console.error('Failed to send message:', error);
            return false;
        }
    }

    // Helper methods for common message types
    async sendTextMessage(sessionId: string, text: string, type: 'human' | 'assistant' = 'human'): Promise<boolean> {
        const content: MessageContent = { type, content: { type: 'text', text } };
        return this.sendMessage(sessionId, content);
    }

    getSessions(): Session[] {
        return Array.from(this.sessions.values());
    }

    getSession(id: string): Session | undefined {
        return this.sessions.get(id);
    }

    async getSessionMessages(sessionId: string): Promise<DecryptedMessage[]> {
        if (!this.credentials) return [];

        try {
            const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/messages`, {
                headers: {
                    'Authorization': `Bearer ${this.credentials.token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch messages: ${response.status}`);
            }

            const data = await response.json();
            const messages = data.messages as EncryptedMessage[];

            // Decrypt all messages
            return messages.map(msg => {
                return {
                    id: msg.id,
                    seq: msg.seq,
                    content: msg.content.t === 'encrypted' ? this.decryptContent(msg.content.c) : null,
                    createdAt: msg.createdAt
                };
            });
        } catch (error) {
            console.error('Failed to fetch session messages:', error);
            return [];
        }
    }

    clear() {
        this.sessions.clear();
        this.listeners.clear();
        this.credentials = null;
        this.encryption = null;
        this.isLoaded = false;
        this.wasConnected = false;
    }
}

// Global singleton instance
export const sessionsEngine = new SessionsEngine();