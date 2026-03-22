/**
 * App SyncNode Store — account-scoped SyncNode for the React Native app.
 *
 * The app uses an account-scoped SyncNode that:
 * - Receives all session messages in real-time
 * - Holds SessionState for all sessions
 * - Provides typed state for React components
 *
 * React components render MessageWithParts.parts directly:
 *   text part     → TextPartView
 *   tool part     → ToolPartView
 *   reasoning part → ReasoningPartView
 *   subtask part  → SubtaskPartView
 *
 * No conversion. No intermediate types. The type that enters the pipeline
 * is the type that renders on screen.
 */

import {
    SyncNode,
    type SyncNodeToken,
    type SyncState,
    type SessionState,
    type KeyMaterial,
    type ResolveSessionKeyMaterial,
    type v3,
} from '@slopus/happy-sync';

type MessageWithParts = v3.MessageWithParts;
type SessionID = v3.SessionID;
type Part = v3.Part;

export interface AppSyncUserMessageMeta {
    sentFrom?: string;
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo';
    model?: string | null;
    fallbackModel?: string | null;
    customSystemPrompt?: string | null;
    appendSystemPrompt?: string | null;
    allowedTools?: string[] | null;
    disallowedTools?: string[] | null;
    displayText?: string;
}

export interface AppSyncUserMessageOpts {
    agent?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    meta?: AppSyncUserMessageMeta;
}

export interface AppSyncNodeOpts {
    serverUrl: string;
    token: SyncNodeToken;
    keyMaterial: KeyMaterial;
    resolveSessionKeyMaterial?: ResolveSessionKeyMaterial;
}

/**
 * Manages the account-scoped SyncNode for the app.
 *
 * Usage:
 *   const store = new AppSyncStore(opts);
 *   await store.connect();
 *   store.subscribe((state) => { ... });
 */
export class AppSyncStore {
    readonly node: SyncNode;
    private listeners = new Set<(state: SyncState) => void>();

    constructor(opts: AppSyncNodeOpts) {
        this.node = new SyncNode(opts.serverUrl, opts.token, opts.keyMaterial, {
            resolveSessionKeyMaterial: opts.resolveSessionKeyMaterial,
        });

        this.node.onStateChange((state: SyncState) => {
            for (const listener of this.listeners) {
                listener(state);
            }
        });
    }

    async connect(): Promise<void> {
        await this.node.connect();
    }

    disconnect(): void {
        this.node.disconnect();
    }

    /** Subscribe to state changes. Returns unsubscribe function. */
    subscribe(listener: (state: SyncState) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    /** Get current sync state. */
    get state(): SyncState {
        return this.node.state;
    }

    /** Get session state by ID. */
    getSession(sessionId: SessionID): SessionState | undefined {
        return this.node.state.sessions.get(sessionId as string);
    }

    /** Get all session IDs. */
    get sessionIds(): SessionID[] {
        return Array.from(this.node.state.sessions.keys()) as SessionID[];
    }

    /** Get messages for a session. */
    getMessages(sessionId: SessionID): MessageWithParts[] {
        return this.getSession(sessionId)?.messages ?? [];
    }

    /** Fetch messages for a specific session. */
    async fetchSession(sessionId: SessionID): Promise<void> {
        await this.node.fetchMessages(sessionId);
    }

    /** Approve a permission in a session. */
    async approvePermission(
        sessionId: SessionID,
        permissionId: string,
        opts?: { decision?: 'once' | 'always'; allowTools?: string[] },
    ): Promise<void> {
        await this.node.approvePermission(sessionId, permissionId, {
            decision: opts?.decision ?? 'once',
            allowTools: opts?.allowTools,
        });
    }

    /** Deny a permission in a session. */
    async denyPermission(
        sessionId: SessionID,
        permissionId: string,
        reason?: string,
    ): Promise<void> {
        await this.node.denyPermission(sessionId, permissionId, { reason });
    }

    /** Answer a question in a session. */
    async answerQuestion(
        sessionId: SessionID,
        questionId: string,
        answers: string[][],
    ): Promise<void> {
        await this.node.answerQuestion(sessionId, questionId, answers);
    }

    /** Send a user message to a session. */
    async sendUserMessage(
        sessionId: SessionID,
        text: string,
        opts: AppSyncUserMessageOpts = {},
    ): Promise<void> {
        const { createId } = await import('@paralleldrive/cuid2');
        const msgId = `msg_${createId()}` as v3.MessageID;

        const message: MessageWithParts = {
            info: {
                id: msgId,
                sessionID: sessionId,
                role: 'user' as const,
                time: { created: Date.now() },
                agent: opts.agent ?? 'user',
                model: opts.model ?? { providerID: 'user', modelID: 'user' },
                meta: opts.meta,
            },
            parts: [{
                id: `prt_${createId()}` as v3.PartID,
                sessionID: sessionId,
                messageID: msgId,
                type: 'text' as const,
                text,
            }],
        };

        await this.node.sendMessage(sessionId, message);
    }

    /** Get child sessions (subagents) for a parent session. */
    getChildSessions(parentSessionId: SessionID): SessionState[] {
        const result: SessionState[] = [];
        for (const [, session] of this.node.state.sessions) {
            if (session.info.parentID === parentSessionId) {
                result.push(session);
            }
        }
        return result;
    }
}
