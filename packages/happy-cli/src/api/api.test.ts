import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from './api';
import axios from 'axios';
import { connectionState } from '@/utils/serverConnectionErrors';

// Use vi.hoisted to ensure mock functions are available when vi.mock factory runs
const { mockPost, mockIsAxiosError, mockLoggerDebug } = vi.hoisted(() => ({
    mockPost: vi.fn(),
    mockIsAxiosError: vi.fn(() => true),
    mockLoggerDebug: vi.fn(),
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
        debug: mockLoggerDebug,
    }
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
        mockLoggerDebug.mockReset();
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

    afterEach(() => {
        delete process.env.HAPPY_SESSION_STARTUP_TRACE_ID;
    });

    describe('getOrCreateSession', () => {
        it('records worker session creation at the successful HTTP boundary with only allowlisted fields', async () => {
            process.env.HAPPY_SESSION_STARTUP_TRACE_ID = '00000000-0000-4000-8000-000000000001';
            api = await ApiClient.create({
                token: 'fake-token',
                encryption: { type: 'legacy', secret: new Uint8Array(32) },
            });
            expect(process.env.HAPPY_SESSION_STARTUP_TRACE_ID).toBeUndefined();
            mockPost.mockResolvedValue({
                data: {
                    session: {
                        id: 'session-1',
                        seq: 0,
                        metadata: 'encrypted-metadata',
                        metadataVersion: 0,
                        agentState: null,
                        agentStateVersion: 0,
                    },
                },
            });

            await api.getOrCreateSession({
                tag: 'tag-canary',
                metadata: { ...testMetadata, machineId: 'machine-1' },
                state: null,
            });
            await api.getOrCreateSession({
                tag: 'retry-tag-canary',
                metadata: { ...testMetadata, machineId: 'machine-1' },
                state: null,
            });

            const stageEvents = mockLoggerDebug.mock.calls
                .filter(([label]) => label === '[SESSION STARTUP]')
                .map(([, event]) => event);
            expect(stageEvents).toEqual([
                expect.objectContaining({
                    traceId: '00000000-0000-4000-8000-000000000001',
                    stage: 'worker.session.created',
                    sessionId: 'session-1',
                    machineId: 'machine-1',
                    outcome: 'success',
                }),
            ]);
            expect(JSON.stringify(stageEvents)).not.toContain('canary');
        });

        it('consumes an invalid inherited startup trace without emitting telemetry', async () => {
            process.env.HAPPY_SESSION_STARTUP_TRACE_ID = 'legacy-or-invalid-trace';

            api = await ApiClient.create({
                token: 'fake-token',
                encryption: { type: 'legacy', secret: new Uint8Array(32) },
            });

            expect(process.env.HAPPY_SESSION_STARTUP_TRACE_ID).toBeUndefined();
            expect(mockLoggerDebug.mock.calls.some(([label]) => label === '[SESSION STARTUP]')).toBe(false);
        });

        it.each([undefined, '', '   ', 42])('does not emit session-created telemetry for invalid session id %j', async (sessionId) => {
            process.env.HAPPY_SESSION_STARTUP_TRACE_ID = '00000000-0000-4000-8000-000000000001';
            api = await ApiClient.create({
                token: 'fake-token',
                encryption: { type: 'legacy', secret: new Uint8Array(32) },
            });
            mockPost.mockResolvedValue({
                data: {
                    session: {
                        id: sessionId,
                        seq: 0,
                        metadata: 'encrypted-metadata',
                        metadataVersion: 0,
                        agentState: null,
                        agentStateVersion: 0,
                    },
                },
            });

            await api.getOrCreateSession({ tag: 'tag', metadata: testMetadata, state: null });

            expect(mockLoggerDebug.mock.calls.some(([label]) => label === '[SESSION STARTUP]')).toBe(false);
        });

        it('returns the created session when startup telemetry logging throws', async () => {
            process.env.HAPPY_SESSION_STARTUP_TRACE_ID = '00000000-0000-4000-8000-000000000001';
            api = await ApiClient.create({
                token: 'fake-token',
                encryption: { type: 'legacy', secret: new Uint8Array(32) },
            });
            mockLoggerDebug.mockImplementation((label) => {
                if (label === '[SESSION STARTUP]') throw new Error('logger-canary');
            });
            mockPost.mockResolvedValue({
                data: {
                    session: {
                        id: 'session-1',
                        seq: 0,
                        metadata: 'encrypted-metadata',
                        metadataVersion: 0,
                        agentState: null,
                        agentStateVersion: 0,
                    },
                },
            });

            await expect(api.getOrCreateSession({ tag: 'tag', metadata: testMetadata, state: null }))
                .resolves.toMatchObject({ id: 'session-1' });
        });

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
});
