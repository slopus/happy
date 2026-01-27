import { ApiClient, ApiSessionClient } from "@/lib";
import { MessageQueue2 } from "@/utils/MessageQueue2";
import { EnhancedMode } from "./loop";
import { logger } from "@/ui/logger";
import type { JsRuntime } from "./runClaude";
import type { SessionHookData } from "./utils/startHookServer";
import type { PermissionMode } from "@/api/types";
import { randomUUID } from "node:crypto";

export type SessionFoundInfo = {
    sessionId: string;
    transcriptPath: string | null;
};

export class Session {
    readonly path: string;
    readonly logPath: string;
    readonly api: ApiClient;
    readonly client: ApiSessionClient;
    readonly queue: MessageQueue2<EnhancedMode>;
    readonly claudeEnvVars?: Record<string, string>;
    claudeArgs?: string[];  // Made mutable to allow filtering
    readonly mcpServers: Record<string, any>;
    readonly allowedTools?: string[];
    readonly _onModeChange: (mode: 'local' | 'remote') => void;
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    readonly hookSettingsPath: string;
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    readonly jsRuntime: JsRuntime;

    sessionId: string | null;
    transcriptPath: string | null = null;
    mode: 'local' | 'remote' = 'local';
    thinking: boolean = false;
    private currentTaskId: string | null = null;

    /**
     * Last known permission mode for this session, derived from message metadata / permission responses.
     * Used to carry permission settings across remote ↔ local mode switches.
     */
    lastPermissionMode: PermissionMode = 'default';
    lastPermissionModeUpdatedAt: number = 0;
    
    /** Callbacks to be notified when session ID is found/changed */
    private sessionFoundCallbacks: ((info: SessionFoundInfo) => void)[] = [];
    
    /** Keep alive interval reference for cleanup */
    private keepAliveInterval: NodeJS.Timeout;

    constructor(opts: {
        api: ApiClient,
        client: ApiSessionClient,
        path: string,
        logPath: string,
        sessionId: string | null,
        claudeEnvVars?: Record<string, string>,
        claudeArgs?: string[],
        mcpServers: Record<string, any>,
        messageQueue: MessageQueue2<EnhancedMode>,
        onModeChange: (mode: 'local' | 'remote') => void,
        allowedTools?: string[],
        /** Path to temporary settings file with SessionStart hook (required for session tracking) */
        hookSettingsPath: string,
        /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
        jsRuntime?: JsRuntime,
    }) {
        this.path = opts.path;
        this.api = opts.api;
        this.client = opts.client;
        this.logPath = opts.logPath;
        this.sessionId = opts.sessionId;
        this.queue = opts.messageQueue;
        this.claudeEnvVars = opts.claudeEnvVars;
        this.claudeArgs = opts.claudeArgs;
        this.mcpServers = opts.mcpServers;
        this.allowedTools = opts.allowedTools;
        this._onModeChange = opts.onModeChange;
        this.hookSettingsPath = opts.hookSettingsPath;
        this.jsRuntime = opts.jsRuntime ?? 'node';

        // Start keep alive
        this.client.keepAlive(this.thinking, this.mode);
        this.keepAliveInterval = setInterval(() => {
            this.client.keepAlive(this.thinking, this.mode);
        }, 2000);
    }
    
    /**
     * Cleanup resources (call when session is no longer needed)
     */
    cleanup = (): void => {
        clearInterval(this.keepAliveInterval);
        this.sessionFoundCallbacks = [];
        logger.debug('[Session] Cleaned up resources');
    }

    setLastPermissionMode = (mode: PermissionMode, updatedAt: number = Date.now()): void => {
        if (mode === this.lastPermissionMode) {
            return;
        }
        this.lastPermissionMode = mode;
        this.lastPermissionModeUpdatedAt = updatedAt;
        this.client.updateMetadata((metadata) => ({
            ...metadata,
            permissionMode: mode,
            permissionModeUpdatedAt: updatedAt
        }));
    }

    onThinkingChange = (thinking: boolean) => {
        const wasThinking = this.thinking;
        this.thinking = thinking;
        this.client.keepAlive(thinking, this.mode);

        if (wasThinking === thinking) {
            return;
        }

        if (thinking) {
            const id = randomUUID();
            this.currentTaskId = id;
            this.client.sendAgentMessage('claude', { type: 'task_started', id });
            return;
        }

        if (!this.currentTaskId) {
            return;
        }

        const id = this.currentTaskId;
        this.currentTaskId = null;
        this.client.sendAgentMessage('claude', { type: 'task_complete', id });
    }

