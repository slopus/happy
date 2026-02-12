import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import tweetnacl from 'tweetnacl';
import { encodeBase64, getRandomBytes, libsodiumEncryptForPublicKey } from './encryption';
import { readCredentials, writeCredentials } from './credentials';
import type { Config } from './config';

// Mock axios
vi.mock('axios', () => {
    const fn = vi.fn();
    return {
        default: { post: fn },
        AxiosError: class AxiosError extends Error {
            constructor(message: string) {
                super(message);
                this.name = 'AxiosError';
            }
        },
    };
});

// Mock qrcode-terminal
vi.mock('qrcode-terminal', () => ({
    default: {
        generate: vi.fn((_data: string, _opts: unknown, cb: (code: string) => void) => {
            cb('[QR CODE]');
        }),
    },
}));

// Mock chalk to pass-through
vi.mock('chalk', () => ({
    default: {
        bold: (s: string) => s,
        dim: (s: string) => s,
        green: (s: string) => s,
        yellow: (s: string) => s,
    },
}));

import axios from 'axios';
import { authLogin, authLogout, authStatus } from './auth';

const mockedAxiosPost = vi.mocked(axios.post);

function makeTestConfig(): Config {
    const homeDir = mkdtempSync(join(tmpdir(), 'happy-agent-auth-test-'));
    return {
        serverUrl: 'https://test-server.example.com',
        homeDir,
        credentialPath: join(homeDir, 'agent.key'),
    };
}

