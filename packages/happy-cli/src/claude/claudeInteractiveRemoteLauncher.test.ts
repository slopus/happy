import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    mockInkRender,
    mockLoggerDebug,
    mockResolveInteractiveClaudeIdentity,
} = vi.hoisted(() => ({
    mockBuildClaudeLocalCommand: vi.fn(),
    mockClaudeLocal: vi.fn(),
    mockClaudeRemote: vi.fn(),
    mockCreateSessionScanner: vi.fn(),
    mockCreateTerminalTransport: vi.fn(),
    mockInkRender: vi.fn(),
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

vi.mock('ink', () => ({
    render: mockInkRender,
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

const stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdinSetRawMode = (process.stdin as any).setRawMode;
const stdinResume = process.stdin.resume;
const stdinPause = process.stdin.pause;
const stdinSetEncoding = process.stdin.setEncoding;

describe('claudeInteractiveRemoteLauncher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        restoreTTY();
        mockInkRender.mockReturnValue({
            unmount: vi.fn(),
        });
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
            flush: vi.fn(async () => { }),
            cleanup: vi.fn(async () => { }),
        });
    });

    afterEach(() => {
        restoreTTY();
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
        expect(transport.spawn).toHaveBeenCalledWith(expect.objectContaining({
            command: 'node',
            args: ['claude-launcher.cjs', '--session-id', 'claude-known-session'],
            cwd: '/tmp/project',
            env: { HAPPY_TEST: '1' },
            shell: false,
            windowName: expect.stringMatching(/^happy-claude-[A-Za-z0-9_-]+$/),
        }));
        const spawnOptions = transport.spawn.mock.calls[0][0];
        expect(spawnOptions.windowName).not.toBe('happy-claude');
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
                terminalId: expect.stringMatching(/^tmux:happy-claude-[A-Za-z0-9_-]+$/),
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

    it('launches interactive Claude with skipped permissions when the session starts in yolo mode', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            initialMode: {
                ...initialMode,
                permissionMode: 'yolo',
            },
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(mockBuildClaudeLocalCommand).toHaveBeenCalled();
        });

        expect(mockBuildClaudeLocalCommand).toHaveBeenCalledWith(expect.objectContaining({
            sessionArgs: ['--session-id', 'claude-known-session', '--dangerously-skip-permissions'],
        }));

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('registers the scanner callback and forwards raw Claude session messages including summaries', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const scanner = {
            onNewSession: vi.fn(),
            flush: vi.fn(async () => { }),
            cleanup: vi.fn(async () => { }),
        };
        mockCreateSessionScanner.mockResolvedValue(scanner);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(mockCreateSessionScanner).toHaveBeenCalled();
        });

        expect(mockCreateSessionScanner).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'claude-known-session',
            workingDirectory: '/tmp/project',
            onMessage: expect.any(Function),
            onTranscriptMissing: expect.any(Function),
        }));
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

    it('uses the first queued batch hash as the interactive mode baseline', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'hello with launch-time append prompt',
                mode: {
                    ...initialMode,
                    appendSystemPrompt: '# Options',
                },
                hash: 'first-web-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });
        expect(transport.paste).not.toHaveBeenCalled();
        transport.emitData('❯ ');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('hello with launch-time append prompt\r');
        });
        expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith({
            type: 'message',
            message: 'Claude interactive remote cannot change model, effort, tools, prompts, or sandbox settings inside a running session.',
        });

        session.enqueueBatch({
            message: 'changed settings later',
            mode: {
                ...initialMode,
                appendSystemPrompt: '# Different options',
            },
            hash: 'changed-mode-hash',
            isolate: false,
        });

        await vi.waitFor(() => {
            expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
                type: 'message',
                message: 'Claude interactive remote cannot change model, effort, tools, prompts, or sandbox settings inside a running session.',
            });
        });
        expect(transport.paste).toHaveBeenCalledTimes(1);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalledTimes(3);
        });
        transport.emitExit({ code: 0, signal: null });

        await resultPromise;
    });

    it('waits for the terminal input prompt before sending a queued batch', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'queued before terminal is ready',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });
        await Promise.resolve();
        expect(transport.paste).not.toHaveBeenCalled();
        expect(transport.enter).not.toHaveBeenCalled();

        transport.emitData('Claude Code v2.1.153\n❯ ');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('queued before terminal is ready');
            expect(transport.enter).toHaveBeenCalledOnce();
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('completed');

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('treats a matching SessionStart hook after spawn as terminal input ready', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'queued before silent terminal prompt',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        try {
            await vi.waitFor(() => {
                expect(transport.spawn).toHaveBeenCalledOnce();
                expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
            });
            await Promise.resolve();
            expect(transport.paste).not.toHaveBeenCalled();

            session.onSessionFound('claude-known-session');

            await vi.waitFor(() => {
                expect(transport.paste).toHaveBeenCalledWith('queued before silent terminal prompt\r');
            });
        } finally {
            transport.emitExit({ code: 0, signal: null });
            await resultPromise;
        }
    });

    it('does not paste a queued batch for a stale prompt in terminal history', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'queued while busy',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        transport.emitData('Claude Code v2.1.153\n❯ Try "old prompt"\nWorking on it...');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(transport.paste).not.toHaveBeenCalled();
        expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('completed');

        transport.emitData('Claude Code v2.1.153\n❯ Try "new prompt"');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('queued while busy');
            expect(transport.enter).toHaveBeenCalledOnce();
        });

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('clears cached readiness when stale prompt history is followed by busy output', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'first queued batch',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });

        transport.emitData('Claude Code v2.1.153\n❯ Try "first prompt"');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('first queued batch');
            expect(transport.enter).toHaveBeenCalledOnce();
        });

        transport.emitData('Claude Code v2.1.153\n❯ Try "cached ready prompt"');
        transport.emitData('Claude Code v2.1.153\n❯ Try "old prompt"\nWorking on it...');

        session.enqueueBatch({
            message: 'second queued batch',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(transport.paste).toHaveBeenCalledTimes(1);
        expect(transport.enter).toHaveBeenCalledTimes(1);

        transport.emitData('Claude Code v2.1.153\n❯ Try "fresh prompt"');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('second queued batch');
            expect(transport.enter).toHaveBeenCalledTimes(2);
        });

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('cancels a pending completion debounce when stale prompt history is followed by busy output', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'batch before stale busy',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });

        transport.emitData('Claude Code v2.1.153\n❯ Try "first prompt"');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('batch before stale busy');
            expect(transport.enter).toHaveBeenCalledOnce();
        });

        transport.emitData('Claude Code v2.1.153\n❯ Try "idle ready prompt"');
        transport.emitData('Claude Code v2.1.153\n❯ Try "old prompt"\nWorking on it...');
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('completed');

        transport.emitData('Claude Code v2.1.153\n❯ Try "fresh prompt"');

        await vi.waitFor(() => {
            expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('completed');
        });

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('clears cached readiness when ANSI stale prompt history is followed by busy output', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'first batch before ansi stale busy',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });

        transport.emitData('Claude Code v2.1.153\n❯ Try "first prompt"');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('first batch before ansi stale busy');
            expect(transport.enter).toHaveBeenCalledOnce();
        });

        transport.emitData('Claude Code v2.1.153\n❯ Try "cached ready prompt"');
        transport.emitData('Claude Code v2.1.153\n\x1b[32m❯\x1b[0m Try "old prompt"\nWorking on it...');

        session.enqueueBatch({
            message: 'second batch after ansi stale busy',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(transport.paste).toHaveBeenCalledTimes(1);
        expect(transport.enter).toHaveBeenCalledTimes(1);

        transport.emitData('Claude Code v2.1.153\n❯ Try "fresh prompt"');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('second batch after ansi stale busy');
            expect(transport.enter).toHaveBeenCalledTimes(2);
        });

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('cancels completion debounce when ANSI stale prompt history is followed by busy output', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'batch before ansi stale debounce',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });

        transport.emitData('Claude Code v2.1.153\n❯ Try "first prompt"');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('batch before ansi stale debounce');
            expect(transport.enter).toHaveBeenCalledOnce();
        });

        transport.emitData('Claude Code v2.1.153\n❯ Try "idle ready prompt"');
        transport.emitData('Claude Code v2.1.153\n\x1b[32m❯\x1b[0m Try "old prompt"\nWorking on it...');
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('completed');

        transport.emitData('Claude Code v2.1.153\n❯ Try "fresh prompt"');

        await vi.waitFor(() => {
            expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('completed');
        });

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('clears cached readiness and completion debounce when a permission prompt appears', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'first batch before permission prompt',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });

        transport.emitData('Claude Code v2.1.153\n❯ Try "first prompt"');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('first batch before permission prompt');
            expect(transport.enter).toHaveBeenCalledOnce();
        });

        transport.emitData('Claude Code v2.1.153\n❯ Try "idle ready prompt"');
        transport.emitData('Do you want to allow Bash?');
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('completed');

        session.enqueueBatch({
            message: 'second batch after permission prompt',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(transport.paste).toHaveBeenCalledTimes(1);
        expect(transport.enter).toHaveBeenCalledTimes(1);

        transport.emitData('Claude Code v2.1.153\n❯ Try "fresh prompt"');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('second batch after permission prompt');
            expect(transport.enter).toHaveBeenCalledTimes(2);
        });

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('fails the current turn without pasting when input readiness times out', async () => {
        vi.useFakeTimers();
        try {
            const transport = new FakeTerminalTransport('pty');
            mockCreateTerminalTransport.mockResolvedValue(transport);
            const session = createSession({
                batches: [{
                    message: 'do not paste blindly',
                    mode: initialMode,
                    hash: 'initial-mode-hash',
                    isolate: false,
                }],
            });

            const resultPromise = claudeInteractiveRemoteLauncher(session as any);

            await vi.waitFor(() => {
                expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
            });

            await vi.advanceTimersByTimeAsync(8001);

            expect(transport.paste).not.toHaveBeenCalled();
            expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
                type: 'message',
                message: 'Claude interactive terminal is not ready for input yet.',
            });
            expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('failed');
            expect(session.metadataSnapshots()).toContainEqual(expect.objectContaining({
                claudeRuntime: expect.objectContaining({
                    state: 'degraded',
                    message: 'Claude interactive terminal is not ready for input yet.',
                }),
            }));

            session.enqueueBatch({
                message: 'retry after timeout',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            });
            transport.emitData('❯ Try "ready now"');

            await vi.waitFor(() => {
                expect(transport.paste).toHaveBeenCalledWith('retry after timeout\r');
            });
            expect(session.metadataSnapshots()).toContainEqual(expect.objectContaining({
                claudeRuntime: expect.objectContaining({
                    state: 'interactive',
                    message: undefined,
                }),
            }));

            transport.emitExit({ code: 0, signal: null });
            await resultPromise;
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not report readiness timeout when abort wakes an input wait', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'waiting when aborted',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });

        await session.invokeRpc('abort');

        expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith({
            type: 'message',
            message: 'Claude interactive terminal is not ready for input yet.',
        });
        expect(transport.paste).not.toHaveBeenCalled();
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('cancelled');

        session.enqueueBatch({
            message: 'after abort wake',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        });
        transport.emitData('>');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('after abort wake\r');
        });

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('does not report readiness timeout when switch wakes an input wait', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'waiting when switching local',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });

        await session.invokeRpc('switch');

        expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith({
            type: 'message',
            message: 'Claude interactive terminal is not ready for input yet.',
        });
        expect(transport.paste).not.toHaveBeenCalled();
        expect(session.onModeChange).toHaveBeenCalledWith('local');

        session.enqueueBatch({
            message: 'after switch wake',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        });

        await vi.waitFor(() => {
            expect(transport.detachLocal).toHaveBeenCalledOnce();
        });
        expect(transport.paste).not.toHaveBeenCalled();

        transport.emitData('>');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('after switch wake');
        });

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('does not report readiness timeout when PTY switch wakes an input wait', async () => {
        vi.useFakeTimers();
        try {
            const transport = new FakeTerminalTransport('pty');
            mockCreateTerminalTransport.mockResolvedValue(transport);
            const session = createSession({
                batches: [{
                    message: 'waiting when pty switch is requested',
                    mode: initialMode,
                    hash: 'initial-mode-hash',
                    isolate: false,
                }],
            });

            const resultPromise = claudeInteractiveRemoteLauncher(session as any);

            await vi.waitFor(() => {
                expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
            });

            await session.invokeRpc('switch');

            expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
                type: 'message',
                message: 'Claude interactive remote cannot switch to local attach from a PTY terminal.',
            });
            expect(transport.paste).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(8001);

            expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith({
                type: 'message',
                message: 'Claude interactive terminal is not ready for input yet.',
            });
            expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('failed');
            expect(transport.paste).not.toHaveBeenCalled();

            session.enqueueBatch({
                message: 'after pty switch wake',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            });
            transport.emitData('>');

            await vi.waitFor(() => {
                expect(transport.paste).toHaveBeenCalledWith('after pty switch wake\r');
            });

            transport.emitExit({ code: 0, signal: null });
            await resultPromise;
        } finally {
            vi.useRealTimers();
        }
    });

    it('requires fresh readiness before pasting after switching from cached ready local attach', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });

        transport.emitData('Claude Code v2.1.153\n❯ Try "cached prompt"');
        await session.invokeRpc('switch');
        expect(session.onModeChange).toHaveBeenCalledWith('local');

        session.enqueueBatch({
            message: 'after cached local switch',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(transport.paste).not.toHaveBeenCalled();
        expect(transport.enter).not.toHaveBeenCalled();

        transport.emitData('Claude Code v2.1.153\n❯ Try "fresh after switch"');

        await vi.waitFor(() => {
            expect(transport.detachLocal).toHaveBeenCalledOnce();
            expect(transport.paste).toHaveBeenCalledWith('after cached local switch');
            expect(transport.enter).toHaveBeenCalledOnce();
        });

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('ignores prompts observed during local attach when app later detaches for a batch', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });

        await session.invokeRpc('switch');
        expect(session.onModeChange).toHaveBeenCalledWith('local');

        transport.emitData('Claude Code v2.1.153\n❯ Try "local prompt"');

        session.enqueueBatch({
            message: 'after local attach prompt',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(transport.detachLocal).toHaveBeenCalledOnce();
        expect(transport.paste).not.toHaveBeenCalled();
        expect(transport.enter).not.toHaveBeenCalled();

        transport.emitData('Claude Code v2.1.153\n❯ Try "fresh after detach"');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('after local attach prompt');
            expect(transport.enter).toHaveBeenCalledOnce();
        });

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('does not report readiness timeout when terminal exit wakes an input wait', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'waiting when terminal exits',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });

        transport.emitExit({ code: 0, signal: null });

        await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 0 });
        expect(transport.paste).not.toHaveBeenCalled();
        expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith({
            type: 'message',
            message: 'Claude interactive terminal is not ready for input yet.',
        });
    });

    it('does not forward transcript echoes for prompts sent from the app', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'как дела',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });
        transport.emitData('❯ ');
        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('как дела');
        });

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        const promptEcho = {
            type: 'user',
            uuid: 'prompt-echo',
            message: {
                role: 'user',
                content: 'как дела',
            },
        } satisfies RawJSONLines;
        scannerOptions.onMessage(promptEcho);
        const toolResult = {
            type: 'user',
            uuid: 'tool-result',
            message: {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_123',
                    content: [{ type: 'text', text: 'done' }],
                }],
            },
        } satisfies RawJSONLines;
        scannerOptions.onMessage(toolResult);

        expect(session.client.sendClaudeSessionMessage).not.toHaveBeenCalledWith(promptEcho);
        expect(session.client.sendClaudeSessionMessage).toHaveBeenCalledWith(toolResult);

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('does not forward transcript echoes when Claude trims app prompt whitespace', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'как дела\n',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });
        transport.emitData('❯ ');
        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('как дела\n');
            expect(transport.enter).toHaveBeenCalledOnce();
        });

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        const promptEcho = {
            type: 'user',
            uuid: 'trimmed-prompt-echo',
            message: {
                role: 'user',
                content: 'как дела',
            },
        } satisfies RawJSONLines;
        scannerOptions.onMessage(promptEcho);

        expect(session.client.sendClaudeSessionMessage).not.toHaveBeenCalledWith(promptEcho);

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('does not forward transcript echoes written before tmux enter resolves', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'как дела',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(mockCreateSessionScanner).toHaveBeenCalled();
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });
        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        const promptEcho = {
            type: 'user',
            uuid: 'early-prompt-echo',
            message: {
                role: 'user',
                content: 'как дела',
            },
        } satisfies RawJSONLines;
        transport.enter.mockImplementationOnce(async () => {
            scannerOptions.onMessage(promptEcho);
        });

        transport.emitData('❯ ');
        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('как дела');
            expect(transport.enter).toHaveBeenCalledOnce();
        });

        expect(session.client.sendClaudeSessionMessage).not.toHaveBeenCalledWith(promptEcho);

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('does not forward main transcript user prompts while controlled remotely', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(mockCreateSessionScanner).toHaveBeenCalled();
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        const remotePromptEcho = {
            type: 'user',
            uuid: 'remote-controlled-user-prompt',
            isSidechain: false,
            message: {
                role: 'user',
                content: 'приветик',
            },
        } satisfies RawJSONLines;
        scannerOptions.onMessage(remotePromptEcho);

        expect(session.client.sendClaudeSessionMessage).not.toHaveBeenCalledWith(remotePromptEcho);

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('forwards main transcript user prompts while locally attached', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(mockCreateSessionScanner).toHaveBeenCalled();
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });
        await session.invokeRpc('switch');

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        const localPrompt = {
            type: 'user',
            uuid: 'local-attach-user-prompt',
            isSidechain: false,
            message: {
                role: 'user',
                content: 'typed in tmux',
            },
        } satisfies RawJSONLines;
        scannerOptions.onMessage(localPrompt);

        expect(session.client.sendClaudeSessionMessage).toHaveBeenCalledWith(localPrompt);

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

    it('fails the runtime and exits on usage or auth terminal output', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });
        transport.emitData('Claude AI usage limit reached|1799999999');

        await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 1 });
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Claude reported a usage or authentication problem.',
        });
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('failed');
        expect(session.metadataSnapshots()).toContainEqual(expect.objectContaining({
            claudeRuntime: expect.objectContaining({
                state: 'failed',
                message: 'Claude reported a usage or authentication problem.',
            }),
        }));
        expect(transport.dispose).toHaveBeenCalledOnce();
    });

    it('fails the runtime with sanitized diagnostics on terminal process errors', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });
        transport.emitData('failed /Users/me/Library/Application Support/Claude/log.txt sk-ant-api03-secret https://example.com/x');

        await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 1 });
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Terminal reported an error. failed [path] [secret] [url]',
        });
        const messages = session.client.sendSessionEvent.mock.calls.map((call) => {
            const event = call[0] as { message?: string };
            return event.message ?? '';
        });
        expect(messages.join('\n')).not.toContain('/Users/me');
        expect(messages.join('\n')).not.toContain('sk-ant-api03-secret');
        expect(messages.join('\n')).not.toContain('https://example.com/x');
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('failed');
        expect(session.metadataSnapshots()).toContainEqual(expect.objectContaining({
            claudeRuntime: expect.objectContaining({
                state: 'failed',
                message: 'Terminal reported an error. failed [path] [secret] [url]',
            }),
        }));
    });

    it('keeps a live terminal runtime when the known transcript has not appeared yet', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();
        let settled = false;

        const resultPromise = claudeInteractiveRemoteLauncher(session as any).then((result) => {
            settled = true;
            return result;
        });

        await vi.waitFor(() => {
            expect(mockCreateSessionScanner).toHaveBeenCalled();
        });
        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        scannerOptions.onTranscriptMissing('claude-known-session');

        await Promise.resolve();
        expect(settled).toBe(false);
        expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith({
            type: 'message',
            message: 'Claude transcript did not appear for the interactive session.',
        });
        expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('failed');
        expect(session.metadataSnapshots()).toContainEqual(expect.objectContaining({
            claudeRuntime: expect.objectContaining({
                state: 'interactive',
            }),
        }));

        transport.emitExit({ code: 0, signal: null });
        await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 0 });
        expect(transport.dispose).toHaveBeenCalledOnce();
    });

    it('fails the current turn when terminal input write fails', async () => {
        const transport = new FakeTerminalTransport('pty');
        transport.paste.mockRejectedValueOnce(new Error('write failed with secret path /Users/me/.claude'));
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession({
            batches: [{
                message: 'hello',
                mode: initialMode,
                hash: 'initial-mode-hash',
                isolate: false,
            }],
        });

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalled();
        });
        transport.emitData('>');

        await expect(resultPromise).resolves.toEqual({
            type: 'exit',
            code: 1,
        });

        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Claude interactive terminal failed to receive input.',
        });
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('failed');
        expect(session.metadataSnapshots()).toContainEqual(expect.objectContaining({
            claudeRuntime: expect.objectContaining({
                state: 'failed',
                message: 'Claude interactive terminal failed to receive input.',
            }),
        }));
        expect(transport.dispose).toHaveBeenCalledOnce();
    });

    it('wakes an idle queue wait on abort and accepts future batches', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalledOnce();
        });

        await session.invokeRpc('abort');
        expect(session.onAbort).toHaveBeenCalledOnce();
        expect(session.queue.reset).toHaveBeenCalledOnce();
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('cancelled');
        expect(transport.interrupt).toHaveBeenCalledOnce();

        session.enqueueBatch({
            message: 'after abort',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        });
        transport.emitData('>');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('after abort\r');
        });

        transport.emitExit({ code: 0, signal: null });
        await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 0 });
    });

    it('closes the turn as completed only after prompt debounce and scanner flush', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const scanner = {
            onNewSession: vi.fn(),
            flush: vi.fn(async () => { }),
            cleanup: vi.fn(async () => { }),
        };
        mockCreateSessionScanner.mockResolvedValue(scanner);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(mockCreateSessionScanner).toHaveBeenCalled();
        });

        transport.emitData('>\n');

        expect(session.onThinkingChange).toHaveBeenCalledWith(false);
        expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('completed');

        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        scannerOptions.onMessage({
            type: 'assistant',
            uuid: 'assistant-after-prompt',
            message: {
                model: 'claude-opus',
            },
        } satisfies RawJSONLines);

        expect(session.client.sendClaudeSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
            uuid: 'assistant-after-prompt',
        }));
        expect(session.client.closeClaudeSessionTurn).not.toHaveBeenCalledWith('completed');

        await vi.waitFor(() => {
            expect(scanner.flush).toHaveBeenCalledOnce();
            expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('completed');
        });
        expect(scanner.flush.mock.invocationCallOrder[0]).toBeLessThan(
            session.client.closeClaudeSessionTurn.mock.invocationCallOrder.find((order: number, index: number) => {
                return session.client.closeClaudeSessionTurn.mock.calls[index][0] === 'completed';
            })!,
        );

        transport.emitExit({ code: 0, signal: null });
        await resultPromise;
    });

    it('switches tmux control to local attach without disposing the terminal', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();
        let settled = false;

        const resultPromise = claudeInteractiveRemoteLauncher(session as any).then((result) => {
            settled = true;
            return result;
        });

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalledOnce();
        });

        await session.invokeRpc('switch');
        await Promise.resolve();

        expect(settled).toBe(false);
        expect(session.onModeChange).toHaveBeenCalledWith('local');
        expect(transport.attachLocal).toHaveBeenCalledOnce();
        expect(transport.interrupt).not.toHaveBeenCalled();
        expect(transport.dispose).not.toHaveBeenCalled();
        const localAttachSnapshot = session.metadataSnapshots()
            .map((snapshot) => (snapshot as any).claudeRuntime)
            .find((runtime: any) => runtime?.message?.includes('Attach with:'));
        expect(localAttachSnapshot).toEqual(expect.objectContaining({
            state: 'interactive',
            message: expect.stringContaining(`tmux attach -t ${transport.terminalId}`),
        }));

        transport.emitExit({ code: 0, signal: null });
        await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 0 });
        expect(transport.dispose).not.toHaveBeenCalled();
    });

    it('disposes the tmux terminal when session cleanup runs before launcher exit', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(transport.spawn).toHaveBeenCalledOnce();
        });

        await session.runCleanupHooks();

        expect(transport.dispose).toHaveBeenCalledOnce();

        transport.emitExit({ code: 0, signal: null });
        await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 0 });
        expect(transport.dispose).toHaveBeenCalledOnce();
    });

    it('renders the remote-mode terminal display and attaches tmux from its switch action', async () => {
        forceTTY();
        const unmount = vi.fn();
        mockInkRender.mockReturnValue({ unmount });
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(transport.spawn).toHaveBeenCalledOnce();
            expect(mockInkRender).toHaveBeenCalledOnce();
        });

        const element = mockInkRender.mock.calls[0][0] as any;
        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        scannerOptions.onMessage({
            type: 'assistant',
            uuid: 'assistant-for-terminal-display',
            message: {
                content: [{ type: 'text', text: 'hello from tmux transcript' }],
            },
        } satisfies RawJSONLines);
        expect(element.props.messageBuffer.getMessages()).toContainEqual(expect.objectContaining({
            type: 'assistant',
            content: 'hello from tmux transcript',
        }));

        await element.props.onSwitchToLocal();

        expect(unmount).toHaveBeenCalledOnce();
        await vi.waitFor(() => {
            expect(transport.attachLocal).toHaveBeenCalledOnce();
            expect(session.onModeChange).toHaveBeenCalledWith('local');
        });

        transport.emitExit({ code: 0, signal: null });
        await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 0 });
    });

    it('returns from local attach to remote control on the same tmux terminal when app sends a prompt', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalledOnce();
        });

        await session.invokeRpc('switch');
        expect(session.onModeChange).toHaveBeenCalledWith('local');

        session.enqueueBatch({
            message: 'take remote control back',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        });

        await vi.waitFor(() => {
            expect(transport.detachLocal).toHaveBeenCalledOnce();
        });
        expect(session.onModeChange).toHaveBeenCalledWith('remote');
        expect(transport.paste).not.toHaveBeenCalled();

        transport.emitData('❯ ');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('take remote control back');
            expect(transport.enter).toHaveBeenCalledOnce();
        });
        expect(transport.detachLocal.mock.invocationCallOrder[0]).toBeLessThan(
            transport.paste.mock.invocationCallOrder[0],
        );
        expect(transport.dispose).not.toHaveBeenCalled();

        transport.emitExit({ code: 0, signal: null });
        await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 0 });
        expect(transport.dispose).toHaveBeenCalledOnce();
    });

    it('returns from local attach to remote control when app aborts', async () => {
        const transport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(session.queue.waitForMessagesAndGetAsString).toHaveBeenCalledOnce();
        });

        await session.invokeRpc('switch');
        await session.invokeRpc('abort');

        expect(session.onModeChange.mock.calls.map(([mode]) => mode)).toEqual(['local', 'remote']);
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('cancelled');
        expect(transport.detachLocal).toHaveBeenCalledOnce();
        expect(transport.detachLocal.mock.invocationCallOrder[0]).toBeLessThan(
            transport.interrupt.mock.invocationCallOrder[0],
        );
        expect(transport.interrupt).toHaveBeenCalledOnce();

        session.enqueueBatch({
            message: 'after abort from attach',
            mode: initialMode,
            hash: 'initial-mode-hash',
            isolate: false,
        });
        transport.emitData('>');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('after abort from attach');
            expect(transport.enter).toHaveBeenCalledOnce();
        });

        transport.emitExit({ code: 0, signal: null });
        await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 0 });
        expect(transport.dispose).toHaveBeenCalledOnce();
    });

    it('uses distinct non-fixed terminal window names for separate launches', async () => {
        const firstTransport = new FakeTerminalTransport('tmux');
        const secondTransport = new FakeTerminalTransport('tmux');
        mockCreateTerminalTransport
            .mockResolvedValueOnce(firstTransport)
            .mockResolvedValueOnce(secondTransport);

        const firstResult = claudeInteractiveRemoteLauncher(createSession() as any);
        await vi.waitFor(() => {
            expect(firstTransport.spawn).toHaveBeenCalledOnce();
        });
        firstTransport.emitExit({ code: 0, signal: null });
        await firstResult;

        const secondResult = claudeInteractiveRemoteLauncher(createSession() as any);
        await vi.waitFor(() => {
            expect(secondTransport.spawn).toHaveBeenCalledOnce();
        });
        secondTransport.emitExit({ code: 0, signal: null });
        await secondResult;

        const firstWindowName = firstTransport.spawn.mock.calls[0][0].windowName;
        const secondWindowName = secondTransport.spawn.mock.calls[0][0].windowName;

        expect(firstWindowName).toMatch(/^happy-claude-[A-Za-z0-9_-]+$/);
        expect(secondWindowName).toMatch(/^happy-claude-[A-Za-z0-9_-]+$/);
        expect(firstWindowName).not.toBe('happy-claude');
        expect(secondWindowName).not.toBe('happy-claude');
        expect(firstWindowName).not.toBe(secondWindowName);
    });
});

