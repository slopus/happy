import { describe, expect, it, vi } from 'vitest';
import { validateHappyServerConnection } from './serverConnectionValidation';

function response(options: { ok?: boolean; status?: number; json?: () => Promise<unknown> }): Response {
    return {
        ok: options.ok ?? true,
        status: options.status ?? 200,
        json: options.json ?? (async () => ({ status: 'ok', service: 'happy-server' })),
    } as Response;
}

describe('validateHappyServerConnection', () => {
    it('validates the server through its health endpoint', async () => {
        const fetcher = vi.fn(async () => response({})) as unknown as typeof fetch;

        await expect(validateHappyServerConnection('https://happy.example.com/', fetcher)).resolves.toEqual({ valid: true });
        expect(fetcher).toHaveBeenCalledWith('https://happy.example.com/health', {
            method: 'GET',
            headers: { Accept: 'application/json' },
        });
    });

    it('rejects a successful response from a different service', async () => {
        const fetcher = vi.fn(async () => response({
            json: async () => ({ status: 'ok', service: 'something-else' }),
        })) as unknown as typeof fetch;

        await expect(validateHappyServerConnection('https://example.com', fetcher)).resolves.toEqual({
            valid: false,
            reason: 'not-happy-server',
        });
    });

    it('reports HTTP errors separately from connection failures', async () => {
        const serverErrorFetcher = vi.fn(async () => response({ ok: false, status: 503 })) as unknown as typeof fetch;
        const connectionErrorFetcher = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;

        await expect(validateHappyServerConnection('https://example.com', serverErrorFetcher)).resolves.toEqual({
            valid: false,
            reason: 'server-error',
        });
        await expect(validateHappyServerConnection('https://example.com', connectionErrorFetcher)).resolves.toEqual({
            valid: false,
            reason: 'connection-failed',
        });
    });

    it('rejects malformed health responses', async () => {
        const fetcher = vi.fn(async () => response({
            json: async () => { throw new SyntaxError('invalid JSON'); },
        })) as unknown as typeof fetch;

        await expect(validateHappyServerConnection('https://example.com', fetcher)).resolves.toEqual({
            valid: false,
            reason: 'not-happy-server',
        });
    });
});
