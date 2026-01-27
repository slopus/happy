import { logger } from "@/ui/logger";
import { claudeLocal } from "./claudeLocal";
import { Session, type SessionFoundInfo } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import type { PermissionMode } from "@/api/types";
import { mapToClaudeMode } from "./utils/permissionMode";
import { createInterface } from "node:readline";

function upsertClaudePermissionModeArgs(args: string[] | undefined, mode: PermissionMode): string[] | undefined {
    const filtered: string[] = [];
    const input = args ?? [];

    for (let i = 0; i < input.length; i++) {
        const arg = input[i];

        // Remove any existing permission mode flags so we can enforce the session's current mode.
        if (arg === '--permission-mode') {
            // Skip value if present
            if (i + 1 < input.length) {
                i++;
            }
            continue;
        }
        if (arg === '--dangerously-skip-permissions') {
            continue;
        }
        filtered.push(arg);
    }

    const claudeMode = mapToClaudeMode(mode);
    if (claudeMode !== 'default') {
        filtered.push('--permission-mode', claudeMode);
    }

    return filtered.length > 0 ? filtered : undefined;
}

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
            session.setLastPermissionMode(mode.permissionMode);
            // Switch to remote mode when message received
            void doSwitch();
        }); // When any message is received, abort current process, clean queue and switch to remote mode

        const queued = session.queue.queue.map((item) => item.message);
        const queuedCount = session.queue.size();
        const queuedLocalIds = session.queue.queue
            .map((item) => item.mode?.localId)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const serverPending = session.client.peekPendingMessageQueueV1Preview({ maxPreview: 3 });

        if (queuedCount > 0 || serverPending.count > 0) {
            const confirmed = await confirmDiscardQueuedMessages({
                queuedCount,
                queuedPreview: queued,
                serverCount: serverPending.count,
                serverPreview: serverPending.preview,
            });
            if (!confirmed) {
                return 'switch';
            }

            // Discard server-side pending messages first, so remote mode does not replay them later.
            let discardedServerCount = 0;
            try {
                if (serverPending.count > 0) {
                    discardedServerCount = await session.client.discardPendingMessageQueueV1All({ reason: 'switch_to_local' });
                }
            } catch (e) {
                session.client.sendSessionEvent({
                    type: 'message',
                    message: `Failed to discard pending messages before switching to local mode: ${formatErrorForUi(e)}`,
                });
                return 'switch';
            }

            // Mark committed queued remote messages as discarded in session metadata so the UI can render them correctly.
            try {
                if (queuedLocalIds.length > 0) {
                    await session.client.discardCommittedMessageLocalIds({ localIds: queuedLocalIds, reason: 'switch_to_local' });
                }
            } catch (e) {
                session.client.sendSessionEvent({
                    type: 'message',
                    message: `Failed to mark queued messages as discarded before switching to local mode: ${formatErrorForUi(e)}`,
                });
                return 'switch';
            }

            if (queuedCount > 0) {
                session.queue.reset();
            }

            const parts: string[] = [];
            if (discardedServerCount > 0) {
                parts.push(`${discardedServerCount} pending UI message${discardedServerCount === 1 ? '' : 's'}`);
            }
            if (queuedCount > 0) {
                parts.push(`${queuedCount} queued remote message${queuedCount === 1 ? '' : 's'}`);
            }

            if (parts.length > 0) {
                session.client.sendSessionEvent({
                    type: 'message',
                    message: `Discarded ${parts.join(' and ')} to switch to local mode. Please resend them from this terminal if needed.`,
                });
            }
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
                // Ensure local Claude Code is spawned with the current session permission mode.
                // This is essential for remote → local switches where the app-selected mode must carry over.
                session.claudeArgs = upsertClaudePermissionModeArgs(session.claudeArgs, session.lastPermissionMode);

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
    async function confirmDiscardQueuedMessages(opts: { queuedCount: number; queuedPreview: string[]; serverCount: number; serverPreview: string[] }): Promise<boolean> {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            return false;
        }

        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve));

        const renderPreview = (messages: string[]) =>
            messages
            .filter((m) => m.trim().length > 0)
            .slice(0, 3)
            .map((m, i) => `  ${i + 1}. ${m.length > 120 ? `${m.slice(0, 120)}…` : m}`)
            .join('\n');

        const blocks: string[] = [];
        if (opts.serverCount > 0) {
            const preview = renderPreview(opts.serverPreview);
            blocks.push(preview
                ? `Pending UI messages (${opts.serverCount}):\n${preview}`
                : `Pending UI messages (${opts.serverCount}).`);
        }
        if (opts.queuedCount > 0) {
            const preview = renderPreview(opts.queuedPreview);
            blocks.push(preview
                ? `Queued remote messages (${opts.queuedCount}):\n${preview}`
                : `Queued remote messages (${opts.queuedCount}).`);
        }

        process.stdout.write(`\n${blocks.join('\n\n')}\n\n`);

        const answer = await question('Discard these messages and switch to local mode? (y/N) ');
        rl.close();

        const normalized = answer.trim().toLowerCase();
        return normalized === 'y' || normalized === 'yes';
    }
