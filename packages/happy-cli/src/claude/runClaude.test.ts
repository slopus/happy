import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
    mockApiClientCreate,
    mockCreateSessionScanner,
    mockLoop,
    mockNotifyDaemonSessionStarted,
    mockReadSettings,
    mockStartHappyServer,
    mockStartHookServer,
    mockRegisterKillSessionHandler,
} = vi.hoisted(() => ({
    mockApiClientCreate: vi.fn(),
    mockCreateSessionScanner: vi.fn(),
    mockLoop: vi.fn(),
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
        debug: vi.fn(),
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
import { getProjectPath } from './utils/path';

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
        delete process.env.CLAUDE_CONFIG_DIR;

        mockReadSettings.mockResolvedValue({
            machineId: 'machine-1',
            sandboxConfig: undefined,
        });
        mockNotifyDaemonSessionStarted.mockResolvedValue({});
        mockStartHappyServer.mockResolvedValue({
            url: 'http://127.0.0.1:12345',
            toolNames: ['change_title', 'send_image'],
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

    it('does not backfill the /paws attach command turn into the forked Happy session', async () => {
        const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happy-claude-config-'));
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
        process.env.HAPPY_FORK_CLAUDE_SESSION_ID = 'source-claude-session';

        const sourceProjectPath = getProjectPath(process.cwd());
        await mkdir(sourceProjectPath, { recursive: true });
        await writeFile(join(sourceProjectPath, 'source-claude-session.jsonl'), [
            JSON.stringify({
                type: 'user',
                uuid: 'u-before',
                timestamp: '2026-07-12T06:30:00.000Z',
                message: { role: 'user', content: '你是什么模型？' },
            }),
            JSON.stringify({
                type: 'assistant',
                uuid: 'a-before',
                timestamp: '2026-07-12T06:30:01.000Z',
                message: { role: 'assistant', content: [{ type: 'text', text: '我是 Claude。' }] },
            }),
            JSON.stringify({
                type: 'user',
                uuid: 'u-paws',
                timestamp: '2026-07-12T06:30:02.000Z',
                message: {
                    role: 'user',
                    content: '<command-message>paws</command-message>\n<command-name>/paws</command-name>',
                },
            }),
            JSON.stringify({
                type: 'assistant',
                uuid: 'a-paws-tool',
                timestamp: '2026-07-12T06:30:03.000Z',
                attributionSkill: 'paws',
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        id: 'toolu_paws',
                        name: 'Bash',
                        input: { command: 'happy attach --json' },
                    }],
                },
            }),
        ].join('\n'));

        const sentMessages: unknown[] = [];
        const sessionClient = {
            sessionId: 'happy-session-1',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn((message: unknown) => {
                sentMessages.push(message);
            }),
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
            startingMode: 'remote',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
        });

        expect(sentMessages).toHaveLength(2);
        expect(sentMessages).toEqual([
            expect.objectContaining({ uuid: 'u-before' }),
            expect.objectContaining({ uuid: 'a-before' }),
        ]);

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
        await rm(claudeConfigDir, { recursive: true, force: true });
    });

    it('does not forward terminal JSONL messages while local mode owns the transcript', async () => {
        const sentMessages: unknown[] = [];
        const sessionClient = {
            sessionId: 'happy-session-1',
            suppressNextArchiveSignal: vi.fn(),
            skipExistingMessages: vi.fn(),
            updateMetadata: vi.fn(),
            sendClaudeSessionMessage: vi.fn((message: unknown) => {
                sentMessages.push(message);
            }),
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
            expect(mockCreateSessionScanner).toHaveBeenCalled();
        });

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        scannerOptions.onMessage({
            type: 'user',
            uuid: 'local-owned-user',
            parentUuid: null,
            isSidechain: false,
            sessionId: 'claude-session-1',
            timestamp: new Date().toISOString(),
            message: {
                role: 'user',
                content: 'typed in local terminal',
            },
        });

        expect(sentMessages).toHaveLength(0);

        const loopOptions = mockLoop.mock.calls[0][0];
        loopOptions.onModeChange('remote');
        scannerOptions.onMessage({
            type: 'user',
            uuid: 'remote-terminal-user',
            parentUuid: null,
            isSidechain: false,
            sessionId: 'claude-session-1',
            timestamp: new Date().toISOString(),
            message: {
                role: 'user',
                content: 'typed in parallel remote terminal',
            },
        });

        expect(sentMessages).toHaveLength(1);
        expect(sessionClient.sendClaudeSessionMessage).toHaveBeenCalledWith(
            expect.objectContaining({ uuid: 'remote-terminal-user' }),
        );

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
    });

    it('serializes remote messages so /clear atomically discards an earlier in-flight PDF', async () => {
        const attachmentDir = await mkdtemp(join(tmpdir(), 'happy-clear-attachment-'));
        const attachmentPath = join(attachmentDir, 'queued.pdf');
        await writeFile(attachmentPath, '%PDF-1.7');

        const firstAttachments = createDeferred<any[]>();
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
            drainAttachmentsForUserMessage: vi.fn()
                .mockImplementationOnce(() => firstAttachments.promise)
                .mockResolvedValueOnce([]),
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
            startingMode: 'remote',
            shouldStartDaemon: false,
        });

        await vi.waitFor(() => {
            expect(mockLoop).toHaveBeenCalled();
            expect(sessionClient.onUserMessage).toHaveBeenCalled();
        });

        const onUserMessage = sessionClient.onUserMessage.mock.calls[0][0];
        const firstMessage = onUserMessage({ content: { text: 'read the PDF' } });
        const clearMessage = onUserMessage({ content: { text: '/clear' } });
        firstAttachments.resolve([{
            kind: 'file',
            localPath: attachmentPath,
            size: 8,
            mimeType: 'application/pdf',
            name: 'queued.pdf',
        }]);
        await Promise.all([firstMessage, clearMessage]);

        const messageQueue = mockLoop.mock.calls[0][0].messageQueue;
        expect(messageQueue.queue.map((item: { message: string }) => item.message)).toEqual(['/clear']);
        await expect(stat(attachmentPath)).rejects.toMatchObject({ code: 'ENOENT' });

        loopDeferred.resolve(0);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
        await expect(runPromise).rejects.toThrow('process.exit');
        exitSpy.mockRestore();
        await rm(attachmentDir, { recursive: true, force: true });
    });
});
