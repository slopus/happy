import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    execSync: vi.fn(),
    getOrCreateMachine: vi.fn(),
    getOrCreateSession: vi.fn(),
    notifyDaemonSessionStarted: vi.fn(),
    readSettings: vi.fn(),
    launchNativeCodex: vi.fn(),
    startHappyServer: vi.fn(),
    remoteClient: {
        sandboxEnabled: false,
        setApprovalHandler: vi.fn(),
        setEventHandler: vi.fn(),
        connect: vi.fn(),
        hasActiveThread: vi.fn(),
        startThread: vi.fn(),
        resumeThread: vi.fn(),
        sendTurnAndWait: vi.fn(),
        disconnect: vi.fn(),
        abortTurnWithFallback: vi.fn(),
    },
    render: vi.fn(),
    renderedElement: null as null | {
        type: unknown;
        props: Record<string, unknown>;
    },
    reconnectionCancel: vi.fn(),
    userMessageHandler: null as null | ((message: {
        content: { text: string };
        meta?: Record<string, unknown>;
    }) => void),
    queuedMessages: [] as Array<{ message: string; mode: unknown }>,
    session: {
        rpcHandlerManager: {
            registerHandler: vi.fn(),
        },
        onUserMessage: vi.fn(),
        keepAlive: vi.fn(),
        getMetadata: vi.fn(),
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn(),
        sendSessionEvent: vi.fn(),
        sendSessionProtocolMessage: vi.fn(),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
        sessionId: 'happy-session-1',
    },
}));

vi.mock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    execSync: mocks.execSync,
}));

vi.mock('ink', () => ({
    render: mocks.render,
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({
            getOrCreateMachine: mocks.getOrCreateMachine,
            getOrCreateSession: mocks.getOrCreateSession,
            push: vi.fn(() => ({
                sendSessionNotification: vi.fn(),
            })),
        })),
    },
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/persistence')>()),
    readSettings: mocks.readSettings,
}));

vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionStarted: mocks.notifyDaemonSessionStarted,
}));

vi.mock('@/utils/setupOfflineReconnection', () => ({
    setupOfflineReconnection: vi.fn(() => ({
        session: mocks.session,
        reconnectionHandle: { cancel: mocks.reconnectionCancel },
    })),
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: mocks.startHappyServer,
}));

vi.mock('@/utils/MessageQueue2', () => ({
    MessageQueue2: class<T> {
        constructor(private readonly modeHasher: (mode: T) => string) {}
        push(message: string, mode: T) {
            mocks.queuedMessages.push({ message, mode });
        }
        async waitForMessagesAndGetAsString() {
            const item = mocks.queuedMessages.shift();
            if (!item) return null;
            return {
                message: item.message,
                mode: item.mode,
                isolate: false,
                hash: this.modeHasher(item.mode as T),
            };
        }
        size() {
            return mocks.queuedMessages.length;
        }
    },
}));

vi.mock('./codexAppServerClient', () => ({
    CodexAppServerClient: vi.fn(() => mocks.remoteClient),
}));

vi.mock('./codexLocalLauncher', () => ({
    launchNativeCodex: mocks.launchNativeCodex,
}));

import { runCodex } from './runCodex';

