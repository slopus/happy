import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiSessionClient } from './apiSession';

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
});