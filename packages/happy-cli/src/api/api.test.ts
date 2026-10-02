import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from './api';
import axios from 'axios';
import { connectionState } from '@/utils/serverConnectionErrors';

// Use vi.hoisted to ensure mock functions are available when vi.mock factory runs
const { mockPost, mockIsAxiosError } = vi.hoisted(() => ({
    mockPost: vi.fn(),
    mockIsAxiosError: vi.fn(() => true)
}));

vi.mock('axios', () => ({
    default: {
        post: mockPost,
        isAxiosError: mockIsAxiosError
    },
    isAxiosError: mockIsAxiosError
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

// Mock encryption utilities
vi.mock('./encryption', () => ({
    decodeBase64: vi.fn((data: string) => data),
    encodeBase64: vi.fn((data: any) => data),
    decrypt: vi.fn((_key: any, _variant: any, data: any) => data),
    encrypt: vi.fn((_key: any, _variant: any, data: any) => data),
    // 부분 mock 함정 방지: getOrCreateMachine 이 무조건 호출하는 조립 함수.
    // 이 스위트의 자격증명은 wrap 재료가 없는 plain legacy — 실물과 동일하게
    // 봉투 없음을 돌려준다.
    buildMachineKeyEnvelopes: vi.fn(() => ({ dataEncryptionKey: null, serverDataEncryptionKey: null, serverRpcKeyEnvelope: null }))
}));

// Mock configuration
vi.mock('./configuration', () => ({
    configuration: {
        serverUrl: 'https://api.example.com'
    }
}));

// Mock libsodium encryption
vi.mock('./libsodiumEncryption', () => ({
    libsodiumEncryptForPublicKey: vi.fn((data: any) => new Uint8Array(32))
}));

// Global test metadata
const testMetadata = {
    path: '/tmp',
    host: 'localhost',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/home/user/.happy/lib',
    happyToolsDir: '/home/user/.happy/tools'
};

const testMachineMetadata = {
    host: 'localhost',
    platform: 'darwin',
    happyCliVersion: '1.0.0',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/home/user/.happy/lib'
};

describe('Api server error handling', () => {
    let api: ApiClient;

    beforeEach(async () => {
        vi.clearAllMocks();
        connectionState.reset(); // Reset offline state between tests

        // Create a mock credential
        const mockCredential = {
            token: 'fake-token',
            encryption: {
                type: 'legacy' as const,
                secret: new Uint8Array(32)
            }
        };

        api = await ApiClient.create(mockCredential);
    });

    describe('getOrCreateSession', () => {
        it('should return null when Happy server is unreachable (ECONNREFUSED)', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw connection refused error
            mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        // The session path deliberately does NOT swallow an axios client-side
        // timeout. This call mints a fresh data encryption key per invocation
        // and the reconnect path retries under the same session tag; if the
        // server did persist the timed-out request it keeps the original key
        // and ignores the resubmitted one, leaving a session encrypted under a
        // key the app cannot hold. Failing loudly beats silent E2EE corruption.
        it('should rethrow a request timeout (ECONNABORTED) rather than silently going offline', async () => {
            connectionState.reset();
            mockPost.mockRejectedValue({
                code: 'ECONNABORTED',
                message: 'timeout of 60000ms exceeded',
                isAxiosError: true
            });

            // Must throw rather than resolve to null — null is the "we went
            // offline, retry under the same tag" signal, and that is exactly
            // the path that would corrupt the session key here.
            await expect(api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            })).rejects.toMatchObject({
                message: expect.stringContaining('ECONNABORTED'),
                cause: expect.objectContaining({ code: 'ECONNABORTED' })
            });
        });

        it('should return null when Happy server cannot be found (ENOTFOUND)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw DNS resolution error
            mockPost.mockRejectedValue({ code: 'ENOTFOUND' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when Happy server times out (ETIMEDOUT)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw timeout error
            mockPost.mockRejectedValue({ code: 'ETIMEDOUT' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when session endpoint returns 404', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 404
            mockPost.mockRejectedValue({
                response: { status: 404 },
                code: 'ERR_BAD_REQUEST',
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            // New unified format via connectionState.fail()
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Session creation failed: 404')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when server returns 500 Internal Server Error', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 500 error
            mockPost.mockRejectedValue({
                response: { status: 500 },
                code: 'ERR_BAD_RESPONSE',
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            consoleSpy.mockRestore();
        });

        it('should return null when server returns 503 Service Unavailable', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 503 error
            mockPost.mockRejectedValue({
                response: { status: 503 },
                code: 'ERR_BAD_RESPONSE',
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            consoleSpy.mockRestore();
        });

        it('should re-throw non-connection errors', async () => {
            // Mock axios to throw a different type of error (e.g., authentication error)
            const authError = new Error('Invalid API key');
            (authError as any).code = 'UNAUTHORIZED';
            mockPost.mockRejectedValue(authError);

            await expect(
                api.getOrCreateSession({ tag: 'test-tag', metadata: testMetadata, state: null })
            ).rejects.toThrow('Failed to get or create session: UNAUTHORIZED — Invalid API key');

            // Should not show the offline mode message
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            expect(consoleSpy).not.toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            consoleSpy.mockRestore();
        });
    });

    describe('getOrCreateSession with a key the caller chose', () => {
        // The daemon creates a session for its channel host and must know the key it is sealed
        // with — the host reads the session with it. So the caller supplies the key and the
        // envelope, and this call uploads exactly those instead of minting its own.
        it('uploads the supplied envelope and seals the session with the supplied key', async () => {
            const dataKeyApi = await ApiClient.create({
                token: 'fake-token',
                encryption: { type: 'dataKey', publicKey: new Uint8Array(32), machineKey: new Uint8Array(32) },
            });
            const key = new Uint8Array(32).fill(7);
            const wrapped = new Uint8Array([0, 1, 2, 3]);
            mockPost.mockResolvedValue({
                data: { session: { id: 's-1', seq: 0, metadata: testMetadata, metadataVersion: 0, agentState: null, agentStateVersion: 0 } },
            });

            const session = await dataKeyApi.getOrCreateSession({
                tag: 'tag-1', metadata: testMetadata, state: null, dataKey: { key, wrapped },
            });

            expect(mockPost.mock.calls[0][1].dataEncryptionKey).toBe(wrapped);
            expect(session?.encryptionKey).toBe(key);
            expect(session?.encryptionVariant).toBe('dataKey');
        });

        it('refuses a supplied key on a legacy account, whose sessions have no per-session key', async () => {
            await expect(api.getOrCreateSession({
                tag: 'tag-1', metadata: testMetadata, state: null,
                dataKey: { key: new Uint8Array(32), wrapped: new Uint8Array(4) },
            })).rejects.toThrow('legacy');
            expect(mockPost).not.toHaveBeenCalled();
        });
    });

    describe('getOrCreateMachine', () => {
        // aplus-dev-studio specs/e2ee-machine-control-boundary R1 — the server
        // lane envelope goes up with every registration; strict mode stops
        // escrowing the machine key itself.
        it('registers the server-lane envelope next to the account envelope', async () => {
            const { buildMachineKeyEnvelopes } = await import('./encryption');
            vi.mocked(buildMachineKeyEnvelopes).mockReturnValueOnce({
                dataEncryptionKey: 'account-envelope' as never,
                serverDataEncryptionKey: 'machine-key-escrow' as never,
                serverRpcKeyEnvelope: 'server-lane-envelope' as never,
            });
            mockPost.mockResolvedValue({ data: { machine: { id: 'test-machine', metadata: testMachineMetadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 } } });

            await api.getOrCreateMachine({ machineId: 'test-machine', metadata: testMachineMetadata });

            expect(mockPost.mock.calls[0][1]).toMatchObject({
                dataEncryptionKey: 'account-envelope',
                serverDataEncryptionKey: 'machine-key-escrow',
                serverRpcKeyEnvelope: 'server-lane-envelope',
            });
            expect(vi.mocked(buildMachineKeyEnvelopes).mock.calls.at(-1)![2]).toEqual({ escrowMachineKey: true });
        });

        it('asks for no machine-key escrow in strict mode', async () => {
            const { buildMachineKeyEnvelopes } = await import('./encryption');
            mockPost.mockResolvedValue({ data: { machine: { id: 'test-machine', metadata: testMachineMetadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 } } });

            await api.getOrCreateMachine({ machineId: 'test-machine', metadata: testMachineMetadata, machineControl: 'strict' });

            expect(vi.mocked(buildMachineKeyEnvelopes).mock.calls.at(-1)![2]).toEqual({ escrowMachineKey: false });
        });

        it('asks for no machine-key escrow from a strict process whatever the caller passes', async () => {
            const { buildMachineKeyEnvelopes } = await import('./encryption');
            const { configuration } = await import('@/configuration');
            const mode = configuration as { machineControl: 'compat' | 'strict' };
            const previous = mode.machineControl;
            mode.machineControl = 'strict';
            try {
                mockPost.mockResolvedValue({ data: { machine: { id: 'test-machine', metadata: testMachineMetadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 } } });

                await api.getOrCreateMachine({ machineId: 'test-machine', metadata: testMachineMetadata });
                await api.getOrCreateMachine({ machineId: 'test-machine', metadata: testMachineMetadata, machineControl: 'compat' });

                expect(vi.mocked(buildMachineKeyEnvelopes).mock.calls.slice(-2).map((call) => call[2])).toEqual([
                    { escrowMachineKey: false },
                    { escrowMachineKey: false },
                ]);
            } finally {
                mode.machineControl = previous;
            }
        });

        it('should retain the current daemon startup state when the server returns an existing machine', async () => {
            mockPost.mockResolvedValue({
                data: {
                    machine: {
                        id: 'test-machine',
                        metadata: testMachineMetadata,
                        metadataVersion: 4,
                        daemonState: {
                            status: 'shutting-down',
                            shutdownSource: 'cli',
                            mcpCallerGrantPublicKey: 'stale-process-key'
                        },
                        daemonStateVersion: 9
                    }
                }
            });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
                daemonState: {
                    status: 'offline',
                    pid: 5678,
                    httpPort: 4321,
                    mcpCallerGrantPublicKey: 'current-process-key'
                }
            });

            expect(result.daemonState).toEqual({
                status: 'offline',
                shutdownSource: 'cli',
                pid: 5678,
                httpPort: 4321,
                mcpCallerGrantPublicKey: 'current-process-key'
            });
            expect(result.daemonStateVersion).toBe(9);
        });

        it('should return minimal machine object when server is unreachable (ECONNREFUSED)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw connection refused error
            mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
                daemonState: {
                    status: 'running',
                    pid: 1234
                }
            });

            expect(result).toEqual({
                id: 'test-machine',
                encryptionKey: expect.any(Uint8Array),
                encryptionVariant: 'legacy',
                metadata: testMachineMetadata,
                metadataVersion: 0,
                daemonState: {
                    status: 'running',
                    pid: 1234
                },
                daemonStateVersion: 0,
            });

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        // 회귀 테스트: 프로덕션에서 데몬을 죽였던 바로 그 오류.
        // axios 는 자기 `timeout` 옵션이 만료되면 커널의 ETIMEDOUT 이 아니라
        // ECONNABORTED 를 쓴다. 이 코드가 NETWORK_ERROR_CODES 에 없던 동안에는
        // 여기서 오류가 다시 던져졌고, 데몬 최상위 catch 가 그걸 받아
        // process.exit(1) 로 프로세스를 통째로 내렸다.
        it('should return minimal machine object when the request times out (ECONNABORTED)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            mockPost.mockRejectedValue({
                code: 'ECONNABORTED',
                message: 'timeout of 60000ms exceeded',
                isAxiosError: true
            });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata,
                daemonState: { status: 'running', pid: 1234 }
            });

            expect(result).toEqual({
                id: 'test-machine',
                encryptionKey: expect.any(Uint8Array),
                encryptionVariant: 'legacy',
                metadata: testMachineMetadata,
                metadataVersion: 0,
                daemonState: { status: 'running', pid: 1234 },
                daemonStateVersion: 0,
            });

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        // Not every transport failure arrives as an AxiosError — some surface
        // as a plain Error carrying `code`, or wrap the real failure on
        // `cause`. Missing those means a crash instead of offline mode.
        it('should return minimal machine object for a transport error carried on cause', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            mockPost.mockRejectedValue(Object.assign(new Error('fetch failed'), {
                cause: { code: 'EAI_AGAIN' }
            }));

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata
            });

            expect(result.id).toBe('test-machine');
            expect(result.metadataVersion).toBe(0);
            consoleSpy.mockRestore();
        });

        // 401 used to fall through every branch and be rethrown, which on the
        // daemon startup path meant a FATAL exit with an opaque stack.
        it('should return minimal machine object and explain how to recover on 401', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            mockPost.mockRejectedValue({
                response: { status: 401 },
                code: 'ERR_BAD_REQUEST',
                isAxiosError: true
            });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata
            });

            expect(result.id).toBe('test-machine');
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining("run 'happy auth'")
            );

            consoleSpy.mockRestore();
        });

        // A 200 whose body will not parse (captive portal, proxy serving HTML)
        // reaches the catch with `response` set and a 2xx status. Reporting
        // that as a rejection would be self-contradictory, so it must fail
        // with a message that says what actually happened.
        it('should fail with a readable message when a 2xx body cannot be parsed', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            mockPost.mockRejectedValue({
                response: { status: 200 },
                code: 'ERR_BAD_RESPONSE',
                message: "Unexpected token '<', \"<html>\"... is not valid JSON",
                isAxiosError: true
            });

            await expect(api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata
            })).rejects.toThrow('unreadable response (status 200)');

            expect(consoleSpy).not.toHaveBeenCalledWith(
                expect.stringContaining('rejected machine registration')
            );

            consoleSpy.mockRestore();
        });

        // Guards the reordering fix: axios stamps ERR_BAD_RESPONSE on every
        // 5xx, so classifying by code before status once made this dedicated
        // branch unreachable and reported a real server error as a mangled
        // reply. Without a machine-path 5xx test that could regress silently.
        it('should return minimal machine object and report the status when the server returns 503', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            mockPost.mockRejectedValue({
                response: { status: 503 },
                code: 'ERR_BAD_RESPONSE',
                isAxiosError: true
            });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata
            });

            expect(result.id).toBe('test-machine');
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Machine registration failed: 503')
            );

            consoleSpy.mockRestore();
        });

        // A permanent rejection must not claim the server is unreachable or
        // promise a retry that never comes — registration runs once per
        // process. It still returns a local machine so the daemon lives.
        it('should report a 400 as a contract problem rather than as being offline', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            mockPost.mockRejectedValue({
                response: { status: 400 },
                code: 'ERR_BAD_REQUEST',
                isAxiosError: true
            });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata
            });

            expect(result.id).toBe('test-machine');
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('rejected machine registration with status 400')
            );
            expect(consoleSpy).not.toHaveBeenCalledWith(
                expect.stringContaining('Happy server unreachable')
            );

            consoleSpy.mockRestore();
        });

        // A rate limiter answering mid-burst is transient, not fatal.
        it('should return minimal machine object when the server returns 429', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            mockPost.mockRejectedValue({
                response: { status: 429 },
                code: 'ERR_BAD_REQUEST',
                isAxiosError: true
            });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata
            });

            expect(result.id).toBe('test-machine');
            consoleSpy.mockRestore();
        });

        // Genuine defects must stay loud rather than be masked as "offline".
        it('should rethrow a non-transport, non-HTTP error', async () => {
            connectionState.reset();
            mockIsAxiosError.mockReturnValue(false);
            mockPost.mockRejectedValue(new TypeError('bad encryption input'));

            try {
                await expect(api.getOrCreateMachine({
                    machineId: 'test-machine',
                    metadata: testMachineMetadata
                })).rejects.toThrow(TypeError);
            } finally {
                mockIsAxiosError.mockReturnValue(true);
            }
        });

        it('should return minimal machine object when server endpoint returns 404', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 404
            mockPost.mockRejectedValue({
                response: { status: 404 },
                code: 'ERR_BAD_REQUEST',
                isAxiosError: true
            });

            const result = await api.getOrCreateMachine({
                machineId: 'test-machine',
                metadata: testMachineMetadata
            });

            expect(result).toEqual({
                id: 'test-machine',
                encryptionKey: expect.any(Uint8Array),
                encryptionVariant: 'legacy',
                metadata: testMachineMetadata,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            });

            // New unified format via connectionState.fail()
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Machine registration failed: 404')
            );

            consoleSpy.mockRestore();
        });
    });
});
