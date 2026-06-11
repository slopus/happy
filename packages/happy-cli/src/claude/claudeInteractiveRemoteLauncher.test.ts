import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnhancedMode } from './loop';
import type { TerminalDataHandler, TerminalExit, TerminalExitHandler, TerminalSpawnOptions, TerminalTransport } from './interactive/terminalTransport';
import type { InteractiveClaudeBatch } from './interactive/types';
import type { RawJSONLines } from './types';

const {
    mockBuildClaudeLocalCommand,
    mockClaudeLocal,
    mockClaudeRemote,
    mockCreateSessionScanner,
    mockCreateTerminalTransport,
    mockLoggerDebug,
    mockResolveInteractiveClaudeIdentity,
} = vi.hoisted(() => ({
    mockBuildClaudeLocalCommand: vi.fn(),
    mockClaudeLocal: vi.fn(),
    mockClaudeRemote: vi.fn(),
    mockCreateSessionScanner: vi.fn(),
    mockCreateTerminalTransport: vi.fn(),
    mockLoggerDebug: vi.fn(),
    mockResolveInteractiveClaudeIdentity: vi.fn(),
}));

vi.mock('./claudeLocalCommand', () => ({
    buildClaudeLocalCommand: mockBuildClaudeLocalCommand,
}));

vi.mock('./claudeLocal', () => ({
    claudeLocal: mockClaudeLocal,
}));

vi.mock('./claudeRemote', () => ({
    claudeRemote: mockClaudeRemote,
}));

vi.mock('./interactive/sessionIdentity', () => ({
    resolveInteractiveClaudeIdentity: mockResolveInteractiveClaudeIdentity,
}));

vi.mock('./interactive/terminalTransportFactory', () => ({
    createTerminalTransport: mockCreateTerminalTransport,
}));

vi.mock('./utils/sessionScanner', () => ({
    createSessionScanner: mockCreateSessionScanner,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: mockLoggerDebug,
        warn: vi.fn(),
    },
}));

import { claudeInteractiveRemoteLauncher } from './claudeInteractiveRemoteLauncher';

const initialMode: EnhancedMode = {
    permissionMode: 'default',
    model: 'opus',
    effort: 'medium',
};

