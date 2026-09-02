import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiSessionClient } from './apiSession';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import type { Update } from './types';

const {
    mockIo,
    mockAxiosGet,
    mockAxiosPost,
    mockBackoff,
    mockDelay,
    mockShouldReconnect
} = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockAxiosGet: vi.fn(),
    mockAxiosPost: vi.fn(),
    mockBackoff: vi.fn(async <T>(callback: () => Promise<T>) => {
        let lastError: unknown;
        for (let i = 0; i < 20; i += 1) {
            try {
                return await callback();
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError;
    }),
    mockDelay: vi.fn(async () => undefined),
    mockShouldReconnect: vi.fn(() => true)
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('axios', () => ({
    default: {
        get: mockAxiosGet,
        post: mockAxiosPost
    }
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'https://server.test'
    }
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
    }
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn()
}));

vi.mock('@/utils/time', () => ({
    backoff: mockBackoff,
    delay: mockDelay
}));

vi.mock('@/utils/lidState', () => ({
    shouldReconnect: mockShouldReconnect
}));

type SocketHandler = (...args: any[]) => void;
type SocketHandlers = Record<string, SocketHandler[]>;

function makeSession() {
    return {
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
}

function encryptContent(session: ReturnType<typeof makeSession>, content: unknown): string {
    return encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, content));
}

function createNewMessageUpdate(seq: number, encryptedContent: string): Update {
    return {
        id: `upd-${seq}`,
        seq,
        createdAt: Date.now(),
        body: {
            t: 'new-message',
            sid: 'test-session-id',
            message: {
                id: `msg-${seq}`,
                seq,
                localId: null,
                content: {
                    t: 'encrypted',
                    c: encryptedContent
                },
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }
        }
    };
}

