import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockApiClientCreate,
    mockCreateSessionScanner,
    mockLoop,
    mockLoggerDebug,
    mockNotifyDaemonSessionStarted,
    mockReadSettings,
    mockStartHappyServer,
    mockStartHookServer,
    mockRegisterKillSessionHandler,
} = vi.hoisted(() => ({
    mockApiClientCreate: vi.fn(),
    mockCreateSessionScanner: vi.fn(),
    mockLoop: vi.fn(),
    mockLoggerDebug: vi.fn(),
    mockNotifyDaemonSessionStarted: vi.fn(),
    mockReadSettings: vi.fn(),
    mockStartHappyServer: vi.fn(),
    mockStartHookServer: vi.fn(),
    mockRegisterKillSessionHandler: vi.fn(),
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: mockApiClientCreate,
    },
}));

vi.mock('@/persistence', () => ({
    readSettings: mockReadSettings,
}));

vi.mock('@/claude/utils/sessionScanner', () => ({
    createSessionScanner: mockCreateSessionScanner,
}));

vi.mock('@/claude/loop', () => ({
    loop: mockLoop,
}));

vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionStarted: mockNotifyDaemonSessionStarted,
}));

vi.mock('@/daemon/run', () => ({
    initialMachineMetadata: {},
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: mockStartHappyServer,
}));

vi.mock('@/claude/utils/startHookServer', () => ({
    startHookServer: mockStartHookServer,
}));

vi.mock('@/claude/utils/generateHookSettings', () => ({
    generateHookSettingsFile: vi.fn(() => '/tmp/happy-hook-settings.json'),
    cleanupHookSettingsFile: vi.fn(),
}));

vi.mock('./registerKillSessionHandler', () => ({
    registerKillSessionHandler: mockRegisterKillSessionHandler,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: mockLoggerDebug,
        debugLargeJson: vi.fn(),
        infoDeveloper: vi.fn(),
    },
}));

vi.mock('@/ui/doctor', () => ({
    getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
    connectionState: {
        setBackend: vi.fn(),
        notifyOffline: vi.fn(),
        fail: vi.fn(),
    },
    startOfflineReconnection: vi.fn(),
}));

vi.mock('@/claude/claudeLocal', () => ({
    claudeLocal: vi.fn(),
}));

