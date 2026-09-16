import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ frozen: false }));
vi.mock('./accountRuntime', () => ({ assertAccountRuntime: () => { if (state.frozen) throw new Error('frozen'); } }));
afterEach(() => { vi.unstubAllGlobals(); state.frozen = false; vi.resetModules(); });
describe('account request lifecycle', () => {
    it('aborts in-flight work and blocks new requests after freeze', async () => {
        const transport = vi.fn((_input: any, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }));
        vi.stubGlobal('fetch', transport);
        const network = await import('./accountNetwork');
        network.installAccountNetworkGuard();
        const request = fetch('https://example.com');
        const rejection = expect(request).rejects.toThrow('aborted');
        state.frozen = true;
        network.abortAccountRequests();
        await rejection;
        await expect(fetch('https://example.com')).rejects.toThrow('frozen');
        expect(transport).toHaveBeenCalledOnce();
    });
    it('drops a response that arrives after another tab switched accounts', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { state.frozen = true; return new Response('old account'); }));
        const network = await import('./accountNetwork');
        network.installAccountNetworkGuard();
        await expect(fetch('https://example.com')).rejects.toThrow('frozen');
    });
});
