/**
 * SyncNode bridge for CLI session processes.
 *
 * Each CLI session process (Claude, Codex, OpenCode) uses a session-scoped
 * SyncNode. The bridge:
 *   1. Creates the SyncNode with the session-scoped JWT from the daemon
 *   2. Provides a simple interface for mappers to read current state and
 *      push updated MessageWithParts
 *   3. Watches for incoming decision/answer messages and invokes callbacks
 *
 * Usage pattern (from mapper):
 *   const currentMsg = bridge.currentAssistantMessage();
 *   const updated = applyAgentEvent(currentMsg, event);
 *   await bridge.updateMessage(updated);
 */

import {
    SyncNode,
    type SyncNodeToken,
    type SyncState,
    type SessionState,
    type KeyMaterial,
    type UsageReport,
    type RpcHandler,
    type v3,
} from '@slopus/happy-sync';

type MessageWithParts = v3.MessageWithParts;
type SessionID = v3.SessionID;

export type UserMessageCallback = (message: MessageWithParts) => void;

export interface SyncBridgeOpts {
    serverUrl: string;
    token: SyncNodeToken;
    keyMaterial: KeyMaterial;
    sessionId: SessionID;
}

export type PermissionDecisionCallback = (decision: {
    permissionId: string;
    decision: 'once' | 'always' | 'reject';
    allowTools?: string[];
    reason?: string;
}) => void;

export type QuestionAnswerCallback = (answer: {
    questionId: string;
    answers: string[][];
}) => void;

export class SyncBridge {
    readonly node: SyncNode;
    readonly sessionId: SessionID;

    private permissionCallbacks = new Set<PermissionDecisionCallback>();
    private questionCallbacks = new Set<QuestionAnswerCallback>();
    private userMessageCallbacks = new Set<UserMessageCallback>();

    constructor(opts: SyncBridgeOpts) {
        if (opts.token.claims.scope.type !== 'session') {
            throw new Error('SyncBridge requires a session-scoped SyncNode token');
        }
        if (opts.token.claims.scope.sessionId !== opts.sessionId) {
            throw new Error(
                `SyncBridge token/session mismatch: ${opts.token.claims.scope.sessionId} !== ${opts.sessionId}`,
            );
        }

        this.sessionId = opts.sessionId;
        this.node = new SyncNode(opts.serverUrl, opts.token, opts.keyMaterial);

        // Watch for incoming messages — dispatch decisions, answers, and user messages
        this.node.onMessage(this.sessionId, (message: MessageWithParts) => {
            // User messages from the app
            if (message.info.role === 'user') {
                for (const cb of this.userMessageCallbacks) {
                    cb(message);
                }
            }

            for (const part of message.parts) {
                if (part.type === 'decision') {
                    for (const cb of this.permissionCallbacks) {
                        cb({
                            permissionId: part.permissionID,
                            decision: part.decision,
                            allowTools: part.allowTools,
                            reason: part.reason,
                        });
                    }
                }
                if (part.type === 'answer') {
                    for (const cb of this.questionCallbacks) {
                        cb({
                            questionId: part.questionID,
                            answers: part.answers,
                        });
                    }
                }
            }
        });
    }

    async connect(): Promise<void> {
        await this.node.connect();
        // Hydrate existing transcript state without replaying historical messages
        // into the live agent queue. Live socket updates still notify listeners.
        await this.node.fetchMessages(this.sessionId, undefined, {
            notifyListeners: false,
        });
    }

    disconnect(): void {
        this.node.disconnect();
    }

    /** Get the current session state. */
    get session(): SessionState | undefined {
        return this.node.state.sessions.get(this.sessionId as string);
    }

    /** Get all messages in the session. */
    get messages(): MessageWithParts[] {
        return this.session?.messages ?? [];
    }

    /** Get the latest assistant message (the one being built), or null. */
    currentAssistantMessage(): MessageWithParts | null {
        const msgs = this.messages;
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].info.role === 'assistant') {
                return msgs[i];
            }
        }
        return null;
    }

    /** Send a new message to the session. */
    async sendMessage(message: MessageWithParts): Promise<void> {
        await this.node.sendMessage(this.sessionId, message);
    }

    /** Update an existing message (patch in place). */
    async updateMessage(message: MessageWithParts): Promise<void> {
        await this.node.updateMessage(this.sessionId, message);
    }

    /** Register a callback for permission decisions from the app. */
    onPermissionDecision(callback: PermissionDecisionCallback): () => void {
        this.permissionCallbacks.add(callback);
        return () => { this.permissionCallbacks.delete(callback); };
    }

    /** Register a callback for question answers from the app. */
    onQuestionAnswer(callback: QuestionAnswerCallback): () => void {
        this.questionCallbacks.add(callback);
        return () => { this.questionCallbacks.delete(callback); };
    }

    /** Register a callback for user messages from the app. */
    onUserMessage(callback: UserMessageCallback): () => void {
        this.userMessageCallbacks.add(callback);
        return () => { this.userMessageCallbacks.delete(callback); };
    }

    /** Check if there are unresolved permission requests. */
    get hasPendingPermissions(): boolean {
        return (this.session?.permissions.some((p: { resolved: boolean }) => !p.resolved)) ?? false;
    }

    /** Check if there are unresolved question requests. */
    get hasPendingQuestions(): boolean {
        return (this.session?.questions.some((q: { resolved: boolean }) => !q.resolved)) ?? false;
    }

    // ─── Session lifecycle ──────────────────────────────────────────────────

    /** Send a keepalive heartbeat. */
    keepAlive(thinking: boolean, mode: 'local' | 'remote'): void {
        this.node.keepAlive(this.sessionId, thinking, mode);
    }

    /** Signal that the session process has ended. */
    sendSessionDeath(): void {
        this.node.sendSessionDeath(this.sessionId);
    }

    /** Send usage/cost data. */
    sendUsageData(report: UsageReport): void {
        this.node.sendUsageData(report);
    }

    /** Update session metadata with CAS. */
    async updateMetadata<T = unknown>(handler: (current: T) => T): Promise<void> {
        await this.node.updateMetadata(this.sessionId, handler);
    }

    /** Update agent state with CAS. */
    async updateAgentState<T = unknown>(handler: (current: T) => T): Promise<void> {
        await this.node.updateAgentState(this.sessionId, handler);
    }

    /** Register an RPC handler for server-initiated calls. */
    setRpcHandler(handler: RpcHandler): void {
        this.node.setRpcHandler(handler);
    }

    /** Register RPC methods with the server. */
    registerRpcMethods(methods: string[]): void {
        this.node.registerRpcMethods(methods);
    }

    /** Flush the outbox and wait for socket drain. */
    async flush(): Promise<void> {
        await this.node.flush(this.sessionId);
    }

    /** Close the connection (alias for disconnect). */
    async close(): Promise<void> {
        await this.flush();
        this.disconnect();
    }
}
