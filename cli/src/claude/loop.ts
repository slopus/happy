import { ApiSessionClient } from "@/api/apiSession"
import { MessageQueue2 } from "@/utils/MessageQueue2"
import { logger } from "@/ui/logger"
import { Session } from "./session"
import { claudeLocalLauncher } from "./claudeLocalLauncher"
import { claudeRemoteLauncher } from "./claudeRemoteLauncher"
import { ApiClient } from "@/lib"
import type { JsRuntime } from "./runClaude"

// Re-export permission mode type from api/types
// Single unified type with 7 modes - Codex modes mapped at SDK boundary
export type { PermissionMode } from "@/api/types"
import type { PermissionMode } from "@/api/types"

export interface EnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    fallbackModel?: string;
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
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
    allowedTools?: string[]
    onSessionReady?: (session: Session) => void
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime
}

export async function loop(opts: LoopOptions) {

    // Get log path for debug display
    const logPath = logger.logFilePath;
    let session = new Session({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: null,
        claudeEnvVars: opts.claudeEnvVars,
        claudeArgs: opts.claudeArgs,
        mcpServers: opts.mcpServers,
        logPath: logPath,
        messageQueue: opts.messageQueue,
        allowedTools: opts.allowedTools,
        onModeChange: opts.onModeChange,
        hookSettingsPath: opts.hookSettingsPath,
        jsRuntime: opts.jsRuntime
    });

    // Notify that session is ready
    if (opts.onSessionReady) {
        opts.onSessionReady(session);
    }

    let mode: 'local' | 'remote' = opts.startingMode ?? 'local';
    while (true) {
        logger.debug(`[loop] Iteration with mode: ${mode}`);

        // Run local mode if applicable
        if (mode === 'local') {
            let reason = await claudeLocalLauncher(session);
            if (reason === 'exit') { // Normal exit - Exit loop
                return;
            }

            // Non "exit" reason means we need to switch to remote mode
            mode = 'remote';
            if (opts.onModeChange) {
                opts.onModeChange(mode);
            }
            continue;
        }

        // Start remote mode
        if (mode === 'remote') {
            let reason = await claudeRemoteLauncher(session);
            if (reason === 'exit') { // Normal exit - Exit loop
                return;
            }

            // Non "exit" reason means we need to switch to local mode
            mode = 'local';
            if (opts.onModeChange) {
                opts.onModeChange(mode);
            }
            continue;
        }
    }
}
