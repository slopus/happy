import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiSessionClient } from './apiSession';
import * as trimToolUseResultModule from './trimToolUseResult';
import * as toolOutputStoreModule from '../modules/common/toolOutputStore';
import * as encryptionModule from './encryption';

// Use vi.hoisted to ensure mock function is available when vi.mock factory runs
const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn()
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

describe('ApiSessionClient connection handling', () => {
    let mockSocket: any;
    let consoleSpy: any;
    let mockSession: any;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Mock socket.io client
        mockSocket = {
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            disconnect: vi.fn()
        };

        mockIo.mockReturnValue(mockSocket);

        // Create a proper mock session with metadata
        mockSession = {
            id: 'test-session-id',
            seq: 0,
            metadata: {
                path: '/tmp',
                host: 'localhost',
                homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy',
                happyLibDir: '/home/user/.happy/lib',
                happyToolsDir: '/home/user/.happy/tools'
            },
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const
        };
    });

    it('should handle socket connection failure gracefully', async () => {
        // Should not throw during client creation
        // Note: socket is created with autoConnect: false, so connection happens later
        expect(() => {
            new ApiSessionClient('fake-token', mockSession);
        }).not.toThrow();
    });

    it('should emit correct events on socket connection', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        // Should have set up event listeners
        expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should advertise supportsMessageReceipt capability in socket auth', () => {
        new ApiSessionClient('fake-token', mockSession);

        expect(mockIo).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                auth: expect.objectContaining({
                    clientType: 'session-scoped',
                    sessionId: 'test-session-id',
                    supportsMessageReceipt: true,
                }),
            }),
        );
    });

    afterEach(() => {
        consoleSpy.mockRestore();
        vi.restoreAllMocks();
    });
});

describe('ApiSessionClient v3 outbox', () => {
    let mockSocket: any;
    let consoleSpy: any;
    let mockSession: any;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        mockSocket = {
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            close: vi.fn(),
            disconnect: vi.fn(),
            emit: vi.fn(),
            connected: true
        };

        mockIo.mockReturnValue(mockSocket);

        mockSession = {
            id: 'test-session-id',
            seq: 0,
            metadata: {
                path: '/tmp',
                host: 'localhost',
                homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy',
                happyLibDir: '/home/user/.happy/lib',
                happyToolsDir: '/home/user/.happy/tools'
            },
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const
        };
    });

    afterEach(() => {
        consoleSpy.mockRestore();
        vi.restoreAllMocks();
    });

    it('should initialize sendSync in the constructor', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        // The sendSync field should exist (it's private, but we can verify
        // indirectly by ensuring close() doesn't throw)
        expect(() => client.close()).not.toThrow();
    });

    it('should NOT emit via socket when sending a Claude session message (v3 outbox only)', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        const body = {
            type: 'assistant' as const,
            message: {
                content: [{ type: 'text', text: 'Hello' }],
                role: 'assistant' as const
            }
        };

        client.sendClaudeSessionMessage(body as any);

        // Socket emit should NOT be called — messages now go through v3 HTTP outbox only
        expect(mockSocket.emit).not.toHaveBeenCalledWith('message', expect.anything());
    });

    it('should NOT emit via socket when sending an agent message (v3 outbox only)', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        client.sendAgentMessage('gemini', { type: 'message', message: 'Hello from Gemini' });

        // Socket emit should NOT be called — messages now go through v3 HTTP outbox only
        expect(mockSocket.emit).not.toHaveBeenCalledWith('message', expect.anything());
    });

    it('should NOT emit via socket when sending a codex message (v3 outbox only)', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        client.sendCodexMessage({ type: 'message', text: 'Hello from Codex' });

        // Socket emit should NOT be called — messages now go through v3 HTTP outbox only
        expect(mockSocket.emit).not.toHaveBeenCalledWith('message', expect.anything());
    });

    it('should use snake_case tool_use_result payloads when trimming Claude tool results', () => {
        const client = new ApiSessionClient('fake-token', mockSession) as any;
        const trimSpy = vi.spyOn(trimToolUseResultModule, 'trimToolUseResult').mockReturnValue({
            _outputTrimmed: true,
            _callId: 'toolu_read_1',
            _toolResultKind: 'text',
        });

        client.buildMessageContent({
            type: 'assistant',
            uuid: 'assistant-1',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'toolu_read_1',
                    name: 'Read',
                    input: {
                        file_path: '/tmp/demo.ts',
                    },
                }],
            },
        });

        const toolUseResult = {
            type: 'text',
            file: {
                filePath: '/tmp/demo.ts',
                content: 'export const demo = 1;\n',
                numLines: 1,
                startLine: 1,
                totalLines: 1,
            },
        };

        const messageContent = client.buildMessageContent({
            type: 'user',
            uuid: 'user-1',
            message: {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_read_1',
                    content: 'demo',
                }],
            },
            tool_use_result: toolUseResult,
        });

        expect(trimSpy).toHaveBeenCalledWith(
            'Read',
            toolUseResult,
            'test-session-id',
            'toolu_read_1'
        );
        expect(messageContent).toMatchObject({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    toolUseResult: {
                        _outputTrimmed: true,
                        _callId: 'toolu_read_1',
                        _toolResultKind: 'text',
                    },
                },
            },
        });

        trimSpy.mockRestore();
    });

    it('should preserve trimmed WebSearch results from snake_case tool_use_result payloads', () => {
        const client = new ApiSessionClient('fake-token', mockSession) as any;
        const saveSpy = vi.spyOn(toolOutputStoreModule, 'saveToolOutputRecord').mockImplementation(() => {});

        client.buildMessageContent({
            type: 'assistant',
            uuid: 'assistant-web-1',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'toolu_web_1',
                    name: 'WebSearch',
                    input: {
                        query: 'Claude Code CLI tool 2026',
                    },
                }],
            },
        });

        const messageContent = client.buildMessageContent({
            type: 'user',
            uuid: 'user-web-1',
            message: {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_web_1',
                    content: 'large raw result',
                }],
            },
            tool_use_result: {
                query: 'Claude Code CLI tool 2026',
                results: [
                    { title: 'Claude Code', url: 'https://example.com/claude-code' },
                ],
            },
        });

        expect(messageContent).toMatchObject({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    toolUseResult: {
                        query: 'Claude Code CLI tool 2026',
                        _outputTrimmed: true,
                        _callId: 'toolu_web_1',
                        _toolResultKind: 'structured',
                    },
                },
            },
        });

        saveSpy.mockRestore();
    });
});

