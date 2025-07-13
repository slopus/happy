import { syncEngine } from './SyncEngine';
import { TokenStorage } from '@/auth/tokenStorage';
import { MessageContent, EncryptedMessage, DecryptedMessage } from './types';
import * as tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from '@/auth/base64';

export type MessageStatus = 'sent' | 'pending' | 'error';

export interface SyncMessage {
    id: string;
    seq: number;
    content: MessageContent;
    status: MessageStatus;
    createdAt: number;
    error?: string;
}

interface SyncSessionState {
    sessionId: string;
    messages: SyncMessage[];
    isLoading: boolean;
    error: string | null;
}

type SyncSessionListener = (state: SyncSessionState) => void;

export class SyncSession {
    private sessionId: string;
    private messages = new Map<string, SyncMessage>();
    private listeners = new Set<SyncSessionListener>();
    private isLoading = false;
    private error: string | null = null;
    private pendingMessageCounter = 0;
    private messageUpdateHandler: ((data: any) => void) | null = null;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }

    // State management
    addListener(listener: SyncSessionListener) {
        this.listeners.add(listener);
        // Immediately notify with current state
        listener(this.getState());
    }

    removeListener(listener: SyncSessionListener) {
        this.listeners.delete(listener);
    }

    private notifyListeners() {
        const state = this.getState();
        this.listeners.forEach(listener => listener(state));
    }

    private getState(): SyncSessionState {
        // Sort messages by seq, then by createdAt for pending messages
        const sortedMessages = Array.from(this.messages.values()).sort((a, b) => {
            // Server messages (sent) are sorted by seq
            if (a.status === 'sent' && b.status === 'sent') {
                return a.seq - b.seq;
            }
            // Pending/error messages come after sent messages
            if (a.status === 'sent' && b.status !== 'sent') return -1;
            if (a.status !== 'sent' && b.status === 'sent') return 1;
            // Between pending/error messages, sort by createdAt
            return a.createdAt - b.createdAt;
        });

        return {
            sessionId: this.sessionId,
            messages: sortedMessages,
            isLoading: this.isLoading,
            error: this.error
        };
    }

    // Encryption/Decryption
    private async getSecret(): Promise<Uint8Array | null> {
        const creds = await TokenStorage.getCredentials();
        if (!creds) return null;
        return decodeBase64(creds.secret, 'base64url');
    }

    private decryptContent(encryptedContent: string): MessageContent | null {
        try {
            const secret = this.getSecretSync();
            if (!secret) return null;

            const decoded = decodeBase64(encryptedContent, 'base64');
            const decrypted = tweetnacl.secretbox.open(
                new Uint8Array(decoded.slice(24)),
                new Uint8Array(decoded.slice(0, 24)),
                secret
            );

            if (!decrypted) return null;

            const jsonStr = new TextDecoder().decode(decrypted);
            return JSON.parse(jsonStr) as MessageContent;
        } catch (error) {
            console.error('Failed to decrypt message:', error);
            return null;
        }
    }

    private getSecretSync(): Uint8Array | null {
        // This is a workaround - in real app, we'd handle this better
        // For now, assume secret is available when SyncSession is created
        const credsStr = TokenStorage.getCredentialsSync();
        if (!credsStr) return null;
        const creds = JSON.parse(credsStr);
        return decodeBase64(creds.secret, 'base64url');
    }

    private encryptContent(content: MessageContent): string {
        const secret = this.getSecretSync();
        if (!secret) throw new Error('No secret available');

        const nonce = tweetnacl.randomBytes(24);
        const messageBytes = new TextEncoder().encode(JSON.stringify(content));
        const encrypted = tweetnacl.secretbox(messageBytes, nonce, secret);
        
        const combined = new Uint8Array(nonce.length + encrypted.length);
        combined.set(nonce, 0);
        combined.set(encrypted, nonce.length);
        
        return encodeBase64(combined, 'base64');
    }

    // Message loading
    async loadMessages() {
        if (this.isLoading) return;

        this.isLoading = true;
        this.error = null;
        this.notifyListeners();

        try {
            const response = await syncEngine.request(`/v1/sessions/${this.sessionId}/messages`);
            const data = await response.json();

            // Clear existing messages and add loaded ones
            this.messages.clear();
            
            for (const msg of data.messages) {
                const decryptedContent = msg.content.t === 'encrypted' 
                    ? this.decryptContent(msg.content.c)
                    : null;

                if (decryptedContent) {
                    const message: SyncMessage = {
                        id: msg.id,
                        seq: msg.seq,
                        content: decryptedContent,
                        status: 'sent',
                        createdAt: msg.createdAt
                    };
                    this.messages.set(msg.id, message);
                }
            }

            this.isLoading = false;
            this.notifyListeners();
        } catch (error) {
            this.error = error instanceof Error ? error.message : 'Failed to load messages';
            this.isLoading = false;
            this.notifyListeners();
        }
    }

    // Message sending
    async sendMessage(content: MessageContent): Promise<void> {
        // Generate temporary ID for pending message
        const tempId = `pending-${Date.now()}-${this.pendingMessageCounter++}`;
        const pendingMessage: SyncMessage = {
            id: tempId,
            seq: -1, // Temporary seq
            content,
            status: 'pending',
            createdAt: Date.now(),
            error: undefined
        };

        // Add to messages immediately
        this.messages.set(tempId, pendingMessage);
        this.notifyListeners();

        try {
            // Encrypt content
            const encryptedContent = this.encryptContent(content);

            // Send to server
            const response = await syncEngine.request(`/v1/sessions/${this.sessionId}/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    t: 'encrypted',
                    c: encryptedContent
                })
            });

            if (!response.ok) {
                throw new Error(`Failed to send message: ${response.status}`);
            }

            const result = await response.json();
            
            // Remove pending message and add the sent one
            this.messages.delete(tempId);
            const sentMessage: SyncMessage = {
                id: result.message.id,
                seq: result.message.seq,
                content,
                status: 'sent',
                createdAt: result.message.createdAt
            };
            this.messages.set(result.message.id, sentMessage);
            this.notifyListeners();
        } catch (error) {
            // Update pending message to error state
            pendingMessage.status = 'error';
            pendingMessage.error = error instanceof Error ? error.message : 'Failed to send message';
            this.notifyListeners();
        }
    }

    // Retry failed message
    async retryMessage(messageId: string): Promise<void> {
        const message = this.messages.get(messageId);
        if (!message || message.status !== 'error') return;

        // Reset to pending and retry
        message.status = 'pending';
        message.error = undefined;
        this.notifyListeners();

        // Remove the error message and resend
        this.messages.delete(messageId);
        await this.sendMessage(message.content);
    }

    // Real-time updates
    startSync() {
        // Load initial messages
        this.loadMessages();

        // Subscribe to message updates
        this.messageUpdateHandler = (data: any) => {
            if (data.content.t === 'new-message' && data.content.sid === this.sessionId) {
                // Decrypt and add new message
                const decryptedContent = data.content.c.t === 'encrypted' 
                    ? this.decryptContent(data.content.c.c)
                    : null;

                if (decryptedContent) {
                    const message: SyncMessage = {
                        id: data.content.mid,
                        seq: data.seq,
                        content: decryptedContent,
                        status: 'sent',
                        createdAt: data.createdAt
                    };
                    
                    // Check if we already have this message (might be our own sent message)
                    if (!this.messages.has(message.id)) {
                        this.messages.set(message.id, message);
                        this.notifyListeners();
                    }
                }
            }
        };

        syncEngine.onMessage('update', this.messageUpdateHandler);
    }

    stopSync() {
        // Unsubscribe from updates
        if (this.messageUpdateHandler) {
            syncEngine.offMessage('update', this.messageUpdateHandler);
            this.messageUpdateHandler = null;
        }
    }

    // Cleanup
    dispose() {
        this.stopSync();
        this.listeners.clear();
        this.messages.clear();
    }
}