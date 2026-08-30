import { describe, expect, it, vi } from 'vitest';
import { decodeBase64, libsodiumEncryptForPublicKey, encodeBase64 } from '../crypto/encryption';
import type { CredentialProvider, PawsCredentials } from '../client/types';
import { startBrowserAccountLink } from './browserAccountLink';

function provider(): CredentialProvider & { value: PawsCredentials | null } {
    return {
        value: null,
        async getCredentials() { return this.value; },
        async setCredentials(value) { this.value = value; },
        async clearCredentials() { this.value = null; },
    };
}

describe('startBrowserAccountLink', () => {
    it('creates a QR link, decrypts authorization, and persists browser credentials', async () => {
        const credentials = provider();
        const secret = new Uint8Array(32).fill(9);
        let calls = 0;
        const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            calls += 1;
            const body = JSON.parse(String(init?.body)) as { publicKey: string };
            if (calls === 1) return Response.json({ state: 'requested' });
            const encrypted = libsodiumEncryptForPublicKey(secret, decodeBase64(body.publicKey));
            return Response.json({ state: 'authorized', token: 'browser-token', response: encodeBase64(encrypted) });
        });

        const link = await startBrowserAccountLink({
            serverUrl: 'https://paws.example/',
            credentials,
            fetch: fetcher,
        });
        expect(link.qrUrl).toMatch(/^paws:\/\/\/account\?/);

        const result = await link.waitForAuthorization({ pollIntervalMs: 0, timeoutMs: 1_000 });
        expect(result.token).toBe('browser-token');
        expect(result.secret).toEqual(secret);
        expect(credentials.value).toEqual(result);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('stops polling when the caller aborts', async () => {
        const controller = new AbortController();
        const fetcher = vi.fn(async () => Response.json({ state: 'requested' }));
        const link = await startBrowserAccountLink({
            serverUrl: 'https://paws.example',
            credentials: provider(),
            fetch: fetcher,
        });
        controller.abort(new Error('cancelled'));

        await expect(link.waitForAuthorization({ signal: controller.signal })).rejects.toThrow('cancelled');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('passes cancellation into the initial account-link request', async () => {
        const controller = new AbortController();
        const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => (
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
            })
        ));

        const pending = startBrowserAccountLink({
            serverUrl: 'https://paws.example',
            credentials: provider(),
            fetch: fetcher,
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
        controller.abort(new Error('cancelled before QR creation'));

        await expect(pending).rejects.toThrow('cancelled before QR creation');
    });

    it('times out a hung initial account-link request', async () => {
        const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => (
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
            })
        ));

        await expect(startBrowserAccountLink({
            serverUrl: 'https://paws.example',
            credentials: provider(),
            fetch: fetcher,
            timeoutMs: 25,
        })).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
    });

    it('passes cancellation into an in-flight authorization request', async () => {
        const controller = new AbortController();
        let calls = 0;
        const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            calls += 1;
            if (calls === 1) return Promise.resolve(Response.json({ state: 'requested' }));
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
            });
        });
        const link = await startBrowserAccountLink({
            serverUrl: 'https://paws.example',
            credentials: provider(),
            fetch: fetcher,
        });

        const pending = link.waitForAuthorization({ signal: controller.signal, pollIntervalMs: 0 });
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        try {
            expect(fetcher.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
        } finally {
            controller.abort(new Error('cancelled in flight'));
        }
        await expect(pending).rejects.toThrow('cancelled in flight');
    });

    it('times out an in-flight authorization request', async () => {
        let calls = 0;
        const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            calls += 1;
            if (calls === 1) return Promise.resolve(Response.json({ state: 'requested' }));
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
            });
        });
        const link = await startBrowserAccountLink({
            serverUrl: 'https://paws.example',
            credentials: provider(),
            fetch: fetcher,
        });

        await expect(link.waitForAuthorization({ pollIntervalMs: 0, timeoutMs: 25 }))
            .rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
        expect(fetcher.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    });
});
