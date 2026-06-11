import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { buildClaudeLocalCommand, type ClaudeLocalCommand } from './claudeLocalCommand';
import type { Session } from './session';
import { buildInteractivePaste, validateInteractiveBatch } from './interactive/inputInjection';
import { resolveInteractiveClaudeIdentity } from './interactive/sessionIdentity';
import { classifyTerminalOutput } from './interactive/terminalObserver';
import { createTerminalTransport } from './interactive/terminalTransportFactory';
import type { InteractiveClaudeRuntimeMetadata } from './interactive/types';
import type { TerminalExit, TerminalTransport } from './interactive/terminalTransport';
import { createSessionScanner } from './utils/sessionScanner';

const UNSUPPORTED_TERMINAL_MESSAGE = 'Claude interactive remote is not supported in this terminal environment.';
const WINDOW_NAME_PREFIX = 'happy-claude-';
const TURN_COMPLETION_DEBOUNCE_MS = 25;
type InteractiveRemoteResult = { type: 'exit'; code: number };

export async function claudeInteractiveRemoteLauncher(session: Session): Promise<InteractiveRemoteResult> {
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
    let exitReason: InteractiveRemoteResult | null = null;
    let terminalExit: TerminalExit | null = null;
    let waitController = new AbortController();
    let continueAfterWaitAbort = false;
    let localAttachMode = false;
    let detachTerminalOnCleanup = false;
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

    const failRuntime = (message: string) => {
        cancelPendingCompletion();
        localAttachMode = false;
        detachTerminalOnCleanup = false;
        updateRuntimeMetadata(session, terminalMetadata('failed', message));
        if (lastSafeTerminalMessage !== message) {
            lastSafeTerminalMessage = message;
            sendSafeMessage(session, message);
        }
        session.client.closeClaudeSessionTurn('failed');
        if (!exitReason) {
            exitReason = { type: 'exit', code: 1 };
        }
        abortQueueWait();
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
            onTranscriptMissing: (sessionId) => {
                if (sessionId === identity.claudeSessionId) {
                    failRuntime('Claude transcript did not appear for the interactive session.');
                }
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
                    failRuntime(observation.message);
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
            if (exitReason) {
                return;
            }
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
            if (localAttachMode) {
                session.onModeChange('remote');
                updateRuntimeMetadata(session, terminalMetadata('interactive'));
            }
            localAttachMode = false;
            detachTerminalOnCleanup = false;
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
            cancelPendingCompletion();
            localAttachMode = true;
            detachTerminalOnCleanup = true;
            session.onModeChange('local');
            updateRuntimeMetadata(session, terminalMetadata('interactive', buildTmuxAttachMessage(transport.terminalId)));
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
            windowName: createInteractiveWindowName(),
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

            if (localAttachMode) {
                localAttachMode = false;
                detachTerminalOnCleanup = false;
                session.onModeChange('remote');
                updateRuntimeMetadata(session, terminalMetadata('interactive'));
            }

            cancelPendingCompletion();
            const payload = buildInteractivePaste(batch.message, transport.backend);
            try {
                await transport.paste(payload);
                if (transport.backend === 'tmux') {
                    await transport.enter();
                }
            } catch {
                failRuntime('Claude interactive terminal failed to receive input.');
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
        if (!detachTerminalOnCleanup) {
            await transport.dispose();
        }
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

function createInteractiveWindowName(): string {
    const suffix = randomUUID().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12);
    return `${WINDOW_NAME_PREFIX}${suffix || Date.now().toString(36)}`;
}

function buildTmuxAttachMessage(terminalId: string | null): string {
    if (!terminalId) {
        return 'Claude is running in tmux. Attach to the configured tmux session to control it locally.';
    }
    const [sessionName] = terminalId.split(':');
    return `Claude is running in tmux target ${terminalId}. Attach with: tmux attach -t ${sessionName}`;
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
