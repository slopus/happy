import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClaudeRemote } = vi.hoisted(() => ({
    mockClaudeRemote: vi.fn(),
}));

vi.mock('./claudeRemote', () => ({
    claudeRemote: mockClaudeRemote,
}));

vi.mock('ink', () => ({
    render: vi.fn(() => ({ unmount: vi.fn() })),
}));

vi.mock('@/ui/ink/messageBuffer', () => ({
    MessageBuffer: class {
        addMessage = vi.fn();
        clear = vi.fn();
    },
}));

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({
    RemoteModeDisplay: vi.fn(),
}));

vi.mock('@/ui/messageFormatterInk', () => ({
    formatClaudeMessageForInk: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

vi.mock('@/utils/terminalStdinCleanup', () => ({
    cleanupStdinAfterInk: vi.fn(async () => {}),
}));

vi.mock('./utils/questionNotification', () => ({
    getAskUserQuestionToolCallIds: vi.fn(() => []),
}));

vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        handleToolCall = vi.fn();
        handleModeChange = vi.fn();
        isAborted = vi.fn(() => false);
        reset = vi.fn();
        setOnPermissionRequest = vi.fn();
        setPermissionModeUpdater = vi.fn();
        getResponses = vi.fn(() => new Map());
    },
}));

vi.mock('./utils/sdkToLogConverter', () => ({
    SDKToLogConverter: class {
        convert = vi.fn(() => null);
        convertSidechainUserMessage = vi.fn(() => null);
        generateInterruptedToolResult = vi.fn(() => null);
        resetParentChain = vi.fn();
        updateSessionId = vi.fn();
    },
}));

import { claudeRemoteLauncher } from './claudeRemoteLauncher';

function rejectOnAbort(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
        if (signal.aborted) {
            reject(new Error('aborted'));
            return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
}

function resolveOnAbort(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
    });
}

describe('claudeRemoteLauncher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('treats abort-triggered remote errors as cancelled turns', async () => {
        const handlers = new Map<string, (payload?: unknown) => Promise<void>>();
        const session = {
            sessionId: 'claude-session-1',
            path: '/tmp/project',
            allowedTools: [],
            mcpServers: {},
            hookSettingsPath: '/tmp/hook-settings.json',
            queue: {
                waitForMessagesAndGetAsString: vi.fn(),
                size: vi.fn(() => 0),
            },
            client: {
                sessionId: 'happy-session-1',
                sendClaudeSessionMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
                closeClaudeSessionTurn: vi.fn(),
                getMetadata: vi.fn(() => ({})),
                updateMetadata: vi.fn(),
                rpcHandlerManager: {
                    registerHandler: vi.fn((name: string, handler: (payload?: unknown) => Promise<void>) => {
                        handlers.set(name, handler);
                    }),
                },
            },
            api: {
                push: vi.fn(() => ({
                    sendSessionNotification: vi.fn(),
                })),
            },
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            clearSessionId: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
        };

        mockClaudeRemote
            .mockImplementationOnce(async (opts: { signal: AbortSignal }) => {
                await rejectOnAbort(opts.signal);
            })
            .mockImplementationOnce(async (opts: { signal: AbortSignal }) => {
                await resolveOnAbort(opts.signal);
            });

        const launcher = claudeRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(handlers.get('abort')).toBeDefined();
        });

        await handlers.get('abort')!({});

        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('cancelled');
        expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('failed');
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: 'Aborted by user' });
        expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'message', message: 'Process exited unexpectedly' });

        await vi.waitFor(() => {
            expect(mockClaudeRemote).toHaveBeenCalledTimes(2);
        });

        await handlers.get('switch')!({});

        await expect(launcher).resolves.toBe('switch');
    });
});