    onModeChange = (mode: 'local' | 'remote') => {
        this.mode = mode;
        this.client.keepAlive(this.thinking, mode);
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
    onSessionFound = (sessionId: string, hookData?: SessionHookData) => {
        const nextTranscriptPathRaw = hookData?.transcript_path ?? hookData?.transcriptPath;
        const nextTranscriptPath = typeof nextTranscriptPathRaw === 'string' ? nextTranscriptPathRaw : null;

        const prevSessionId = this.sessionId;
        const prevTranscriptPath = this.transcriptPath;

        this.sessionId = sessionId;
        if (prevSessionId !== sessionId) {
            // Avoid carrying a transcript path across different Claude sessions.
            // If the hook didn't provide a transcript path for this session, force fallback to heuristics.
            this.transcriptPath = nextTranscriptPath;
        } else if (nextTranscriptPath) {
            // Same sessionId, but we learned/updated the exact transcript path.
            this.transcriptPath = nextTranscriptPath;
        }
        
        // Update metadata with Claude Code session ID
        if (prevSessionId !== sessionId) {
            this.client.updateMetadata((metadata) => ({
                ...metadata,
                claudeSessionId: sessionId
            }));
            logger.debug(`[Session] Claude Code session ID ${sessionId} added to metadata`);

        }

        // Notify callbacks when either the sessionId changes or we learned a better transcript path.
        const didTranscriptPathChange = Boolean(nextTranscriptPath) && nextTranscriptPath !== prevTranscriptPath;
        if (prevSessionId === sessionId && !didTranscriptPathChange) {
            return;
        }

        const info: SessionFoundInfo = {
            sessionId,
            transcriptPath: this.transcriptPath
        };
        
        // Notify all registered callbacks
        for (const callback of this.sessionFoundCallbacks) {
            callback(info);
        }
    }
    
    /**
     * Register a callback to be notified when session ID is found/changed
     */
    addSessionFoundCallback = (callback: (info: SessionFoundInfo) => void): void => {
        this.sessionFoundCallbacks.push(callback);
    }
    
    /**
     * Remove a session found callback
     */
    removeSessionFoundCallback = (callback: (info: SessionFoundInfo) => void): void => {
        const index = this.sessionFoundCallbacks.indexOf(callback);
        if (index !== -1) {
            this.sessionFoundCallbacks.splice(index, 1);
        }
    }

    /**
     * Wait until we have a sessionId (and optionally a transcriptPath) from Claude hooks.
     * Used to avoid switching modes before the session is actually initialized on disk.
     */
    waitForSessionFound = async (opts: { timeoutMs?: number; requireTranscriptPath?: boolean } = {}): Promise<SessionFoundInfo | null> => {
        const timeoutMs = opts.timeoutMs ?? 2000;
        const requireTranscriptPath = opts.requireTranscriptPath ?? false;

        const isReady = (): boolean => {
            if (!this.sessionId) return false;
            if (requireTranscriptPath && !this.transcriptPath) return false;
            return true;
        };

        if (isReady()) {
            return { sessionId: this.sessionId!, transcriptPath: this.transcriptPath };
        }

        return new Promise((resolve) => {
            const onUpdate = () => {
                if (!isReady()) return;
                cleanup();
                resolve({ sessionId: this.sessionId!, transcriptPath: this.transcriptPath });
            };

            const cleanup = () => {
                clearTimeout(timeoutId);
                this.removeSessionFoundCallback(onUpdate);
            };

            const timeoutId = setTimeout(() => {
                cleanup();
                if (this.sessionId) {
                    resolve({ sessionId: this.sessionId, transcriptPath: this.transcriptPath });
                } else {
                    resolve(null);
                }
            }, timeoutMs);

            this.addSessionFoundCallback(onUpdate);
        });
    }

    /**
     * Clear the current session ID (used by /clear command)
     */
    clearSessionId = (): void => {
        this.sessionId = null;
        this.transcriptPath = null;
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
            
            if (arg === '--continue' || arg === '-c') {
                logger.debug('[Session] Consumed --continue flag');
                continue;
            }

            if (arg === '--session-id') {
                if (i + 1 < this.claudeArgs.length) {
                    const nextArg = this.claudeArgs[i + 1];
                    if (!nextArg.startsWith('-')) {
                        i++; // Skip the value
                        logger.debug(`[Session] Consumed --session-id flag with value: ${nextArg}`);
                    } else {
                        logger.debug('[Session] Consumed --session-id flag (missing value)');
                    }
                } else {
                    logger.debug('[Session] Consumed --session-id flag (missing value)');
                }
                continue;
            }
            
            if (arg === '--resume' || arg === '-r') {
                const nextArg = i + 1 < this.claudeArgs.length ? this.claudeArgs[i + 1] : undefined;
                if (nextArg && !nextArg.startsWith('-')) {
                    i++; // Skip the value
                    logger.debug(`[Session] Consumed ${arg} flag with session ID: ${nextArg}`);
                } else {
                    logger.debug(`[Session] Consumed ${arg} flag (no session ID)`);
                }
                continue;
            }
            
            filteredArgs.push(arg);
        }
        
        this.claudeArgs = filteredArgs.length > 0 ? filteredArgs : undefined;
        logger.debug(`[Session] Consumed one-time flags, remaining args:`, this.claudeArgs);
    }
}