async function waitForCheck(check: () => void, timeoutMs = 2000) {
    const startedAt = Date.now();
    let lastError: unknown;
    while (Date.now() - startedAt < timeoutMs) {
        try {
            check();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
    throw lastError;
}

describe('ApiSessionClient v3 messages API migration', () => {
    let socketHandlers: SocketHandlers;
    let mockSocket: any;
    let session: ReturnType<typeof makeSession>;

    const emitSocketEvent = (event: string, ...args: any[]) => {
        const handlers = socketHandlers[event] || [];
        handlers.forEach((handler) => handler(...args));
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockShouldReconnect.mockReturnValue(true);
        socketHandlers = {};
        session = makeSession();
        mockSocket = {
            connected: true,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: SocketHandler) => {
                if (!socketHandlers[event]) {
                    socketHandlers[event] = [];
                }
                socketHandlers[event].push(handler);
            }),
            off: vi.fn(),
            emit: vi.fn(),
            emitWithAck: vi.fn(async () => ({ result: 'error' })),
            volatile: {
                emit: vi.fn()
            },
            close: vi.fn()
        };

        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('registers core socket handlers and connects', () => {
        new ApiSessionClient('fake-token', session);

        expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('update', expect.any(Function));
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);
    });

    it('retries after initial socket connection error', async () => {
        vi.useFakeTimers();
        mockSocket.connected = false;

        const client = new ApiSessionClient('fake-token', session);

        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(3000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(3);

        await client.close();
    });

    it('queues codex message to v3 outbox, sends once, and drains outbox', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [
                    {
                        id: 'msg-1',
                        seq: 1,
                        localId: 'local-1',
                        createdAt: 1,
                        updatedAt: 1
                    }
                ]
            }
        });

        client.sendCodexMessage({ type: 'delta', text: 'hello' });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        expect(payload.messages).toHaveLength(1);
        expect(typeof payload.messages[0].localId).toBe('string');
        expect((client as any).pendingOutbox).toHaveLength(0);
        expect((client as any).lastSeq).toBe(0);

        const decrypted = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );
        expect(decrypted).toEqual({
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'delta', text: 'hello' }
            },
            meta: {
                sentFrom: 'cli'
            }
        });
    });

    it('rejects strict outbox flush when delivery is not acknowledged', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockImplementationOnce(() => new Promise(() => {}));

        client.sendCodexMessage({ type: 'never-acknowledged' });
        const assertion = expect(client.flushOutboxAndAwait(10)).rejects.toThrow(
            'Timed out waiting for session outbox after 10ms',
        );

        await assertion;
        expect((client as any).pendingOutbox).toHaveLength(1);
        await client.close();
    });

    it('accumulates multiple pending outbox messages into one follow-up batch', async () => {
        const client = new ApiSessionClient('fake-token', session);

        type PostResponse = {
            data: {
                messages: Array<{ id: string; seq: number; localId: string; createdAt: number; updatedAt: number }>;
            };
        };
        let resolveFirstPost!: (value: PostResponse) => void;
        mockAxiosPost
            .mockImplementationOnce(() => new Promise<PostResponse>((resolve) => {
                resolveFirstPost = resolve;
            }))
            .mockResolvedValueOnce({
                data: {
                    messages: [
                        { id: 'msg-2', seq: 2, localId: 'local-2', createdAt: 2, updatedAt: 2 },
                        { id: 'msg-3', seq: 3, localId: 'local-3', createdAt: 3, updatedAt: 3 }
                    ]
                }
            });

        client.sendCodexMessage({ type: 'first' });
        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        client.sendCodexMessage({ type: 'second' });
        client.sendCodexMessage({ type: 'third' });

        resolveFirstPost({
            data: {
                messages: [
                    { id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }
                ]
            }
        });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(2);
        });

        const secondPayload = mockAxiosPost.mock.calls[1][1];
        expect(secondPayload.messages).toHaveLength(2);
        expect((client as any).pendingOutbox).toHaveLength(0);
        expect((client as any).lastSeq).toBe(0);
    });

    it('retries failed POST and succeeds without dropping queued messages', async () => {
        const client = new ApiSessionClient('fake-token', session);

        mockAxiosPost
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValueOnce({
                data: {
                    messages: [
                        { id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }
                    ]
                }
            });

        client.sendCodexMessage({ type: 'retry-me' });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(2);
        });

        const firstPayload = mockAxiosPost.mock.calls[0][1];
        const secondPayload = mockAxiosPost.mock.calls[1][1];
        expect(secondPayload).toEqual(firstPayload);
        expect((client as any).pendingOutbox).toHaveLength(0);
        expect((client as any).lastSeq).toBe(0);
    });

    it('sends claude user text as modern session envelope', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.sendClaudeSessionMessage({
            type: 'user',
            message: { content: 'hi there' },
            isSidechain: false,
            isMeta: false
        } as any);

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        expect(payload.messages).toHaveLength(1);

        const sessionUser = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );
        expect(sessionUser).toMatchObject({
            role: 'session',
            content: {
                role: 'user',
                ev: {
                    t: 'text',
                    text: 'hi there'
                }
            },
            meta: {
                sentFrom: 'cli'
            }
        });
        expect(typeof (sessionUser as any).content.time).toBe('number');
    });

    it('sends session protocol messages through enqueueMessage with session envelope', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        const envelope = {
            id: 'env-1',
            time: 1000,
            role: 'agent' as const,
            turn: 'turn-1',
            ev: { t: 'text' as const, text: 'hello from session protocol' }
        };
        client.sendSessionProtocolMessage(envelope);

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        expect(payload.messages[0].localId).toBe('session-envelope:env-1');
        const decrypted = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );

        expect(decrypted).toEqual({
            role: 'session',
            content: envelope,
            meta: {
                sentFrom: 'cli'
            }
        });
    });

    it('uploads historical session envelopes oldest-first in server-sized batches', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockImplementation(async (_url: string, payload: { messages: Array<{ localId: string }> }) => ({
            data: {
                messages: payload.messages.map((message, index) => ({
                    id: `msg-${message.localId}`,
                    seq: index + 1,
                    localId: message.localId,
                    createdAt: index + 1,
                    updatedAt: index + 1,
                })),
            },
        }));

        const envelopes = Array.from({ length: 205 }, (_, index) => ({
            id: `history-${String(index + 1).padStart(3, '0')}`,
            time: index + 1,
            role: 'agent' as const,
            turn: `turn-${index + 1}`,
            ev: { t: 'text' as const, text: `historical message ${index + 1}` },
        }));

        await client.sendSessionProtocolHistoryAndAwait(envelopes);

        expect(mockAxiosPost).toHaveBeenCalledTimes(3);
        expect(mockAxiosPost.mock.calls.map(([, payload]) => payload.messages.length)).toEqual([100, 100, 5]);

        const uploadedEnvelopeIds = mockAxiosPost.mock.calls.flatMap(([, payload]) => (
            payload.messages.map((message: { content: string }) => {
                const decrypted = decrypt(
                    session.encryptionKey,
                    session.encryptionVariant,
                    decodeBase64(message.content),
                ) as { content: { id: string } };
                return decrypted.content.id;
            })
        ));
        expect(uploadedEnvelopeIds).toEqual(envelopes.map((envelope) => envelope.id));
    });

    it('persists only the final root lifecycle while replaying historical turns', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });
        mockSocket.emitWithAck.mockImplementation(async (_event: string, payload: any) => ({
            result: 'success',
            version: 1,
            agentState: payload.agentState,
        }));

        await client.sendSessionProtocolHistoryAndAwait([
            { id: 'start-1', time: 100, role: 'agent', turn: 'turn-1', ev: { t: 'turn-start' } },
            { id: 'end-1', time: 101, role: 'agent', turn: 'turn-1', ev: { t: 'turn-end', status: 'completed' } },
            { id: 'start-2', time: 200, role: 'agent', turn: 'turn-2', ev: { t: 'turn-start' } },
            { id: 'end-2', time: 201, role: 'agent', turn: 'turn-2', ev: { t: 'turn-end', status: 'failed' } },
        ]);

        expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(mockAxiosPost.mock.invocationCallOrder.at(-1))
            .toBeLessThan(mockSocket.emitWithAck.mock.invocationCallOrder[0]);
        expect(decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(mockSocket.emitWithAck.mock.calls[0][1].agentState),
        )).toEqual({
            turnStatus: { status: 'failed', updatedAt: 201, turnId: 'turn-2' },
        });
    });

    it('sends only modern payload for user session envelopes', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.sendSessionProtocolMessage({
            id: 'env-user-1',
            time: 1001,
            role: 'user',
            ev: { t: 'text', text: 'shadow this' }
        });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        expect(payload.messages).toHaveLength(1);

        const sessionUser = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );
        expect(sessionUser).toMatchObject({
            role: 'session',
            content: {
                id: 'env-user-1',
                time: 1001,
                role: 'user',
                ev: { t: 'text', text: 'shadow this' }
            }
        });
    });

    it('sends modern session envelope for user text', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.sendSessionProtocolMessage({
            id: 'env-user-flag-on-1',
            time: 1002,
            role: 'user',
            ev: { t: 'text', text: 'session only' }
        });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        expect(payload.messages).toHaveLength(1);

        const sessionOnly = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );

        expect(sessionOnly).toMatchObject({
            role: 'session',
            content: {
                role: 'user',
                ev: { t: 'text', text: 'session only' }
            },
            meta: {
                sentFrom: 'cli'
            }
        });
        expect(typeof (sessionOnly as any).content.time).toBe('number');
    });

    it('sends ACP agent messages through enqueueMessage', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.sendAgentMessage('codex', {
            type: 'message',
            message: 'hi'
        });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        const decrypted = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );

        expect(decrypted).toEqual({
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'codex',
                data: {
                    type: 'message',
                    message: 'hi'
                }
            },
            meta: {
                sentFrom: 'cli'
            }
        });
    });

    it('sends session events through enqueueMessage', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.sendSessionEvent({ type: 'ready' }, 'event-1');

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        const decrypted = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );

        expect(decrypted).toEqual({
            role: 'agent',
            content: {
                id: 'event-1',
                type: 'event',
                data: {
                    type: 'ready'
                }
            }
        });
    });

    it('waits for the server acknowledgement before resolving an agent state update', async () => {
        const client = new ApiSessionClient('fake-token', session);
        let releaseAck!: () => void;
        const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
        mockSocket.emitWithAck.mockImplementation(async (_event: string, payload: any) => {
            await ackGate;
            return {
                result: 'success',
                version: 1,
                agentState: payload.agentState,
            };
        });

        let settled = false;
        const update = client.updateAgentState((state) => ({ ...state, queuedMessages: 1 }))
            .then(() => { settled = true; });

        await waitForCheck(() => expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(1));
        expect(settled).toBe(false);
        releaseAck();
        await update;
        expect(settled).toBe(true);
    });

    it('persists root protocol lifecycle outcomes and keeps them after the normal ready event', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });
        let version = 0;
        mockSocket.emitWithAck.mockImplementation(async (event: string, payload: any) => {
            if (event !== 'update-state') return { result: 'error' };
            version += 1;
            return { result: 'success', version, agentState: payload.agentState };
        });

        client.sendSessionProtocolMessage({
            id: 'start-1', time: 100, role: 'agent', turn: 'turn-1', ev: { t: 'turn-start' },
        });
        client.sendSessionProtocolMessage({
            id: 'end-1', time: 101, role: 'agent', turn: 'turn-1', ev: { t: 'turn-end', status: 'completed' },
        });

        await waitForCheck(() => expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(2));
        const terminalPayload = mockSocket.emitWithAck.mock.calls[1][1];
        expect(decrypt(session.encryptionKey, session.encryptionVariant, decodeBase64(terminalPayload.agentState))).toEqual({
            turnStatus: { status: 'completed', updatedAt: 101, turnId: 'turn-1' },
        });

        client.sendSessionEvent({ type: 'ready' });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(2);
    });

    it('ignores subagent lifecycle envelopes for the root persisted status', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });

        client.sendSessionProtocolMessage({
            id: 'child-start',
            time: 100,
            role: 'agent',
            turn: 'child-turn',
            subagent: 'child-1',
            ev: { t: 'turn-start' },
        });
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(mockSocket.emitWithAck).not.toHaveBeenCalled();
    });

    it('fresh ready clears stale running while preserving permission state through a version retry', async () => {
        (session as any).agentState = { turnStatus: { status: 'running', updatedAt: 50, turnId: 'stale-turn' } };
        session.agentStateVersion = 2;
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });
        const latest = {
            requests: { permission: { tool: 'Bash', arguments: {}, createdAt: 1 } },
            turnStatus: { status: 'running', updatedAt: 50, turnId: 'stale-turn' },
        };
        mockSocket.emitWithAck
            .mockResolvedValueOnce({
                result: 'version-mismatch',
                version: 3,
                agentState: encryptContent(session, latest),
            })
            .mockImplementationOnce(async (_event: string, payload: any) => ({
                result: 'success',
                version: 4,
                agentState: payload.agentState,
            }));

        client.sendSessionEvent({ type: 'ready' });

        await waitForCheck(() => expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(2));
        expect(mockSocket.emitWithAck.mock.calls[1][1].expectedVersion).toBe(3);
        expect(decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(mockSocket.emitWithAck.mock.calls[1][1].agentState),
        )).toEqual({ requests: latest.requests });
    });

    it('maps legacy Gemini aborts conservatively while preserving explicit failures', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });
        mockSocket.emitWithAck.mockImplementation(async (_event: string, payload: any) => ({
            result: 'success',
            version: 1,
            agentState: payload.agentState,
        }));

        client.sendAgentMessage('gemini', { type: 'turn_aborted', id: 'legacy-abort' });
        await waitForCheck(() => expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(1));
        expect(decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(mockSocket.emitWithAck.mock.calls[0][1].agentState),
        )).toEqual({
            turnStatus: expect.objectContaining({ status: 'cancelled', turnId: 'legacy-abort' }),
        });

        client.sendAgentMessage('gemini', { type: 'turn_aborted', id: 'error-abort', status: 'failed' });
        await waitForCheck(() => expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(2));
        expect(decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(mockSocket.emitWithAck.mock.calls[1][1].agentState),
        )).toEqual({
            turnStatus: expect.objectContaining({ status: 'failed', turnId: 'error-abort' }),
        });
    });

    it('fetchMessages uses after_seq=0 initially and routes user messages to callback', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const userMessage = {
            role: 'user',
            content: {
                type: 'text',
                text: 'from fetch'
            }
        };

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [
                    {
                        id: 'msg-1',
                        seq: 1,
                        content: {
                            t: 'encrypted',
                            c: encryptContent(session, userMessage)
                        },
                        localId: null,
                        createdAt: 1000,
                        updatedAt: 1000
                    }
                ],
                hasMore: false
            }
        });

        await (client as any).fetchMessages();

        expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        expect(mockAxiosGet.mock.calls[0][0]).toBe('https://server.test/v3/sessions/test-session-id/messages');
        expect(mockAxiosGet.mock.calls[0][1].params).toEqual({
            after_seq: 0,
            limit: 100
        });
        expect(onUserMessage).toHaveBeenCalledWith(userMessage);
        expect((client as any).lastSeq).toBe(1);
    });

    it('fetchMessages uses incremental cursor and paginates while hasMore is true', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        (client as any).lastSeq = 2;

        const message3 = {
            role: 'user',
            content: { type: 'text', text: 'm3' }
        };
        const message4 = {
            role: 'user',
            content: { type: 'text', text: 'm4' }
        };

        mockAxiosGet
            .mockResolvedValueOnce({
                data: {
                    messages: [
                        {
                            id: 'msg-3',
                            seq: 3,
                            content: { t: 'encrypted', c: encryptContent(session, message3) },
                            localId: null,
                            createdAt: 3000,
                            updatedAt: 3000
                        }
                    ],
                    hasMore: true
                }
            })
            .mockResolvedValueOnce({
                data: {
                    messages: [
                        {
                            id: 'msg-4',
                            seq: 4,
                            content: { t: 'encrypted', c: encryptContent(session, message4) },
                            localId: null,
                            createdAt: 4000,
                            updatedAt: 4000
                        }
                    ],
                    hasMore: false
                }
            });

        await (client as any).fetchMessages();

        expect(mockAxiosGet).toHaveBeenCalledTimes(2);
        expect(mockAxiosGet.mock.calls[0][1].params.after_seq).toBe(2);
        expect(mockAxiosGet.mock.calls[1][1].params.after_seq).toBe(3);
        expect(onUserMessage).toHaveBeenCalledTimes(2);
        expect((client as any).lastSeq).toBe(4);
    });

    it('fetchMessages stops pagination when hasMore is true but seq cursor does not advance', async () => {
        const client = new ApiSessionClient('fake-token', session);
        (client as any).lastSeq = 2;

        mockAxiosGet
            .mockResolvedValueOnce({
                data: {
                    messages: [],
                    hasMore: true
                }
            })
            .mockRejectedValueOnce(new Error('should not request another page when cursor is stalled'));

        await expect((client as any).fetchMessages()).resolves.toBeUndefined();

        expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        expect(mockAxiosGet.mock.calls[0][1].params.after_seq).toBe(2);
        expect((client as any).lastSeq).toBe(2);
    });

    it('routes non-user fetched messages through EventEmitter message event', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        const onMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        client.on('message', onMessage);

        const userMessage = {
            role: 'user',
            content: { type: 'text', text: 'user text' }
        };
        const agentMessage = {
            role: 'agent',
            content: {
                type: 'output',
                data: { answer: 'agent response' }
            }
        };

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [
                    {
                        id: 'msg-1',
                        seq: 1,
                        content: { t: 'encrypted', c: encryptContent(session, userMessage) },
                        localId: null,
                        createdAt: 1000,
                        updatedAt: 1000
                    },
                    {
                        id: 'msg-2',
                        seq: 2,
                        content: { t: 'encrypted', c: encryptContent(session, agentMessage) },
                        localId: null,
                        createdAt: 2000,
                        updatedAt: 2000
                    }
                ],
                hasMore: false
            }
        });

        await (client as any).fetchMessages();

        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith(userMessage);
        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(onMessage).toHaveBeenCalledWith(agentMessage);
    });

    it('applies consecutive new-message updates directly (fast path)', () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        (client as any).lastSeq = 1;
        const userMessage = {
            role: 'user',
            content: { type: 'text', text: 'fast-path' }
        };

        emitSocketEvent('update', createNewMessageUpdate(2, encryptContent(session, userMessage)));

        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith(userMessage);
        expect((client as any).lastSeq).toBe(2);
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('invalidates receive sync and fetches on seq gap', async () => {
        const client = new ApiSessionClient('fake-token', session);
        (client as any).lastSeq = 1;

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [],
                hasMore: false
            }
        });

        emitSocketEvent('update', createNewMessageUpdate(3, encryptContent(session, {
            role: 'user',
            content: { type: 'text', text: 'gap' }
        })));

        await waitForCheck(() => {
            expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        });
        expect(mockAxiosGet.mock.calls[0][1].params.after_seq).toBe(1);
    });

    it('invalidates receive sync on first message when lastSeq is 0', async () => {
        const client = new ApiSessionClient('fake-token', session);

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [],
                hasMore: false
            }
        });

        emitSocketEvent('update', createNewMessageUpdate(1, encryptContent(session, {
            role: 'user',
            content: { type: 'text', text: 'first' }
        })));

        await waitForCheck(() => {
            expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        });
        expect(mockAxiosGet.mock.calls[0][1].params.after_seq).toBe(0);
    });

    it('invalidates receive sync for duplicate and stale seq values', async () => {
        const client = new ApiSessionClient('fake-token', session);
        (client as any).lastSeq = 5;

        mockAxiosGet.mockResolvedValue({
            data: {
                messages: [],
                hasMore: false
            }
        });

        emitSocketEvent('update', createNewMessageUpdate(5, encryptContent(session, {
            role: 'user',
            content: { type: 'text', text: 'duplicate' }
        })));
        emitSocketEvent('update', createNewMessageUpdate(4, encryptContent(session, {
            role: 'user',
            content: { type: 'text', text: 'stale' }
        })));

        await waitForCheck(() => {
            expect(mockAxiosGet).toHaveBeenCalledTimes(2);
        });
        expect(mockAxiosGet.mock.calls[0][1].params.after_seq).toBe(5);
        expect(mockAxiosGet.mock.calls[1][1].params.after_seq).toBe(5);
    });

    it('keeps the receive cursor unchanged after successful outbox flush', async () => {
        const client = new ApiSessionClient('fake-token', session);
        (client as any).lastSeq = 10;

        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-9', seq: 9, localId: 'l9', createdAt: 9, updatedAt: 9 }]
            }
        });

        client.sendCodexMessage({ type: 'older' });
        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });
        expect((client as any).lastSeq).toBe(10);

        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-11', seq: 11, localId: 'l11', createdAt: 11, updatedAt: 11 }]
            }
        });

        client.sendCodexMessage({ type: 'newer' });
        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(2);
        });
        expect((client as any).lastSeq).toBe(10);
    });

    it('does not skip an in-flight user message when outbound messages receive later seqs first', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        (client as any).lastSeq = 10;

        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-12', seq: 12, localId: 'agent-out', createdAt: 12, updatedAt: 12 }]
            }
        });

        client.sendCodexMessage({ type: 'agent-output-after-user-message' });
        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const queuedUserMessage = {
            role: 'user',
            content: { type: 'text', text: 'queued while codex was running' }
        };

        emitSocketEvent('update', createNewMessageUpdate(11, encryptContent(session, queuedUserMessage)));

        await waitForCheck(() => {
            expect(onUserMessage).toHaveBeenCalledTimes(1);
        });
        expect(onUserMessage).toHaveBeenCalledWith(queuedUserMessage);
    });

    it('flushOutbox tolerates missing response.data.messages and keeps lastSeq unchanged', async () => {
        const client = new ApiSessionClient('fake-token', session);
        (client as any).lastSeq = 7;

        mockAxiosPost.mockResolvedValueOnce({
            data: {}
        });

        client.sendCodexMessage({ type: 'no-messages-field' });
        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        expect((client as any).lastSeq).toBe(7);
        expect((client as any).pendingOutbox).toHaveLength(0);
    });

    it('triggers receive catch-up fetch on socket reconnect', async () => {
        new ApiSessionClient('fake-token', session);

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [],
                hasMore: false
            }
        });

        emitSocketEvent('connect');

        await waitForCheck(() => {
            expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        });
        expect(mockAxiosGet.mock.calls[0][1].params.after_seq).toBe(0);
    });

    it('downloads a presigned S3 attachment URL without bearer auth', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const presignedUrl = 'https://bucket.oss-cn-hangzhou.aliyuncs.com/sessions/test-session-id/attachments/a.enc?X-Amz-Signature=sig';
        const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(new Uint8Array([1, 2, 3])),
        );

        mockAxiosPost.mockResolvedValueOnce({ data: { downloadUrl: presignedUrl } });

        const data = await client.downloadAttachment('sessions/test-session-id/attachments/a.enc');

        expect(mockAxiosPost).toHaveBeenCalledWith(
            'https://server.test/v1/sessions/test-session-id/attachments/request-download',
            { ref: 'sessions/test-session-id/attachments/a.enc' },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer fake-token' }),
            }),
        );
        expect(data).toEqual(new Uint8Array([1, 2, 3]));
        expect(mockAxiosGet).not.toHaveBeenCalled();
        expect(mockFetch).toHaveBeenCalledWith(
            presignedUrl,
            expect.objectContaining({
                headers: {},
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it('keeps bearer auth and normal proxy behavior for server-hosted attachment downloads', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const downloadUrl = 'https://server.test/v1/sessions/test-session-id/attachments/a.enc';
        const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(new Uint8Array([1, 2, 3])),
        );

        mockAxiosPost.mockResolvedValueOnce({ data: { downloadUrl } });

        const data = await client.downloadAttachment('sessions/test-session-id/attachments/a.enc');

        expect(data).toEqual(new Uint8Array([1, 2, 3]));
        expect(mockAxiosGet).not.toHaveBeenCalled();
        expect(mockFetch).toHaveBeenCalledWith(
            downloadUrl,
            expect.objectContaining({
                headers: { Authorization: 'Bearer fake-token' },
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it('stops send and receive sync loops on close', async () => {
        const client = new ApiSessionClient('fake-token', session);
        await client.close();

        mockAxiosGet.mockResolvedValue({
            data: {
                messages: [],
                hasMore: false
            }
        });
        mockAxiosPost.mockResolvedValue({
            data: {
                messages: []
            }
        });

        emitSocketEvent('update', createNewMessageUpdate(1, encryptContent(session, {
            role: 'user',
            content: { type: 'text', text: 'after-close' }
        })));
        client.sendCodexMessage({ type: 'after-close-send' });

        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(mockSocket.close).toHaveBeenCalledTimes(1);
        expect(mockAxiosGet).not.toHaveBeenCalled();
        expect(mockAxiosPost).not.toHaveBeenCalled();
    });
});