describe('ApiSessionClient message receipt', () => {
    let mockSocket: any;
    let mockSession: any;

    beforeEach(() => {
        mockSocket = {
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            close: vi.fn(),
            disconnect: vi.fn(),
            emit: vi.fn(),
            connected: true
        };

        mockIo.mockReturnValue(mockSocket);

        mockSession = {
            id: 'test-session-id',
            seq: 0,
            metadata: {
                path: '/tmp',
                host: 'localhost',
                homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy',
                happyLibDir: '/home/user/.happy/lib',
                happyToolsDir: '/home/user/.happy/tools'
            },
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function getUpdateHandler() {
        const call = mockSocket.on.mock.calls.find((args: any[]) => args[0] === 'update');
        if (!call) {
            throw new Error('update handler not registered');
        }
        return call[1];
    }

    it('emits message-receipt ok=true when app-originated user message is accepted', () => {
        new ApiSessionClient('fake-token', mockSession);

        vi.spyOn(encryptionModule, 'decodeBase64').mockReturnValue(new Uint8Array([1, 2, 3]));
        vi.spyOn(encryptionModule, 'decrypt').mockReturnValue({
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { sentFrom: 'web' }
        } as any);

        const updateHandler = getUpdateHandler();
        updateHandler({
            body: {
                t: 'new-message',
                sid: 'test-session-id',
                message: {
                    id: 'msg-1',
                    localId: 'local-1',
                    content: { t: 'encrypted', c: 'abc' }
                }
            }
        });

        expect(mockSocket.emit).toHaveBeenCalledWith('message-receipt', {
            sid: 'test-session-id',
            messageId: 'msg-1',
            localId: 'local-1',
            ok: true
        });
    });

    it('emits message-receipt ok=false with original error on decrypt/parse failure', () => {
        new ApiSessionClient('fake-token', mockSession);

        vi.spyOn(encryptionModule, 'decodeBase64').mockReturnValue(new Uint8Array([1, 2, 3]));
        vi.spyOn(encryptionModule, 'decrypt').mockImplementation(() => {
            throw new Error('decrypt failed: invalid payload');
        });

        const updateHandler = getUpdateHandler();
        updateHandler({
            body: {
                t: 'new-message',
                sid: 'test-session-id',
                message: {
                    id: 'msg-1',
                    localId: 'local-1',
                    content: { t: 'encrypted', c: 'abc' }
                }
            }
        });

        expect(mockSocket.emit).toHaveBeenCalledWith('message-receipt', {
            sid: 'test-session-id',
            messageId: 'msg-1',
            localId: 'local-1',
            ok: false,
            error: 'decrypt failed: invalid payload'
        });
    });
});
