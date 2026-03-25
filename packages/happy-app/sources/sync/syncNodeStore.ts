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
type SessionControlMessage = v3.SessionControlMessage;

interface SessionSnapshot {
    infoSignature: string;
    messageIds: string[];
    messageRefs: MessageWithParts[];
    controlIds: string[];
    controlRefs: SessionControlMessage[];
    metadataVersion: number;
    agentStateVersion: number;
    statusSignature: string;
}

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
    private stateListeners = new Set<(state: SyncState) => void>();
    private storeListeners = new Set<() => void>();
    private loadedSessions = new Set<string>();
    private sessionSnapshots = new Map<string, SessionSnapshot>();
    private sessionStateVersions = new Map<string, number>();
    private sessionMessagesVersions = new Map<string, number>();
    private messageVersions = new Map<string, number>();

    constructor(opts: AppSyncNodeOpts) {
        this.node = new SyncNode(opts.serverUrl, opts.token, opts.keyMaterial, {
            resolveSessionKeyMaterial: opts.resolveSessionKeyMaterial,
        });

        this.node.onStateChange((state: SyncState) => {
            this.reconcileVersions(state);

            for (const listener of this.stateListeners) {
                listener(state);
            }

            for (const listener of this.storeListeners) {
                listener();
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
        this.stateListeners.add(listener);
        return () => { this.stateListeners.delete(listener); };
    }

    /** Subscribe for useSyncExternalStore-backed selectors. */
    subscribeStore(listener: () => void): () => void {
        this.storeListeners.add(listener);
        return () => { this.storeListeners.delete(listener); };
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

    /** Get a single message by ID. */
    getMessage(sessionId: SessionID, messageId: v3.MessageID): MessageWithParts | null {
        return this.getMessages(sessionId).find((message) => message.info.id === messageId) ?? null;
    }

    /** Get a single tool part by message/part IDs. */
    getToolPart(
        sessionId: SessionID,
        messageId: v3.MessageID,
        partId?: v3.PartID,
    ): v3.ToolPart | null {
        const message = this.getMessage(sessionId, messageId);
        if (!message) {
            return null;
        }

        const toolParts = message.parts.filter((part): part is v3.ToolPart => part.type === 'tool');
        if (partId) {
            return toolParts.find((part) => part.id === partId) ?? null;
        }
        return toolParts[0] ?? null;
    }

    /** Whether the app already hydrated full message history for a session. */
    isSessionLoaded(sessionId: SessionID): boolean {
        return this.loadedSessions.has(sessionId as string);
    }

    getSessionStateVersion(sessionId: SessionID): number {
        return this.sessionStateVersions.get(sessionId as string) ?? 0;
    }

    getSessionMessagesVersion(sessionId: SessionID): number {
        return this.sessionMessagesVersions.get(sessionId as string) ?? 0;
    }

    getMessageVersion(sessionId: SessionID, messageId: v3.MessageID): number {
        return this.messageVersions.get(this.messageVersionKey(sessionId, messageId)) ?? 0;
    }

    /** Fetch messages for a specific session. */
    async fetchSession(sessionId: SessionID): Promise<void> {
        await this.node.fetchMessages(sessionId);
        const key = sessionId as string;
        if (!this.loadedSessions.has(key)) {
            this.loadedSessions.add(key);
            this.bumpVersion(this.sessionMessagesVersions, key);
            this.bumpVersion(this.sessionStateVersions, key);
            this.emitStoreChange();
        }
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
        const runtimeConfig: Omit<v3.RuntimeConfigChange, 'type' | 'id' | 'sessionID' | 'time'> = {
            source: 'user',
        };
        let hasRuntimeConfigChange = false;
        const meta = opts.meta;
        if (meta && Object.prototype.hasOwnProperty.call(meta, 'permissionMode')) {
            runtimeConfig.permissionMode = meta.permissionMode;
            hasRuntimeConfigChange = true;
        }
        if (meta && Object.prototype.hasOwnProperty.call(meta, 'model')) {
            runtimeConfig.model = meta.model;
            hasRuntimeConfigChange = true;
        }
        if (meta && Object.prototype.hasOwnProperty.call(meta, 'fallbackModel')) {
            runtimeConfig.fallbackModel = meta.fallbackModel;
            hasRuntimeConfigChange = true;
        }
        if (meta && Object.prototype.hasOwnProperty.call(meta, 'customSystemPrompt')) {
            runtimeConfig.customSystemPrompt = meta.customSystemPrompt;
            hasRuntimeConfigChange = true;
        }
        if (meta && Object.prototype.hasOwnProperty.call(meta, 'appendSystemPrompt')) {
            runtimeConfig.appendSystemPrompt = meta.appendSystemPrompt;
            hasRuntimeConfigChange = true;
        }
        if (meta && Object.prototype.hasOwnProperty.call(meta, 'allowedTools')) {
            runtimeConfig.allowedTools = meta.allowedTools;
            hasRuntimeConfigChange = true;
        }
        if (meta && Object.prototype.hasOwnProperty.call(meta, 'disallowedTools')) {
            runtimeConfig.disallowedTools = meta.disallowedTools;
            hasRuntimeConfigChange = true;
        }

        if (hasRuntimeConfigChange) {
            await this.node.sendRuntimeConfigChange(sessionId, runtimeConfig);
        }

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

    private emitStoreChange(): void {
        for (const listener of this.storeListeners) {
            listener();
        }
    }

    private reconcileVersions(state: SyncState): void {
        const seenSessions = new Set<string>();

        for (const [sessionId, session] of state.sessions) {
            seenSessions.add(sessionId);
            const previous = this.sessionSnapshots.get(sessionId);

            const {
                messagesChanged,
                changedMessageIds,
                messageIds,
                messageRefs,
            } = this.diffMessages(previous, session.messages);
            const {
                changed: controlChanged,
                ids: controlIds,
                refs: controlRefs,
            } = this.diffControlMessages(previous, session.controlMessages);

            const infoSignature = this.getInfoSignature(session.info);
            const statusSignature = this.getStatusSignature(session.status);
            const sessionStateChanged = !previous
                || messagesChanged
                || controlChanged
                || previous.infoSignature !== infoSignature
                || previous.metadataVersion !== session.metadataVersion
                || previous.agentStateVersion !== session.agentStateVersion
                || previous.statusSignature !== statusSignature;

            if (messagesChanged) {
                this.bumpVersion(this.sessionMessagesVersions, sessionId);
            }
            if (sessionStateChanged) {
                this.bumpVersion(this.sessionStateVersions, sessionId);
            }
            for (const messageId of changedMessageIds) {
                this.bumpVersion(this.messageVersions, this.messageVersionKey(session.info.id, messageId));
            }

            this.sessionSnapshots.set(sessionId, {
                infoSignature,
                messageIds,
                messageRefs,
                controlIds,
                controlRefs,
                metadataVersion: session.metadataVersion,
                agentStateVersion: session.agentStateVersion,
                statusSignature,
            });
        }

        for (const sessionId of Array.from(this.sessionSnapshots.keys())) {
            if (seenSessions.has(sessionId)) {
                continue;
            }

            this.sessionSnapshots.delete(sessionId);
            this.loadedSessions.delete(sessionId);
            this.bumpVersion(this.sessionMessagesVersions, sessionId);
            this.bumpVersion(this.sessionStateVersions, sessionId);
            this.deleteMessageVersions(sessionId);
        }
    }

    private diffMessages(previous: SessionSnapshot | undefined, messages: MessageWithParts[]): {
        messagesChanged: boolean;
        changedMessageIds: string[];
        messageIds: string[];
        messageRefs: MessageWithParts[];
    } {
        const messageIds = messages.map((message) => message.info.id as string);
        const messageRefs = [...messages];

        if (!previous) {
            return {
                messagesChanged: messages.length > 0,
                changedMessageIds: messageIds,
                messageIds,
                messageRefs,
            };
        }

        let messagesChanged = previous.messageIds.length !== messageIds.length;
        const changedMessageIds = new Set<string>();
        const maxLength = Math.max(previous.messageIds.length, messageIds.length);

        for (let i = 0; i < maxLength; i += 1) {
            const previousId = previous.messageIds[i];
            const nextId = messageIds[i];

            if (previousId !== nextId) {
                messagesChanged = true;
                if (previousId) {
                    changedMessageIds.add(previousId);
                }
                if (nextId) {
                    changedMessageIds.add(nextId);
                }
                continue;
            }

            if (nextId && previous.messageRefs[i] !== messageRefs[i]) {
                messagesChanged = true;
                changedMessageIds.add(nextId);
            }
        }

        return {
            messagesChanged,
            changedMessageIds: Array.from(changedMessageIds),
            messageIds,
            messageRefs,
        };
    }

    private diffControlMessages(previous: SessionSnapshot | undefined, messages: SessionControlMessage[]): {
        changed: boolean;
        ids: string[];
        refs: SessionControlMessage[];
    } {
        const ids = messages.map((message) => message.id as string);
        const refs = [...messages];

        if (!previous) {
            return {
                changed: messages.length > 0,
                ids,
                refs,
            };
        }

        let changed = previous.controlIds.length !== ids.length;
        const maxLength = Math.max(previous.controlIds.length, ids.length);
        for (let i = 0; i < maxLength; i += 1) {
            if (previous.controlIds[i] !== ids[i] || previous.controlRefs[i] !== refs[i]) {
                changed = true;
                break;
            }
        }

        return {
            changed,
            ids,
            refs,
        };
    }

    private getInfoSignature(info: SessionState['info']): string {
        return [
            info.id,
            info.projectID,
            info.directory,
            info.parentID ?? '',
            info.title,
            String(info.time.created),
            String(info.time.updated),
        ].join('\u0000');
    }

    private getStatusSignature(status: SessionState['status']): string {
        switch (status.type) {
            case 'blocked':
                return `${status.type}:${status.reason}`;
            case 'error':
                return `${status.type}:${status.error}`;
            default:
                return status.type;
        }
    }

    private bumpVersion(map: Map<string, number>, key: string): void {
        map.set(key, (map.get(key) ?? 0) + 1);
    }

    private messageVersionKey(sessionId: SessionID | string, messageId: v3.MessageID | string): string {
        return `${sessionId as string}:${messageId as string}`;
    }

    private deleteMessageVersions(sessionId: string): void {
        const prefix = `${sessionId}:`;
        for (const key of Array.from(this.messageVersions.keys())) {
            if (key.startsWith(prefix)) {
                this.messageVersions.delete(key);
            }
        }
    }
}
