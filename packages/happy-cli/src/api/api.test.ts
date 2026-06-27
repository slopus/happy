import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from './api';
import axios from 'axios';
import { connectionState } from '@/utils/serverConnectionErrors';

// Use vi.hoisted to ensure mock functions are available when vi.mock factory runs
const { mockPost, mockGet, mockIsAxiosError } = vi.hoisted(() => ({
    mockPost: vi.fn(),
    mockGet: vi.fn(),
    mockIsAxiosError: vi.fn(() => true)
}));

vi.mock('axios', () => ({
    default: {
        post: mockPost,
        get: mockGet,
        isAxiosError: mockIsAxiosError
    },
    isAxiosError: mockIsAxiosError
}));

vi.mock('chalk', () => ({
    default: new Proxy({}, {
        get: () => (value: string) => value
    })
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

vi.mock('./apiSession', () => ({
    ApiSessionClient: vi.fn()
}));

vi.mock('./apiMachine', () => ({
    ApiMachineClient: vi.fn()
}));

vi.mock('./pushNotifications', () => ({
    PushNotificationClient: vi.fn(function PushNotificationClient() {
        return {};
    })
}));

// Mock encryption utilities
vi.mock('./encryption', () => ({
    decodeBase64: vi.fn((data: string) => data),
    encodeBase64: vi.fn((data: any) => data),
    decrypt: vi.fn((data: any) => data),
    encrypt: vi.fn((data: any) => data)
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
            ).rejects.toThrow('Failed to get or create session: Invalid API key');

            // Should not show the offline mode message
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            expect(consoleSpy).not.toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Happy server unreachable')
            );
            consoleSpy.mockRestore();
        });
    });

    describe('getOrCreateMachine', () => {
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

        it('should return minimal machine object when server endpoint returns 404', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 404
            mockPost.mockRejectedValue({
                response: { status: 404 },
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

    describe('registerVendorToken', () => {
        it('waits for long-task completion while progress continues', async () => {
            mockPost.mockResolvedValue({
                status: 202,
                data: {
                    taskId: 'task-1',
                    state: 'accepted',
                    stage: 'accepted',
                    pollAfterMs: 1,
                    heartbeatAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z'
                }
            });
            mockGet
                .mockResolvedValueOnce({
                    data: {
                        taskId: 'task-1',
                        state: 'running',
                        stage: 'persisting',
                        pollAfterMs: 1,
                        heartbeatAt: '2026-01-01T00:00:00.100Z',
                        updatedAt: '2026-01-01T00:00:00.100Z'
                    }
                })
                .mockResolvedValueOnce({
                    data: {
                        taskId: 'task-1',
                        state: 'succeeded',
                        stage: 'succeeded',
                        pollAfterMs: 1,
                        heartbeatAt: '2026-01-01T00:00:00.200Z',
                        updatedAt: '2026-01-01T00:00:00.200Z'
                    }
                });

            const seenStages: string[] = [];
            await expect(api.registerVendorToken('openai', { oauth: true }, {
                pollIntervalMs: 1,
                idleTimeoutMs: 50,
                absoluteTimeoutMs: 500,
                onProgress: (status) => seenStages.push(status.stage)
            })).resolves.toBeUndefined();

            expect(mockGet).toHaveBeenCalledTimes(2);
            expect(seenStages).toEqual(['accepted', 'persisting', 'succeeded']);
        });

        it('fails when task stops making progress', async () => {
            mockPost.mockResolvedValue({
                status: 202,
                data: {
                    taskId: 'task-2',
                    state: 'accepted',
                    stage: 'accepted',
                    pollAfterMs: 1,
                    heartbeatAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z'
                }
            });
            mockGet.mockResolvedValue({
                data: {
                    taskId: 'task-2',
                    state: 'running',
                    stage: 'persisting',
                    pollAfterMs: 1,
                    heartbeatAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z'
                }
            });

            await expect(api.registerVendorToken('openai', { oauth: true }, {
                pollIntervalMs: 1,
                idleTimeoutMs: 10,
                absoluteTimeoutMs: 100
            })).rejects.toThrow('Failed to register vendor token: Vendor token registration stalled after 10ms without progress');
        });

        it('surfaces task failure errors', async () => {
            mockPost.mockResolvedValue({
                status: 202,
                data: {
                    taskId: 'task-3',
                    state: 'accepted',
                    stage: 'accepted',
                    pollAfterMs: 1,
                    heartbeatAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z'
                }
            });
            mockGet.mockResolvedValue({
                data: {
                    taskId: 'task-3',
                    state: 'failed',
                    stage: 'failed',
                    pollAfterMs: 1,
                    heartbeatAt: '2026-01-01T00:00:00.100Z',
                    updatedAt: '2026-01-01T00:00:00.100Z',
                    error: 'Vendor token registration failed. Please retry.',
                    errorCode: 'CONNECT_REGISTER_FAILED'
                }
            });

            await expect(api.registerVendorToken('openai', { oauth: true }, {
                pollIntervalMs: 1,
                idleTimeoutMs: 50,
                absoluteTimeoutMs: 500
            })).rejects.toThrow('Failed to register vendor token: Vendor token registration failed. Please retry.');
        });

        it('explains when the long-task record disappears mid-poll', async () => {
            mockPost.mockResolvedValue({
                status: 202,
                data: {
                    taskId: 'task-4',
                    state: 'accepted',
                    stage: 'accepted',
                    pollAfterMs: 1,
                    heartbeatAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z'
                }
            });
            mockGet.mockRejectedValue({
                response: {
                    status: 404
                }
            });

            await expect(api.registerVendorToken('openai', { oauth: true }, {
                pollIntervalMs: 1,
                idleTimeoutMs: 50,
                absoluteTimeoutMs: 500
            })).rejects.toThrow(
                'Failed to register vendor token: Vendor token registration task was lost before completion (the server may have restarted or evicted the task). Please retry registration.'
            );
        });
    });
});
