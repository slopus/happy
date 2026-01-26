import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiSessionClient } from './apiSession';
import type { RawJSONLines } from '@/claude/types';
import { encodeBase64, encrypt } from './encryption';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetToolTraceForTests } from '@/toolTrace/toolTrace';

// Use vi.hoisted to ensure mock function is available when vi.mock factory runs
const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

describe('ApiSessionClient connection handling', () => {
    let mockSocket: any;
    let mockUserSocket: any;
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
            close: vi.fn(),
            emit: vi.fn(),
        };

        mockUserSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            emit: vi.fn(),
        };

        mockIo.mockReset();
        mockIo
            .mockImplementationOnce(() => mockSocket)
            .mockImplementationOnce(() => mockUserSocket)
            .mockImplementation(() => mockSocket);

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

    afterEach(() => {
        delete process.env.HAPPY_STACKS_TOOL_TRACE;
        delete process.env.HAPPY_STACKS_TOOL_TRACE_FILE;
        __resetToolTraceForTests();
    });

    it('should handle socket connection failure gracefully', async () => {
        // Should not throw during client creation
        // Note: socket is created with autoConnect: false, so connection happens later
        expect(() => {
            new ApiSessionClient('fake-token', mockSession);
        }).not.toThrow();
    });

    it('records outbound ACP tool messages when tool tracing is enabled', () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-apiSession-'));
        const filePath = join(dir, 'tool-trace.jsonl');
        process.env.HAPPY_STACKS_TOOL_TRACE = '1';
        process.env.HAPPY_STACKS_TOOL_TRACE_FILE = filePath;

        const client = new ApiSessionClient('fake-token', mockSession);
        client.sendAgentMessage('codex', {
            type: 'tool-call',
            callId: 'call-1',
            name: 'read',
            input: { filePath: '/etc/hosts' },
            id: 'msg-1',
        });

        const raw = readFileSync(filePath, 'utf8');
        const lines = raw.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toMatchObject({
            v: 1,
            direction: 'outbound',
            sessionId: 'test-session-id',
            protocol: 'acp',
            provider: 'codex',
            kind: 'tool-call',
        });
    });

    it('sets isError on outbound ACP tool-result messages when output looks like an error', () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-apiSession-'));
        const filePath = join(dir, 'tool-trace.jsonl');
        process.env.HAPPY_STACKS_TOOL_TRACE = '1';
        process.env.HAPPY_STACKS_TOOL_TRACE_FILE = filePath;

        const client = new ApiSessionClient('fake-token', mockSession);
        client.sendAgentMessage('gemini', {
            type: 'tool-result',
            callId: 'call-1',
            output: { error: 'Tool call failed', status: 'failed' },
            id: 'msg-1',
        });

        const raw = readFileSync(filePath, 'utf8');
        const lines = raw.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toMatchObject({
            protocol: 'acp',
            provider: 'gemini',
            kind: 'tool-result',
            payload: expect.objectContaining({
                type: 'tool-result',
                isError: true,
            }),
        });
    });

    it('does not record outbound ACP non-tool messages when tool tracing is enabled', () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-apiSession-'));
        const filePath = join(dir, 'tool-trace.jsonl');
        process.env.HAPPY_STACKS_TOOL_TRACE = '1';
        process.env.HAPPY_STACKS_TOOL_TRACE_FILE = filePath;

        const client = new ApiSessionClient('fake-token', mockSession);
        client.sendAgentMessage('codex', {
            type: 'message',
            message: 'hello',
        });

        expect(existsSync(filePath)).toBe(false);
    });

    it('records Claude tool_use/tool_result blocks when tool tracing is enabled', () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-claude-'));
        const filePath = join(dir, 'tool-trace.jsonl');
        process.env.HAPPY_STACKS_TOOL_TRACE = '1';
        process.env.HAPPY_STACKS_TOOL_TRACE_FILE = filePath;

        const client = new ApiSessionClient('fake-token', mockSession);
        client.sendClaudeSessionMessage({
            type: 'assistant',
            uuid: 'uuid-1',
            message: {
                content: [
                    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/etc/hosts' } },
                    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
                ],
            },
        } as any);

        const raw = readFileSync(filePath, 'utf8');
        const lines = raw.trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0])).toMatchObject({
            v: 1,
            direction: 'outbound',
            sessionId: 'test-session-id',
            protocol: 'claude',
            provider: 'claude',
            kind: 'tool-call',
        });
        expect(JSON.parse(lines[1])).toMatchObject({
            v: 1,
            direction: 'outbound',
            sessionId: 'test-session-id',
            protocol: 'claude',
            provider: 'claude',
            kind: 'tool-result',
        });
    });

    it('records Claude tool_result blocks sent as user messages when tool tracing is enabled', () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-claude-user-tool-result-'));
        const filePath = join(dir, 'tool-trace.jsonl');
        process.env.HAPPY_STACKS_TOOL_TRACE = '1';
        process.env.HAPPY_STACKS_TOOL_TRACE_FILE = filePath;

        const session = { ...mockSession, id: 'test-session-id-user-tool-result' };
        const client = new ApiSessionClient('fake-token', session);
        client.sendClaudeSessionMessage({
            type: 'user',
            uuid: 'uuid-2',
            message: {
                content: [
                    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
                ],
            },
        } as any);

        const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
        const lines = raw.trim().length > 0 ? raw.trim().split('\n') : [];
        const parsed = lines.map((l) => JSON.parse(l));
        expect(parsed).toContainEqual(expect.objectContaining({
            v: 1,
            direction: 'outbound',
            sessionId: 'test-session-id-user-tool-result',
            protocol: 'claude',
            provider: 'claude',
            kind: 'tool-result',
            payload: expect.objectContaining({
                type: 'tool_result',
                tool_use_id: 'toolu_1',
            }),
        }));
    });

    it('does not record Claude user text messages when tool tracing is enabled', () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-claude-'));
        const filePath = join(dir, 'tool-trace.jsonl');
        process.env.HAPPY_STACKS_TOOL_TRACE = '1';
        process.env.HAPPY_STACKS_TOOL_TRACE_FILE = filePath;

        const client = new ApiSessionClient('fake-token', mockSession);
        client.sendClaudeSessionMessage({
            type: 'user',
            uuid: 'uuid-2',
            message: { content: 'hello' },
        } as any);

        expect(existsSync(filePath)).toBe(false);
    });

    it('should emit correct events on socket connection', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        // Should have set up event listeners
        expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('close closes both the session-scoped and user-scoped sockets', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        await client.close();

        expect(mockSocket.close).toHaveBeenCalledTimes(1);
        expect(mockUserSocket.close).toHaveBeenCalledTimes(1);
    });

    it('waitForMetadataUpdate ensures the user-scoped socket is connected so metadata updates can wake idle agents', async () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        const controller = new AbortController();
        const promise = client.waitForMetadataUpdate(controller.signal);

        expect(mockUserSocket.connect).toHaveBeenCalledTimes(1);

        controller.abort();
        await expect(promise).resolves.toBe(false);
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

	                it('waitForMetadataUpdate resolves when the user-scoped socket connects (wakes idle agents)', async () => {
	                    const client = new ApiSessionClient('fake-token', mockSession);

	                    const waitPromise = client.waitForMetadataUpdate();

	                    const connectHandlers = mockUserSocket.on.mock.calls
	                        .filter((call: any[]) => call[0] === 'connect')
	                        .map((call: any[]) => call[1]);
	                    const lastConnectHandler = connectHandlers[connectHandlers.length - 1];
	                    expect(typeof lastConnectHandler).toBe('function');

	                    lastConnectHandler();
	                    await expect(waitPromise).resolves.toBe(true);
	                });

            it('waitForMetadataUpdate resolves when session metadata updates (server sends update-session with id)', async () => {
                const client = new ApiSessionClient('fake-token', mockSession);

                const waitPromise = client.waitForMetadataUpdate();

                const updateHandler = (mockSocket.on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1];
                expect(typeof updateHandler).toBe('function');

                const nextMetadata = { ...mockSession.metadata, path: '/tmp/next2' };
                const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, nextMetadata));

                updateHandler({
                    id: 'update-2b',
                    seq: 3,
                    createdAt: Date.now(),
                    body: {
                        t: 'update-session',
                        id: mockSession.id,
                        metadata: {
                            version: 1,
                            value: encrypted,
                        },
                    },
                } as any);

	                await expect(waitPromise).resolves.toBe(true);
	            });

	            it('waitForMetadataUpdate resolves false when user-scoped socket disconnects', async () => {
	                const client = new ApiSessionClient('fake-token', mockSession);

	                const waitPromise = client.waitForMetadataUpdate();

	                const disconnectHandlers = mockUserSocket.on.mock.calls
	                    .filter((call: any[]) => call[0] === 'disconnect')
	                    .map((call: any[]) => call[1]);
	                const lastDisconnectHandler = disconnectHandlers[disconnectHandlers.length - 1];
	                expect(typeof lastDisconnectHandler).toBe('function');

	                lastDisconnectHandler();
	                await expect(waitPromise).resolves.toBe(false);
	            });

                it('waitForMetadataUpdate does not miss fast user-scoped update-session wakeups', async () => {
                    const client = new ApiSessionClient('fake-token', mockSession);

                    const updateHandler = (mockUserSocket.on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1];
                    expect(typeof updateHandler).toBe('function');

                    mockUserSocket.connect.mockImplementation(() => {
                        const nextMetadata = { ...mockSession.metadata, path: '/tmp/fast' };
                        const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, nextMetadata));
                        updateHandler({
                            id: 'update-fast',
                            seq: 999,
                            createdAt: Date.now(),
                            body: {
                                t: 'update-session',
                                sid: mockSession.id,
                                metadata: {
                                    version: 2,
                                    value: encrypted,
                                },
                            },
                        } as any);
                    });

                    const controller = new AbortController();
                    const promise = client.waitForMetadataUpdate(controller.signal);

                    queueMicrotask(() => controller.abort());
                    await expect(promise).resolves.toBe(true);
                });

                it('waitForMetadataUpdate does not miss snapshot sync updates started before handlers attach', async () => {
                    const client = new ApiSessionClient('fake-token', mockSession);

                    (client as any).metadataVersion = -1;
                    (client as any).agentStateVersion = -1;

                    (client as any).syncSessionSnapshotFromServer = () => {
                        (client as any).metadataVersion = 1;
                        (client as any).agentStateVersion = 1;
                        client.emit('metadata-updated');
                        return Promise.resolve();
                    };

                    const promise = client.waitForMetadataUpdate();
                    await expect(
                        Promise.race([
                            promise,
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('waitForMetadataUpdate() hung after snapshot sync')), 50)
                            )
                        ])
                    ).resolves.toBe(true);
                });

	            it('updateMetadata syncs a snapshot first when metadataVersion is unknown', async () => {
	                const sessionSocket: any = {
	                    connected: false,
                    connect: vi.fn(),
                    on: vi.fn(),
                    off: vi.fn(),
                    disconnect: vi.fn(),
                    close: vi.fn(),
                    emit: vi.fn(),
                };

                const userSocket: any = {
                    connected: false,
                    connect: vi.fn(),
                    on: vi.fn(),
                    off: vi.fn(),
                    disconnect: vi.fn(),
                    close: vi.fn(),
                    emit: vi.fn(),
                };

                const serverMetadata = {
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
                const encryptedServerMetadata = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, serverMetadata));

                const emitWithAck = vi.fn().mockResolvedValueOnce({
                    result: 'success',
                    version: 6,
                    metadata: encryptedServerMetadata,
                });
                sessionSocket.emitWithAck = emitWithAck;

                mockIo.mockReset();
                mockIo
                    .mockImplementationOnce(() => sessionSocket)
                    .mockImplementationOnce(() => userSocket);

                const axiosMod = await import('axios');
                const axios = axiosMod.default as any;
                vi.spyOn(axios, 'get').mockResolvedValueOnce({
                    data: {
                        sessions: [{
                            id: mockSession.id,
                            metadataVersion: 5,
                            metadata: encryptedServerMetadata,
                            agentStateVersion: 0,
                            agentState: null,
                        }],
                    },
                });

                const client = new ApiSessionClient('fake-token', {
                    ...mockSession,
                    metadataVersion: -1,
                    metadata: {
                        ...mockSession.metadata,
                        messageQueueV1: { v: 1, queue: [] },
                    },
                });

                let observedQueuedMessage = false;
                client.updateMetadata((metadata) => {
                    const mq = (metadata as any).messageQueueV1;
                    observedQueuedMessage = Array.isArray(mq?.queue) && mq.queue.length === 1;
                    return metadata;
                });

                await vi.waitFor(() => {
                    expect(observedQueuedMessage).toBe(true);
                    expect(emitWithAck).toHaveBeenCalledWith(
                        'update-metadata',
                        expect.objectContaining({ expectedVersion: 5 }),
                    );
                });
            });

		    it('clears messageQueueV1 inFlight only after observing the materialized user message', async () => {
			        const sessionSocket: any = {
			            connected: true,
			            connect: vi.fn(),
			            on: vi.fn(),
			            off: vi.fn(),
			            disconnect: vi.fn(),
			            emit: vi.fn(),
			        };

			        const userSocket: any = {
			            connected: true,
			            connect: vi.fn(),
			            on: vi.fn(),
			            off: vi.fn(),
			            disconnect: vi.fn(),
			            emit: vi.fn(),
			        };

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

		        sessionSocket.emitWithAck = emitWithAck;

			        mockIo.mockReset();
			        mockIo
			            .mockImplementationOnce(() => sessionSocket)
			            .mockImplementationOnce(() => userSocket);

			        // Recreate client with our two-socket setup.
			        const clientWithTwoSockets = new ApiSessionClient('fake-token', {
			            ...mockSession,
			            metadata: metadataBase,
			        });

		        const popped = await clientWithTwoSockets.popPendingMessage();
		        expect(popped).toBe(true);

		        // Should have emitted the transcript message but NOT yet cleared inFlight.
		        expect(sessionSocket.emit).toHaveBeenCalledWith('message', expect.objectContaining({ localId: 'local-p1' }));
		        expect(emitWithAck).toHaveBeenCalledTimes(1);

		        const userUpdateHandler = (userSocket.on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1];
		        expect(typeof userUpdateHandler).toBe('function');

		        const plaintext = {
		            role: 'user',
		            content: { type: 'text', text: 'hello' },
		        };
		        const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, plaintext));

		        // Simulate server broadcast of the materialized message with the same localId (arriving on user-scoped socket).
		        userUpdateHandler({
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

            it('recovers an already-inFlight queued message by fetching the transcript (no server echo required)', async () => {
                const sessionSocket: any = {
                    connected: true,
                    connect: vi.fn(),
                    on: vi.fn(),
                    off: vi.fn(),
                    disconnect: vi.fn(),
                    emit: vi.fn(),
                };

                const userSocket: any = {
                    connected: true,
                    connect: vi.fn(),
                    on: vi.fn(),
                    off: vi.fn(),
                    disconnect: vi.fn(),
                    emit: vi.fn(),
                };

                mockIo.mockReset();
                mockIo
                    .mockImplementationOnce(() => sessionSocket)
                    .mockImplementationOnce(() => userSocket);

                const metadataBase = {
                    ...mockSession.metadata,
                    messageQueueV1: {
                        v: 1,
                        queue: [],
                        inFlight: {
                            localId: 'local-inflight-1',
                            message: 'encrypted-user-record',
                            createdAt: 1,
                            updatedAt: 1,
                            claimedAt: Date.now(),
                        },
                    },
                };

                const plaintext = {
                    role: 'user',
                    content: { type: 'text', text: 'hello' },
                };
                const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, plaintext));

                const axiosMod = await import('axios');
                const axios = axiosMod.default as any;
                vi.spyOn(axios, 'get').mockResolvedValueOnce({
                    data: {
                        messages: [{
                            id: 'msg-xyz',
                            seq: 1,
                            localId: 'local-inflight-1',
                            content: { t: 'encrypted', c: encrypted },
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                        }],
                    },
                });

                const emitWithAck = vi.fn().mockResolvedValueOnce({
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
                sessionSocket.emitWithAck = emitWithAck;

                const client = new ApiSessionClient('fake-token', {
                    ...mockSession,
                    metadata: metadataBase,
                });

                const popped = await client.popPendingMessage();
                expect(popped).toBe(true);

                // Should not re-emit the transcript message when it already exists.
                expect(sessionSocket.emit).not.toHaveBeenCalledWith('message', expect.anything());

                // Allow queued async clear to run.
                await new Promise((r) => setTimeout(r, 0));
                expect(emitWithAck).toHaveBeenCalledTimes(1);
            });

            it('syncs a server snapshot on connect for resumed sessions (metadataVersion=-1) so queued messages enqueued before attach can be popped', async () => {
                const sessionSocket: any = {
                    connected: true,
                    connect: vi.fn(),
                    on: vi.fn(),
                    off: vi.fn(),
                    disconnect: vi.fn(),
                    close: vi.fn(),
                    emit: vi.fn(),
                };

                const userSocket: any = {
                    connected: false,
                    connect: vi.fn(),
                    on: vi.fn(),
                    off: vi.fn(),
                    disconnect: vi.fn(),
                    close: vi.fn(),
                    emit: vi.fn(),
                };

                mockIo.mockReset();
                mockIo
                    .mockImplementationOnce(() => sessionSocket)
                    .mockImplementationOnce(() => userSocket);

                const serverMetadata = {
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

                const axiosMod = await import('axios');
                const axios = axiosMod.default as any;
                vi.spyOn(axios, 'get').mockResolvedValueOnce({
                    data: {
                        sessions: [{
                            id: mockSession.id,
                            seq: 0,
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                            active: true,
                            activeAt: Date.now(),
                            metadata: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, serverMetadata)),
                            metadataVersion: 10,
                            agentState: null,
                            agentStateVersion: 0,
                            dataEncryptionKey: null,
                            lastMessage: null,
                        }],
                    },
                });

                const emitWithAck = vi.fn().mockResolvedValueOnce({
                    result: 'success',
                    version: 11,
                    metadata: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
                        ...serverMetadata,
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
                });
                sessionSocket.emitWithAck = emitWithAck;

                const client = new ApiSessionClient('fake-token', {
                    ...mockSession,
                    metadata: { ...mockSession.metadata },
                    metadataVersion: -1,
                    agentStateVersion: -1,
                });

                // Simulate socket.io connect event (resume/reattach).
                const connectHandler = (sessionSocket.on.mock.calls.find((call: any[]) => call[0] === 'connect') ?? [])[1];
                expect(typeof connectHandler).toBe('function');
                connectHandler();

                // Allow snapshot sync to run.
                await new Promise((r) => setTimeout(r, 0));

                const popped = await client.popPendingMessage();
                expect(popped).toBe(true);

                expect(sessionSocket.emit).toHaveBeenCalledWith('message', expect.objectContaining({ localId: 'local-p1' }));
                expect(emitWithAck).toHaveBeenCalledTimes(1);
            });

	    afterEach(() => {
	        consoleSpy.mockRestore();
	        vi.restoreAllMocks();
	    });
});
