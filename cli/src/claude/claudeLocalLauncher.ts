import { logger } from "@/ui/logger";
import { claudeLocal } from "./claudeLocal";
import { Session, type SessionFoundInfo } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";
import { formatErrorForUi } from "@/utils/formatErrorForUi";

export async function claudeLocalLauncher(session: Session): Promise<'switch' | 'exit'> {

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        transcriptPath: session.transcriptPath,
        claudeConfigDir: session.claudeEnvVars?.CLAUDE_CONFIG_DIR ?? null,
        workingDirectory: session.path,
        onMessage: (message) => { 
            // Block SDK summary messages - we generate our own
            if (message.type !== 'summary') {
                session.client.sendClaudeSessionMessage(message)
            }
        },
        onTranscriptMissing: () => {
            session.client.sendSessionEvent({
                type: 'message',
                message: 'Claude transcript file not found yet — waiting for it to appear…'
            });
        },
    });
    
    // Register callback to notify scanner when session ID is found via hook
    // This is important for --continue/--resume where session ID is not known upfront
    const scannerSessionCallback = (info: SessionFoundInfo) => {
        scanner.onNewSession({ sessionId: info.sessionId, transcriptPath: info.transcriptPath });
    };
    session.addSessionFoundCallback(scannerSessionCallback);


    // Handle abort
    let exitReason: 'switch' | 'exit' | null = null;
    const processAbortController = new AbortController();
    let exutFuture = new Future<void>();
    try {
        async function abort() {

            // Send abort signal
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }

            // Await full exit
            await exutFuture.promise;
        }

        async function ensureSessionInfoBeforeSwitch(): Promise<void> {
            const needsSessionId = session.sessionId === null;
            const needsTranscriptPath = session.transcriptPath === null;
            if (!needsSessionId && !needsTranscriptPath) return;

            session.client.sendSessionEvent({
                type: 'message',
                message: needsSessionId
                    ? 'Waiting for Claude session to initialize before switching…'
                    : 'Waiting for Claude transcript info before switching…',
            });

            await session.waitForSessionFound({
                timeoutMs: 2000,
                requireTranscriptPath: needsTranscriptPath,
            });
        }

        async function doAbort() {
            logger.debug('[local]: doAbort');

            // Switching to remote mode
            if (!exitReason) {
                exitReason = 'switch';
            }

            // Reset sent messages
            session.queue.reset();

            // Abort
            await ensureSessionInfoBeforeSwitch();
            await abort();
        }

        async function doSwitch() {
            logger.debug('[local]: doSwitch');

            // Switching to remote mode
            if (!exitReason) {
                exitReason = 'switch';
            }

            // Abort
            await ensureSessionInfoBeforeSwitch();
            await abort();
        }

        // When to abort
        session.client.rpcHandlerManager.registerHandler('abort', doAbort); // Abort current process, clean queue and switch to remote mode
        session.client.rpcHandlerManager.registerHandler('switch', async (params: any) => {
            // Newer clients send a target mode. Older clients send no params.
            // Local launcher is already in local mode, so {to:'local'} is a no-op.
            const to = params && typeof params === 'object' ? (params as any).to : undefined;
            if (to === 'local') return false;
            await doSwitch();
            return true;
        }); // When user wants to switch to remote mode
        session.queue.setOnMessage((message: string, mode) => {
            // Switch to remote mode when message received
            void doSwitch();
        }); // When any message is received, abort current process, clean queue and switch to remote mode

        // Exit if there are messages in the queue
        if (session.queue.size() > 0) {
            return 'switch';
        }

        // Handle session start
        const handleSessionStart = (sessionId: string) => {
            session.onSessionFound(sessionId);
            scanner.onNewSession(sessionId);
        }

        // Run local mode
        while (true) {
            // If we already have an exit reason, return it
            if (exitReason) {
                return exitReason;
            }

            const resumeFromSessionId = session.sessionId;
            const resumeFromTranscriptPath = session.transcriptPath;
            const expectsFork = resumeFromSessionId !== null;
            if (expectsFork) {
                // Starting local mode from an existing session uses `--resume`, which forks
                // to a new Claude session ID and transcript file. Clear the current
                // session info so a fast local→remote switch waits for the new hook data,
                // instead of resuming the stale pre-fork sessionId/transcriptPath.
                session.clearSessionId();
            }

            // Launch
            logger.debug('[local]: launch');
            try {
                await claudeLocal({
                    path: session.path,
                    sessionId: resumeFromSessionId,
                    onSessionFound: handleSessionStart,
                    onThinkingChange: session.onThinkingChange,
                    abort: processAbortController.signal,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    mcpServers: session.mcpServers,
                    allowedTools: session.allowedTools,
                    hookSettingsPath: session.hookSettingsPath,
                });

                // Consume one-time Claude flags after spawn
                // For example we don't want to pass --resume flag after first spawn
                session.consumeOneTimeFlags();

                // Normal exit
                if (!exitReason) {
                    exitReason = 'exit';
                    break;
                }
            } catch (e) {
                logger.debug('[local]: launch error', e);
                if (expectsFork && session.sessionId === null) {
                    // If the local spawn failed before Claude reported the forked session,
                    // restore the previous session info so remote mode can still resume it.
                    session.sessionId = resumeFromSessionId;
                    session.transcriptPath = resumeFromTranscriptPath;
                }
                if (!exitReason) {
                    session.client.sendSessionEvent({ type: 'message', message: `Claude process error: ${formatErrorForUi(e)}` });
                    continue;
                } else {
                    break;
                }
            }
            logger.debug('[local]: launch done');
        }
    } finally {

        // Resolve future
        exutFuture.resolve(undefined);

        // Set handlers to no-op
        session.client.rpcHandlerManager.registerHandler('abort', async () => { });
        session.client.rpcHandlerManager.registerHandler('switch', async () => false);
        session.queue.setOnMessage(null);
        
        // Remove session found callback
        session.removeSessionFoundCallback(scannerSessionCallback);

        // Cleanup
        await scanner.cleanup();
    }

    // Return
    return exitReason || 'exit';
}
