import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiSessionClient } from './apiSession';
import type { RawJSONLines } from '@/claude/types';
import { encodeBase64, encrypt } from './encryption';

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
            connected: false,
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            disconnect: vi.fn(),
            emit: vi.fn(),
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

    it('emits messages even when disconnected (socket.io will buffer)', () => {
        mockSocket.connected = false;

        const client = new ApiSessionClient('fake-token', mockSession);

        const payload: RawJSONLines = {
            type: 'user',
            uuid: 'test-uuid',
            message: {
                content: 'hello',
            },
        } as const;

        client.sendClaudeSessionMessage(payload);

        expect(mockSocket.emit).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: mockSession.id,
                message: expect.any(String),
            })
        );
    });

	    it('attaches server localId onto decrypted user messages', async () => {
	        const client = new ApiSessionClient('fake-token', mockSession);

        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const updateHandler = (mockSocket.on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1];
        expect(typeof updateHandler).toBe('function');

        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { sentFrom: 'web' },
        };
        const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, plaintext));

        updateHandler({
            id: 'update-1',
            seq: 1,
            createdAt: Date.now(),
            body: {
                t: 'new-message',
                sid: mockSession.id,
                message: {
                    id: 'msg-1',
                    seq: 1,
                    localId: 'local-1',
                    content: { t: 'encrypted', c: encrypted },
                },
            },
        } as any);

	        expect(onUserMessage).toHaveBeenCalledWith(
	            expect.objectContaining({
	                content: expect.objectContaining({ text: 'hello' }),
	                localId: 'local-1',
	            }),
	        );
	    });

	    it('waitForMetadataUpdate resolves when session metadata updates', async () => {
	        const client = new ApiSessionClient('fake-token', mockSession);

	        const waitPromise = client.waitForMetadataUpdate();

	        const updateHandler = (mockSocket.on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1];
	        expect(typeof updateHandler).toBe('function');

	        const nextMetadata = { ...mockSession.metadata, path: '/tmp/next' };
	        const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, nextMetadata));

	        updateHandler({
	            id: 'update-2',
	            seq: 2,
	            createdAt: Date.now(),
	            body: {
	                t: 'update-session',
	                sid: mockSession.id,
	                metadata: {
	                    version: 1,
	                    value: encrypted,
	                },
	            },
	        } as any);

	        await expect(waitPromise).resolves.toBe(true);
	    });

	    it('clears messageQueueV1 inFlight only after observing the materialized user message', async () => {
	        mockSocket.connected = true;

	        const metadataBase = {
	            ...mockSession.metadata,
	            messageQueueV1: {
	                v: 1,
	                queue: [{
	                    localId: 'local-p1',
	                    message: 'encrypted-user-record',
	                    createdAt: 1,
	                    updatedAt: 1,
	                }],
	                inFlight: null,
	            },
	        };

	        const client = new ApiSessionClient('fake-token', {
	            ...mockSession,
	            metadata: metadataBase,
	        });

	        // Minimal emitWithAck mock for metadata claim + later clear
	        const emitWithAck = vi.fn()
	            // 1) claim succeeds
	            .mockResolvedValueOnce({
	                result: 'success',
	                version: 1,
	                metadata: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
	                    ...metadataBase,
	                    messageQueueV1: {
	                        v: 1,
	                        queue: [],
	                        inFlight: {
	                            localId: 'local-p1',
	                            message: 'encrypted-user-record',
	                            createdAt: 1,
	                            updatedAt: 1,
	                            claimedAt: 100,
	                        },
	                    },
	                })),
	            })
	            // 2) clear succeeds
	            .mockResolvedValueOnce({
	                result: 'success',
	                version: 2,
	                metadata: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
	                    ...metadataBase,
	                    messageQueueV1: {
	                        v: 1,
	                        queue: [],
	                        inFlight: null,
	                    },
	                })),
	            });

	        mockSocket.emitWithAck = emitWithAck;

	        const popped = await client.popPendingMessage();
	        expect(popped).toBe(true);

	        // Should have emitted the transcript message but NOT yet cleared inFlight.
	        expect(mockSocket.emit).toHaveBeenCalledWith('message', expect.objectContaining({ localId: 'local-p1' }));
	        expect(emitWithAck).toHaveBeenCalledTimes(1);

	        const updateHandler = (mockSocket.on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1];
	        expect(typeof updateHandler).toBe('function');

	        const plaintext = {
	            role: 'user',
	            content: { type: 'text', text: 'hello' },
	        };
	        const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, plaintext));

	        // Simulate server broadcast of the materialized message with the same localId.
	        updateHandler({
	            id: 'update-3',
	            seq: 3,
	            createdAt: Date.now(),
	            body: {
	                t: 'new-message',
	                sid: mockSession.id,
	                message: {
	                    id: 'msg-2',
	                    seq: 2,
	                    localId: 'local-p1',
	                    content: { t: 'encrypted', c: encrypted },
	                },
	            },
	        } as any);

	        // Allow queued async clear to run.
	        await new Promise((r) => setTimeout(r, 0));
	        expect(emitWithAck).toHaveBeenCalledTimes(2);
	    });

	    afterEach(() => {
	        consoleSpy.mockRestore();
	        vi.restoreAllMocks();
	    });
});
