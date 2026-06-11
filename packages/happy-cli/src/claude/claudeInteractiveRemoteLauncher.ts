import { logger } from '@/ui/logger';
import { buildClaudeLocalCommand, type ClaudeLocalCommand } from './claudeLocalCommand';
import type { LauncherResult } from './claudeLocalLauncher';
import type { Session } from './session';
import { buildInteractivePaste, validateInteractiveBatch } from './interactive/inputInjection';
import { resolveInteractiveClaudeIdentity } from './interactive/sessionIdentity';
import { classifyTerminalOutput } from './interactive/terminalObserver';
import { createTerminalTransport } from './interactive/terminalTransportFactory';
import type { InteractiveClaudeRuntimeMetadata } from './interactive/types';
import type { TerminalExit, TerminalTransport } from './interactive/terminalTransport';
import { createSessionScanner } from './utils/sessionScanner';

const UNSUPPORTED_TERMINAL_MESSAGE = 'Claude interactive remote is not supported in this terminal environment.';
const WINDOW_NAME = 'happy-claude';
const TURN_COMPLETION_DEBOUNCE_MS = 25;

export async function claudeInteractiveRemoteLauncher(session: Session): Promise<LauncherResult> {
    logger.debug('[interactive-remote]: launch');

    const identity = resolveInteractiveClaudeIdentity({
        workingDirectory: session.path,
        claudeArgs: session.claudeArgs,
    });

    if (identity.mode === 'unsupported') {
        updateRuntimeMetadata(session, {
            state: 'unsupported',
            message: identity.error,
        });
        sendSafeMessage(session, identity.error);
        return { type: 'exit', code: 1 };
    }

    const transport = await createTerminalTransport();
    if (!transport) {
        updateRuntimeMetadata(session, {
            state: 'unsupported',
            claudeSessionId: identity.claudeSessionId,
            message: UNSUPPORTED_TERMINAL_MESSAGE,
        });
        sendSafeMessage(session, UNSUPPORTED_TERMINAL_MESSAGE);
        return { type: 'exit', code: 1 };
    }

    let command: ClaudeLocalCommand | null = null;
    let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null;
    let unsubscribeData: (() => void) | null = null;
    let unsubscribeExit: (() => void) | null = null;
    let scannerSessionCallback: ((sessionId: string) => void) | null = null;
    let exitReason: LauncherResult | null = null;
    let terminalExit: TerminalExit | null = null;
    let waitController = new AbortController();
    let continueAfterWaitAbort = false;
    let lastSafeTerminalMessage: string | null = null;
    let completionTimer: ReturnType<typeof setTimeout> | null = null;
    let completionGeneration = 0;

    const terminalMetadata = (state: InteractiveClaudeRuntimeMetadata['state'], message?: string): Partial<InteractiveClaudeRuntimeMetadata> => ({
        state,
        backend: transport.backend,
        capabilities: [...transport.capabilities],
        terminalId: transport.terminalId ?? undefined,
        claudeSessionId: identity.claudeSessionId,
        message,
    });

    const abortQueueWait = () => {
        if (!waitController.signal.aborted) {
            waitController.abort();
        }
    };

    const wakeQueueWaitAndContinue = () => {
        continueAfterWaitAbort = true;
        if (!waitController.signal.aborted) {
            waitController.abort();
        }
        waitController = new AbortController();
    };

    const cancelPendingCompletion = () => {
        completionGeneration++;
        if (completionTimer) {
            clearTimeout(completionTimer);
            completionTimer = null;
        }
    };

    const completeTurnAfterScannerFlush = async (generation: number) => {
        await scanner?.flush();
        if (generation !== completionGeneration || exitReason) {
            return;
        }
        session.client.closeClaudeSessionTurn('completed');
    };

    const scheduleCompletedTurn = () => {
        cancelPendingCompletion();
        const generation = completionGeneration;
        completionTimer = setTimeout(() => {
            completionTimer = null;
            void completeTurnAfterScannerFlush(generation);
        }, TURN_COMPLETION_DEBOUNCE_MS);
    };

    try {
        command = await buildClaudeLocalCommand({
            path: session.path,
            sessionArgs: identity.launchArgs,
            mcpServers: session.mcpServers,
            allowedTools: session.allowedTools,
            hookSettingsPath: session.hookSettingsPath,
            claudeEnvVars: session.claudeEnvVars,
            sandboxConfig: session.sandboxConfig,
        });

        scanner = await createSessionScanner({
            sessionId: identity.claudeSessionId,
            workingDirectory: session.path,
            onMessage: (message) => {
                session.client.sendClaudeSessionMessage(message);
            },
        });

        scannerSessionCallback = (sessionId: string) => {
            void scanner?.onNewSession(sessionId);
        };
        session.addSessionFoundCallback(scannerSessionCallback);

        unsubscribeData = transport.onData((data) => {
            const observation = classifyTerminalOutput(data);
            if (!observation) {
                return;
            }

            switch (observation.type) {
                case 'spinner_without_transcript':
                    session.onThinkingChange(true);
                    return;
                case 'input_prompt_visible':
                    session.onThinkingChange(false);
                    scheduleCompletedTurn();
                    return;
                case 'usage_or_auth_error':
                case 'terminal_process_error':
                    if (lastSafeTerminalMessage !== observation.message) {
                        lastSafeTerminalMessage = observation.message;
                        sendSafeMessage(session, observation.message);
                    }
                    return;
                case 'permission_prompt_visible':
                    return;
                default: {
                    const _: never = observation.type satisfies never;
                    return _;
                }
            }
        });

        unsubscribeExit = transport.onExit((exit) => {
            cancelPendingCompletion();
            terminalExit = exit;
            const code = exitCodeFromTerminalExit(exit);
            const state = code === 0 ? 'degraded' : 'failed';
            updateRuntimeMetadata(session, terminalMetadata(
                state,
                code === 0
                    ? 'Claude interactive terminal exited.'
                    : `Claude interactive terminal exited with code ${code}.`,
            ));
            if (!exitReason) {
                exitReason = { type: 'exit', code };
            }
            abortQueueWait();
        });

        const doAbort = async () => {
            logger.debug('[interactive-remote]: abort');
            session.onAbort();
            cancelPendingCompletion();
            wakeQueueWaitAndContinue();
            session.queue.reset();
            session.client.closeClaudeSessionTurn('cancelled');
            await transport.interrupt();
        };

        const doSwitch = async () => {
            logger.debug('[interactive-remote]: switch');
            if (transport.backend === 'pty') {
                sendSafeMessage(session, 'Claude interactive remote cannot switch to local attach from a PTY terminal.');
                return;
            }
            if (!exitReason) {
                exitReason = { type: 'switch' };
            }
            cancelPendingCompletion();
            updateRuntimeMetadata(session, terminalMetadata('degraded', 'Switching to local terminal attach.'));
            abortQueueWait();
            await transport.interrupt();
        };

        session.client.rpcHandlerManager.registerHandler('abort', doAbort);
        session.client.rpcHandlerManager.registerHandler('switch', doSwitch);

        session.onSessionFound(identity.claudeSessionId);
        updateRuntimeMetadata(session, terminalMetadata('starting'));

        const spawnResult = await transport.spawn({
            command: command.command,
            args: command.args,
            cwd: command.cwd,
            env: toStringEnv(command.env),
            shell: command.shell,
            windowName: WINDOW_NAME,
        });
        updateRuntimeMetadata(session, {
            ...terminalMetadata('interactive'),
            terminalId: spawnResult.terminalId,
        });

        session.consumeOneTimeFlags();

        const launchModeHash = session.queue.modeHasher(session.initialMode);
        while (!exitReason) {
            const batch = await session.queue.waitForMessagesAndGetAsString(waitController.signal);
            if (!batch) {
                if (continueAfterWaitAbort && !exitReason) {
                    continueAfterWaitAbort = false;
                    continue;
                }
                break;
            }

            const validation = validateInteractiveBatch({
                batch,
                launchModeHash,
            });
            if (!validation.ok) {
                cancelPendingCompletion();
                sendSafeMessage(session, validation.message);
                session.client.closeClaudeSessionTurn('failed');
                continue;
            }

            cancelPendingCompletion();
            const payload = buildInteractivePaste(batch.message, transport.backend);
            await transport.paste(payload);
            if (transport.backend === 'tmux') {
                await transport.enter();
            }
        }
    } catch {
        logger.debug('[interactive-remote]: launch error');
        if (!exitReason) {
            updateRuntimeMetadata(session, terminalMetadata('failed', 'Claude interactive terminal failed to start.'));
            sendSafeMessage(session, 'Claude interactive terminal failed to start.');
            exitReason = { type: 'exit', code: 1 };
        }
    } finally {
        cancelPendingCompletion();
        unsubscribeData?.();
        unsubscribeExit?.();
        session.client.rpcHandlerManager.registerHandler('abort', async () => { });
        session.client.rpcHandlerManager.registerHandler('switch', async () => { });

        if (scannerSessionCallback) {
            session.removeSessionFoundCallback(scannerSessionCallback);
        }

        session.onThinkingChange(false);
        await scanner?.cleanup();
        await transport.dispose();
        await command?.cleanupSandbox?.();
    }

    if (exitReason) {
        return exitReason;
    }

    return {
        type: 'exit',
        code: terminalExit ? exitCodeFromTerminalExit(terminalExit) : 0,
    };
}

function updateRuntimeMetadata(
    session: Session,
    runtime: Partial<InteractiveClaudeRuntimeMetadata>,
): void {
    const claudeRuntime: InteractiveClaudeRuntimeMetadata = {
        kind: 'interactive',
        state: runtime.state ?? 'starting',
        backend: runtime.backend,
        capabilities: runtime.capabilities,
        claudeSessionId: runtime.claudeSessionId,
        terminalId: runtime.terminalId,
        message: runtime.message,
        updatedAt: Date.now(),
    };

    session.client.updateMetadata((metadata) => ({
        ...metadata,
        ...(runtime.claudeSessionId ? { claudeSessionId: runtime.claudeSessionId } : {}),
        claudeRuntime,
    }));
}

function sendSafeMessage(session: Session, message: string): void {
    session.client.sendSessionEvent({
        type: 'message',
        message,
    });
}

function exitCodeFromTerminalExit(exit: TerminalExit): number {
    if (typeof exit.code === 'number') {
        return exit.code;
    }
    return exit.signal ? 1 : 0;
}

function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }

    return result;
}