describe('auth', () => {
    let config: Config;
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        config = makeTestConfig();
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockedAxiosPost.mockReset();
    });

    afterEach(() => {
        rmSync(config.homeDir, { recursive: true, force: true });
        consoleSpy.mockRestore();
    });

    describe('authLogin', () => {
        it('completes the auth flow on first poll response', async () => {
            // The auth flow makes two POST calls:
            // 1. Initial request to register the public key
            // 2. Poll that returns authorized state

            const accountSecret = getRandomBytes(32);

            // We need to intercept the publicKey from the first call
            // to encrypt the secret with it for the response
            let capturedPublicKey: Uint8Array | null = null;

            mockedAxiosPost.mockImplementation(async (_url: string, data?: unknown) => {
                const body = data as { publicKey: string };
                if (!capturedPublicKey) {
                    // First call - initial request
                    capturedPublicKey = new Uint8Array(Buffer.from(body.publicKey, 'base64'));
                    return { data: { state: 'pending' } };
                }

                // Second call - poll returns authorized
                // Encrypt the account secret using the ephemeral public key
                const encryptedSecret = libsodiumEncryptForPublicKey(accountSecret, capturedPublicKey);

                return {
                    data: {
                        state: 'authorized',
                        token: 'test-jwt-token',
                        response: encodeBase64(encryptedSecret),
                    },
                };
            });

            await authLogin(config);

            // Verify credentials were saved
            const creds = readCredentials(config);
            expect(creds).not.toBeNull();
            expect(creds!.token).toBe('test-jwt-token');
            expect(creds!.secret).toEqual(accountSecret);

            // Verify axios was called with correct URL
            expect(mockedAxiosPost).toHaveBeenCalledWith(
                'https://test-server.example.com/v1/auth/account/request',
                expect.objectContaining({ publicKey: expect.any(String) })
            );
        });

        it('polls multiple times before success', async () => {
            const accountSecret = getRandomBytes(32);
            let capturedPublicKey: Uint8Array | null = null;
            let callCount = 0;

            mockedAxiosPost.mockImplementation(async (_url: string, data?: unknown) => {
                callCount++;
                const body = data as { publicKey: string };

                if (callCount === 1) {
                    // Initial request
                    capturedPublicKey = new Uint8Array(Buffer.from(body.publicKey, 'base64'));
                    return { data: { state: 'pending' } };
                }

                if (callCount <= 3) {
                    // Polls 2 and 3 return pending
                    return { data: { state: 'pending' } };
                }

                // Poll 4 returns authorized
                const encryptedSecret = libsodiumEncryptForPublicKey(accountSecret, capturedPublicKey!);
                return {
                    data: {
                        state: 'authorized',
                        token: 'multi-poll-token',
                        response: encodeBase64(encryptedSecret),
                    },
                };
            });

            await authLogin(config);

            const creds = readCredentials(config);
            expect(creds).not.toBeNull();
            expect(creds!.token).toBe('multi-poll-token');
            expect(creds!.secret).toEqual(accountSecret);
            expect(callCount).toBe(4); // 1 initial + 3 polls
        });

        it('throws when initial request fails', async () => {
            const { AxiosError } = await import('axios');
            mockedAxiosPost.mockRejectedValueOnce(new AxiosError('Network Error'));

            await expect(authLogin(config)).rejects.toThrow('Failed to initiate auth: Network Error');
        });

        it('throws when polling fails', async () => {
            const { AxiosError } = await import('axios');

            let callCount = 0;
            mockedAxiosPost.mockImplementation(async () => {
                callCount++;
                if (callCount === 1) {
                    return { data: { state: 'pending' } };
                }
                throw new AxiosError('Connection refused');
            });

            await expect(authLogin(config)).rejects.toThrow('Auth polling failed: Connection refused');
        });

        it('throws when decryption fails (wrong key)', async () => {
            // Encrypt with a different public key so decryption fails
            const wrongKeyPair = tweetnacl.box.keyPair();
            const accountSecret = getRandomBytes(32);
            const encryptedWithWrongKey = libsodiumEncryptForPublicKey(accountSecret, wrongKeyPair.publicKey);

            let callCount = 0;
            mockedAxiosPost.mockImplementation(async () => {
                callCount++;
                if (callCount === 1) {
                    return { data: { state: 'pending' } };
                }
                return {
                    data: {
                        state: 'authorized',
                        token: 'bad-token',
                        response: encodeBase64(encryptedWithWrongKey),
                    },
                };
            });

            await expect(authLogin(config)).rejects.toThrow('Failed to decrypt auth response');
        });

        it('sends publicKey as base64 in request body', async () => {
            const accountSecret = getRandomBytes(32);

            mockedAxiosPost.mockImplementation(async (_url: string, data?: unknown) => {
                const body = data as { publicKey: string };

                // Verify publicKey is valid base64
                const decoded = Buffer.from(body.publicKey, 'base64');
                expect(decoded.length).toBe(32); // NaCl public key is 32 bytes

                // Return authorized immediately
                const pubKey = new Uint8Array(decoded);
                const encryptedSecret = libsodiumEncryptForPublicKey(accountSecret, pubKey);
                return {
                    data: {
                        state: 'authorized',
                        token: 'token',
                        response: encodeBase64(encryptedSecret),
                    },
                };
            });

            // First call is initial, which returns pending above... but our mock
            // always returns authorized. Let me fix the mock.
            let callCount = 0;
            mockedAxiosPost.mockImplementation(async (_url: string, data?: unknown) => {
                callCount++;
                const body = data as { publicKey: string };

                // Verify publicKey is valid base64 and 32 bytes
                const decoded = Buffer.from(body.publicKey, 'base64');
                expect(decoded.length).toBe(32);

                if (callCount === 1) {
                    return { data: { state: 'pending' } };
                }

                const pubKey = new Uint8Array(decoded);
                const encryptedSecret = libsodiumEncryptForPublicKey(accountSecret, pubKey);
                return {
                    data: {
                        state: 'authorized',
                        token: 'token',
                        response: encodeBase64(encryptedSecret),
                    },
                };
            });

            await authLogin(config);
        });
    });

    describe('authLogout', () => {
        it('clears stored credentials', async () => {
            // First write some credentials
            writeCredentials(config, 'some-token', getRandomBytes(32));
            expect(existsSync(config.credentialPath)).toBe(true);

            await authLogout(config);

            expect(existsSync(config.credentialPath)).toBe(false);
        });

        it('does not throw when no credentials exist', async () => {
            await expect(authLogout(config)).resolves.toBeUndefined();
        });

        it('prints logout message', async () => {
            await authLogout(config);
            const calls = consoleSpy.mock.calls.map(c => String(c[0]));
            expect(calls).toContain('## Authentication');
            expect(calls).toContain('- Status: Logged out');
            expect(calls).toContain('- Credentials: Cleared');
        });
    });

    describe('authStatus', () => {
        it('shows authenticated status when credentials exist', async () => {
            writeCredentials(config, 'test-token', getRandomBytes(32));

            await authStatus(config);

            const calls = consoleSpy.mock.calls.map(c => String(c[0]));
            expect(calls).toContain('## Authentication');
            expect(calls).toContain('- Status: Authenticated');
        });

        it('shows not authenticated when no credentials', async () => {
            await authStatus(config);

            const calls = consoleSpy.mock.calls.map(c => String(c[0]));
            expect(calls).toContain('## Authentication');
            expect(calls).toContain('- Status: Not authenticated');
        });

        it('shows public key when authenticated', async () => {
            const secret = getRandomBytes(32);
            writeCredentials(config, 'test-token', secret);

            await authStatus(config);

            // Should include a call with the public key
            const calls = consoleSpy.mock.calls.map(c => String(c[0]));
            const pubKeyCall = calls.find(c => c.includes('- Public Key: `'));
            expect(pubKeyCall).toBeDefined();
        });
    });
});
