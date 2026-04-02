/**
 * SyncNode bridge for CLI session processes.
 *
 * Each CLI session process (Claude, Codex, OpenCode) uses a session-scoped
 * SyncNode. The bridge:
 *   1. Creates the SyncNode with the session-scoped JWT from the daemon
 *   2. Provides a simple interface for sending/updating raw acpx SessionMessage
 *   3. Watches metadata-derived state for permission decisions, question answers,
 *      runtime config changes, and lifecycle transitions
 *
 * Usage pattern (from agent runner):
 *   await bridge.sendMessage({ Agent: agentMessage });
 *   await bridge.updateMessage({ Agent: agentMessage });
 */

import {
    SyncNode,
    type SyncNodeToken,
    type SessionState,
    type KeyMaterial,
    type UsageReport,
    type RpcHandler,
} from '@slopus/happy-sync';
import type {
    SessionMessage,
    SessionUserMessage,
} from '@slopus/happy-sync';
import type {
    SessionID,
    RuntimeConfig,
} from '@slopus/happy-sync';

export type UserMessageCallback = (message: { User: SessionUserMessage }) => void;

export interface SyncBridgeOpts {
    serverUrl: string;
    token: SyncNodeToken;
    keyMaterial: KeyMaterial;
    sessionId: SessionID;
}

export type PermissionDecisionCallback = (decision: {
    permissionId: string;
    callId: string;
    decision: 'once' | 'always' | 'reject';
    allowTools?: string[];
    reason?: string;
}) => void;

export type QuestionAnswerCallback = (answer: {
    questionId: string;
    answers: string[][];
}) => void;

export type RuntimeConfigChangeCallback = (config: RuntimeConfig) => void;
export type AbortRequestCallback = () => void;
export type SessionEndCallback = () => void;

export class SyncBridge {
    readonly node: SyncNode;
    readonly sessionId: SessionID;

    private permissionCallbacks = new Set<PermissionDecisionCallback>();
    private questionCallbacks = new Set<QuestionAnswerCallback>();
    private userMessageCallbacks = new Set<UserMessageCallback>();
    private runtimeConfigCallbacks = new Set<RuntimeConfigChangeCallback>();
    private abortCallbacks = new Set<AbortRequestCallback>();
    private sessionEndCallbacks = new Set<SessionEndCallback>();

    private knownResolvedPermissions = new Set<string>();
    private knownResolvedQuestions = new Set<string>();
    private lastRuntimeConfigJson = '';
    private lastAbortRequestAt: number | null = null;
    private lastLifecycleState: string | null = null;

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

        // Watch for incoming user messages from the app
        this.node.onSessionMessage(this.sessionId, (message) => {
            if (typeof message === 'object' && message !== null && 'User' in message) {
                for (const cb of this.userMessageCallbacks) {
                    cb(message as { User: SessionUserMessage });
                }
            }
        });

