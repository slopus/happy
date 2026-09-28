import type { ClaudeStandaloneDrain } from './claudeStandaloneDrain';
import type { LessonProposalTurn } from '@/utils/lessonProposalTurn';
import { ApiClient, ApiSessionClient } from "@/lib";
import { MessageQueue2 } from "@/utils/MessageQueue2";
import { EnhancedMode } from "./loop";
import { logger } from "@/ui/logger";
import type { JsRuntime } from "./runClaude";
import type { SandboxConfig } from "@/persistence";
import type { SandboxPolicyMode } from "@/sandbox/sandboxPolicy";
import type { AplusMcpServersMap } from '@/aplus/fetchAplusMcpServers';
import type { McpConfigSource } from './mcpConfigSynchronizer';
import type { CheckpointSessionComposition } from '@/checkpoint/checkpointSessionComposition';

import type { LessonSessionHost } from '@/memory/lessonSessionHost';

/** Survives SDK generations, but is reset with the actual conversation. */
export interface ClaudeLessonReviewLifecycle {
    controller: AbortController;
    completedAssistantTurns: number;
}

export class Session {
    prepareChannelExecution?: (requestId: string) => Promise<boolean>;
    beginChannelExecution?: (requestId: string) => boolean;
    readonly path: string;
    readonly logPath: string;
    readonly api: ApiClient;
    readonly client: ApiSessionClient;
    readonly queue: MessageQueue2<EnhancedMode>;
    readonly claudeEnvVars?: Record<string, string>;
    readonly managedSettingsLockdown?: boolean;
    /** A managed Cloud run: unbound instruction paths are closed. */
    readonly managedRun?: boolean;
    /** A Windows standalone launch that the daemon can drain (W0-5c). */
    readonly standaloneDrain?: ClaudeStandaloneDrain;
    /**
     * Project lesson recall and background review for this session.
     *
     * Built once by the runner, from the daemon's trusted spawn context, and
     * carried here so the remote launcher can hand it to each turn without
     * rebuilding it per turn. Absent for a managed run and for any
     * installation without a lesson host.
     */
    readonly lessons?: LessonSessionHost;
    readonly lessonProposalTurn?: LessonProposalTurn;
    readonly lessonReviewLifecycle: ClaudeLessonReviewLifecycle = {
        controller: new AbortController(), completedAssistantTurns: 0,
    };
    cancelLessonReview = (): void => {
        this.lessonReviewLifecycle.controller.abort();
        this.lessonProposalTurn?.cancel();
    };
    claudeArgs?: string[];  // Made mutable to allow filtering
    mcpServers: Record<string, any>;
    readonly mcpConfig?: McpConfigSource;
    readonly allowedTools?: string[];
    readonly sandboxConfig?: SandboxConfig;
    /** 생략하면 개인 머신(owner-choice) — sandbox/sandboxPolicy.ts */
    readonly sandboxPolicyMode?: SandboxPolicyMode;
    readonly checkpointComposition?: CheckpointSessionComposition;
    readonly _onModeChange: (mode: 'local' | 'remote') => void;
    readonly _onAbort?: () => void;
    readonly onActiveUserInputAccepted?: (text: string) => void;
    readonly onSessionReset?: () => void;
    readonly onModeResolved?: (requestIds: string[] | undefined) => { model: string; effort: string | null } | null;
    readonly onModeApplied?: (requestIds: string[] | undefined, executionId: string) => { model: string; effort: string | null } | null;
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    readonly hookSettingsPath: string;
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    readonly jsRuntime: JsRuntime;
    readonly exitAfterFirstTurn: boolean;

    sessionId: string | null;
    /** Always assigned from opts.startingMode in the constructor — the single
     *  place the default lives — before the first keepalive is sent. */
    mode: 'local' | 'remote';
    thinking: boolean = false;
    
    /** Callbacks to be notified when session ID is found/changed */
    private sessionFoundCallbacks: ((sessionId: string) => void)[] = [];
    
    /** Keep alive interval reference for cleanup */
    private keepAliveInterval: NodeJS.Timeout;

