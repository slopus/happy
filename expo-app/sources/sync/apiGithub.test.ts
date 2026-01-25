import { afterEach, describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors';
import { disconnectGitHub, getGitHubOAuthParams } from './apiGithub';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('getGitHubOAuthParams', () => {
    it('throws a config HappyError when a 400 response body is not JSON', async () => {
        const jsonError = new Error('invalid json');
        (jsonError as any).canTryAgain = false;

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 400,
                json: async () => {
                    throw jsonError;
                },
            })),
        );

        try {
            await getGitHubOAuthParams({ token: 'test' } as any);
            throw new Error('expected getGitHubOAuthParams to throw');
        } catch (e) {
            expect(e).toBeInstanceOf(HappyError);
            expect((e as HappyError).message).toBe('GitHub OAuth not configured');
            expect((e as HappyError).status).toBe(400);
            expect((e as HappyError).kind).toBe('config');
        }
    });
});

describe('disconnectGitHub', () => {
    it('throws a config HappyError when a 404 response body is not JSON', async () => {
        const jsonError = new Error('invalid json');
        (jsonError as any).canTryAgain = false;

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 404,
                json: async () => {
                    throw jsonError;
                },
            })),
        );

        try {
            await disconnectGitHub({ token: 'test' } as any);
            throw new Error('expected disconnectGitHub to throw');
        } catch (e) {
            expect(e).toBeInstanceOf(HappyError);
            expect((e as HappyError).message).toBe('GitHub account not connected');
            expect((e as HappyError).status).toBe(404);
            expect((e as HappyError).kind).toBe('config');
        }
    });
});
