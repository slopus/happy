import { describe, expect, it, vi } from 'vitest';
import { PawsHttpTransport } from './http';
import type { CredentialProvider } from '../client/types';

const credentials = {
    token: 'token-value',
    secret: new Uint8Array(32),
    contentKeyPair: {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(32),
    },
};

function provider(value = credentials): CredentialProvider {
    return {
        getCredentials: vi.fn().mockResolvedValue(value),
        setCredentials: vi.fn(),
        clearCredentials: vi.fn(),
    };
}

describe('PawsHttpTransport', () => {
    it('normalizes the base URL and authenticates each request', async () => {
        const client = { get: vi.fn().mockResolvedValue({ data: { ok: true } }) };
        const credentials = provider();
        const transport = new PawsHttpTransport({
            serverUrl: 'https://paws.example///',
            credentials,
            client: client as never,
        });

        await expect(transport.get<{ ok: boolean }>('/v1/machines')).resolves.toEqual({ ok: true });
        expect(credentials.getCredentials).toHaveBeenCalledOnce();
        expect(client.get).toHaveBeenCalledWith('https://paws.example/v1/machines', {
            headers: {
                Authorization: 'Bearer token-value',
                'X-Happy-Client': 'paws-agent-sdk/0.1.0',
            },
            signal: expect.any(AbortSignal),
        });
    });

    it('rejects missing credentials before making a request', async () => {
        const client = { get: vi.fn() };
        const transport = new PawsHttpTransport({
            serverUrl: 'https://paws.example',
            credentials: provider(null as never),
            client: client as never,
        });

        await expect(transport.get('/v1/machines')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
        expect(client.get).not.toHaveBeenCalled();
    });

    it('aborts an in-flight request when disposed', async () => {
        const client = {
            get: vi.fn((_url: string, options: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            })),
        };
        const transport = new PawsHttpTransport({
            serverUrl: 'https://paws.example',
            credentials: provider(),
            client: client as never,
        });

        const request = transport.get('/v1/machines');
        await vi.waitFor(() => expect(client.get).toHaveBeenCalledOnce());
        transport.dispose();

        await expect(request).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    });
});