    constructor(opts: {
        api: ApiClient,
        client: ApiSessionClient,
        path: string,
        logPath: string,
        sessionId: string | null,
        claudeEnvVars?: Record<string, string>,
        managedSettingsLockdown?: boolean,
        managedRun?: boolean,
        standaloneDrain?: ClaudeStandaloneDrain,
        lessons?: LessonSessionHost,
        lessonProposalTurn?: LessonProposalTurn,
        claudeArgs?: string[],
        mcpServers: Record<string, any>,
        mcpConfig?: McpConfigSource,
        messageQueue: MessageQueue2<EnhancedMode>,
        onModeChange: (mode: 'local' | 'remote') => void,
        onAbort?: () => void,
        onActiveUserInputAccepted?: (text: string) => void,
        onSessionReset?: () => void,
        onModeResolved?: (requestIds: string[] | undefined) => { model: string; effort: string | null } | null,
        onModeApplied?: (requestIds: string[] | undefined, executionId: string) => { model: string; effort: string | null } | null,
        allowedTools?: string[],
        sandboxConfig?: SandboxConfig,
        sandboxPolicyMode?: SandboxPolicyMode,
        checkpointComposition?: CheckpointSessionComposition,
        /** Path to temporary settings file with SessionStart hook (required for session tracking) */
        hookSettingsPath: string,
        /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
        jsRuntime?: JsRuntime,
        /** Mode the run loop is starting in. Sets this.mode before the first
         *  keepalive, so a remote session is never reported as 'local'.
         *  Defaults to 'local' (a plain interactive terminal run). */
        startingMode?: 'local' | 'remote',
        exitAfterFirstTurn?: boolean,
    }) {
        this.path = opts.path;
        this.api = opts.api;
        this.client = opts.client;
        this.logPath = opts.logPath;
        this.sessionId = opts.sessionId;
        this.queue = opts.messageQueue;
        this.claudeEnvVars = opts.claudeEnvVars;
        this.managedSettingsLockdown = opts.managedSettingsLockdown;
        this.managedRun = opts.managedRun;
        this.standaloneDrain = opts.standaloneDrain;
        this.lessons = opts.lessons;
        this.lessonProposalTurn = opts.lessonProposalTurn;
        this.claudeArgs = opts.claudeArgs;
        this.mcpServers = opts.mcpServers;
        this.mcpConfig = opts.mcpConfig;
        this.allowedTools = opts.allowedTools;
        this.sandboxConfig = opts.sandboxConfig;
        this.sandboxPolicyMode = opts.sandboxPolicyMode;
        this.checkpointComposition = opts.checkpointComposition;
        this._onModeChange = opts.onModeChange;
        this._onAbort = opts.onAbort;
        this.onActiveUserInputAccepted = opts.onActiveUserInputAccepted;
        this.onModeResolved = opts.onModeResolved;
        this.onModeApplied = opts.onModeApplied;
        this.onSessionReset = opts.onSessionReset;
        this.hookSettingsPath = opts.hookSettingsPath;
        this.jsRuntime = opts.jsRuntime ?? 'node';
        this.mode = opts.startingMode ?? 'local';
        this.exitAfterFirstTurn = opts.exitAfterFirstTurn === true;

        // Start keep alive
        this.client.keepAlive(this.thinking, this.mode);
        this.keepAliveInterval = setInterval(() => {
            this.client.keepAlive(this.thinking, this.mode);
        }, 2000);
    }

    updateMcpConfiguration(servers: Record<string, any>, aplusServers: AplusMcpServersMap): void {
        this.mcpServers = servers;
        if (this.mcpConfig) {
            this.mcpConfig.initialAplusServers = aplusServers;
        }
    }
    
    /**
     * Cleanup resources (call when session is no longer needed)
     */
    cleanup = (): void => {
        this.cancelLessonReview();
        clearInterval(this.keepAliveInterval);
        this.sessionFoundCallbacks = [];
        logger.debug('[Session] Cleaned up resources');
    }

    onThinkingChange = (thinking: boolean) => {
        this.thinking = thinking;
        this.client.keepAlive(thinking, this.mode);
    }

    onModeChange = (mode: 'local' | 'remote') => {
        this.mode = mode;
        this.client.keepAlive(this.thinking, mode);
        this._onModeChange(mode);
    }

    onAbort = () => {
        this._onAbort?.();
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
        this.client.updateMetadata((metadata) => ({
            ...metadata,
            claudeSessionId: sessionId
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
        this.cancelLessonReview();
        this.lessonReviewLifecycle.completedAssistantTurns = 0;
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
