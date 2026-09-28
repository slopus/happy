import type { ClaudeStandaloneDrain } from './claudeStandaloneDrain';
import type { LessonProposalTurn } from '@/utils/lessonProposalTurn';
import { ApiSessionClient } from "@/api/apiSession"
import { MessageQueue2 } from "@/utils/MessageQueue2"
import { logger } from "@/ui/logger"
import { Session } from "./session"
import type { LessonSessionHost } from '@/memory/lessonSessionHost'
import { claudeLocalLauncher, LauncherResult } from "./claudeLocalLauncher"
import { claudeRemoteLauncher } from "./claudeRemoteLauncher"
import { ApiClient } from "@/lib"
import type { JsRuntime } from "./runClaude"
import type { SandboxConfig } from "@/persistence"
import type { SandboxPolicyMode } from "@/sandbox/sandboxPolicy"
import type { McpConfigSource } from './mcpConfigSynchronizer'
import type { SaycodePromptBlockOverrides } from '@/prompt/promptProvenance'
import type { CheckpointSessionComposition } from '@/checkpoint/checkpointSessionComposition'

// Re-export permission mode type from api/types
// Single unified type with 7 modes - Codex modes mapped at SDK boundary
export type { PermissionMode } from "@/api/types"
import type { PermissionMode } from "@/api/types"

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface EnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    fallbackModel?: string;
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
    saycodeSystemPromptEnabled?: boolean;
    /** Per-block overrides; default-on blocks stay enabled, while other missing blocks inherit the master. */
    saycodePromptBlocks?: SaycodePromptBlockOverrides;
    allowedTools?: string[];
    disallowedTools?: string[];
    /** Effort level passed through to the Claude Agent SDK as the `effort` option. */
    effort?: ClaudeEffort;
}

interface LoopOptions {
    path: string
    model?: string
    permissionMode?: PermissionMode
    startingMode?: 'local' | 'remote'
    onModeChange: (mode: 'local' | 'remote') => void
    mcpServers: Record<string, any>
    mcpConfig?: McpConfigSource
    session: ApiSessionClient
    api: ApiClient,
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    /**
     * A managed Cloud run loads no filesystem settings.
     *
     * A settings file's `env` block is applied to the agent and wins over the
     * environment this startup produced, so `~/.claude/settings.json` on the
     * runtime image could redirect the gateway or substitute a key after the
     * approval was made. Managed runs load none of those sources.
     */
    managedSettingsLockdown?: boolean
    /** A managed Cloud run: steering and goal-setting are refused. */
    managedRun?: boolean
    /** A Windows standalone launch the daemon can drain (W0-5c). */
    standaloneDrain?: ClaudeStandaloneDrain
    /** Built by the runner; see `Session.lessons`. */
    lessons?: LessonSessionHost
    lessonProposalTurn?: LessonProposalTurn
    messageQueue: MessageQueue2<EnhancedMode>
    allowedTools?: string[]
    sandboxConfig?: SandboxConfig
    sandboxPolicyMode?: SandboxPolicyMode
    checkpointComposition?: CheckpointSessionComposition
    onSessionReady?: (session: Session) => void
    onAbort?: () => void
    /** Called after /clear actually resets the provider context. */
    onSessionReset?: () => void
    onActiveUserInputAccepted?: (text: string) => void
    /**
     * Called when a collected batch's mode becomes the settings of an engine
     * query — the engine-applied boundary. Carries every client request the
     * batch merged, so a consumer can commit per-execution state exactly once.
     */
    onModeResolved?: (requestIds: string[] | undefined) => { model: string; effort: string | null } | null
    onModeApplied?: (requestIds: string[] | undefined, executionId: string) => { model: string; effort: string | null } | null
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime
    exitAfterFirstTurn?: boolean
    getSaycodeSystemPromptEnabled: () => boolean | undefined
    getSaycodePromptBlocks: () => SaycodePromptBlockOverrides | undefined
}

export async function loop(opts: LoopOptions): Promise<number> {

    // Get log path for debug display
    const logPath = logger.logFilePath;
    let session = new Session({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: null,
        claudeEnvVars: opts.claudeEnvVars,
        claudeArgs: opts.claudeArgs,
        managedSettingsLockdown: opts.managedSettingsLockdown,
        managedRun: opts.managedRun,
        standaloneDrain: opts.standaloneDrain,
        mcpServers: opts.mcpServers,
        mcpConfig: opts.mcpConfig,
        logPath: logPath,
        messageQueue: opts.messageQueue,
        allowedTools: opts.allowedTools,
        sandboxConfig: opts.sandboxConfig,
        sandboxPolicyMode: opts.sandboxPolicyMode,
        checkpointComposition: opts.checkpointComposition,
        onModeChange: opts.onModeChange,
        onAbort: opts.onAbort,
        onActiveUserInputAccepted: opts.onActiveUserInputAccepted,
        onModeResolved: opts.onModeResolved,
        onModeApplied: opts.onModeApplied,
        onSessionReset: opts.onSessionReset,
        hookSettingsPath: opts.hookSettingsPath,
        jsRuntime: opts.jsRuntime,
        startingMode: opts.startingMode,
        exitAfterFirstTurn: opts.exitAfterFirstTurn,
        lessons: opts.lessons,
        lessonProposalTurn: opts.lessonProposalTurn,
    });

    opts.onSessionReady?.(session)

    let mode: 'local' | 'remote' = opts.startingMode ?? 'local';
    while (true) {
        logger.debug(`[loop] Iteration with mode: ${mode}`);
        if (opts.checkpointComposition?.beforeTurn && mode !== 'remote') {
            throw new Error('checkpoint protection supports Claude remote mode only');
        }

        switch (mode) {
            case 'local': {
                const result = await claudeLocalLauncher(session, {
                    saycodeSystemPromptEnabled: opts.getSaycodeSystemPromptEnabled(),
                    saycodePromptBlocks: opts.getSaycodePromptBlocks(),
                });
                switch (result.type ) {
                    case 'switch':
                        mode = 'remote';
                        session.onModeChange(mode);
                        break;
                    case 'exit':
                        return result.code;
                    default:
                        const _: never = result satisfies never;
                }
                break;
            }

            case 'remote': {
                const reason = await claudeRemoteLauncher(session);
                switch (reason) {
                    case 'exit':
                        return 0;
                    case 'switch':
                        mode = 'local';
                        session.onModeChange(mode);
                        break;
                    default:
                        const _: never = reason satisfies never;
                }
                break;
            }

            default: {
                const _: never = mode satisfies never;
            }
        }
    }
}