describe('claudeInteractiveRemoteLauncher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockResolveInteractiveClaudeIdentity.mockReturnValue({
            claudeSessionId: 'claude-known-session',
            launchArgs: ['--session-id', 'claude-known-session'],
            consumedArgs: ['--model', 'opus'],
            mode: 'fresh',
        });
        mockBuildClaudeLocalCommand.mockResolvedValue({
            command: 'node',
            args: ['claude-launcher.cjs', '--session-id', 'claude-known-session'],
            cwd: '/tmp/project',
            env: { HAPPY_TEST: '1' },
            shell: false,
            cleanupSandbox: vi.fn(async () => { }),
        });
        mockCreateSessionScanner.mockResolvedValue({
            onNewSession: vi.fn(),
            cleanup: vi.fn(async () => { }),
        });
    });

    it('starts Claude in a terminal with a known Claude session id and does not invoke SDK launchers', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(transport.spawn).toHaveBeenCalledOnce();
        });

        expect(mockResolveInteractiveClaudeIdentity).toHaveBeenCalledWith({
            workingDirectory: '/tmp/project',
            claudeArgs: ['--model', 'opus'],
        });
        expect(mockBuildClaudeLocalCommand).toHaveBeenCalledWith({
            path: '/tmp/project',
            sessionArgs: ['--session-id', 'claude-known-session'],
            mcpServers: { happy: { type: 'http', url: 'http://happy.test' } },
            allowedTools: ['mcp__happy__change_title'],
            hookSettingsPath: '/tmp/hook-settings.json',
            claudeEnvVars: { CLAUDE_CONFIG_DIR: '/tmp/claude' },
            sandboxConfig: undefined,
        });
        expect(transport.spawn).toHaveBeenCalledWith({
            command: 'node',
            args: ['claude-launcher.cjs', '--session-id', 'claude-known-session'],
            cwd: '/tmp/project',
            env: { HAPPY_TEST: '1' },
            shell: false,
            windowName: 'happy-claude',
        } satisfies TerminalSpawnOptions);
        expect(session.onSessionFound).toHaveBeenCalledWith('claude-known-session');
        expect(mockClaudeLocal).not.toHaveBeenCalled();
        expect(mockClaudeRemote).not.toHaveBeenCalled();

        const snapshots = session.metadataSnapshots();
        expect(snapshots).toContainEqual(expect.objectContaining({
            claudeSessionId: 'claude-known-session',
            claudeRuntime: expect.objectContaining({
                kind: 'interactive',
                state: 'interactive',
                backend: 'tmux',
                capabilities: ['remote-control', 'local-attach'],
                claudeSessionId: 'claude-known-session',
                terminalId: 'tmux:happy-claude',
            }),
        }));
        expect(session.consumeOneTimeFlags).toHaveBeenCalledOnce();

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });
        transport.emitExit({ code: 0, signal: null });

        await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 0 });
        expect(transport.dispose).toHaveBeenCalledOnce();
    });

    it('registers the scanner callback and forwards raw Claude session messages including summaries', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const scanner = {
            onNewSession: vi.fn(),
            cleanup: vi.fn(async () => { }),
        };
        mockCreateSessionScanner.mockResolvedValue(scanner);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(mockCreateSessionScanner).toHaveBeenCalled();
        });

        expect(mockCreateSessionScanner).toHaveBeenCalledWith({
            sessionId: 'claude-known-session',
            workingDirectory: '/tmp/project',
            onMessage: expect.any(Function),
        });
        expect(session.addSessionFoundCallback).toHaveBeenCalledWith(expect.any(Function));
        expect(scanner.onNewSession).toHaveBeenCalledWith('claude-known-session');

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        const rawMessage = {
            type: 'assistant',
            uuid: 'assistant-message-1',
            message: {
                model: 'claude-opus',
            },
        } satisfies RawJSONLines;
        scannerOptions.onMessage(rawMessage);
        const summaryMessage = {
            type: 'summary',
            summary: 'Compacted conversation',
            leafUuid: 'assistant-message-1',
        } satisfies RawJSONLines;
        scannerOptions.onMessage(summaryMessage);

        expect(session.client.sendClaudeSessionMessage).toHaveBeenCalledWith(rawMessage);
        expect(session.client.sendClaudeSessionMessage).toHaveBeenCalledWith(summaryMessage);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });
        transport.emitExit({ code: 0, signal: null });

        await resultPromise;
        expect(session.removeSessionFoundCallback).toHaveBeenCalledWith(expect.any(Function));
        expect(scanner.cleanup).toHaveBeenCalledOnce();
    });

    it('rejects attachment batches before writing to the terminal', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'describe this',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
                attachments: [{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', name: 'image.png' }],
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
                type: 'message',
                message: 'Claude interactive remote does not support image or file attachments yet.',
            });
        });

        expect(transport.paste).not.toHaveBeenCalled();
        expect(transport.enter).not.toHaveBeenCalled();

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalledTimes(2);
        });
        transport.emitExit({ code: 0, signal: null });

        await resultPromise;
    });

    it('reports unsupported identity without creating a terminal transport', async () => {
        mockResolveInteractiveClaudeIdentity.mockReturnValue({
            mode: 'unsupported',
            error: 'No local Claude session found for --continue.',
        });
        const session = createSession();

        await expect(claudeInteractiveRemoteLauncher(session as any)).resolves.toEqual({
            type: 'exit',
            code: 1,
        });

        expect(mockCreateTerminalTransport).not.toHaveBeenCalled();
        expect(mockBuildClaudeLocalCommand).not.toHaveBeenCalled();
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'No local Claude session found for --continue.',
        });
        expect(session.metadataSnapshots()).toContainEqual(expect.objectContaining({
            claudeRuntime: expect.objectContaining({
                kind: 'interactive',
                state: 'unsupported',
                message: 'No local Claude session found for --continue.',
            }),
        }));
    });

    it('reports missing terminal transport as unsupported', async () => {
        mockCreateTerminalTransport.mockResolvedValue(null);
        const session = createSession();

        await expect(claudeInteractiveRemoteLauncher(session as any)).resolves.toEqual({
            type: 'exit',
            code: 1,
        });

        expect(mockBuildClaudeLocalCommand).not.toHaveBeenCalled();
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Claude interactive remote is not supported in this terminal environment.',
        });
        expect(session.metadataSnapshots()).toContainEqual(expect.objectContaining({
            claudeRuntime: expect.objectContaining({
                kind: 'interactive',
                state: 'unsupported',
            }),
        }));
    });

    it('does not pass raw caught errors into launcher diagnostics', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const rawError = new Error('secret /Users/devdvlive/.claude/session.jsonl');
        mockBuildClaudeLocalCommand.mockRejectedValue(rawError);
        const session = createSession();

        await expect(claudeInteractiveRemoteLauncher(session as any)).resolves.toEqual({
            type: 'exit',
            code: 1,
        });

        expect(mockLoggerDebug).not.toHaveBeenCalledWith('[interactive-remote]: launch error', rawError);
        expect(mockLoggerDebug).toHaveBeenCalledWith('[interactive-remote]: launch error');
    });
});

