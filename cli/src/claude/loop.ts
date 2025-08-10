import { ApiSessionClient } from "@/api/apiSession"
import { MessageQueue2 } from "@/utils/MessageQueue2"
import { logger } from "@/ui/logger"
import { createSessionScanner } from "./utils/sessionScanner"
import { Session } from "./session"
import { claudeLocalLauncher } from "./claudeLocalLauncher"
import { claudeRemoteLauncher } from "./claudeRemoteLauncher"
import { ApiClient } from "@/lib"

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

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
    messageQueue: MessageQueue2<PermissionMode>
}

export async function loop(opts: LoopOptions) {

    // Get log path for debug display
    const logPath = await logger.logFilePathPromise;
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
        onModeChange: opts.onModeChange
    });

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
            try {
                await claudeRemoteLauncher(session);
            } catch (e) {
                opts.session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
            }
            mode = 'local';
            if (opts.onModeChange) {
                opts.onModeChange(mode);
            }
            continue;
        }
    }
}