import { runClaude } from './runClaude';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('runClaude remote JSONL scanner', () => {
    const processEvents = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;
    const originalListeners = new Map<string, Array<(...args: any[]) => void>>();

    beforeEach(() => {
        vi.clearAllMocks();
        for (const event of processEvents) {
            originalListeners.set(event, process.listeners(event as any) as Array<(...args: any[]) => void>);
        }

        delete process.env.HAPPY_RECONNECT_SESSION_ID;
        delete process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
        delete process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT;
        delete process.env.HAPPY_RECONNECT_SEQ;
        delete process.env.HAPPY_RECONNECT_METADATA_VERSION;
        delete process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;
        delete process.env.HAPPY_FORKED_FROM_SESSION_ID;
        delete process.env.HAPPY_FORKED_FROM_MESSAGE_ID;
        delete process.env.HAPPY_FORK_CLAUDE_SESSION_ID;

        mockReadSettings.mockResolvedValue({
            machineId: 'machine-1',
            sandboxConfig: undefined,
        });
        mockNotifyDaemonSessionStarted.mockResolvedValue({});
        mockStartHappyServer.mockResolvedValue({
            url: 'http://127.0.0.1:12345',
            toolNames: ['change_title'],
            stop: vi.fn(),
        });
        mockStartHookServer.mockResolvedValue({
            port: 23456,
            stop: vi.fn(),
        });
        mockCreateSessionScanner.mockResolvedValue({
            onNewSession: vi.fn(),
            cleanup: vi.fn(),
        });
    });

    afterEach(() => {
        for (const [event, listeners] of originalListeners) {
            process.removeAllListeners(event as any);
            for (const listener of listeners) {
                process.on(event as any, listener);
            }
        }
        originalListeners.clear();
    });

    it('does not start the SDK-era remote JSONL scanner for interactive Claude remote', async () => {
        const sessionClient = {
            sessionId: 'happy-session-1',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            onUserMessage: vi.fn(),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            getMetadata: vi.fn(() => ({})),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-1',
                seq: 0,
                metadata: {},
                metadataVersion: 0,
                agentState: {},
                agentStateVersion: 0,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientCreate.mockResolvedValue(api);

        const loopDeferred = createDeferred<number>();
        mockLoop.mockReturnValue(loopDeferred.promise);

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'local',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
        });

        expect(mockCreateSessionScanner).not.toHaveBeenCalled();

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    });

    it('passes /skills through to Claude when the remote runtime is interactive', async () => {
        let onUserMessage: ((message: any) => Promise<void>) | undefined;
        const sessionClient = {
            sessionId: 'happy-session-1',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            onUserMessage: vi.fn((handler) => { onUserMessage = handler; }),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            getMetadata: vi.fn(() => ({
                claudeRuntime: {
                    kind: 'interactive',
                    state: 'interactive',
                    backend: 'tmux',
                },
            })),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-1',
                seq: 0,
                metadata: {},
                metadataVersion: 0,
                agentState: {},
                agentStateVersion: 0,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientCreate.mockResolvedValue(api);

        const loopDeferred = createDeferred<number>();
        mockLoop.mockReturnValue(loopDeferred.promise);

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'remote',
            shouldStartDaemon: false,
        });

        let assertionError: unknown;
        try {
            await vi.waitFor(() => {
                expect(mockLoop).toHaveBeenCalled();
                expect(onUserMessage).toBeDefined();
            });

            await onUserMessage!({
                role: 'user',
                content: { type: 'text', text: '/skills ' },
                meta: { sentFrom: 'web' },
            });

            const queue = mockLoop.mock.calls[0][0].messageQueue;
            expect(sessionClient.sendClaudeSessionMessage).not.toHaveBeenCalled();
            expect(queue.size()).toBe(1);
            const queued = await queue.waitForMessagesAndGetAsString();
            expect(queued?.message).toBe('/skills ');
            expect(queued?.isolate).toBe(false);
        } catch (error) {
            assertionError = error;
        }

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();

        if (assertionError) {
            throw assertionError;
        }
    });

    it('does not log raw attachment details while preparing Claude batches', async () => {
        const sessionClient = {
            sessionId: 'happy-session-1',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            onUserMessage: vi.fn(),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(async () => {
                throw new Error('secret /Users/devdvlive/cache/raw-image.png ref-sensitive');
            }),
            getMetadata: vi.fn(() => ({})),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => {}),
            close: vi.fn(async () => {}),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-1',
                seq: 0,
                metadata: {},
                metadataVersion: 0,
                agentState: {},
                agentStateVersion: 0,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => {}),
        };
        mockApiClientCreate.mockResolvedValue(api);

        const loopDeferred = createDeferred<number>();
        mockLoop.mockReturnValue(loopDeferred.promise);

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'remote',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(sessionClient.onFileEvent).toHaveBeenCalledWith(expect.any(Function));
        });

        const onFileEvent = sessionClient.onFileEvent.mock.calls[0][0];
        onFileEvent({
            role: 'session',
            content: {
                type: 'session',
                data: {
                    id: 'file-event-1',
                    time: 1,
                    role: 'user',
                    ev: {
                        t: 'file',
                        ref: 'ref-sensitive',
                        name: 'raw-image.png',
                        size: 987654321,
                        mimeType: 'image/png',
                    },
                },
            },
        });

        const trackedPromise = sessionClient.trackAttachmentDownload.mock.calls[0][0];
        await trackedPromise;

        const debugOutput = mockLoggerDebug.mock.calls
            .flat()
            .map((value) => typeof value === 'string' ? value : JSON.stringify(value))
            .join('\n');
        expect(debugOutput).toContain('[loop] Failed to download attachment');
        expect(debugOutput).not.toContain('raw-image.png');
        expect(debugOutput).not.toContain('ref-sensitive');
        expect(debugOutput).not.toContain('987654321');
        expect(debugOutput).not.toContain('/Users/devdvlive/cache');

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    });

    it('waits for the active session cleanup before exiting from kill-session cleanup', async () => {
        const sessionClient = {
            sessionId: 'happy-session-1',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            onUserMessage: vi.fn(),
            onFileEvent: vi.fn(),
            on: vi.fn(),
            trackAttachmentDownload: vi.fn(),
            drainAttachmentsForUserMessage: vi.fn(async () => []),
            downloadAndDecryptAttachment: vi.fn(),
            getMetadata: vi.fn(() => ({})),
            sendSessionEvent: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            sendSessionDeath: vi.fn(),
            flush: vi.fn(async () => { }),
            close: vi.fn(async () => { }),
        };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-1',
                seq: 0,
                metadata: {},
                metadataVersion: 0,
                agentState: {},
                agentStateVersion: 0,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => { }),
        };
        mockApiClientCreate.mockResolvedValue(api);

        const loopDeferred = createDeferred<number>();
        const cleanupDeferred = createDeferred<void>();
        const activeSession = {
            cleanup: vi.fn(() => cleanupDeferred.promise),
        };
        mockLoop.mockImplementation(async (opts: any) => {
            opts.onSessionReady(activeSession);
            return loopDeferred.promise;
        });

        const runPromise = runClaude({
            token: 'token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        } as any, {
            startingMode: 'remote',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockRegisterKillSessionHandler).toHaveBeenCalled();
        });

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        const cleanupPromise = mockRegisterKillSessionHandler.mock.calls[0][1]();

        await vi.waitFor(() => {
            expect(activeSession.cleanup).toHaveBeenCalledOnce();
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(exitSpy).not.toHaveBeenCalled();
        expect(api.deactivateSession).not.toHaveBeenCalled();
        expect(sessionClient.sendSessionDeath).not.toHaveBeenCalled();

        cleanupDeferred.resolve();
        await expect(cleanupPromise).rejects.toThrow('process.exit');
        expect(exitSpy).toHaveBeenCalledWith(0);

        loopDeferred.resolve(0);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    });
});