describe('runCodex local start', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readSettings.mockResolvedValue({ machineId: 'machine-1' });
        mocks.getOrCreateSession.mockResolvedValue({
            id: 'happy-session-1',
            seq: 1,
            encryptionKey: new Uint8Array([1, 2, 3]),
            encryptionVariant: 'legacy',
            metadata: {},
            metadataVersion: 1,
            agentState: {},
            agentStateVersion: 1,
        });
        mocks.notifyDaemonSessionStarted.mockResolvedValue({});
        mocks.launchNativeCodex.mockResolvedValue({ type: 'exit', code: 4 });
        mocks.startHappyServer.mockResolvedValue({
            url: 'http://127.0.0.1:3005',
            stop: vi.fn(),
        });
        mocks.queuedMessages = [];
        mocks.userMessageHandler = null;
        mocks.remoteClient.connect.mockResolvedValue(undefined);
        let hasActiveThread = false;
        mocks.remoteClient.hasActiveThread.mockImplementation(() => hasActiveThread);
        mocks.remoteClient.startThread.mockResolvedValue({ threadId: 'thread-remote', model: 'gpt-test' });
        mocks.remoteClient.resumeThread.mockImplementation(async () => {
            hasActiveThread = true;
            return { threadId: 'thread-discovered', model: 'gpt-test' };
        });
        mocks.remoteClient.sendTurnAndWait.mockResolvedValue({ aborted: false });
        mocks.remoteClient.disconnect.mockResolvedValue(undefined);
        mocks.remoteClient.abortTurnWithFallback.mockResolvedValue({ forcedRestart: false });
        mocks.render.mockImplementation((element) => {
            mocks.renderedElement = element;
            return { unmount: vi.fn() };
        });
        mocks.renderedElement = null;
        mocks.session.getMetadata.mockReturnValue({});
        mocks.session.onUserMessage.mockImplementation((handler) => {
            mocks.userMessageHandler = handler;
        });
        mocks.session.updateAgentState.mockImplementation((updater) => updater({}));
        mocks.session.updateMetadata.mockImplementation((updater) => updater({}));
        mocks.session.flush.mockResolvedValue(undefined);
        mocks.session.close.mockResolvedValue(undefined);
    });

    it('launches native Codex and exits with its code for terminal local mode', async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
            throw new Error(`exit:${code}`);
        }) as never);

        await expect(runCodex({
            credentials: { token: 'token' } as never,
            startedBy: 'terminal',
            startingMode: 'local',
            resumeThreadId: 'thread-123',
            startupModel: 'gpt-5.5',
            startupEffort: 'medium',
            startupPermissionMode: 'yolo',
        })).rejects.toThrow('exit:4');

        expect(mocks.session.keepAlive).toHaveBeenCalledWith(false, 'local');
        expect(mocks.session.updateAgentState).toHaveBeenCalled();
        expect(mocks.session.updateMetadata).toHaveBeenCalledWith(expect.any(Function));
        expect(mocks.launchNativeCodex).toHaveBeenCalledWith(expect.objectContaining({
            cwd: process.cwd(),
            codexHomeDir: undefined,
            codexThreadId: 'thread-123',
            sandboxConfig: undefined,
            model: 'gpt-5.5',
            effort: 'medium',
            permissionMode: 'yolo',
            onThreadIdDiscovered: expect.any(Function),
            onTerminateReady: expect.any(Function),
        }));
        expect(mocks.session.sendSessionDeath).toHaveBeenCalled();
        expect(mocks.session.flush).toHaveBeenCalled();
        expect(mocks.session.close).toHaveBeenCalled();
        expect(exit).toHaveBeenCalledWith(4);

        exit.mockRestore();
    });

    it('passes configured Happy sandbox settings to native Codex', async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
            throw new Error(`exit:${code}`);
        }) as never);
        const sandboxConfig = {
            enabled: true,
            network: { enabled: false },
            filesystem: { read: [], write: [] },
        };
        mocks.readSettings.mockResolvedValue({ machineId: 'machine-1', sandboxConfig });

        await expect(runCodex({
            credentials: { token: 'token' } as never,
            startedBy: 'terminal',
            startingMode: 'local',
        })).rejects.toThrow('exit:4');

        expect(mocks.launchNativeCodex).toHaveBeenCalledWith(expect.objectContaining({
            sandboxConfig,
        }));

        exit.mockRestore();
    });

    it('surfaces native Codex discovery failures as Happy session messages', async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
            throw new Error(`exit:${code}`);
        }) as never);
        mocks.launchNativeCodex.mockRejectedValue(new Error('Ambiguous Codex thread discovery for cwd /tmp/project: one, two'));

        await expect(runCodex({
            credentials: { token: 'token' } as never,
            startedBy: 'terminal',
            startingMode: 'local',
        })).rejects.toThrow('exit:1');

        expect(mocks.session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('Ambiguous Codex thread discovery'),
        });
        expect(exit).toHaveBeenCalledWith(1);

        exit.mockRestore();
    });

    it('persists a discovered Codex thread id after a fresh local session', async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
            throw new Error(`exit:${code}`);
        }) as never);
        mocks.launchNativeCodex.mockResolvedValue({
            type: 'exit',
            code: 0,
            codexThreadId: 'thread-discovered',
        });

        await expect(runCodex({
            credentials: { token: 'token' } as never,
            startedBy: 'terminal',
            startingMode: 'local',
        })).rejects.toThrow('exit:0');

        const metadataUpdater = mocks.session.updateMetadata.mock.calls
            .map((call) => call[0])
            .find((updater) => typeof updater === 'function' && updater({}).codexThreadId === 'thread-discovered');
        expect(metadataUpdater).toBeDefined();

        exit.mockRestore();
    });

    it('requests local handoff when a user message arrives during local mode', async () => {
        const handoffCalls: string[] = [];
        mocks.launchNativeCodex.mockImplementation(async (opts) => {
            opts.onLocalHandoffReady(() => {
                handoffCalls.push('handoff');
            });
            opts.onThreadIdDiscovered('thread-discovered');
            mocks.userMessageHandler?.({
                content: { text: 'mobile prompt' },
                meta: {},
            });
            return { type: 'switch', codexThreadId: 'thread-discovered' };
        });

        await expect(runCodex({
            credentials: { token: 'token' } as never,
            startedBy: 'terminal',
            startingMode: 'local',
        })).resolves.toBeUndefined();

        expect(handoffCalls).toEqual(['handoff']);
        expect(mocks.session.keepAlive).toHaveBeenCalledWith(false, 'remote');
        expect(mocks.remoteClient.resumeThread).toHaveBeenCalledWith(expect.objectContaining({
            threadId: 'thread-discovered',
        }));
        expect(mocks.remoteClient.startThread).not.toHaveBeenCalled();
        expect(mocks.remoteClient.sendTurnAndWait).toHaveBeenCalledWith(
            expect.stringContaining('mobile prompt'),
            expect.any(Object),
        );
    });

    it('requests handoff for a user message queued before local handoff is registered', async () => {
        const handoffCalls: string[] = [];
        mocks.session.onUserMessage.mockImplementation((handler) => {
            mocks.userMessageHandler = handler;
            handler({
                content: { text: 'early mobile prompt' },
                meta: {},
            });
        });
        mocks.launchNativeCodex.mockImplementation(async (opts) => {
            opts.onThreadIdDiscovered('thread-discovered');
            opts.onLocalHandoffReady(() => {
                handoffCalls.push('handoff');
            });
            return { type: 'switch', codexThreadId: 'thread-discovered' };
        });

        await expect(runCodex({
            credentials: { token: 'token' } as never,
            startedBy: 'terminal',
            startingMode: 'local',
        })).resolves.toBeUndefined();

        expect(handoffCalls).toEqual(['handoff']);
        expect(mocks.remoteClient.resumeThread).toHaveBeenCalledWith(expect.objectContaining({
            threadId: 'thread-discovered',
        }));
        expect(mocks.remoteClient.sendTurnAndWait).toHaveBeenCalledWith(
            expect.stringContaining('early mobile prompt'),
            expect.any(Object),
        );
    });

    it('switches terminal remote mode back to native Codex with the active thread id', async () => {
        const stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
        const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
        const setRawMode = process.stdin.setRawMode;
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
            throw new Error(`exit:${code}`);
        }) as never);
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
        process.stdin.setRawMode = vi.fn() as never;

        mocks.remoteClient.hasActiveThread.mockReturnValue(false);
        mocks.remoteClient.startThread.mockResolvedValue({ threadId: 'thread-started', model: 'gpt-test' });
        mocks.remoteClient.sendTurnAndWait.mockImplementation(async () => {
            const onSwitchToLocal = mocks.renderedElement?.props.onSwitchToLocal;
            if (typeof onSwitchToLocal !== 'function') {
                throw new Error('missing onSwitchToLocal');
            }
            await onSwitchToLocal();
            return { aborted: true };
        });
        mocks.launchNativeCodex.mockResolvedValue({ type: 'exit', code: 0, codexThreadId: 'thread-started' });
        mocks.session.onUserMessage.mockImplementation((handler) => {
            mocks.userMessageHandler = handler;
            handler({
                content: { text: 'remote prompt' },
                meta: {},
            });
        });

        try {
            await expect(runCodex({
                credentials: { token: 'token' } as never,
                startedBy: 'terminal',
                startingMode: 'remote',
            })).rejects.toThrow('exit:0');

            expect(mocks.remoteClient.startThread).toHaveBeenCalled();
            expect(mocks.remoteClient.abortTurnWithFallback).toHaveBeenCalled();
            expect(mocks.launchNativeCodex).toHaveBeenCalledWith(expect.objectContaining({
                codexThreadId: 'thread-started',
            }));
        } finally {
            if (stdoutIsTTY) {
                Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTY);
            }
            if (stdinIsTTY) {
                Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
            }
            process.stdin.setRawMode = setRawMode;
            exit.mockRestore();
        }
    });

    it('restarts remote mode when a mobile message arrives after terminal switch-back', async () => {
        const stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
        const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
        const setRawMode = process.stdin.setRawMode;
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
        process.stdin.setRawMode = vi.fn() as never;

        let sendCount = 0;
        mocks.remoteClient.hasActiveThread.mockReturnValue(false);
        mocks.remoteClient.startThread.mockResolvedValue({ threadId: 'thread-started', model: 'gpt-test' });
        mocks.remoteClient.sendTurnAndWait.mockImplementation(async () => {
            sendCount += 1;
            if (sendCount === 1) {
                const onSwitchToLocal = mocks.renderedElement?.props.onSwitchToLocal;
                if (typeof onSwitchToLocal !== 'function') {
                    throw new Error('missing onSwitchToLocal');
                }
                await onSwitchToLocal();
                return { aborted: true };
            }
            return { aborted: false };
        });
        mocks.launchNativeCodex.mockImplementation(async (opts) => {
            opts.onLocalHandoffReady(() => undefined);
            mocks.userMessageHandler?.({
                content: { text: 'second mobile prompt' },
                meta: {},
            });
            return { type: 'switch', codexThreadId: 'thread-started' };
        });
        mocks.session.onUserMessage.mockImplementation((handler) => {
            mocks.userMessageHandler = handler;
            handler({
                content: { text: 'first remote prompt' },
                meta: {},
            });
        });

        try {
            await expect(runCodex({
                credentials: { token: 'token' } as never,
                startedBy: 'terminal',
                startingMode: 'remote',
            })).resolves.toBeUndefined();

            expect(mocks.remoteClient.connect).toHaveBeenCalledTimes(2);
            expect(mocks.startHappyServer).toHaveBeenCalledTimes(2);
            expect(mocks.launchNativeCodex).toHaveBeenCalledWith(expect.objectContaining({
                codexThreadId: 'thread-started',
            }));
            expect(mocks.remoteClient.resumeThread).toHaveBeenCalledWith(expect.objectContaining({
                threadId: 'thread-started',
            }));
            expect(mocks.remoteClient.sendTurnAndWait).toHaveBeenNthCalledWith(
                2,
                'second mobile prompt',
                expect.any(Object),
            );
        } finally {
            if (stdoutIsTTY) {
                Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTY);
            }
            if (stdinIsTTY) {
                Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
            }
            process.stdin.setRawMode = setRawMode;
        }
    });
});
