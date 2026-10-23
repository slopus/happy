import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { disconnectGitHub, getGitHubOAuthParams } from './apiGithub';
import { AuthCredentials } from '@/auth/tokenStorage';
import { HappyError } from '@/utils/errors';

// Mock the serverConfig
vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.test.com'
}));

// Mock apiSocket to avoid pulling React Native modules into this unit test.
vi.mock('./apiSocket', () => ({
    getHappyClientId: () => 'test-client'
}));

// Mock backoff utility: retry while the callback throws, like the real one,
// but without delays and giving up after 3 attempts.
vi.mock('@/utils/time', () => ({
    backoff: vi.fn(async (fn) => {
        for (let attempt = 1; ; attempt++) {
            try {
                return await fn();
            } catch (e) {
                if (attempt >= 3) throw e;
            }
        }
    })
}));

describe('apiGithub', () => {
    const mockCredentials: AuthCredentials = {
        token: 'test-token',
        secret: 'test-secret'
    };

    beforeEach(() => {
        // Reset all mocks before each test
        vi.clearAllMocks();
        // Mock global fetch
        global.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('disconnectGitHub', () => {
        it('should successfully disconnect GitHub account', async () => {
            // Mock successful response
            const mockResponse = {
                ok: true,
                json: vi.fn().mockResolvedValue({ success: true })
            };
            global.fetch = vi.fn().mockResolvedValue(mockResponse);

            await expect(disconnectGitHub(mockCredentials)).resolves.toBeUndefined();

            expect(global.fetch).toHaveBeenCalledWith(
                'https://api.test.com/v1/connect/github',
                {
                    method: 'DELETE',
                    headers: {
                        'Authorization': 'Bearer test-token',
                        'X-Happy-Client': 'test-client'
                    }
                }
            );
        });

        it('should throw error when GitHub account is not connected', async () => {
            // Mock 404 response
            const mockResponse = {
                ok: false,
                status: 404,
                json: vi.fn().mockResolvedValue({ error: 'GitHub account not connected' })
            };
            global.fetch = vi.fn().mockResolvedValue(mockResponse);

            await expect(disconnectGitHub(mockCredentials))
                .rejects.toThrow('GitHub account not connected');
        });

        it('should throw error when server returns non-success response', async () => {
            // Mock successful HTTP response but unsuccessful operation
            const mockResponse = {
                ok: true,
                json: vi.fn().mockResolvedValue({ success: false })
            };
            global.fetch = vi.fn().mockResolvedValue(mockResponse);

            await expect(disconnectGitHub(mockCredentials))
                .rejects.toThrow('Failed to disconnect GitHub account');
        });

        it('should throw generic error for other HTTP errors', async () => {
            // Mock 401 response
            const mockResponse = {
                ok: false,
                status: 401,
                json: vi.fn().mockResolvedValue({ error: 'Unauthorized' })
            };
            global.fetch = vi.fn().mockResolvedValue(mockResponse);

            await expect(disconnectGitHub(mockCredentials))
                .rejects.toThrow('Failed to disconnect GitHub: 401');
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('getGitHubOAuthParams', () => {
        it('should return the OAuth params', async () => {
            const mockResponse = {
                ok: true,
                status: 200,
                json: vi.fn().mockResolvedValue({ url: 'https://github.com/login/oauth/authorize?x=1' })
            };
            global.fetch = vi.fn().mockResolvedValue(mockResponse);

            await expect(getGitHubOAuthParams(mockCredentials))
                .resolves.toEqual({ url: 'https://github.com/login/oauth/authorize?x=1' });
        });

        it('should not retry when the server has no GitHub OAuth configured', async () => {
            // Mock the 400 a server without GITHUB_CLIENT_ID answers
            const mockResponse = {
                ok: false,
                status: 400,
                json: vi.fn().mockResolvedValue({ error: 'GitHub OAuth not configured' })
            };
            global.fetch = vi.fn().mockResolvedValue(mockResponse);

            const error = await getGitHubOAuthParams(mockCredentials).catch((e) => e);
            expect(error).toBeInstanceOf(HappyError);
            expect(error.message).toBe('GitHub OAuth not configured');
            expect(error.canTryAgain).toBe(false);
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        it('should retry server errors until the request succeeds', async () => {
            global.fetch = vi.fn()
                .mockResolvedValueOnce({ ok: false, status: 503, json: vi.fn() })
                .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ url: 'https://github.com/x' }) });

            await expect(getGitHubOAuthParams(mockCredentials))
                .resolves.toEqual({ url: 'https://github.com/x' });
            expect(global.fetch).toHaveBeenCalledTimes(2);
        });
    });
});
