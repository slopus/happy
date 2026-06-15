import { randomUUID } from 'node:crypto';
import React from 'react';
import { render } from 'ink';
import { logger } from '@/ui/logger';
import { MessageBuffer, type BufferedMessage } from '@/ui/ink/messageBuffer';
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay';
import { cleanupStdinAfterInk } from '@/utils/terminalStdinCleanup';
import { buildClaudeLocalCommand, type ClaudeLocalCommand } from './claudeLocalCommand';
import type { Session } from './session';
import { buildInteractivePaste, normalizePromptText, validateInteractiveBatch } from './interactive/inputInjection';
import { hasTerminalInputPrompt, isTerminalInputReady } from './interactive/inputReadiness';
import { resolveInteractiveClaudeIdentity } from './interactive/sessionIdentity';
import { classifyTerminalOutput } from './interactive/terminalObserver';
import { createTerminalTransport } from './interactive/terminalTransportFactory';
import type { InteractiveClaudeRuntimeMetadata } from './interactive/types';
import type { TerminalExit, TerminalTransport } from './interactive/terminalTransport';
import { createSessionScanner } from './utils/sessionScanner';
import type { RawJSONLines } from './types';

const UNSUPPORTED_TERMINAL_MESSAGE = 'Claude interactive remote is not supported in this terminal environment.';
const WINDOW_NAME_PREFIX = 'happy-claude-';
const TURN_COMPLETION_DEBOUNCE_MS = 25;
const TERMINAL_INPUT_READY_TIMEOUT_MS = 8000;
const TERMINAL_INPUT_NOT_READY_MESSAGE = 'Claude interactive terminal is not ready for input yet.';
const SKIP_PERMISSIONS_ARG = '--dangerously-skip-permissions';
type TerminalInputReadyWaitResult = 'ready' | 'timeout' | 'cancelled' | 'exited';
type InteractiveRemoteResult = { type: 'exit'; code: number };
type LocalAttachTransport = TerminalTransport & {
    attachLocal?: () => Promise<void>;
    detachLocal?: () => Promise<void>;
};

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

    let transportDisposed = false;
    const disposeTransport = async () => {
        if (transportDisposed) {
            return;
        }
        transportDisposed = true;
        await transport.dispose();
    };
    const removeTransportCleanupHook = session.addCleanupHook(disposeTransport);

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
    let terminalSpawned = false;
    let lastSafeTerminalMessage: string | null = null;
    let completionTimer: ReturnType<typeof setTimeout> | null = null;
    let completionGeneration = 0;
    let terminalInputReady = false;
    let inputCancellationGeneration = 0;
    const hasTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
    const messageBuffer = new MessageBuffer();
    let inkInstance: ReturnType<typeof render> | null = null;
    const inputReadyWaiters = new Set<(result: TerminalInputReadyWaitResult) => void>();
    const pendingAppPromptEchoes: string[] = [];

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

    const wakeInputReadyWaiters = (result: TerminalInputReadyWaitResult) => {
        const waiters = [...inputReadyWaiters];
        inputReadyWaiters.clear();
        for (const waiter of waiters) {
            waiter(result);
        }
    };

    const markTerminalInputReady = () => {
        terminalInputReady = true;
        if (lastSafeTerminalMessage === TERMINAL_INPUT_NOT_READY_MESSAGE) {
            lastSafeTerminalMessage = null;
            updateRuntimeMetadata(session, terminalMetadata('interactive'));
        }
        wakeInputReadyWaiters('ready');
    };

    const markTerminalInputBusy = () => {
        terminalInputReady = false;
        cancelPendingCompletion();
    };

    const cancelPendingInputWaits = (result: Extract<TerminalInputReadyWaitResult, 'cancelled' | 'exited'> = 'cancelled') => {
        inputCancellationGeneration++;
        wakeInputReadyWaiters(result);
    };

    const mountRemoteDisplay = (opts: {
        onExit: () => Promise<void> | void;
        onSwitchToLocal: () => Promise<void> | void;
    }) => {
        if (!hasTTY || inkInstance || exitReason || localAttachMode) {
            return;
        }

        console.clear();
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: () => {
                void opts.onExit();
            },
            onSwitchToLocal: () => {
                void opts.onSwitchToLocal();
            },
        }), {
            exitOnCtrlC: false,
            patchConsole: false,
        });

        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode?.(true);
        }
        process.stdin.setEncoding('utf8');
    };

    const unmountRemoteDisplay = async (leaveRawMode = true) => {
        if (!inkInstance) {
            return;
        }

        const t0 = Date.now();
        inkInstance.unmount();
        inkInstance = null;
        await cleanupStdinAfterInk({
            stdin: process.stdin,
            drainMs: 150,
            leaveRawMode,
            onDebug: (event) => {
                logger.debug(`[interactive-remote]: stdin drain ${event.bytes}B / ${event.chunks} chunk(s) +${Date.now() - t0}ms`);
            },
        });
    };

    const waitForTerminalInputReady = async (): Promise<TerminalInputReadyWaitResult> => {
        if (terminalInputReady) {
            return 'ready';
        }
        if (exitReason) {
            return 'exited';
        }

        return new Promise<TerminalInputReadyWaitResult>((resolve) => {
            let timeout: ReturnType<typeof setTimeout> | null = null;
            const done = (result: TerminalInputReadyWaitResult) => {
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                }
                inputReadyWaiters.delete(done);
                resolve(result);
            };

            timeout = setTimeout(() => {
                logger.debug('[interactive-remote]: terminal input readiness timed out; not sending prompt');
                done('timeout');
            }, TERMINAL_INPUT_READY_TIMEOUT_MS);
            inputReadyWaiters.add(done);
        });
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
        cancelPendingInputWaits();
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

    const failCurrentTurnForInputNotReady = () => {
        updateRuntimeMetadata(session, terminalMetadata('degraded', TERMINAL_INPUT_NOT_READY_MESSAGE));
        if (lastSafeTerminalMessage !== TERMINAL_INPUT_NOT_READY_MESSAGE) {
            lastSafeTerminalMessage = TERMINAL_INPUT_NOT_READY_MESSAGE;
            sendSafeMessage(session, TERMINAL_INPUT_NOT_READY_MESSAGE);
        }
        session.client.closeClaudeSessionTurn('failed');
    };

    try {
        command = await buildClaudeLocalCommand({
            path: session.path,
            sessionArgs: withInteractivePermissionArgs(identity.launchArgs, session.initialMode.permissionMode),
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
                if (suppressRemoteControlledUserPrompt(message, {
                    localAttachMode,
                    pendingAppPromptEchoes,
                })) {
                    return;
                }
                appendRemoteDisplayMessage(messageBuffer, message);
                session.client.sendClaudeSessionMessage(message);
            },
            onTranscriptMissing: (sessionId) => {
                if (sessionId === identity.claudeSessionId) {
                    logger.debug('[interactive-remote]: active Claude transcript has not appeared yet; keeping terminal runtime alive');
                }
            },
            keepMissingCurrentSession: true,
        });

        scannerSessionCallback = (sessionId: string) => {
            void scanner?.onNewSession(sessionId);
            if (terminalSpawned && sessionId === identity.claudeSessionId && !localAttachMode) {
                markTerminalInputReady();
            }
        };
        session.addSessionFoundCallback(scannerSessionCallback);

        unsubscribeData = transport.onData((data) => {
            const terminalInputIsReady = isTerminalInputReady(data);
            const terminalInputPromptVisible = hasTerminalInputPrompt(data);
            const observation = classifyTerminalOutput(data);

            if (observation) {
                switch (observation.type) {
                    case 'spinner_without_transcript':
                        markTerminalInputBusy();
                        session.onThinkingChange(true);
                        return;
                    case 'usage_or_auth_error':
                    case 'terminal_process_error':
                        failRuntime(observation.message);
                        return;
                    case 'permission_prompt_visible':
                        markTerminalInputBusy();
                        return;
                    case 'input_prompt_visible':
                        if (!terminalInputIsReady) {
                            markTerminalInputBusy();
                            return;
                        }
                        break;
                    default: {
                        const _: never = observation.type satisfies never;
                        return _;
                    }
                }
            }

            if (localAttachMode) {
                if (terminalInputPromptVisible) {
                    markTerminalInputBusy();
                }
                return;
            }

            if (terminalInputIsReady) {
                markTerminalInputReady();
                session.onThinkingChange(false);
                scheduleCompletedTurn();
                return;
            }

            if (terminalInputPromptVisible) {
                markTerminalInputBusy();
            }
        });

        unsubscribeExit = transport.onExit((exit) => {
            if (exitReason) {
                return;
            }
            cancelPendingCompletion();
            cancelPendingInputWaits('exited');
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
            cancelPendingInputWaits();
            if (localAttachMode) {
                await detachLocalTerminal(transport);
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

        const doExit = async () => {
            logger.debug('[interactive-remote]: exit');
            cancelPendingCompletion();
            cancelPendingInputWaits('exited');
            if (!exitReason) {
                exitReason = { type: 'exit', code: 0 };
            }
            abortQueueWait();
        };

        const doSwitch = async () => {
            logger.debug('[interactive-remote]: switch');
            cancelPendingCompletion();
            cancelPendingInputWaits('cancelled');
            markTerminalInputBusy();
            if (transport.backend === 'pty') {
                sendSafeMessage(session, 'Claude interactive remote cannot switch to local attach from a PTY terminal.');
                return;
            }
            await unmountRemoteDisplay(true);
            const attachMessage = buildTmuxAttachMessage(transport.terminalId);
            const attachedLocally = await attachLocalTerminal(transport);
            if (!attachedLocally) {
                sendSafeMessage(session, attachMessage);
            }
            localAttachMode = true;
            detachTerminalOnCleanup = true;
            session.onModeChange('local');
            updateRuntimeMetadata(session, terminalMetadata('interactive', attachMessage));
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
        terminalSpawned = true;
        updateRuntimeMetadata(session, {
            ...terminalMetadata('interactive'),
            terminalId: spawnResult.terminalId,
        });
        mountRemoteDisplay({
            onExit: doExit,
            onSwitchToLocal: doSwitch,
        });

        session.consumeOneTimeFlags();

        let interactiveModeHash: string | null = null;
        while (!exitReason) {
            const batch = await session.queue.waitForMessagesAndGetAsString(waitController.signal);
            if (!batch) {
                if (continueAfterWaitAbort && !exitReason) {
                    continueAfterWaitAbort = false;
                    continue;
                }
                break;
            }

            interactiveModeHash ??= batch.hash;
            const validation = validateInteractiveBatch({
                batch,
                launchModeHash: interactiveModeHash,
            });
            if (!validation.ok) {
                cancelPendingCompletion();
                sendSafeMessage(session, validation.message);
                session.client.closeClaudeSessionTurn('failed');
                continue;
            }

            if (localAttachMode) {
                await detachLocalTerminal(transport);
                localAttachMode = false;
                detachTerminalOnCleanup = false;
                session.onModeChange('remote');
                updateRuntimeMetadata(session, terminalMetadata('interactive'));
                mountRemoteDisplay({
                    onExit: doExit,
                    onSwitchToLocal: doSwitch,
                });
            }

            cancelPendingCompletion();
            const writeGeneration = inputCancellationGeneration;
            const readiness = await waitForTerminalInputReady();
            if (writeGeneration !== inputCancellationGeneration || exitReason) {
                continue;
            }
            if (readiness === 'timeout') {
                cancelPendingCompletion();
                failCurrentTurnForInputNotReady();
                continue;
            }
            if (readiness !== 'ready') {
                continue;
            }
            cancelPendingCompletion();
            const payload = buildInteractivePaste(batch.message, transport.backend);
            const pendingPromptEcho = normalizePromptText(batch.message);
            pendingAppPromptEchoes.push(pendingPromptEcho);
            try {
                markTerminalInputBusy();
                await transport.paste(payload);
                if (transport.backend === 'tmux') {
                    await transport.enter();
                }
            } catch {
                removePendingAppPromptEcho(pendingAppPromptEchoes, pendingPromptEcho);
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
        await unmountRemoteDisplay(false);
        messageBuffer.clear();
        unsubscribeData?.();
        unsubscribeExit?.();
        session.client.rpcHandlerManager.registerHandler('abort', async () => { });
        session.client.rpcHandlerManager.registerHandler('switch', async () => { });
        removeTransportCleanupHook();

        if (scannerSessionCallback) {
            session.removeSessionFoundCallback(scannerSessionCallback);
        }

        session.onThinkingChange(false);
        await scanner?.cleanup();
        if (!detachTerminalOnCleanup) {
            await disposeTransport();
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

function withInteractivePermissionArgs(args: string[], permissionMode: string | undefined): string[] {
    if (permissionMode !== 'yolo' && permissionMode !== 'bypassPermissions') {
        return args;
    }
    if (args.includes(SKIP_PERMISSIONS_ARG)) {
        return args;
    }
    return [...args, SKIP_PERMISSIONS_ARG];
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
    return `Claude is running in tmux target ${terminalId}. Attach with: tmux attach -t ${terminalId}`;
}

async function attachLocalTerminal(transport: TerminalTransport): Promise<boolean> {
    const localAttachTransport = transport as LocalAttachTransport;
    if (typeof localAttachTransport.attachLocal !== 'function') {
        return false;
    }

    try {
        await localAttachTransport.attachLocal();
        return true;
    } catch {
        logger.debug('[interactive-remote]: local attach failed');
        return false;
    }
}

async function detachLocalTerminal(transport: TerminalTransport): Promise<void> {
    const localAttachTransport = transport as LocalAttachTransport;
    if (typeof localAttachTransport.detachLocal !== 'function') {
        return;
    }

    try {
        await localAttachTransport.detachLocal();
    } catch {
        logger.debug('[interactive-remote]: local detach failed');
    }
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

function suppressRemoteControlledUserPrompt(
    message: RawJSONLines,
    opts: {
        localAttachMode: boolean;
        pendingAppPromptEchoes: string[];
    },
): boolean {
    if (message.type !== 'user' || typeof message.message?.content !== 'string') {
        return false;
    }
    if (message.isSidechain) {
        return false;
    }
    if (opts.localAttachMode) {
        return false;
    }

    const matchIndex = findPendingAppPromptEchoIndex(opts.pendingAppPromptEchoes, message.message.content);
    if (matchIndex !== -1) {
        opts.pendingAppPromptEchoes.splice(matchIndex, 1);
    }

    return true;
}

function removePendingAppPromptEcho(pendingAppPromptEchoes: string[], prompt: string): void {
    const matchIndex = findPendingAppPromptEchoIndex(pendingAppPromptEchoes, prompt);
    if (matchIndex !== -1) {
        pendingAppPromptEchoes.splice(matchIndex, 1);
    }
}

function findPendingAppPromptEchoIndex(pendingAppPromptEchoes: string[], prompt: string): number {
    const normalizedPrompt = normalizePromptForEchoMatch(prompt);
    return pendingAppPromptEchoes.findIndex((pending) => normalizePromptForEchoMatch(pending) === normalizedPrompt);
}

function normalizePromptForEchoMatch(message: string): string {
    return normalizePromptText(message).trim();
}

function appendRemoteDisplayMessage(messageBuffer: MessageBuffer, message: RawJSONLines): void {
    const displayMessage = formatRemoteDisplayMessage(message);
    if (!displayMessage) {
        return;
    }

    messageBuffer.addMessage(displayMessage.content, displayMessage.type);
}

function formatRemoteDisplayMessage(message: RawJSONLines): { content: string; type: BufferedMessage['type'] } | null {
    if (message.type === 'summary') {
        return {
            type: 'result',
            content: truncateRemoteDisplayText(message.summary),
        };
    }

    if (message.type === 'system') {
        return {
            type: 'system',
            content: 'System event',
        };
    }

    if (message.type === 'user') {
        const content = extractRemoteDisplayText(message.message?.content);
        return content ? { type: 'user', content } : null;
    }

    if (message.type === 'assistant') {
        const content = extractRemoteDisplayText(message.message?.content);
        return content ? { type: 'assistant', content } : null;
    }

    const _: never = message satisfies never;
    return _;
}

function extractRemoteDisplayText(content: unknown): string | null {
    if (typeof content === 'string') {
        return truncateRemoteDisplayText(content);
    }

    if (!Array.isArray(content)) {
        return null;
    }

    const parts: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') {
            continue;
        }

        const record = block as Record<string, unknown>;
        if (typeof record.text === 'string') {
            parts.push(record.text);
            continue;
        }

        if (record.type === 'tool_use' && typeof record.name === 'string') {
            parts.push(`Tool: ${record.name}`);
            continue;
        }

        if (record.type === 'tool_result') {
            parts.push('Tool result');
        }
    }

    const text = parts.join('\n').trim();
    return text ? truncateRemoteDisplayText(text) : null;
}

function truncateRemoteDisplayText(text: string): string {
    const trimmed = text.trim();
    const maxLength = 2000;
    return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}