class FakeTerminalTransport implements TerminalTransport {
    readonly capabilities: readonly ('remote-control' | 'local-attach')[];
    terminalId: string | null = null;

    readonly spawn = vi.fn(async (_options: TerminalSpawnOptions) => {
        this.terminalId = `${this.backend}:happy-claude`;
        return { pid: 123, terminalId: this.terminalId };
    });
    readonly paste = vi.fn(async (_text: string) => { });
    readonly enter = vi.fn(async () => { });
    readonly interrupt = vi.fn(async () => { });
    readonly resize = vi.fn(async (_cols: number, _rows: number) => { });
    readonly dispose = vi.fn(async () => { });

    private dataHandlers = new Set<TerminalDataHandler>();
    private exitHandlers = new Set<TerminalExitHandler>();

    constructor(readonly backend: 'tmux' | 'pty') {
        this.capabilities = backend === 'tmux' ? ['remote-control', 'local-attach'] : ['remote-control'];
    }

    onData(handler: TerminalDataHandler): () => void {
        this.dataHandlers.add(handler);
        return () => {
            this.dataHandlers.delete(handler);
        };
    }

    onExit(handler: TerminalExitHandler): () => void {
        this.exitHandlers.add(handler);
        return () => {
            this.exitHandlers.delete(handler);
        };
    }

    emitData(data: string): void {
        for (const handler of this.dataHandlers) {
            handler(data);
        }
    }

    emitExit(exit: TerminalExit): void {
        for (const handler of this.exitHandlers) {
            handler(exit);
        }
    }
}

function createSession(opts: { batches?: InteractiveClaudeBatch[] } = {}) {
    let metadata: Record<string, unknown> = {};
    const snapshots: Record<string, unknown>[] = [];
    const batches = [...(opts.batches ?? [])];
    const sessionFoundCallbacks: Array<(sessionId: string) => void> = [];

    const session = {
        sessionId: null as string | null,
        path: '/tmp/project',
        initialMode,
        claudeEnvVars: { CLAUDE_CONFIG_DIR: '/tmp/claude' },
        claudeArgs: ['--model', 'opus'],
        mcpServers: { happy: { type: 'http', url: 'http://happy.test' } },
        allowedTools: ['mcp__happy__change_title'],
        hookSettingsPath: '/tmp/hook-settings.json',
        sandboxConfig: undefined,
        client: {
            sendClaudeSessionMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            closeClaudeSessionTurn: vi.fn(),
            updateMetadata: vi.fn((handler: (current: any) => any) => {
                metadata = handler(metadata);
                snapshots.push(structuredClone(metadata));
            }),
            getMetadata: vi.fn(() => metadata),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
        },
        queue: {
            modeHasher: vi.fn(() => 'initial-mode-hash'),
            waitForMessagesAndGetAsString: vi.fn(async (signal?: AbortSignal) => {
                const next = batches.shift();
                if (next) {
                    return next;
                }
                if (signal?.aborted) {
                    return null;
                }
                return new Promise<InteractiveClaudeBatch | null>((resolve) => {
                    signal?.addEventListener('abort', () => resolve(null), { once: true });
                });
            }),
            reset: vi.fn(() => {
                batches.length = 0;
            }),
            size: vi.fn(() => batches.length),
            setOnMessage: vi.fn(),
        },
        addSessionFoundCallback: vi.fn((callback: (sessionId: string) => void) => {
            sessionFoundCallbacks.push(callback);
        }),
        removeSessionFoundCallback: vi.fn((callback: (sessionId: string) => void) => {
            const index = sessionFoundCallbacks.indexOf(callback);
            if (index >= 0) {
                sessionFoundCallbacks.splice(index, 1);
            }
        }),
        onSessionFound: vi.fn((sessionId: string) => {
            session.sessionId = sessionId;
            for (const callback of sessionFoundCallbacks) {
                callback(sessionId);
            }
        }),
        onThinkingChange: vi.fn(),
        onAbort: vi.fn(),
        consumeOneTimeFlags: vi.fn(),
        metadataSnapshots: () => snapshots,
    };

    return session;
}
