import { syncSocket } from './SyncSocket';
import { MessageContent, SourceMessage, SessionUpdate } from './types';
import { MessageEncryption } from './encryption';
import { randomUUID } from 'expo-crypto';

export interface SyncMessage {
    id: string; // Local ID
    serverId?: string; // Server ID when delivered
    content: MessageContent | null;
}

interface SyncSessionState {
    messages: SyncMessage[];
    isLoading: boolean;
}

type SyncSessionListener = (state: SyncSessionState) => void;

export class SyncSession {
    private sessionId: string;
    private encryption: MessageEncryption;
    private messages: SyncMessage[] = [];
    private listeners = new Set<SyncSessionListener>();
    private isLoading = false;
    private localToServerMap = new Map<string, string>(); // localId -> serverId

    constructor(sessionId: string, encryption: MessageEncryption) {
        this.sessionId = sessionId;
        this.encryption = encryption;
    }

    //
    // State Management
    //

    addListener(listener: SyncSessionListener) {
        this.listeners.add(listener);
    }

    removeListener(listener: SyncSessionListener) {
        this.listeners.delete(listener);
    }

    private notifyListeners() {
        const state = this.getState();
        this.listeners.forEach(listener => listener(state));
    }

    getState(): SyncSessionState {
        return {
            messages: [...this.messages],
            isLoading: this.isLoading
        };
    }

    //
    // Message Loading
    //

    private async loadMessages() {

        // Start status
        if (this.isLoading) {
            return;
        }
        this.isLoading = true;
        this.notifyListeners();

        while (true) {
            try {
                const response = await syncSocket.request(`/v1/sessions/${this.sessionId}/messages`);
                const data = await response.json();
                for (const msg of data.messages as SourceMessage[]) {
                    this.handleNewMessage(msg);
                }
                this.isLoading = false;
                this.notifyListeners();
                break;
            } catch (error) {
                console.error('Failed to load messages, retrying....');
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
        }
    }

    //
    // Message Sending
    //

    sendMessage(text: string) {
        // Generate local ID
        const localId = randomUUID();

        // Create user message content
        const content: MessageContent = {
            role: 'user',
            localKey: localId,
            content: {
                type: 'text',
                text
            }
        };

        // Add to messages immediately
        this.messages.push({ id: localId, content });
        this.notifyListeners();

        // Encrypt and send (fire and forget)
        const encryptedContent = this.encryption.encrypt(content);
        syncSocket.send('message', { sid: this.sessionId, message: encryptedContent });
    }

    //
    // Handle Updates
    //

    handleUpdate(update: SessionUpdate) {
        if (update.body.t === 'new-message' && update.body.sid === this.sessionId) {
            this.handleNewMessage(update.body.message);
            this.notifyListeners();
        }
    }

    private handleNewMessage(message: SourceMessage) {
        const decrypted = this.encryption.decryptMessage(message);
        if (!decrypted) {
            return;
        }

        //
        // Check if this is a message from the current user
        //

        if (decrypted.content && decrypted.content.role === 'user') {
            const localKey = decrypted.content.localKey;
            const existingIndex = this.messages.findIndex(m => m.id === localKey);
            if (existingIndex !== -1) {
                this.messages[existingIndex] = { ...this.messages[existingIndex], serverId: decrypted.id };
                this.localToServerMap.set(this.messages[existingIndex].id, decrypted.id);
            } else {
                this.messages.push({ id: localKey, content: decrypted.content, serverId: decrypted.id });
                this.localToServerMap.set(localKey, decrypted.id);
            }
        } else {

            //
            // Check if this message is from backend
            //

            const existingIndex = this.messages.findIndex(m => m.serverId === decrypted.id);
            if (existingIndex !== -1) {
                this.messages[existingIndex] = { ...this.messages[existingIndex], serverId: decrypted.id };
                this.localToServerMap.set(this.messages[existingIndex].id, decrypted.id);
            } else {
                const localId = randomUUID();
                this.messages.push({ id: localId, content: decrypted.content, serverId: decrypted.id });
                this.localToServerMap.set(localId, decrypted.id);
            }
        }
    }

    //
    // Lifecycle
    //

    start() {
        // Load initial messages
        this.loadMessages();

        // Reload on reconnection
        syncSocket.addListener((state) => {
            if (state.isConnected && state.connectionStatus === 'connected') {
                this.loadMessages();
            }
        });
    }

    onVisible() {
        this.loadMessages();
    }
}