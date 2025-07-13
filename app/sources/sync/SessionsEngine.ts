import { syncEngine } from '@/sync/SyncEngine';
import { AuthCredentials } from '@/auth/tokenStorage';
import { MessageEncryption } from '@/sync/encryption';
import { 
    Session, 
    EncryptedMessage, 
    DecryptedMessage, 
    SessionUpdate, 
    MessageContent
} from '@/sync/types';

const API_ENDPOINT = 'https://handy-api.korshakov.org';

type SessionsListener = (sessions: Session[], isLoaded: boolean) => void;

class SessionsEngine {
    private sessions: Map<string, Session> = new Map();
    private listeners: Set<SessionsListener> = new Set();
    private credentials: AuthCredentials | null = null;
    private encryption: MessageEncryption | null = null;
    private isInitialized = false;
    private isLoaded = false;
    private wasConnected = false;

    async initialize(credentials: AuthCredentials) {
        this.credentials = credentials;
        this.encryption = new MessageEncryption(credentials.secret);
        
        // Fetch initial sessions
        await this.fetchSessions();
        
        // Subscribe to updates
        this.subscribeToUpdates();
        
        this.isInitialized = true;
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
                    lastMessage: session.lastMessage ? this.decryptMessage(session.lastMessage) : null
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

    private handleUpdate(update: SessionUpdate) {
        if (update.content.t === 'new-message') {
            const session = this.sessions.get(update.content.sid);
            if (session) {
                // Update session with new message
                const decryptedMessage: DecryptedMessage = {
                    id: update.content.mid,
                    seq: update.seq,
                    content: this.decryptContent(update.content.c),
                    createdAt: update.createdAt
                };

                session.lastMessage = decryptedMessage;
                session.updatedAt = update.createdAt;
                session.seq = update.seq;

                // Re-sort sessions by updatedAt
                this.sortSessions();
                this.notifyListeners();
            } else {
                // Fetch sessions again if we don't have this session
                this.fetchSessions();
            }
        }
    }

    private decryptMessage(message: EncryptedMessage): DecryptedMessage {
        return {
            id: message.id,
            seq: message.seq,
            content: this.decryptContent(message.content.c),
            createdAt: message.createdAt
        };
    }

    private decryptContent(encryptedContent: string): MessageContent | null {
        if (!this.encryption) return null;

        const decrypted = this.encryption.decrypt(encryptedContent);
        if (!decrypted) return null;

        try {
            const content = decrypted as MessageContent;
            // Validate the content structure
            if (this.isValidMessageContent(content)) {
                return content;
            }
            return null;
        } catch (error) {
            console.error('Failed to parse decrypted content:', error);
            return null;
        }
    }

    private isValidMessageContent(content: any): content is MessageContent {
        if (!content || typeof content !== 'object') return false;
        
        // Check base structure
        if (!content.type || !content.content || typeof content.content !== 'object') return false;
        
        // Validate based on type
        if (content.type === 'human') {
            return this.isValidHumanContent(content.content);
        } else if (content.type === 'assistant') {
            return this.isValidAssistantContent(content.content);
        }
        
        return false;
    }

    private isValidHumanContent(content: any): boolean {
        if (!content.type) return false;
        
        switch (content.type) {
            case 'text':
                return typeof content.text === 'string';
            case 'image':
                return content.image && 
                       typeof content.image.url === 'string' && 
                       typeof content.image.mimeType === 'string';
            case 'file':
                return content.file && 
                       typeof content.file.name === 'string' &&
                       typeof content.file.url === 'string' &&
                       typeof content.file.mimeType === 'string' &&
                       typeof content.file.size === 'number';
            default:
                return false;
        }
    }

    private isValidAssistantContent(content: any): boolean {
        if (!content.type) return false;
        
        switch (content.type) {
            case 'text':
                return typeof content.text === 'string';
            case 'code':
                return typeof content.language === 'string' && 
                       typeof content.code === 'string';
            case 'tool_call':
                return typeof content.tool === 'string' && 
                       typeof content.arguments === 'object';
            case 'tool_result':
                return typeof content.tool === 'string';
            case 'thinking':
                return typeof content.thought === 'string';
            case 'error':
                return typeof content.error === 'string';
            default:
                return false;
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
                tag: data.tag,
                seq: data.seq,
                createdAt: data.createdAt,
                updatedAt: data.updatedAt,
                lastMessage: null
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
    async sendTextMessage(sessionId: string, text: string): Promise<boolean> {
        const content: MessageContent = { type: 'human', content: { type: 'text', text } };
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
            return messages.map(msg => this.decryptMessage(msg));
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
        this.isInitialized = false;
        this.isLoaded = false;
        this.wasConnected = false;
    }
}

// Global singleton instance
export const sessionsEngine = new SessionsEngine();