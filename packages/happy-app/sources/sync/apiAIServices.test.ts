import { afterEach, expect, it, vi } from 'vitest';
import { createAIServicesAPI, AIServiceAPIError } from './apiAIServices';
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://paws.example' }));
afterEach(() => vi.unstubAllGlobals());
const config = { machineId: 'machine', engine: 'codex', accountRef: { kind: 'codex-profile', id: 'profile' }, modelId: null, reasoning: { mode: 'default' } } as const;
it('updates only the authoritative service revision and sends the expected revision', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ revision: { serviceId: 'service', revision: 4, config, createdAt: 1 } }) }));
    vi.stubGlobal('fetch', fetcher);
    await createAIServicesAPI('owner').update('service', 3, config);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://paws.example/v1/ai-services/service');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ expectedRevision: 3, config });
    expect(init.redirect).toBe('error');
});
it('retains typed conflicts and never displays upstream error text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: { code: 'revision-conflict', retryable: false, detail: 'SECRET' } }) })));
    const error = await createAIServicesAPI('owner').update('service', 3, config).catch(e => e);
    expect(error).toBeInstanceOf(AIServiceAPIError);
    expect(error.code).toBe('revision-conflict');
    expect(error.message).not.toContain('SECRET');
});
it('gives native capability discovery longer than its 25 second server deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))));
    const request = createAIServicesAPI('owner').capabilities({ machineId: config.machineId, engine: config.engine, accountRef: config.accountRef });
    const failed = expect(request).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(26_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000); await failed;
    expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
});
