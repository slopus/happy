import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from './api';
import axios from 'axios';
import { connectionState } from '@/utils/serverConnectionErrors';
import { encryptWithDataKey, decryptWithDataKey, deriveVendorEncryptionKey } from './encryption';

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

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

// Mock encryption utilities
vi.mock('./encryption', () => ({
    decodeBase64: vi.fn((data: string) => {
        // Return a Uint8Array for base64 strings (used by getVendorToken)
        if (typeof data === 'string') return new Uint8Array(Buffer.from(data, 'base64'));
        return data;
    }),
    encodeBase64: vi.fn((data: any) => {
        // Return base64 string for Uint8Array (used by registerVendorToken)
        if (data instanceof Uint8Array) return Buffer.from(data).toString('base64');
        return data;
    }),
    decrypt: vi.fn((data: any) => data),
    encrypt: vi.fn((data: any) => data),
    encryptWithDataKey: vi.fn((_data: any, _key: Uint8Array) => new Uint8Array([1, 2, 3, 4])),
    decryptWithDataKey: vi.fn((_bundle: Uint8Array, _key: Uint8Array) => null),
    deriveVendorEncryptionKey: vi.fn((_machineKey: Uint8Array) => new Uint8Array(32).fill(0xAB)),
    getRandomBytes: vi.fn((size: number) => new Uint8Array(size)),
    libsodiumPublicKeyFromSecretKey: vi.fn(() => new Uint8Array(32)),
    libsodiumEncryptForPublicKey: vi.fn(() => new Uint8Array(32))
}));

// Mock configuration
vi.mock('./configuration', () => ({
    configuration: {
        serverUrl: 'https://api.example.com'
    }
}));

// Mock libsodium encryption (not used by encryption.ts anymore, but still imported directly in some paths)
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
});

describe('registerVendorToken', () => {
    let api: ApiClient;

    beforeEach(async () => {
        vi.clearAllMocks();
        connectionState.reset();

        const dataKeyCredential = {
            token: 'fake-token',
            encryption: {
                type: 'dataKey' as const,
                publicKey: new Uint8Array(32).fill(0x01),
                machineKey: new Uint8Array(32).fill(0x02)
            }
        };

        api = await ApiClient.create(dataKeyCredential);
    });

    it('sends encrypted blob, not raw plaintext token', async () => {
        mockPost.mockResolvedValue({ status: 200, data: { success: true } });

        await api.registerVendorToken('anthropic', 'sk-ant-secret');

        expect(mockPost).toHaveBeenCalledTimes(1);
        const [_url, body] = mockPost.mock.calls[0];
        // The token in the request body should be a base64-encoded encrypted blob, not the raw key
        expect(body.token).not.toBe('sk-ant-secret');
        expect(body.token).not.toBe(JSON.stringify('sk-ant-secret'));
        expect(typeof body.token).toBe('string');
    });

    it('calls deriveVendorEncryptionKey with machineKey from credentials', async () => {
        mockPost.mockResolvedValue({ status: 200, data: { success: true } });

        await api.registerVendorToken('openai', 'sk-openai-key');

        expect(deriveVendorEncryptionKey).toHaveBeenCalledWith(new Uint8Array(32).fill(0x02));
    });

    it('calls encryptWithDataKey with serialized token and derived key', async () => {
        mockPost.mockResolvedValue({ status: 200, data: { success: true } });

        await api.registerVendorToken('gemini', 'gemini-api-key');

        expect(encryptWithDataKey).toHaveBeenCalledWith(
            JSON.stringify('gemini-api-key'),
            new Uint8Array(32).fill(0xAB) // The mocked derived key
        );
    });

    it('throws on non-2xx response', async () => {
        mockPost.mockResolvedValue({ status: 500, data: {} });

        await expect(api.registerVendorToken('anthropic', 'key'))
            .rejects.toThrow('Failed to register vendor token');
    });
});

describe('getVendorToken', () => {
    let api: ApiClient;

    beforeEach(async () => {
        vi.clearAllMocks();
        connectionState.reset();

        const dataKeyCredential = {
            token: 'fake-token',
            encryption: {
                type: 'dataKey' as const,
                publicKey: new Uint8Array(32).fill(0x01),
                machineKey: new Uint8Array(32).fill(0x02)
            }
        };

        api = await ApiClient.create(dataKeyCredential);
    });

    it('returns decrypted token from valid E2E encrypted blob', async () => {
        // decryptWithDataKey returns the JSON.parse'd value from the encrypted blob.
        // registerVendorToken double-encodes: JSON.stringify(apiKey) → encryptWithDataKey,
        // so decryptWithDataKey returns a JSON string that getVendorToken parses once more.
        vi.mocked(decryptWithDataKey).mockReturnValueOnce(JSON.stringify('sk-ant-decrypted-key'));

        mockGet.mockResolvedValue({
            status: 200,
            data: { token: Buffer.from('encrypted-blob').toString('base64') }
        });

        const result = await api.getVendorToken('anthropic');

        expect(decryptWithDataKey).toHaveBeenCalled();
        expect(result).toBe('sk-ant-decrypted-key');
    });

    it('falls back to legacy JSON parsing when decryptWithDataKey returns null', async () => {
        // E2E decryption fails (returns null) — legacy token
        vi.mocked(decryptWithDataKey).mockReturnValueOnce(null);

        mockGet.mockResolvedValue({
            status: 200,
            data: { token: JSON.stringify({ apiKey: 'legacy-key' }) }
        });

        const result = await api.getVendorToken('openai');

        expect(result).toEqual({ apiKey: 'legacy-key' });
    });

    it('returns null when server returns { token: null }', async () => {
        mockGet.mockResolvedValue({
            status: 200,
            data: { token: null }
        });

        const result = await api.getVendorToken('anthropic');

        expect(result).toBeNull();
    });

    it('returns null on 404', async () => {
        const error = new Error('Not found') as any;
        error.response = { status: 404 };
        mockGet.mockRejectedValue(error);

        const result = await api.getVendorToken('gemini');

        expect(result).toBeNull();
    });

    it('handles decryption throw gracefully (inner try/catch)', async () => {
        // E2E decryption throws — should fall through to legacy parsing
        vi.mocked(decryptWithDataKey).mockImplementationOnce(() => { throw new Error('bad blob'); });

        mockGet.mockResolvedValue({
            status: 200,
            data: { token: JSON.stringify('plain-token') }
        });

        const result = await api.getVendorToken('anthropic');

        // Should still return the legacy-parsed token
        expect(result).toBe('plain-token');
    });
});