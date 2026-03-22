import { SyncBridge } from "@/api/syncBridge";
import { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { PushNotificationClient } from "@/api/pushNotifications";
import { MessageQueue2 } from "@/utils/MessageQueue2";
import { EnhancedMode } from "./loop";
import { logger } from "@/ui/logger";
import type { JsRuntime } from "./runClaude";
import type { SandboxConfig } from "@/persistence";
import type { RawJSONLines } from "./types";
import type { SessionTurnEndStatus } from "@/legacy/sessionProtocol";
import type { AgentState, Metadata } from "@/api/types";
import {
    handleClaudeMessage,
    flushV3Turn,
    createV3MapperState,
    blockToolForPermission,
    unblockToolApproved,
    unblockToolRejected,
    type V3MapperState,
} from "./utils/v3Mapper";
import { calculateCost } from "@/utils/pricing";

export class Session {
    readonly path: string;
    readonly logPath: string;
    readonly syncBridge: SyncBridge;
    readonly rpcHandlerManager: RpcHandlerManager;
    readonly push: PushNotificationClient;
    readonly hapSessionId: string;
    readonly queue: MessageQueue2<EnhancedMode>;
    readonly claudeEnvVars?: Record<string, string>;
    claudeArgs?: string[];  // Made mutable to allow filtering
    readonly mcpServers: Record<string, any>;
    readonly allowedTools?: string[];
    readonly sandboxConfig?: SandboxConfig;
    readonly _onModeChange: (mode: 'local' | 'remote') => void;
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    readonly hookSettingsPath: string;
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    readonly jsRuntime: JsRuntime;

    sessionId: string | null;
    mode: 'local' | 'remote' = 'local';
    thinking: boolean = false;

    /** v3 mapper state — owned by Session, not by SyncBridge */
    private v3MapperState: V3MapperState | null = null;

    /** Callbacks to be notified when session ID is found/changed */
    private sessionFoundCallbacks: ((sessionId: string) => void)[] = [];

    /** Keep alive interval reference for cleanup */
    private keepAliveInterval: NodeJS.Timeout;

    constructor(opts: {
        syncBridge: SyncBridge,
        rpcHandlerManager: RpcHandlerManager,
        push: PushNotificationClient,
        hapSessionId: string,
        path: string,
        logPath: string,
        sessionId: string | null,
        claudeEnvVars?: Record<string, string>,
        claudeArgs?: string[],
        mcpServers: Record<string, any>,
        messageQueue: MessageQueue2<EnhancedMode>,
        onModeChange: (mode: 'local' | 'remote') => void,
        allowedTools?: string[],
        sandboxConfig?: SandboxConfig,
        /** Path to temporary settings file with SessionStart hook (required for session tracking) */
        hookSettingsPath: string,
        /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
        jsRuntime?: JsRuntime,
    }) {
        this.path = opts.path;
        this.syncBridge = opts.syncBridge;
        this.rpcHandlerManager = opts.rpcHandlerManager;
        this.push = opts.push;
        this.hapSessionId = opts.hapSessionId;
        this.logPath = opts.logPath;
        this.sessionId = opts.sessionId;
        this.queue = opts.messageQueue;
        this.claudeEnvVars = opts.claudeEnvVars;
        this.claudeArgs = opts.claudeArgs;
        this.mcpServers = opts.mcpServers;
        this.allowedTools = opts.allowedTools;
        this.sandboxConfig = opts.sandboxConfig;
        this._onModeChange = opts.onModeChange;
        this.hookSettingsPath = opts.hookSettingsPath;
        this.jsRuntime = opts.jsRuntime ?? 'node';

        // Start keep alive via SyncBridge
        const sendKeepAlive = () => {
            this.syncBridge.keepAlive(this.thinking, this.mode);
        };
        sendKeepAlive();
        this.keepAliveInterval = setInterval(sendKeepAlive, 2000);
    }

    // ─── v3 message operations (owned by Session, routed through SyncBridge) ──

    /** Process a Claude SDK message through the v3 mapper and send finalized messages. */
    sendClaudeMessage(body: RawJSONLines): void {
        if (!this.v3MapperState) {
            this.v3MapperState = createV3MapperState({
                sessionID: this.hapSessionId,
                providerID: 'anthropic',
            });
        }

        const result = handleClaudeMessage(body, this.v3MapperState);

        for (const msg of result.messages) {
            this.sendV3Message(msg);
        }

        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage, body.message.model);
            } catch (error) {
                logger.debug('[Session] Failed to send usage data:', error);
            }
        }

        // Update metadata with summary
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: { text: (body as any).summary, updatedAt: Date.now() },
            }));
        }
    }

    /** Flush any in-flight v3 assistant message (on turn close). */
    closeClaudeTurn(_status: SessionTurnEndStatus = 'completed'): void {
        if (!this.v3MapperState) return;
        const messages = flushV3Turn(this.v3MapperState);
        for (const msg of messages) {
            this.sendV3Message(msg);
        }
    }

    /** Mark a tool as blocked for permission in the v3 mapper. */
    blockToolForPermission(callID: string, permission: string, patterns: string[], metadata: Record<string, unknown>): void {
        if (!this.v3MapperState) return;
        blockToolForPermission(this.v3MapperState, callID, permission, patterns, metadata);
    }

    /** Mark a blocked tool as approved. */
    unblockToolApproved(callID: string, decision: 'once' | 'always'): void {
        if (!this.v3MapperState) return;
        unblockToolApproved(this.v3MapperState, callID, decision);
    }

    /** Mark a blocked tool as rejected. */
    unblockToolRejected(callID: string, reason: string): void {
        if (!this.v3MapperState) return;
        unblockToolRejected(this.v3MapperState, callID, reason);
    }

    /** Route a v3 MessageWithParts through SyncBridge. */
    private sendV3Message(message: { info: unknown; parts: unknown[] }): void {
        this.syncBridge.sendMessage(message as any).catch((err) => {
            logger.debug('[Session] SyncBridge send failed', { error: err });
        });
    }

    // ─── Session lifecycle ─────────────────────────────────────────────────

    updateAgentState(handler: (state: AgentState) => AgentState): void {
        this.syncBridge.updateAgentState(handler).catch((err) => {
            logger.debug('[Session] SyncBridge updateAgentState failed', { error: err });
        });
    }

    updateMetadata(handler: (metadata: Metadata) => Metadata): void {
        this.syncBridge.updateMetadata(handler).catch((err) => {
            logger.debug('[Session] SyncBridge updateMetadata failed', { error: err });
        });
    }

    sendSessionDeath(): void {
        this.syncBridge.sendSessionDeath();
    }

    /** Send a session event (status message) via agent state update. */
    sendSessionEvent(event: { type: string; message?: string; mode?: string }): void {
        this.updateAgentState((currentState) => ({
            ...currentState,
            lastEvent: { ...event, time: Date.now() },
        }));
    }

    sendUsageData(usage: any, model?: string): void {
        const totalTokens = usage.input_tokens + usage.output_tokens
            + (usage.cache_creation_input_tokens || 0)
            + (usage.cache_read_input_tokens || 0);
        const costs = calculateCost(usage, model);
        this.syncBridge.sendUsageData({
            key: 'claude-session',
            sessionId: this.hapSessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0,
            },
            cost: { total: costs.total, input: costs.input, output: costs.output },
        });
    }

    async flush(): Promise<void> {
        await this.syncBridge.flush();
    }

    /**
     * Cleanup resources (call when session is no longer needed)
     */
    cleanup = (): void => {
        clearInterval(this.keepAliveInterval);
        this.sessionFoundCallbacks = [];
        logger.debug('[Session] Cleaned up resources');
    }

    onThinkingChange = (thinking: boolean) => {
        this.thinking = thinking;
        this.syncBridge.keepAlive(thinking, this.mode);
    }

    onModeChange = (mode: 'local' | 'remote') => {
        this.mode = mode;
        this.syncBridge.keepAlive(this.thinking, mode);
        this._onModeChange(mode);
    }

    /**
     * Called when Claude session ID is discovered or changed.
     *
     * This is triggered by the SessionStart hook when:
     * - Claude starts a new session (fresh start)
     * - Claude resumes a session (--continue, --resume flags)
     * - Claude forks a session (/compact, double-escape fork)
     *
     * Updates internal state, syncs to API metadata, and notifies
     * all registered callbacks (e.g., SessionScanner) about the change.
     */
    onSessionFound = (sessionId: string) => {
        this.sessionId = sessionId;

        // Update metadata with Claude Code session ID
        this.updateMetadata((metadata) => ({
            ...metadata,
            claudeSessionId: sessionId,
        }));
        logger.debug(`[Session] Claude Code session ID ${sessionId} added to metadata`);

        // Notify all registered callbacks
        for (const callback of this.sessionFoundCallbacks) {
            callback(sessionId);
        }
    }

    /**
     * Register a callback to be notified when session ID is found/changed
     */
    addSessionFoundCallback = (callback: (sessionId: string) => void): void => {
        this.sessionFoundCallbacks.push(callback);
    }

    /**
     * Remove a session found callback
     */
    removeSessionFoundCallback = (callback: (sessionId: string) => void): void => {
        const index = this.sessionFoundCallbacks.indexOf(callback);
        if (index !== -1) {
            this.sessionFoundCallbacks.splice(index, 1);
        }
    }

    /**
     * Clear the current session ID (used by /clear command)
     */
    clearSessionId = (): void => {
        this.sessionId = null;
        logger.debug('[Session] Session ID cleared');
    }

    /**
     * Consume one-time Claude flags from claudeArgs after Claude spawn
     * Handles: --resume (with or without session ID), --continue
     */
    consumeOneTimeFlags = (): void => {
        if (!this.claudeArgs) return;

        const filteredArgs: string[] = [];
        for (let i = 0; i < this.claudeArgs.length; i++) {
            const arg = this.claudeArgs[i];

            if (arg === '--continue') {
                logger.debug('[Session] Consumed --continue flag');
                continue;
            }

            if (arg === '--resume') {
                // Check if next arg looks like a UUID (contains dashes and alphanumeric)
                if (i + 1 < this.claudeArgs.length) {
                    const nextArg = this.claudeArgs[i + 1];
                    // Simple UUID pattern check - contains dashes and is not another flag
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        // Skip both --resume and the UUID
                        i++; // Skip the UUID
                        logger.debug(`[Session] Consumed --resume flag with session ID: ${nextArg}`);
                    } else {
                        // Just --resume without UUID
                        logger.debug('[Session] Consumed --resume flag (no session ID)');
                    }
                } else {
                    // --resume at the end of args
                    logger.debug('[Session] Consumed --resume flag (no session ID)');
                }
                continue;
            }

            filteredArgs.push(arg);
        }

        this.claudeArgs = filteredArgs.length > 0 ? filteredArgs : undefined;
        logger.debug(`[Session] Consumed one-time flags, remaining args:`, this.claudeArgs);
    }
}
