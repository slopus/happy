import { syncSocket } from './SyncSocket';
import { MessageContent, SourceMessage, SessionUpdate, HumanContent } from './types';
import { MessageEncryption } from './encryption';
import { randomUUID } from 'expo-crypto';
import { applyMessages, createReducer, ReducedMessage, ReducerState } from './reducer';

type LocalID = string;

export interface SyncMessage {
    id: string; // Local ID
    serverId?: string; // Server ID when delivered
    content: HumanContent | ReducedMessage | null;
}

export interface SyncSessionState {
    messages: SyncMessage[];
    isLoading: boolean;
}

type SyncSessionListener = (state: SyncSessionState) => void;

/**
 * RemoteClaudeCodeSession is your view into what's happening on a remote
 * computer running Claude Code.
 * 
 * Claude Code uses a list of events (called a "session") with a session ID. This class
 * represents a logical interactive session that may span multiple concrete sessions
 * under the hood. The server just forwards the raw Claude Code event log - all
 * transformation logic happens here.
 * 
 * Key architectural detail: The server stores events encrypted and knows very little
 * about them. This class instance is the first place Claude Code events are
 * processed by this app - we decrypt them and are now at basically the same
 * starting point as if you just `file.readSync` the .jsonl session file from
 * the local computer. Performs bookkeeping to minimize rerenders.
 * 
 * Transformation requirements (why we do this work):
 * - Operations list screen: Transform "started X" + "finished X" events into single
 *   UI elements showing current operation status. Handle parallel operations with
 *   different completion times, reactive to individual list items changing.
 * - Message detail screen: Random access to individual messages by ID, reactive
 *   to changes in that specific message only.
 * - TODO list state: Aggregate TODO update events into current TODO state rather
 *   than showing every "crossed off item Y" event in the message stream.
 * - More use cases coming, all handled by this class
 */
export class RemoteClaudeCodeSession {
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
                console.error(error);
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

    //
    // RPC
    //

    abort = async () => {
        await syncSocket.rpc(this.sessionId, 'abort', {});
    }

    allow = async (id: string) => {
        await syncSocket.rpc(this.sessionId, 'permission', { id, approved: true });
    }

    deny = async (id: string) => {
        await syncSocket.rpc(this.sessionId, 'permission', { id, approved: false });
    }
}