        // Watch state changes for permission decisions, question answers, config, abort, lifecycle
        this.node.onStateChange(() => {
            const session = this.session;
            if (!session) return;
            this.processPermissionChanges(session);
            this.processQuestionChanges(session);
            this.processRuntimeConfigChanges(session);
            this.processAbortChanges(session);
            this.processLifecycleChanges(session);
        });
    }

    // ─── State change processors ────────────────────────────────────────────

    private processPermissionChanges(session: SessionState): void {
        for (const perm of session.permissions) {
            if (!perm.resolved || this.knownResolvedPermissions.has(perm.permissionId)) continue;
            this.knownResolvedPermissions.add(perm.permissionId);
            if (!perm.decision) continue;
            for (const cb of this.permissionCallbacks) {
                cb({
                    permissionId: perm.permissionId,
                    callId: perm.callId,
                    decision: perm.decision,
                    allowTools: perm.allowTools,
                    reason: perm.reason,
                });
            }
        }
    }

    private processQuestionChanges(session: SessionState): void {
        for (const q of session.questions) {
            if (!q.resolved || this.knownResolvedQuestions.has(q.questionId)) continue;
            this.knownResolvedQuestions.add(q.questionId);
            if (!q.answers) continue;
            for (const cb of this.questionCallbacks) {
                cb({
                    questionId: q.questionId,
                    answers: q.answers,
                });
            }
        }
    }

    private processRuntimeConfigChanges(session: SessionState): void {
        const config = session.runtimeConfig;
        if (!config) return;
        const json = JSON.stringify(config);
        if (json === this.lastRuntimeConfigJson) return;
        this.lastRuntimeConfigJson = json;
        for (const cb of this.runtimeConfigCallbacks) {
            cb(config);
        }
    }

    private processAbortChanges(session: SessionState): void {
        const agentState = session.agentState;
        if (!agentState || typeof agentState !== 'object') return;
        const lastAbort = (agentState as Record<string, unknown>).lastAbortRequest;
        if (!lastAbort || typeof lastAbort !== 'object') return;
        const createdAt = (lastAbort as Record<string, unknown>).createdAt;
        if (typeof createdAt !== 'number') return;
        if (this.lastAbortRequestAt !== null && createdAt <= this.lastAbortRequestAt) return;
        this.lastAbortRequestAt = createdAt;
        for (const cb of this.abortCallbacks) {
            cb();
        }
    }

    private processLifecycleChanges(session: SessionState): void {
        if (session.lifecycleState === this.lastLifecycleState) return;
        const prev = this.lastLifecycleState;
        this.lastLifecycleState = session.lifecycleState;
        if (session.lifecycleState === 'archived' && prev !== null && prev !== 'archived') {
            for (const cb of this.sessionEndCallbacks) {
                cb();
            }
        }
    }

    // ─── Connection lifecycle ───────────────────────────────────────────────

    async connect(): Promise<void> {
        await this.node.connect();
        await this.node.fetchMessages(this.sessionId, undefined, {
            notifyListeners: false,
        });
    }

    disconnect(): void {
        this.node.disconnect();
    }

    // ─── Session state accessors ────────────────────────────────────────────

    get session(): SessionState | undefined {
        return this.node.state.sessions.get(this.sessionId as string);
    }

    get messages(): SessionMessage[] {
        return this.session?.messages ?? [];
    }

    get hasPendingPermissions(): boolean {
        return (this.session?.permissions.some((p) => !p.resolved)) ?? false;
    }

    get hasPendingQuestions(): boolean {
        return (this.session?.questions.some((q) => !q.resolved)) ?? false;
    }

    // ─── Message operations ─────────────────────────────────────────────────

    async sendMessage(message: SessionMessage): Promise<void> {
        await this.node.sendMessage(this.sessionId, message);
    }

    async updateMessage(message: SessionMessage): Promise<void> {
        await this.node.updateMessage(this.sessionId, message);
    }

    // ─── Callback registration ──────────────────────────────────────────────

    onPermissionDecision(callback: PermissionDecisionCallback): () => void {
        this.permissionCallbacks.add(callback);
        return () => { this.permissionCallbacks.delete(callback); };
    }

    onQuestionAnswer(callback: QuestionAnswerCallback): () => void {
        this.questionCallbacks.add(callback);
        return () => { this.questionCallbacks.delete(callback); };
    }

    onRuntimeConfigChange(callback: RuntimeConfigChangeCallback): () => void {
        this.runtimeConfigCallbacks.add(callback);
        return () => { this.runtimeConfigCallbacks.delete(callback); };
    }

    onAbortRequest(callback: AbortRequestCallback): () => void {
        this.abortCallbacks.add(callback);
        return () => { this.abortCallbacks.delete(callback); };
    }

    onSessionEnd(callback: SessionEndCallback): () => void {
        this.sessionEndCallbacks.add(callback);
        return () => { this.sessionEndCallbacks.delete(callback); };
    }

    onUserMessage(callback: UserMessageCallback): () => void {
        this.userMessageCallbacks.add(callback);
        return () => { this.userMessageCallbacks.delete(callback); };
    }

    // ─── Session lifecycle ──────────────────────────────────────────────────

    keepAlive(thinking: boolean, mode: 'local' | 'remote'): void {
        this.node.keepAlive(this.sessionId, thinking, mode);
    }

    sendSessionDeath(): void {
        this.node.sendSessionDeath(this.sessionId);
    }

    async sendPermissionRequest(request: { callID: string; tool: string; patterns: string[]; input: Record<string, unknown> }): Promise<void> {
        await this.node.sendPermissionRequest(this.sessionId, request);
    }

    async sendRuntimeConfigChange(change: RuntimeConfig): Promise<void> {
        await this.node.sendRuntimeConfigChange(this.sessionId, change);
    }

    async sendAbortRequest(request: { source: string; reason: string }): Promise<void> {
        await this.node.sendAbortRequest(this.sessionId, request);
    }

    async sendSessionEnd(sessionEnd: { reason: string }): Promise<void> {
        await this.node.sendSessionEnd(this.sessionId, sessionEnd);
    }

    sendUsageData(report: UsageReport): void {
        this.node.sendUsageData(report);
    }

    async updateMetadata<T = unknown>(handler: (current: T) => T): Promise<void> {
        await this.node.updateMetadata(this.sessionId, handler);
    }

    async updateAgentState<T = unknown>(handler: (current: T) => T): Promise<void> {
        await this.node.updateAgentState(this.sessionId, handler);
    }

    // ─── Typed session-level setters ────────────────────────────────────────

    async setLifecycleState(
        state: 'running' | 'idle' | 'archived',
        opts?: { archivedBy?: string; archiveReason?: string },
    ): Promise<void> {
        await this.updateMetadata((current: Record<string, unknown>) => ({
            ...current,
            lifecycleState: state,
            lifecycleStateSince: Date.now(),
            ...(opts?.archivedBy ? { archivedBy: opts.archivedBy } : {}),
            ...(opts?.archiveReason ? { archiveReason: opts.archiveReason } : {}),
        }));
    }

    async setControlledByUser(value: boolean): Promise<void> {
        await this.updateAgentState((current: Record<string, unknown>) => ({
            ...current,
            controlledByUser: value,
        }));
    }

    setRpcHandler(handler: RpcHandler): void {
        this.node.setRpcHandler(handler);
    }

    registerRpcMethods(methods: string[]): void {
        this.node.registerRpcMethods(methods);
    }

    async flush(): Promise<void> {
        await this.node.flush(this.sessionId);
    }

    async close(): Promise<void> {
        await this.flush();
        this.disconnect();
    }
}
