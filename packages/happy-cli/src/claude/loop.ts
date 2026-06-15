import { ApiSessionClient } from "@/api/apiSession"
import { MessageQueue2 } from "@/utils/MessageQueue2"
import { logger } from "@/ui/logger"
import { Session } from "./session"
import { claudeLocalLauncher } from "./claudeLocalLauncher"
import { claudeInteractiveRemoteLauncher } from "./claudeInteractiveRemoteLauncher"
import { ApiClient } from "@/lib"
import type { JsRuntime } from "./runClaude"
import type { SandboxConfig } from "@/persistence"

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
    session: ApiSessionClient
    api: ApiClient,
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    messageQueue: MessageQueue2<EnhancedMode>
    initialMode: EnhancedMode
    allowedTools?: string[]
    sandboxConfig?: SandboxConfig
    onSessionReady?: (session: Session) => void
    onAbort?: () => void
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime
}

export async function loop(opts: LoopOptions): Promise<number> {

    // Get log path for debug display
    const logPath = logger.logFilePath;
    let session = new Session({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: null,
        initialMode: opts.initialMode,
        claudeEnvVars: opts.claudeEnvVars,
        claudeArgs: opts.claudeArgs,
        mcpServers: opts.mcpServers,
        logPath: logPath,
        messageQueue: opts.messageQueue,
        allowedTools: opts.allowedTools,
        sandboxConfig: opts.sandboxConfig,
        onModeChange: opts.onModeChange,
        onAbort: opts.onAbort,
        hookSettingsPath: opts.hookSettingsPath,
        jsRuntime: opts.jsRuntime
    });

    opts.onSessionReady?.(session)

    let mode: 'local' | 'remote' = opts.startingMode ?? 'local';
    while (true) {
        logger.debug(`[loop] Iteration with mode: ${mode}`);

        switch (mode) {
            case 'local': {
                const result = await claudeLocalLauncher(session);
                switch (result.type ) {
                    case 'switch':
                        mode = 'remote';
                        opts.onModeChange?.(mode);
                        break;
                    case 'exit':
                        return result.code;
                    default:
                        const _: never = result satisfies never;
                }
                break;
            }

            case 'remote': {
                const result = await claudeInteractiveRemoteLauncher(session);
                return result.code;
            }

            default: {
                const _: never = mode satisfies never;
            }
        }
    }
}
