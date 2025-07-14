import { syncSocket } from './SyncSocket';
import { MessageContent, SourceMessage, SessionUpdate, HumanContent } from './types';
import { MessageEncryption } from './encryption';
import { randomUUID } from 'expo-crypto';
import { applyMessages, createReducer, ReducedMessage, ReducerState } from './reducer';

export interface SyncMessage {
    id: string; // Local ID
    serverId?: string; // Server ID when delivered
    content: HumanContent | ReducedMessage | null;
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
    private reducer: ReducerState = createReducer();

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
            messages: [...this.messages].reverse(),
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
                for (const msg of [...data.messages as SourceMessage[]].reverse()) {
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
            } else {
                this.messages.push({ id: localKey, content: decrypted.content, serverId: decrypted.id });
            }
        } else {

            //
            // Apply reducer to the message
            //

            let reduced = applyMessages(this.reducer, [decrypted]);
            for (let r of reduced) {
                const existingIndex = this.messages.findIndex(m => m.id === r.id);
                if (existingIndex !== -1) {
                    this.messages[existingIndex] = { ...this.messages[existingIndex], content: r };
                } else {
                    this.messages.push({ id: r.id, content: r });
                }
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