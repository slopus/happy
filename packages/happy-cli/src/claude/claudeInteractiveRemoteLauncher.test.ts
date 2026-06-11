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
            flush: vi.fn(async () => { }),
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

    it('fails the runtime when the known transcript never appears', async () => {
        const transport = new FakeTerminalTransport('pty');
        mockCreateTerminalTransport.mockResolvedValue(transport);
        const session = createSession();

        const resultPromise = claudeInteractiveRemoteLauncher(session as any);

        await vi.waitFor(() => {
            expect(mockCreateSessionScanner).toHaveBeenCalled();
        });
        const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
        scannerOptions.onTranscriptMissing('claude-known-session');

        await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 1 });
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Claude transcript did not appear for the interactive session.',
        });
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('failed');
        expect(session.metadataSnapshots()).toContainEqual(expect.objectContaining({
            claudeRuntime: expect.objectContaining({
                state: 'failed',
                message: 'Claude transcript did not appear for the interactive session.',
            }),
        }));
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
        expect(transport.interrupt).not.toHaveBeenCalled();
        expect(transport.dispose).not.toHaveBeenCalled();
        expect(session.metadataSnapshots()).toContainEqual(expect.objectContaining({
            claudeRuntime: expect.objectContaining({
                state: 'interactive',
                message: expect.stringContaining('tmux'),
            }),
        }));

        transport.emitExit({ code: 0, signal: null });
        await expect(resultPromise).resolves.toEqual({ type: 'exit', code: 0 });
        expect(transport.dispose).not.toHaveBeenCalled();
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
        transport.emitData('❯ ');

        await vi.waitFor(() => {
            expect(transport.paste).toHaveBeenCalledWith('take remote control back');
            expect(transport.enter).toHaveBeenCalledOnce();
        });
        expect(session.onModeChange).toHaveBeenCalledWith('remote');
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
    const rpcHandlers = new Map<string, () => Promise<void> | void>();
    let waiter: ((batch: InteractiveClaudeBatch | null) => void) | null = null;

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