function forceTTY(): void {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    (process.stdin as any).setRawMode = vi.fn();
    process.stdin.resume = vi.fn(() => process.stdin);
    process.stdin.pause = vi.fn(() => process.stdin);
    process.stdin.setEncoding = vi.fn(() => process.stdin) as any;
}

function restoreTTY(): void {
    if (stdoutIsTTY) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTY);
    } else {
        delete (process.stdout as any).isTTY;
    }
    if (stdinIsTTY) {
        Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
    } else {
        delete (process.stdin as any).isTTY;
    }
    (process.stdin as any).setRawMode = stdinSetRawMode;
    process.stdin.resume = stdinResume;
    process.stdin.pause = stdinPause;
    process.stdin.setEncoding = stdinSetEncoding;
}

class FakeTerminalTransport implements TerminalTransport {
    readonly capabilities: readonly ('remote-control' | 'local-attach')[];
    terminalId: string | null = null;

    readonly spawn = vi.fn(async (options: TerminalSpawnOptions) => {
        this.terminalId = `${this.backend}:${options.windowName}`;
        return { pid: 123, terminalId: this.terminalId };
    });
    readonly paste = vi.fn(async (_text: string) => { });
    readonly enter = vi.fn(async () => { });
    readonly interrupt = vi.fn(async () => { });
    readonly resize = vi.fn(async (_cols: number, _rows: number) => { });
    readonly attachLocal = vi.fn(async () => { });
    readonly detachLocal = vi.fn(async () => { });
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

function createSession(opts: { batches?: InteractiveClaudeBatch[], initialMode?: EnhancedMode } = {}) {
    let metadata: Record<string, unknown> = {};
    const snapshots: Record<string, unknown>[] = [];
    const batches = [...(opts.batches ?? [])];
    const sessionFoundCallbacks: Array<(sessionId: string) => void> = [];
    const cleanupHooks = new Set<() => Promise<void> | void>();
    const rpcHandlers = new Map<string, () => Promise<void> | void>();
    let waiter: ((batch: InteractiveClaudeBatch | null) => void) | null = null;

    const session = {
        sessionId: null as string | null,
        path: '/tmp/project',
        initialMode: opts.initialMode ?? initialMode,
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
                registerHandler: vi.fn((method: string, handler: () => Promise<void> | void) => {
                    rpcHandlers.set(method, handler);
                }),
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
                    const onAbort = () => {
                        if (waiter === resolve) {
                            waiter = null;
                        }
                        resolve(null);
                    };
                    signal?.addEventListener('abort', onAbort, { once: true });
                    waiter = (batch) => {
                        signal?.removeEventListener('abort', onAbort);
                        waiter = null;
                        resolve(batch);
                    };
                });
            }),
            reset: vi.fn(() => {
                batches.length = 0;
                waiter = null;
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
        addCleanupHook: vi.fn((hook: () => Promise<void> | void) => {
            cleanupHooks.add(hook);
            return () => {
                cleanupHooks.delete(hook);
            };
        }),
        runCleanupHooks: async () => {
            for (const hook of [...cleanupHooks]) {
                await hook();
            }
        },
        onSessionFound: vi.fn((sessionId: string) => {
            session.sessionId = sessionId;
            for (const callback of sessionFoundCallbacks) {
                callback(sessionId);
            }
        }),
        onThinkingChange: vi.fn(),
        onModeChange: vi.fn(),
        onAbort: vi.fn(),
        consumeOneTimeFlags: vi.fn(),
        enqueueBatch: (batch: InteractiveClaudeBatch) => {
            if (waiter) {
                waiter(batch);
                return;
            }
            batches.push(batch);
        },
        invokeRpc: async (method: string) => {
            const handler = rpcHandlers.get(method);
            if (!handler) {
                throw new Error(`No RPC handler registered for ${method}`);
            }
            await handler();
        },
        metadataSnapshots: () => snapshots,
    };

    return session;
}
