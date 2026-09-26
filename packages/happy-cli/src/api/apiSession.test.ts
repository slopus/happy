import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiSessionClient, toolCallStartLaunchesBackgroundJob } from './apiSession';
import { buildInitialPromptUserRecord } from '@/utils/initialPrompt';
import { decodeBase64, decrypt, decryptBlob, encodeBase64, encrypt } from './encryption';
import type { Metadata, Update } from './types';
import { logger } from '@/ui/logger';
import { RECONNECT_NOT_READY_POLL_MS } from './reconnectCadence';

const {
    mockIo,
    mockAxiosGet,
    mockAxiosPost,
    mockAxiosPut,
    mockBackoff,
    mockDelay,
    mockShouldReconnect,
    mockNotifyDaemonSessionRuntime
} = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockAxiosGet: vi.fn(),
    mockAxiosPost: vi.fn(),
    mockAxiosPut: vi.fn(),
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
    mockShouldReconnect: vi.fn(() => true),
    mockNotifyDaemonSessionRuntime: vi.fn(async () => ({ status: 'ok' }))
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('axios', () => ({
    default: {
        get: mockAxiosGet,
        post: mockAxiosPost,
        put: mockAxiosPut
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
    delay: mockDelay,
    isSessionGoneError: (e: unknown) => {
        const status = (e as { response?: { status?: number } })?.response?.status;
        return status === 404 || status === 410;
    }
}));

vi.mock('@/utils/lidState', () => ({
    shouldReconnect: mockShouldReconnect
}));

vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionRuntime: mockNotifyDaemonSessionRuntime
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
        } as Metadata,
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

    // 2026-09-05 프로덕션 — 리뷰 워커가 turn 을 끝내고 정리까지 마쳤는데
    // (sendSessionDeath → flush → close → client.disconnect → happyServer.stop)
    // 프로세스가 2시간 11분 살아남았다. close() 가 socket.close() 를 부르면 그
    // 'disconnect' 핸들러가 startSmartReconnect() 를 걸어, 1초 뒤 소켓이 다시
    // 붙는다. 살아있는 소켓이 이벤트 루프를 붙잡아 run-once 세션이 끝나지 못했고,
    // 그 프로세스가 worktree 를 점유해 그 저장소의 리뷰 큐가 통째로 멈췄다.
    it('never reconnects after the session was deliberately closed', async () => {
        vi.useFakeTimers();
        const client = new ApiSessionClient('fake-token', session);
        mockSocket.connect.mockClear();

        await client.close();
        mockSocket.connected = false;
        // close() 가 유발하는 disconnect 는 재연결을 걸면 안 된다.
        emitSocketEvent('disconnect', 'io client disconnect');
        await vi.advanceTimersByTimeAsync(10_000);

        expect(mockSocket.connect).not.toHaveBeenCalled();
    });

    it('does not let a connect error revive a closed session either', async () => {
        vi.useFakeTimers();
        const client = new ApiSessionClient('fake-token', session);
        mockSocket.connect.mockClear();

        await client.close();
        mockSocket.connected = false;
        emitSocketEvent('connect_error', new Error('boom'));
        await vi.advanceTimersByTimeAsync(10_000);

        expect(mockSocket.connect).not.toHaveBeenCalled();
    });

    // close() 는 interval 은 지우지만 이미 예약된 1초 타이머는 지우지 못한다.
    // 프로덕션에서 소켓이 다시 붙은 것이 close() 1.1초 뒤였다.
    it('does not let a reconnect scheduled before close still fire', async () => {
        vi.useFakeTimers();
        const client = new ApiSessionClient('fake-token', session);
        mockSocket.connected = false;
        emitSocketEvent('disconnect', 'transport close');
        mockSocket.connect.mockClear();

        await client.close();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(mockSocket.connect).not.toHaveBeenCalled();
    });

    // 닫지 않은 세션은 끊기면 당연히 다시 붙어야 한다 — 이 수정으로 그것까지
    // 막으면 네트워크 순단마다 세션을 잃는다.
    it('still reconnects a live session that dropped', async () => {
        vi.useFakeTimers();
        new ApiSessionClient('fake-token', session);
        mockSocket.connect.mockClear();
        mockSocket.connected = false;

        emitSocketEvent('disconnect', 'transport close');
        await vi.advanceTimersByTimeAsync(5_000);

        expect(mockSocket.connect).toHaveBeenCalled();
    });

    // 닫히지 않은 세션이 "아직 붙을 때가 아니다"라고 답하는 것은 실패한 dial 이
    // 아니다 — reconnectAttempts 가 움직이지 않으므로 백오프가 이 분기를 늦출 수
    // 없고, 백오프에서 다시 예약하면 기계가 닫혀 있는 내내 base delay 마다
    // shouldReconnect() 를 다시 묻게 된다. macOS 에서 이 술어는 동기 execSync 다.
    it('polls the not-ready check on its own clock rather than at the base delay', async () => {
        vi.useFakeTimers();
        mockShouldReconnect.mockReturnValue(false);

        const client = new ApiSessionClient('fake-token', session);
        mockSocket.connected = false;
        mockSocket.connect.mockClear();

        // 지터를 상한에 고정해 각 지연이 정확히 공칭값이 되게 한다.
        const random = vi.spyOn(Math, 'random').mockReturnValue(1);
        try {
            emitSocketEvent('disconnect', 'transport close');
            mockShouldReconnect.mockClear();

            const window = 60_000;
            await vi.advanceTimersByTimeAsync(window);

            const looks = mockShouldReconnect.mock.calls.length;
            const expected = window / RECONNECT_NOT_READY_POLL_MS;
            expect(looks).toBeLessThanOrEqual(expected + 1);
            // 그렇다고 멈추면 안 된다 — 기계가 준비되는 순간을 여전히 봐야 한다.
            expect(looks).toBeGreaterThanOrEqual(expected - 1);
            expect(mockSocket.connect).not.toHaveBeenCalled();
        } finally {
            random.mockRestore();
        }

        await client.close();
    });

    it('registers core socket handlers and connects', () => {
        new ApiSessionClient('fake-token', session);

        expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('update', expect.any(Function));
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);
    });

    it('sends stream deltas as volatile, session-key encrypted session-stream frames', () => {
        const client = new ApiSessionClient('fake-token', session);

        client.sendStreamDelta({ messageId: 'msg_1', index: 0, offset: 3, delta: 'Hel', final: false });

        expect(mockSocket.emit).not.toHaveBeenCalledWith('session-stream', expect.anything());
        expect(mockSocket.volatile.emit).toHaveBeenCalledTimes(1);
        const [event, payload] = mockSocket.volatile.emit.mock.calls[0];
        expect(event).toBe('session-stream');
        expect(payload.sid).toBe('test-session-id');
        expect(typeof payload.time).toBe('number');
        expect(decrypt(session.encryptionKey, session.encryptionVariant, decodeBase64(payload.data)))
            .toEqual({ messageId: 'msg_1', index: 0, offset: 3, delta: 'Hel', final: false });
    });

    it('sends opt-in turn latency as an opaque volatile stream frame', () => {
        const client = new ApiSessionClient('fake-token', session);

        client.sendTurnLatency({
            version: 1, type: 'turn-latency', id: 'trace-1', attribution: 'exclusive', inputCount: 1,
            queueMs: 4, sdkSubmitMs: 9, firstSdkTextMs: 20, outcome: 'text',
        });

        const [event, payload] = mockSocket.volatile.emit.mock.calls[0];
        expect(event).toBe('session-stream');
        expect(payload.sid).toBe('test-session-id');
        expect(decrypt(session.encryptionKey, session.encryptionVariant, decodeBase64(payload.data))).toEqual({
            version: 1, type: 'turn-latency', id: 'trace-1', attribution: 'exclusive', inputCount: 1,
            queueMs: 4, sdkSubmitMs: 9, firstSdkTextMs: 20, outcome: 'text',
        });
    });

    it('reapplies a metadata patch to the newest server document after a version mismatch', async () => {
        session.metadata = {
            ...session.metadata,
            summary: { text: 'original title', updatedAt: 1 },
        };
        session.metadataVersion = 4;
        const concurrentMetadata = {
            ...session.metadata,
            summary: { text: 'newer title', updatedAt: 2 },
            promptSuggestion: { text: 'next step', provider: 'codex', updatedAt: 3 },
            futureProviderState: { preserved: true },
        };
        const encryptedConcurrentMetadata = encryptContent(session, concurrentMetadata);

        mockSocket.emitWithAck
            .mockResolvedValueOnce({
                result: 'version-mismatch',
                version: 5,
                metadata: encryptedConcurrentMetadata,
            })
            .mockImplementationOnce(async (_event: string, payload: { metadata: string }) => ({
                result: 'success',
                version: 6,
                metadata: payload.metadata,
            }));

        const client = new ApiSessionClient('fake-token', session);
        client.updateMetadata((metadata) => ({
            ...metadata,
            lifecycleState: 'running',
            archivedBy: undefined,
        }));

        await waitForCheck(() => {
            expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(2);
        });
        expect(mockSocket.emitWithAck.mock.calls[0][1].expectedVersion).toBe(4);
        expect(mockSocket.emitWithAck.mock.calls[1][1].expectedVersion).toBe(5);
        expect(decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(mockSocket.emitWithAck.mock.calls[1][1].metadata),
        )).toEqual({
            ...concurrentMetadata,
            lifecycleState: 'running',
        });
        expect(client.getMetadata()).toEqual({
            ...concurrentMetadata,
            lifecycleState: 'running',
        });
    });

    it('retries after initial socket connection error', async () => {
        vi.useFakeTimers();
        mockSocket.connected = false;

        const client = new ApiSessionClient('fake-token', session);

        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        // specs/machine-socket-duplicate-registration/ — the cadence is
        // jittered; pin the source so each delay is exactly its nominal value.
        const random = vi.spyOn(Math, 'random').mockReturnValue(1);
        try {
            emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

            await vi.advanceTimersByTimeAsync(1000);
            expect(mockSocket.connect).toHaveBeenCalledTimes(2);

            // AC1 — the dial is still out; no second one is stacked on it.
            await vi.advanceTimersByTimeAsync(2000);
            expect(mockSocket.connect).toHaveBeenCalledTimes(2);

            // Resolved, so the cadence carries on at its next tick.
            emitSocketEvent('connect_error', new Error('ECONNREFUSED'));
            await vi.advanceTimersByTimeAsync(2000);
            expect(mockSocket.connect).toHaveBeenCalledTimes(3);
        } finally {
            random.mockRestore();
        }

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
        expect((client as any).lastSeq).toBe(1);

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
        expect((client as any).lastSeq).toBe(3);
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
        expect((client as any).lastSeq).toBe(1);
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

    it('uploads local Claude transcript image blocks and sends file before user text', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x01, 0x02, 0x03]);

        mockAxiosPost.mockImplementation(async (url: string, payload: any) => {
            if (url.endsWith('/attachments/request-upload')) {
                expect(payload).toMatchObject({
                    filename: 'claude-image-1.png',
                });
                expect(payload.size).toBeGreaterThan(pngBytes.length);
                return {
                    data: {
                        ref: 'sessions/test-session-id/attachments/image.enc',
                        uploadUrl: 'https://server.test/v1/sessions/test-session-id/attachments/image.enc',
                        method: 'PUT',
                    },
                };
            }

            return {
                data: {
                    messages: payload.messages.map((_message: unknown, index: number) => ({
                        id: `msg-${index + 1}`,
                        seq: index + 1,
                        localId: `local-${index + 1}`,
                        createdAt: 1,
                        updatedAt: 1,
                    })),
                },
            };
        });
        mockAxiosPut.mockResolvedValueOnce({ data: { ok: true } });

        await client.sendClaudeSessionMessageFromLocalTranscript({
            type: 'user',
            uuid: 'u-image-1',
            isSidechain: false,
            isMeta: false,
            message: {
                role: 'user',
                content: [
                    { type: 'text', text: 'please inspect this' },
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/png',
                            data: Buffer.from(pngBytes).toString('base64'),
                        },
                    },
                ],
            },
        } as any);

        await waitForCheck(() => {
            expect(mockAxiosPut).toHaveBeenCalledTimes(1);
            expect(mockAxiosPost.mock.calls.some(([url]) => url === 'https://server.test/v3/sessions/test-session-id/messages')).toBe(true);
        });

        const uploadBody = mockAxiosPut.mock.calls[0][1];
        const blobKey = await client.getBlobKey();
        expect(decryptBlob(new Uint8Array(uploadBody), blobKey)).toEqual(pngBytes);

        const messagesPost = mockAxiosPost.mock.calls.find(([url]) => {
            return url === 'https://server.test/v3/sessions/test-session-id/messages';
        });
        expect(messagesPost).toBeDefined();
        const sentMessages = messagesPost![1].messages;
        expect(sentMessages).toHaveLength(2);

        const decrypted = sentMessages.map((message: { content: string }) => {
            return decrypt(
                session.encryptionKey,
                session.encryptionVariant,
                decodeBase64(message.content),
            );
        });

        expect(decrypted[0]).toMatchObject({
            role: 'session',
            content: {
                role: 'user',
                claudeUuid: 'u-image-1',
                ev: {
                    t: 'file',
                    ref: 'sessions/test-session-id/attachments/image.enc',
                    name: 'claude-image-1.png',
                    size: pngBytes.length,
                    mimeType: 'image/png',
                },
            },
            meta: {
                sentFrom: 'cli',
            },
        });
        expect(decrypted[1]).toMatchObject({
            role: 'session',
            content: {
                role: 'user',
                claudeUuid: 'u-image-1',
                ev: {
                    t: 'text',
                    text: 'please inspect this',
                },
            },
            meta: {
                sentFrom: 'cli',
            },
        });
    });

    it('emits idempotent provider usage events for duplicate Claude message sources', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockImplementation(async (_url: string, payload: { messages: Array<{ localId: string }> }) => ({
            data: {
                messages: payload.messages.map((message, index) => ({
                    id: `msg-${index + 1}`,
                    seq: index + 1,
                    localId: message.localId,
                    createdAt: 1,
                    updatedAt: 1,
                })),
            },
        }));
        const assistantMessage = {
            type: 'assistant',
            timestamp: 1_788_000_000_000,
            message: {
                id: 'msg-native-1',
                model: 'claude-sonnet-4-5',
                content: [],
                usage: {
                    input_tokens: 100,
                    output_tokens: 20,
                    cache_creation_input_tokens: 40,
                    cache_read_input_tokens: 300,
                },
            },
        } as any;

        client.sendClaudeSessionMessage({ ...assistantMessage, uuid: 'sdk-random-uuid' });
        client.sendClaudeSessionMessage({ ...assistantMessage, uuid: 'transcript-uuid' });

        const events = mockSocket.emit.mock.calls
            .filter(([name]: [string]) => name === 'provider-usage-report')
            .map(([, event]: [string, unknown]) => event);
        expect(events).toHaveLength(2);
        expect(events[0]).toEqual(events[1]);
        expect(events[0]).toMatchObject({
            sourceEventId: 'test-session-id:anthropic:msg-native-1',
            occurredAt: 1_788_000_000_000,
            model: 'claude-sonnet-4-5',
            tokens: {
                input: 100,
                output: 20,
                cacheRead: 300,
                cacheWrite: 40,
                reasoning: 0,
                total: 460,
            },
        });
        const legacyEvents = mockSocket.emit.mock.calls
            .filter(([name]: [string]) => name === 'usage-report')
            .map(([, event]: [string, unknown]) => event);
        expect(legacyEvents).toHaveLength(2);
        expect(legacyEvents[0]).toMatchObject({
            sourceEventId: 'test-session-id:anthropic:msg-native-1',
        });
        expect(legacyEvents[1]).toMatchObject({
            sourceEventId: 'test-session-id:anthropic:msg-native-1',
        });
        expect(mockNotifyDaemonSessionRuntime).toHaveBeenLastCalledWith('test-session-id', expect.objectContaining({
            providerTokens: 460,
        }));

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalled();
        });
        await client.close();
    });

    it('emits one turn usage event from the result when assistant messages reported zero tokens', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockImplementation(async (_url: string, payload: { messages: Array<{ localId: string }> }) => ({
            data: { messages: payload.messages.map((message, index) => ({ id: `msg-${index + 1}`, seq: index + 1, localId: message.localId, createdAt: 1, updatedAt: 1 })) },
        }));
        // Z.AI 호환 경로: assistant usage 0, result 에만 토큰이 있다.
        client.sendClaudeSessionMessage({
            type: 'assistant',
            uuid: 'sdk-uuid-zai',
            timestamp: 1_788_000_000_000,
            message: { id: 'msg-zai-1', model: 'glm-5.3-flash', content: [], usage: { input_tokens: 0, output_tokens: 0 } },
        } as any);
        client.applyClaudeTurnResult({
            uuid: 'result-uuid-1',
            usage: { input_tokens: 962, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            modelUsage: { 'glm-4.7': { inputTokens: 962, outputTokens: 3 } },
        });
        // 같은 result 가 다시 와도(중복 전달) 보정은 한 번뿐이다.
        client.applyClaudeTurnResult({
            uuid: 'result-uuid-1',
            usage: { input_tokens: 962, output_tokens: 3 },
        });

        const events = mockSocket.emit.mock.calls
            .filter(([name]: [string]) => name === 'provider-usage-report')
            .map(([, event]: [string, unknown]) => event);
        expect(events.map((event: any) => event.sourceEventId)).toEqual([
            'test-session-id:anthropic:msg-zai-1',
            'test-session-id:anthropic:turn:result-uuid-1',
        ]);
        expect(events[1]).toMatchObject({ model: 'glm-4.7', tokens: { input: 962, output: 3, total: 965 } });
        const legacyEvents = mockSocket.emit.mock.calls
            .filter(([name]: [string]) => name === 'usage-report')
            .map(([, event]: [string, any]) => event);
        expect(legacyEvents.map((event: any) => event.sourceEventId)).toEqual([
            'test-session-id:anthropic:msg-zai-1',
            'test-session-id:anthropic:turn:result-uuid-1',
        ]);
        expect(mockNotifyDaemonSessionRuntime).toHaveBeenLastCalledWith('test-session-id', expect.objectContaining({
            providerTokens: 965,
        }));
        await client.close();
    });

    it('does not emit a turn usage event when assistant messages already carried tokens', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockImplementation(async (_url: string, payload: { messages: Array<{ localId: string }> }) => ({
            data: { messages: payload.messages.map((message, index) => ({ id: `msg-${index + 1}`, seq: index + 1, localId: message.localId, createdAt: 1, updatedAt: 1 })) },
        }));
        client.sendClaudeSessionMessage({
            type: 'assistant',
            uuid: 'sdk-uuid-anthropic',
            timestamp: 1_788_000_000_000,
            message: { id: 'msg-a-1', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 100, output_tokens: 20 } },
        } as any);
        client.applyClaudeTurnResult({ uuid: 'result-uuid-2', usage: { input_tokens: 100, output_tokens: 20 } });

        const events = mockSocket.emit.mock.calls
            .filter(([name]: [string]) => name === 'provider-usage-report')
            .map(([, event]: [string, unknown]) => event);
        expect(events).toHaveLength(1);
        await client.close();
    });

    it('reports an observed org deployment login only on the events it was handed with', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockImplementation(async (_url: string, payload: { messages: Array<{ localId: string }> }) => ({
            data: { messages: payload.messages.map((message, index) => ({ id: `msg-${index + 1}`, seq: index + 1, localId: message.localId, createdAt: 1, updatedAt: 1 })) },
        }));
        const assistant = (id: string) => ({
            type: 'assistant',
            uuid: `sdk-uuid-${id}`,
            timestamp: 1_788_000_000_000,
            message: { id, model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 0, output_tokens: 0 } },
        } as any);
        client.sendClaudeSessionMessage(assistant('msg-observed'), undefined, 'org-bundle-observed');
        client.applyClaudeTurnResult({ uuid: 'result-observed', usage: { input_tokens: 5, output_tokens: 1 } }, 'org-bundle-observed');
        // A local-mode transcript line has no observation to hand over.
        await client.sendClaudeSessionMessageFromLocalTranscript(assistant('msg-local'));

        const aiAuth = mockSocket.emit.mock.calls
            .filter(([name]: [string]) => name === 'provider-usage-report')
            .map(([, event]: [string, any]) => [event.sourceEventId, event.aiAuth]);
        expect(aiAuth).toEqual([
            ['test-session-id:anthropic:msg-observed', { appliedSource: 'org-bundle-observed', connectionVersion: null }],
            ['test-session-id:anthropic:turn:result-observed', { appliedSource: 'org-bundle-observed', connectionVersion: null }],
            ['test-session-id:anthropic:msg-local', undefined],
        ]);
        await client.close();
    });

    it('preserves the Studio optimistic id on a Claude initial prompt', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'studio-local-claude', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.sendClaudeSessionMessage({
            type: 'user',
            message: { content: 'recover Claude' },
            isSidechain: false,
            isMeta: false
        } as any, 'studio-local-claude');

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        expect(mockAxiosPost.mock.calls[0][1].messages[0].localId).toBe('studio-local-claude');
    });

    it('uploads local Codex image files with codex item ids', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

        mockAxiosPost.mockImplementation(async (url: string, payload: any) => {
            if (url.endsWith('/attachments/request-upload')) {
                expect(payload).toMatchObject({
                    filename: 'codex-image-1.png',
                });
                return {
                    data: {
                        ref: 'sessions/test-session-id/attachments/codex-image.enc',
                        uploadUrl: 'https://server.test/v1/sessions/test-session-id/attachments/codex-image.enc',
                        method: 'PUT',
                    },
                };
            }

            return {
                data: {
                    messages: payload.messages.map((_message: unknown, index: number) => ({
                        id: `msg-${index + 1}`,
                        seq: index + 1,
                        localId: `local-${index + 1}`,
                        createdAt: 1,
                        updatedAt: 1,
                    })),
                },
            };
        });
        mockAxiosPut.mockResolvedValueOnce({ data: { ok: true } });

        const envelope = await client.uploadLocalImageAttachmentEnvelope({
            data: pngBytes,
            mimeType: 'image/png',
            name: 'codex-image-1.png',
        }, {
            codexItemId: 'codex-user-item-1',
        });

        expect(envelope).toMatchObject({
            role: 'user',
            codexItemId: 'codex-user-item-1',
            ev: {
                t: 'file',
                ref: 'sessions/test-session-id/attachments/codex-image.enc',
                name: 'codex-image-1.png',
                size: pngBytes.length,
                mimeType: 'image/png',
            },
        });

        const uploadBody = mockAxiosPut.mock.calls[0][1];
        const blobKey = await client.getBlobKey();
        expect(decryptBlob(new Uint8Array(uploadBody), blobKey)).toEqual(pngBytes);
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

    it('preserves the Studio optimistic id on a Codex initial prompt', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'studio-local-codex', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.sendSessionProtocolMessage({
            id: 'env-user-recovery',
            time: 1002,
            role: 'user',
            ev: { t: 'text', text: 'recover Codex' }
        }, 'studio-local-codex');

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        expect(mockAxiosPost.mock.calls[0][1].messages[0].localId).toBe('studio-local-codex');
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

    it('reports keep-alive thinking state to the local daemon', () => {
        const client = new ApiSessionClient('fake-token', session);

        client.keepAlive(true, 'remote');

        expect(mockSocket.volatile.emit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
            sid: 'test-session-id',
            thinking: true,
            mode: 'remote'
        }));
        expect(mockNotifyDaemonSessionRuntime).toHaveBeenCalledWith('test-session-id', {
            reportSeq: expect.any(Number),
            thinking: true,
            hasOpenToolCall: false,
            pendingUserInput: false,
            lastUserInteractionAt: expect.any(Number),
            lastProcessedSeq: expect.any(Number),
            mode: 'remote'
        });
    });

    it('does not report a daemon repair continuation as user intervention', () => {
        const client = new ApiSessionClient('fake-token', session);
        client.keepAlive(false, 'remote');
        mockNotifyDaemonSessionRuntime.mockClear();

        (client as any).routeIncomingMessage({
            role: 'user',
            content: { type: 'text', text: '<quality-gate-evidence />' },
            meta: { sentFrom: 'daemon' },
        });
        client.keepAlive(true, 'remote');

        expect(mockNotifyDaemonSessionRuntime).toHaveBeenCalled();
        for (const [, runtime] of mockNotifyDaemonSessionRuntime.mock.calls as unknown as Array<[string, Record<string, unknown>]>) {
            expect(runtime).not.toHaveProperty('lastUserInteractionAt');
        }
    });

    it('reports a routed human message as user intervention before the turn starts', () => {
        const client = new ApiSessionClient('fake-token', session);
        client.keepAlive(false, 'remote');
        mockNotifyDaemonSessionRuntime.mockClear();

        (client as any).routeIncomingMessage({
            role: 'user',
            content: { type: 'text', text: 'manual instruction' },
            meta: { sentFrom: 'app' },
        });

        expect(mockNotifyDaemonSessionRuntime).toHaveBeenLastCalledWith('test-session-id', expect.objectContaining({
            lastUserInteractionAt: expect.any(Number),
        }));
    });

    // The daemon uses this as the resume skip-baseline: report the seq actually
    // delivered to the agent loop, or dead-period messages get swallowed.
    it('reports the delivered message seq as the resume skip-baseline', () => {
        const client = new ApiSessionClient('fake-token', session);
        client.skipExistingMessages(621);

        client.keepAlive(true, 'remote');

        expect(mockNotifyDaemonSessionRuntime).toHaveBeenCalledWith('test-session-id', expect.objectContaining({
            lastProcessedSeq: 621,
        }));
    });

    it('keeps an automation resume cursor at its reconnect baseline', () => {
        const client = new ApiSessionClient('fake-token', session);
        client.skipExistingMessages(41);
        client.capRuntimeProcessedSeq(41);
        (client as any).lastSeq = 52;

        client.keepAlive(true, 'remote');

        expect(mockNotifyDaemonSessionRuntime).toHaveBeenCalledWith('test-session-id', expect.objectContaining({
            lastProcessedSeq: 41,
        }));
    });

    it('reports open tool-call state to the local daemon', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValue({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.keepAlive(true, 'remote');
        mockNotifyDaemonSessionRuntime.mockClear();

        client.sendSessionProtocolMessage({
            id: 'env-tool-start-1',
            time: 1003,
            role: 'agent',
            turn: 'turn-1',
            ev: {
                t: 'tool-call-start',
                call: 'tool-1',
                name: 'Bash',
                title: 'Bash',
                description: 'Run command',
                args: {}
            }
        });

        expect(mockNotifyDaemonSessionRuntime).toHaveBeenLastCalledWith('test-session-id', {
            reportSeq: expect.any(Number),
            thinking: true,
            hasOpenToolCall: true,
            pendingUserInput: false,
            lastUserInteractionAt: expect.any(Number),
            lastProcessedSeq: expect.any(Number),
            mode: 'remote'
        });

        client.sendSessionProtocolMessage({
            id: 'env-tool-end-1',
            time: 1004,
            role: 'agent',
            turn: 'turn-1',
            ev: { t: 'tool-call-end', call: 'tool-1' }
        });

        expect(mockNotifyDaemonSessionRuntime).toHaveBeenLastCalledWith('test-session-id', {
            reportSeq: expect.any(Number),
            thinking: true,
            hasOpenToolCall: false,
            pendingUserInput: false,
            lastUserInteractionAt: expect.any(Number),
            lastProcessedSeq: expect.any(Number),
            mode: 'remote'
        });
    });

    it('stamps and reports lastTurnEndAt when the agent finishes a turn (busy → idle)', () => {
        const client = new ApiSessionClient('fake-token', session);

        // A fresh idle report (no prior busy state) must NOT stamp a turn-end.
        client.keepAlive(false, 'remote');
        expect(mockNotifyDaemonSessionRuntime).toHaveBeenLastCalledWith('test-session-id', {
            reportSeq: expect.any(Number),
            thinking: false,
            hasOpenToolCall: false,
            pendingUserInput: false,
            lastProcessedSeq: expect.any(Number),
            mode: 'remote'
        });

        // Agent starts a turn (idle → busy)…
        client.keepAlive(true, 'remote');
        mockNotifyDaemonSessionRuntime.mockClear();

        // …then finishes it (busy → idle): this is a turn-end.
        client.keepAlive(false, 'remote');
        expect(mockNotifyDaemonSessionRuntime).toHaveBeenLastCalledWith('test-session-id', {
            reportSeq: expect.any(Number),
            thinking: false,
            hasOpenToolCall: false,
            pendingUserInput: false,
            lastUserInteractionAt: expect.any(Number),
            lastTurnEndAt: expect.any(Number),
            assistantTurns: 1,
            lastProcessedSeq: expect.any(Number),
            mode: 'remote'
        });
    });

    it('flags launchedBackgroundJob when a Bash tool call runs in the background', () => {
        const client = new ApiSessionClient('fake-token', session);
        client.keepAlive(true, 'remote');
        mockNotifyDaemonSessionRuntime.mockClear();

        client.sendSessionProtocolMessage({
            id: 'env-bg-start-1',
            time: 2001,
            role: 'agent',
            turn: 'turn-bg',
            ev: {
                t: 'tool-call-start',
                call: 'bg-1',
                name: 'Bash',
                title: 'Bash',
                description: 'Run training in background',
                args: { command: 'train.sh', run_in_background: true }
            }
        });

        expect(mockNotifyDaemonSessionRuntime).toHaveBeenLastCalledWith('test-session-id', expect.objectContaining({
            launchedBackgroundJob: true,
        }));
    });

    it('reports AskUserQuestion wait state as idle to the local daemon', () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValue({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.keepAlive(true, 'remote');
        mockNotifyDaemonSessionRuntime.mockClear();

        client.sendSessionProtocolMessage({
            id: 'env-ask-start-1',
            time: 1005,
            role: 'agent',
            turn: 'turn-1',
            ev: {
                t: 'tool-call-start',
                call: 'ask-1',
                name: 'AskUserQuestion',
                title: 'AskUserQuestion',
                description: 'Ask the user',
                args: {
                    questions: [
                        {
                            header: '우선순위',
                            question: '무엇을 먼저 할까요?',
                            options: [{ label: '버그 수정' }],
                        },
                    ],
                }
            }
        });

        expect(mockNotifyDaemonSessionRuntime).toHaveBeenCalledWith('test-session-id', {
            reportSeq: expect.any(Number),
            thinking: false,
            hasOpenToolCall: false,
            pendingUserInput: true,
            lastUserInteractionAt: expect.any(Number),
            lastProcessedSeq: expect.any(Number),
            mode: 'remote'
        });
    });

    it('reports a pending permission request as pending user input', () => {
        const client = new ApiSessionClient('fake-token', session);
        // Claude/Codex permission handlers mirror pending approvals into
        // agentState.requests — codex approvals never open a tool call, so
        // this is the only "waiting on user" signal for them.
        (client as unknown as { agentState: unknown }).agentState = {
            requests: {
                'perm-1': { tool: 'CodexBash', arguments: {}, createdAt: 1000 }
            }
        };

        client.keepAlive(true, 'remote');

        expect(mockNotifyDaemonSessionRuntime).toHaveBeenCalledWith('test-session-id', {
            reportSeq: expect.any(Number),
            thinking: false,
            hasOpenToolCall: false,
            pendingUserInput: true,
            lastProcessedSeq: expect.any(Number),
            mode: 'remote'
        });
    });

    it('persists pending AskUserQuestion as cancelled before shutdown', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValue({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.sendSessionProtocolMessage({
            id: 'env-ask-start-1',
            time: 1005,
            role: 'agent',
            turn: 'turn-1',
            ev: {
                t: 'tool-call-start',
                call: 'ask-1',
                name: 'AskUserQuestion',
                title: 'AskUserQuestion',
                description: 'Ask the user',
                args: {
                    questions: [
                        {
                            header: '우선순위',
                            question: '무엇을 먼저 할까요?',
                            options: [{ label: '버그 수정' }],
                        },
                    ],
                }
            }
        });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });
        mockAxiosPost.mockClear();

        client.closeOpenAskUserQuestionsAsCancelled();
        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        const decryptedMessages = payload.messages.map((message: { content: string }) => (
            decrypt(
                session.encryptionKey,
                session.encryptionVariant,
                decodeBase64(message.content)
            )
        ));

        expect(decryptedMessages).toEqual([
            expect.objectContaining({
                role: 'session',
                content: expect.objectContaining({
                    role: 'agent',
                    turn: 'turn-1',
                    ev: { t: 'tool-call-end', call: 'ask-1' }
                })
            }),
            expect.objectContaining({
                role: 'session',
                content: expect.objectContaining({
                    role: 'agent',
                    turn: 'turn-1',
                    ev: { t: 'turn-end', status: 'cancelled' }
                })
            })
        ]);
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
        expect(onUserMessage).toHaveBeenCalledWith({
            ...userMessage,
            serverMessageId: 'msg-1',
        });
        expect((client as any).lastSeq).toBe(1);
    });

    it('preserves effort in user message metadata after schema parsing', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const userMessage = {
            role: 'user',
            content: {
                type: 'text',
                text: 'from fetch'
            },
            meta: {
                model: 'gpt-5.4',
                effort: 'low'
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

        expect(onUserMessage).toHaveBeenCalledWith({ ...userMessage, serverMessageId: 'msg-1' });
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
        expect(onUserMessage).toHaveBeenCalledWith({ ...userMessage, serverMessageId: 'msg-1' });
        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(onMessage).toHaveBeenCalledWith(agentMessage);
    });

    it('routes file events without logging sensitive names or refs', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onFileEvent = vi.fn();
        const sensitiveName = 'https://upload.example.test/image.png?token=secret';
        const sensitiveRef = 'sessions/test-session-id/attachments/secret-ref.enc?signature=secret';
        client.onFileEvent(onFileEvent);

        const fileMessage = {
            role: 'session',
            content: {
                type: 'session',
                data: {
                    id: 'file-event-1',
                    time: 1000,
                    role: 'user',
                    ev: {
                        t: 'file',
                        ref: sensitiveRef,
                        name: sensitiveName,
                        size: 42,
                        mimeType: 'image/png',
                    }
                }
            }
        };

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [
                    {
                        id: 'msg-1',
                        seq: 1,
                        content: { t: 'encrypted', c: encryptContent(session, fileMessage) },
                        localId: null,
                        createdAt: 1000,
                        updatedAt: 1000
                    }
                ],
                hasMore: false
            }
        });

        await (client as any).fetchMessages();

        expect(onFileEvent).toHaveBeenCalledWith(fileMessage);
        const debugOutput = JSON.stringify(vi.mocked(logger.debug).mock.calls);
        expect(debugOutput).not.toContain(sensitiveName);
        expect(debugOutput).not.toContain(sensitiveRef);
        expect(debugOutput).not.toContain('signature=secret');
    });

    it('applies file event socket updates directly without logging sensitive names or refs', () => {
        const client = new ApiSessionClient('fake-token', session);
        const onFileEvent = vi.fn();
        const sensitiveName = 'https://upload.example.test/image.png?token=socket-secret';
        const sensitiveRef = 'sessions/test-session-id/attachments/socket-secret-ref.enc?signature=socket-secret';
        client.onFileEvent(onFileEvent);

        (client as any).lastSeq = 1;
        const fileMessage = {
            role: 'session',
            content: {
                type: 'session',
                data: {
                    id: 'file-event-2',
                    time: 1000,
                    role: 'user',
                    ev: {
                        t: 'file',
                        ref: sensitiveRef,
                        name: sensitiveName,
                        size: 64,
                        mimeType: 'image/png',
                    }
                }
            }
        };

        emitSocketEvent('update', createNewMessageUpdate(2, encryptContent(session, fileMessage)));

        expect(onFileEvent).toHaveBeenCalledWith(fileMessage);
        expect((client as any).lastSeq).toBe(2);
        const debugOutput = JSON.stringify([
            ...vi.mocked(logger.debug).mock.calls,
            ...vi.mocked(logger.debugLargeJson).mock.calls,
        ]);
        expect(debugOutput).not.toContain(sensitiveName);
        expect(debugOutput).not.toContain(sensitiveRef);
        expect(debugOutput).not.toContain('socket-secret');
    });

    it('applies consecutive new-message updates directly (fast path)', () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        (client as any).lastSeq = 1;
        const userMessage = {
            role: 'user',
            content: { type: 'text', text: 'fast-path' },
            serverMessageId: 'forged-client-id',
        };

        emitSocketEvent('update', createNewMessageUpdate(2, encryptContent(session, userMessage)));

        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith({
            role: 'user',
            content: { type: 'text', text: 'fast-path' },
            serverMessageId: 'msg-2',
        });
        expect((client as any).lastSeq).toBe(2);
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('routes a message once when polling and the socket deliver the same seq concurrently', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const userMessage = {
            role: 'user',
            content: { type: 'text', text: 'one durable message' }
        };
        let resolveFetch!: (value: unknown) => void;
        mockAxiosGet.mockImplementationOnce(() => new Promise((resolve) => {
            resolveFetch = resolve;
        }));

        const fetchPromise = (client as any).fetchMessages();
        await waitForCheck(() => {
            expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        });

        emitSocketEvent('update', createNewMessageUpdate(1, encryptContent(session, userMessage)));
        expect(onUserMessage).toHaveBeenCalledTimes(1);

        resolveFetch({
            data: {
                messages: [
                    {
                        id: 'msg-1',
                        seq: 1,
                        content: { t: 'encrypted', c: encryptContent(session, userMessage) },
                        localId: null,
                        createdAt: 1000,
                        updatedAt: 1000
                    }
                ],
                hasMore: false
            }
        });
        await fetchPromise;

        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith({
            ...userMessage,
            serverMessageId: 'msg-1',
        });
        expect((client as any).lastSeq).toBe(1);
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

    it('applies first live new-message update directly when lastSeq is 0', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [],
                hasMore: false
            }
        });

        const firstMessage = {
            role: 'user',
            content: { type: 'text', text: 'first' }
        };

        try {
            emitSocketEvent('update', createNewMessageUpdate(1, encryptContent(session, firstMessage)));

            expect(onUserMessage).toHaveBeenCalledTimes(1);
            expect(onUserMessage).toHaveBeenCalledWith({ ...firstMessage, serverMessageId: 'msg-1' });
            expect((client as any).lastSeq).toBe(1);
            expect(mockAxiosGet).not.toHaveBeenCalled();
        } finally {
            await client.close();
        }
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

    it('routes a live socket message whose seq was just skipped by reconnect catch-up', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        (client as any).lastSeq = 1;

        const userMessage = {
            role: 'user',
            content: { type: 'text', text: 'race after reconnect' }
        };

        client.skipExistingMessages();
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [
                    {
                        id: 'msg-2',
                        seq: 2,
                        content: { t: 'encrypted', c: encryptContent(session, userMessage) },
                        localId: null,
                        createdAt: 1000,
                        updatedAt: 1000
                    }
                ],
                hasMore: false
            }
        });

        await (client as any).fetchMessages();

        expect(onUserMessage).not.toHaveBeenCalled();
        expect((client as any).lastSeq).toBe(2);

        emitSocketEvent('update', createNewMessageUpdate(2, encryptContent(session, userMessage)));

        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith({ ...userMessage, serverMessageId: 'msg-2' });
        expect((client as any).lastSeq).toBe(2);
        expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    });

    it('routes reconnect catch-up messages newer than the skip baseline', async () => {
        const client = new ApiSessionClient('fake-token', { ...session, seq: 1 });
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const userMessage = {
            role: 'user',
            content: { type: 'text', text: 'resume-triggering message' }
        };

        client.skipExistingMessages(1);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [
                    {
                        id: 'msg-2',
                        seq: 2,
                        content: { t: 'encrypted', c: encryptContent(session, userMessage) },
                        localId: null,
                        createdAt: 1000,
                        updatedAt: 1000
                    }
                ],
                hasMore: false
            }
        });

        await (client as any).fetchMessages();

        expect(mockAxiosGet.mock.calls[0][1].params.after_seq).toBe(1);
        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith({ ...userMessage, serverMessageId: 'msg-2' });
        expect((client as any).lastSeq).toBe(2);
    });

    it('updates lastSeq after successful outbox flush and never moves it backward', async () => {
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
        expect((client as any).lastSeq).toBe(11);
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

    // Regression for the FORK BACKFILL corruption bug: enqueuing an entire
    // historical transcript (hundreds of messages) synchronously used to post
    // them newest-first once the backlog exceeded one batch, permanently
    // assigning the lowest server seq to the newest content. Every consumer
    // renders by seq, so that silently scrambled replayed history.
    it('flushes a backlog larger than one batch in enqueue (oldest-first) order', async () => {
        const client = new ApiSessionClient('fake-token', session);
        (client as any).lastSeq = 0;

        // The first enqueue synchronously kicks off flushOutbox, which awaits
        // this still-pending POST — mirroring a real axios call still in
        // flight while a synchronous loop keeps enqueueing behind it.
        let resolveFirstPost: (value: unknown) => void = () => {};
        const firstPostPromise = new Promise((resolve) => { resolveFirstPost = resolve; });
        mockAxiosPost.mockImplementationOnce(() => firstPostPromise);

        client.sendCodexMessage({ index: 0 });

        // Pile up a backlog bigger than MAX_OUTBOX_BATCH_SIZE (50) while the
        // first POST is still unresolved.
        for (let i = 1; i <= 60; i += 1) {
            client.sendCodexMessage({ index: i });
        }
        expect((client as any).pendingOutbox.length).toBe(61);

        resolveFirstPost({ data: { messages: [{ id: 'm0', seq: 1, localId: 'l0', createdAt: 0, updatedAt: 0 }] } });
        mockAxiosPost.mockResolvedValue({
            data: { messages: [{ id: 'batch', seq: 51, localId: 'lb', createdAt: 0, updatedAt: 0 }] }
        });

        await waitForCheck(() => {
            expect(mockAxiosPost.mock.calls.length).toBeGreaterThanOrEqual(2);
        });

        const secondBatch = mockAxiosPost.mock.calls[1][1].messages as Array<{ content: string }>;
        const decoded = decrypt(session.encryptionKey, session.encryptionVariant, decodeBase64(secondBatch[0].content)) as {
            content: { data: { index: number } }
        };
        expect(decoded.content.data.index).toBe(1);
    });

    it('triggers receive catch-up fetch on socket reconnect', async () => {
        new ApiSessionClient('fake-token', session);

        // The connect handler also captures the session-end event baseline,
        // so route the mock by URL instead of counting raw calls.
        mockAxiosGet.mockImplementation(async (url: unknown) => {
            if (String(url).includes('/events')) {
                return { data: { events: [], hasMore: false } };
            }
            return { data: { messages: [], hasMore: false } };
        });

        emitSocketEvent('connect');

        const messagesCalls = () => mockAxiosGet.mock.calls.filter((call) => String(call[0]).includes('/messages'));
        await waitForCheck(() => {
            expect(messagesCalls()).toHaveLength(1);
        });
        expect(messagesCalls()[0][1].params.after_seq).toBe(0);
    });

    describe('archived-while-disconnected recheck', () => {
        function mockEventsAndMessages(opts: {
            baselineSeq: number | null;
            recheckEvents: Array<{ seq: number }>;
        }) {
            mockAxiosGet.mockImplementation(async (url: unknown, config?: { params?: { order?: string } }) => {
                if (String(url).includes('/events')) {
                    if (config?.params?.order === 'desc') {
                        // Baseline capture on first connect
                        if (opts.baselineSeq === null) {
                            throw new Error('baseline fetch failed');
                        }
                        return {
                            data: {
                                events: opts.baselineSeq > 0
                                    ? [{ id: 'e-base', eventType: 'session-end', seq: opts.baselineSeq, content: '', createdAt: 1, updatedAt: 1 }]
                                    : [],
                                hasMore: false
                            }
                        };
                    }
                    // Recheck on reconnect (after_seq cursor)
                    return {
                        data: {
                            events: opts.recheckEvents.map((e, i) => ({
                                id: `e-${i}`, eventType: 'session-end', seq: e.seq, content: '', createdAt: 2, updatedAt: 2
                            })),
                            hasMore: false
                        }
                    };
                }
                return { data: { messages: [], hasMore: false } };
            });
        }

        function mockLookupActive(active: boolean) {
            mockAxiosPost.mockImplementation(async (url: unknown) => {
                if (String(url).includes('/lookup')) {
                    return { data: { sessions: [{ id: 'test-session-id', active }] } };
                }
                return { data: { messages: [] } };
            });
        }

        it('emits archived when a session-end appeared while disconnected and the session stayed inactive', async () => {
            const client = new ApiSessionClient('fake-token', session);
            const onArchived = vi.fn();
            client.on('archived', onArchived);
            mockEventsAndMessages({ baselineSeq: 5, recheckEvents: [{ seq: 6 }] });
            mockLookupActive(false);

            emitSocketEvent('connect');
            await waitForCheck(() => {
                expect((client as any).sessionEndSeqBaseline).toBe(5);
            });

            emitSocketEvent('connect'); // reconnect
            await waitForCheck(() => {
                expect(onArchived).toHaveBeenCalledTimes(1);
            });
            await client.close();
        });

        it('does not emit when the session was revived (active again) and advances the baseline', async () => {
            const client = new ApiSessionClient('fake-token', session);
            const onArchived = vi.fn();
            client.on('archived', onArchived);
            mockEventsAndMessages({ baselineSeq: 5, recheckEvents: [{ seq: 6 }] });
            mockLookupActive(true);

            emitSocketEvent('connect');
            await waitForCheck(() => {
                expect((client as any).sessionEndSeqBaseline).toBe(5);
            });

            emitSocketEvent('connect'); // reconnect
            await waitForCheck(() => {
                expect((client as any).sessionEndSeqBaseline).toBe(6);
            });
            expect(onArchived).not.toHaveBeenCalled();
            await client.close();
        });

        it('honors suppressNextArchiveSignal exactly once', async () => {
            const client = new ApiSessionClient('fake-token', session);
            const onArchived = vi.fn();
            client.on('archived', onArchived);
            mockEventsAndMessages({ baselineSeq: 0, recheckEvents: [{ seq: 1 }] });
            mockLookupActive(false);
            client.suppressNextArchiveSignal();

            emitSocketEvent('connect');
            await waitForCheck(() => {
                expect((client as any).sessionEndSeqBaseline).toBe(0);
            });

            emitSocketEvent('connect'); // reconnect
            await waitForCheck(() => {
                expect((client as any).sessionEndSeqBaseline).toBe(1);
            });
            expect(onArchived).not.toHaveBeenCalled();
            expect((client as any).ignoreArchiveSignal).toBe(false);
            await client.close();
        });

        it('disables rechecks when the baseline fetch fails (fail-safe)', async () => {
            const client = new ApiSessionClient('fake-token', session);
            const onArchived = vi.fn();
            client.on('archived', onArchived);
            mockEventsAndMessages({ baselineSeq: null, recheckEvents: [{ seq: 1 }] });
            mockLookupActive(false);

            emitSocketEvent('connect');
            emitSocketEvent('connect'); // reconnect — baseline is null, recheck skipped
            // Give the (skipped) recheck a tick to settle
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(onArchived).not.toHaveBeenCalled();
            expect((client as any).archiveRecheckPending).toBe(false);
            await client.close();
        });

        it('suppresses keepalives while a recheck is pending', async () => {
            const client = new ApiSessionClient('fake-token', session);
            (client as any).archiveRecheckPending = true;
            client.keepAlive(false, 'remote');
            expect(mockSocket.volatile.emit).not.toHaveBeenCalled();

            (client as any).archiveRecheckPending = false;
            client.keepAlive(false, 'remote');
            expect(mockSocket.volatile.emit).toHaveBeenCalledWith('session-alive', expect.objectContaining({ sid: 'test-session-id' }));
            await client.close();
        });
    });

    // 2026-07-23 운영 사고: 404 의 실제 원인이 세션 삭제가 아니라 계정/토큰
    // 불일치였음이 DB 로 확정됨. happy-server 는 두 경우를 같은 404 로
    // 반환하므로, sync 404 만으로는 archive 를 확정(stamp)할 수 없다.
    // archive 확정은 명시적 신호(archive ephemeral, durable session-end
    // recheck)에서만 이뤄져야 한다. 세션 종료 자체는 유지하되(죽은 sync 로
    // 프로세스를 살려두지 않음) 세션은 resumable 로 남긴다.
    describe('onSyncFatal', () => {
        function axios404(): Error {
            const err = new Error('Request failed with status code 404') as Error & {
                isAxiosError: boolean;
                response: { status: number };
            };
            err.isAxiosError = true;
            err.response = { status: 404 } as any;
            return err;
        }

        it('exits the session WITHOUT stamping archive on a sync 404 (could be account mismatch)', async () => {
            const client = new ApiSessionClient('fake-token', session);
            const onArchived = vi.fn();
            client.on('archived', onArchived);
            (client as any).onSyncFatal('receive', axios404());
            expect(onArchived).toHaveBeenCalledTimes(1);
            expect(onArchived).toHaveBeenCalledWith({ stampArchive: false });
            await client.close();
        });

        it('exits without stamping archive on other non-retryable errors too (401 등 환경 문제)', async () => {
            const client = new ApiSessionClient('fake-token', session);
            const onArchived = vi.fn();
            client.on('archived', onArchived);
            (client as any).onSyncFatal('send', new Error('Request failed with status code 401'));
            expect(onArchived).toHaveBeenCalledWith({ stampArchive: false });
            await client.close();
        });

        it('tears down only once when both sync directions fail', async () => {
            const client = new ApiSessionClient('fake-token', session);
            const onArchived = vi.fn();
            client.on('archived', onArchived);
            (client as any).onSyncFatal('receive', axios404());
            (client as any).onSyncFatal('send', axios404());
            expect(onArchived).toHaveBeenCalledTimes(1);
            await client.close();
        });
    });

    it('recovers a saved user message when the socket new-message update is missed', async () => {
        vi.useFakeTimers();
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const userMessage = {
            role: 'user',
            content: { type: 'text', text: 'missed socket update' }
        };

        // First messages fetch (connect catch-up) is empty; the poll then
        // recovers the saved message. Events calls (session-end baseline)
        // are routed separately so they don't consume messages responses.
        const messagesResponses = [
            { data: { messages: [], hasMore: false } },
            {
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
            }
        ];
        mockAxiosGet.mockImplementation(async (url: unknown) => {
            if (String(url).includes('/events')) {
                return { data: { events: [], hasMore: false } };
            }
            return messagesResponses.shift() ?? { data: { messages: [], hasMore: false } };
        });
        const messagesCalls = () => mockAxiosGet.mock.calls.filter((call) => String(call[0]).includes('/messages'));

        emitSocketEvent('connect');
        await waitForCheck(() => {
            expect(messagesCalls()).toHaveLength(1);
        });

        await vi.advanceTimersByTimeAsync(5000);

        await waitForCheck(() => {
            expect(messagesCalls()).toHaveLength(2);
            expect(onUserMessage).toHaveBeenCalledWith({ ...userMessage, serverMessageId: 'msg-1' });
        });
        expect(messagesCalls()[1][1].params.after_seq).toBe(0);
        expect((client as any).lastSeq).toBe(1);
        await client.close();
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

    describe('managed durable message acknowledgement', () => {
        /**
         * The confirmation rides the existing outbox: a caller registers a waiter,
         * enqueues through the normal path, and awaits. Nothing here bypasses
         * `pendingOutbox`, so ordering against fork backfill is untouched.
         */
        function ackRow(localId: string, over: Partial<{ id: string; seq: number }> = {}) {
            return { id: 'msg-1', seq: 1, localId, createdAt: 1, updatedAt: 1, ...over };
        }

        it('confirms once the server returns a matching acknowledgement', async () => {
            const client = new ApiSessionClient('fake-token', session);
            mockAxiosPost.mockResolvedValue({ data: { messages: [ackRow('local-initial')] } });

            const wait = client.awaitMessageAck('local-initial', 1_000);
            client.sendClaudeSessionMessage(buildInitialPromptUserRecord('hi', 'sess-1'), 'local-initial');

            await expect(wait).resolves.toMatchObject({ ok: true, id: 'msg-1', seq: 1 });
        });

        it('accepts an acknowledgement for a row the server already had', async () => {
            const client = new ApiSessionClient('fake-token', session);
            // Server-side dedupe returns the pre-existing row; that is a real ack.
            mockAxiosPost.mockResolvedValue({
                data: { messages: [ackRow('local-initial', { id: 'existing-1', seq: 7 })] }
            });
            const wait = client.awaitMessageAck('local-initial', 1_000);
            client.sendClaudeSessionMessage(buildInitialPromptUserRecord('hi', 'sess-1'), 'local-initial');
            await expect(wait).resolves.toMatchObject({ ok: true, id: 'existing-1', seq: 7 });
        });

        it('does not confirm on a 2xx that omits our acknowledgement', async () => {
            const client = new ApiSessionClient('fake-token', session);
            mockAxiosPost.mockResolvedValue({ data: { messages: [] } });

            const wait = client.awaitMessageAck('local-initial', 30);
            client.sendClaudeSessionMessage(buildInitialPromptUserRecord('hi', 'sess-1'), 'local-initial');

            // Not proof the message was lost — durability is simply unknown.
            await expect(wait).resolves.toMatchObject({ ok: false, reason: 'deadline' });
        });

        it.each([
            ['a missing id', { id: '' }],
            ['a non-integer seq', { seq: 1.5 }],
            ['a zero seq', { seq: 0 }],
            ['a negative seq', { seq: -3 }],
            ['an unsafe seq', { seq: Number.MAX_SAFE_INTEGER + 2 }],
        ])('does not confirm on %s', async (_name, over) => {
            const client = new ApiSessionClient('fake-token', session);
            mockAxiosPost.mockResolvedValue({ data: { messages: [ackRow('local-initial', over)] } });
            const wait = client.awaitMessageAck('local-initial', 30);
            client.sendClaudeSessionMessage(buildInitialPromptUserRecord('x', 'sess-1'), 'local-initial');
            await expect(wait).resolves.toMatchObject({ ok: false });
        });

        it('ignores an acknowledgement for a different localId', async () => {
            const client = new ApiSessionClient('fake-token', session);
            mockAxiosPost.mockResolvedValue({ data: { messages: [ackRow('someone-else')] } });
            const wait = client.awaitMessageAck('local-initial', 30);
            client.sendClaudeSessionMessage(buildInitialPromptUserRecord('x', 'sess-1'), 'local-initial');
            await expect(wait).resolves.toMatchObject({ ok: false, reason: 'deadline' });
        });

        it('refuses contradictory duplicate acknowledgements for one localId', async () => {
            const client = new ApiSessionClient('fake-token', session);
            mockAxiosPost.mockResolvedValue({
                data: {
                    messages: [
                        ackRow('local-initial', { id: 'msg-a', seq: 1 }),
                        ackRow('local-initial', { id: 'msg-b', seq: 2 }),
                    ]
                }
            });
            const wait = client.awaitMessageAck('local-initial', 30);
            client.sendClaudeSessionMessage(buildInitialPromptUserRecord('x', 'sess-1'), 'local-initial');
            await expect(wait).resolves.toMatchObject({ ok: false, reason: 'contradictory-ack' });
        });

        it('reports unknown when the post keeps failing', async () => {
            const client = new ApiSessionClient('fake-token', session);
            mockAxiosPost.mockRejectedValue(new Error('network down'));
            const wait = client.awaitMessageAck('local-initial', 30);
            client.sendClaudeSessionMessage(buildInitialPromptUserRecord('x', 'sess-1'), 'local-initial');
            await expect(wait).resolves.toMatchObject({ ok: false });
        });

        it('resolves every pending waiter as unknown when the session closes', async () => {
            const client = new ApiSessionClient('fake-token', session);
            mockAxiosPost.mockImplementation(() => new Promise(() => {}));
            const wait = client.awaitMessageAck('local-initial', 10_000);
            client.sendClaudeSessionMessage(buildInitialPromptUserRecord('x', 'sess-1'), 'local-initial');
            await client.close();
            await expect(wait).resolves.toMatchObject({ ok: false, reason: 'closed' });
        });

        it('refuses a second waiter for the same localId', () => {
            const client = new ApiSessionClient('fake-token', session);
            const first = client.awaitMessageAck('local-initial', 50);
            expect(() => client.awaitMessageAck('local-initial', 50)).toThrowError(/already/);
            return expect(first).resolves.toMatchObject({ ok: false });
        });

        it('keeps ordering: a backfilled queue is posted before the confirmed message', async () => {
            const client = new ApiSessionClient('fake-token', session);
            const posted: string[][] = [];
            mockAxiosPost.mockImplementation(async (_url: string, payload: { messages: Array<{ localId: string }> }) => {
                posted.push(payload.messages.map((m) => m.localId));
                return { data: { messages: payload.messages.map((m, i) => ackRow(m.localId, { id: `id-${i}`, seq: posted.length * 10 + i + 1 })) } };
            });

            // Stands in for FORK BACKFILL: a historical transcript enqueued before
            // the initial prompt ever runs.
            for (let i = 0; i < 3; i += 1) client.sendCodexMessage({ type: `backfill-${i}` });
            const wait = client.awaitMessageAck('local-initial', 1_000);
            client.sendClaudeSessionMessage(buildInitialPromptUserRecord('x', 'sess-1'), 'local-initial');

            await expect(wait).resolves.toMatchObject({ ok: true });
            const flat = posted.flat();
            // The confirmed message must not have jumped the queue.
            expect(flat[flat.length - 1]).toBe('local-initial');
            expect(flat.length).toBe(4);
        });

            it('ignores an acknowledgement that names a localId this batch did not carry', async () => {
            const client = new ApiSessionClient('fake-token', session);
            // An earlier batch's response naming an unrelated localId must not
            // confirm a message that has not even been posted yet.
            mockAxiosPost.mockResolvedValueOnce({
                data: { messages: [ackRow('local-initial', { id: 'stray', seq: 99 })] }
            });
            client.sendCodexMessage({ type: 'backfill' });
            const wait = client.awaitMessageAck('local-initial', 40);
            await expect(wait).resolves.toMatchObject({ ok: false, reason: 'deadline' });
        });

    it('leaves no pending waiter state behind', async () => {
            const client = new ApiSessionClient('fake-token', session);
            mockAxiosPost.mockResolvedValue({ data: { messages: [ackRow('local-initial')] } });
            const wait = client.awaitMessageAck('local-initial', 1_000);
            client.sendClaudeSessionMessage(buildInitialPromptUserRecord('x', 'sess-1'), 'local-initial');
            await wait;
            // Re-registering proves the previous entry was cleaned up.
            expect(() => client.awaitMessageAck('local-initial', 10)).not.toThrow();
        });
    });
});

describe('ApiSessionClient generated title', () => {
    let socketHandlers: SocketHandlers;
    let mockSocket: any;
    let session: ReturnType<typeof makeSession>;

    const emitSocketEvent = (event: string, ...args: any[]) => {
        const handlers = socketHandlers[event] || [];
        handlers.forEach((handler) => handler(...args));
    };

    // Each update needs a fresh seq — the client drops ones it has already seen.
    let nextSeq = 1;
    const sendUserMessage = (client: ApiSessionClient, text: string) => {
        emitSocketEvent('update', createNewMessageUpdate(nextSeq++, encryptContent(session, {
            role: 'user',
            content: { type: 'text', text }
        })));
    };

    const summariesSentBy = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls
        .map(([body]) => body as any)
        .filter((body) => body?.type === 'summary')
        .map((body) => body.summary as string);

    beforeEach(() => {
        vi.clearAllMocks();
        mockShouldReconnect.mockReturnValue(true);
        socketHandlers = {};
        nextSeq = 1;
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
            volatile: { emit: vi.fn() },
            close: vi.fn()
        };
        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does not save the first user message as a fallback title', () => {
        const client = new ApiSessionClient('fake-token', session);
        const spy = vi.spyOn(client, 'sendClaudeSessionMessage');

        sendUserMessage(client, '음... 그러니까 로그인 버튼이 안 눌려');

        // A generated title must come only from the agent's change_title tool.
        expect(summariesSentBy(spy)).toEqual([]);
        expect(client.hasTitle()).toBe(false);
    });

    it('preserves a title written by the model after the user message arrives', () => {
        const client = new ApiSessionClient('fake-token', session);
        const spy = vi.spyOn(client, 'sendClaudeSessionMessage');

        sendUserMessage(client, '로그인 버튼이 안 눌려');
        client.sendClaudeSessionMessage({ type: 'summary', summary: '로그인 버튼 클릭 오류 수정', leafUuid: 'model-uuid' } as any);

        expect(summariesSentBy(spy)).toEqual(['로그인 버튼 클릭 오류 수정']);
    });
});

describe('toolCallStartLaunchesBackgroundJob', () => {
    it('detects a Bash tool call started in the background', () => {
        expect(toolCallStartLaunchesBackgroundJob({ name: 'Bash', args: { command: 'train.sh', run_in_background: true } })).toBe(true);
        expect(toolCallStartLaunchesBackgroundJob({ name: 'Bash', args: { command: 'train.sh', runInBackground: true } })).toBe(true);
    });

    it('does not flag foreground or non-background tool calls', () => {
        expect(toolCallStartLaunchesBackgroundJob({ name: 'Bash', args: { command: 'ls' } })).toBe(false);
        expect(toolCallStartLaunchesBackgroundJob({ name: 'Bash', args: { command: 'ls', run_in_background: false } })).toBe(false);
        expect(toolCallStartLaunchesBackgroundJob({ name: 'Read', args: {} })).toBe(false);
    });
});
