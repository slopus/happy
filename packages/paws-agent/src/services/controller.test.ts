import { it, expect, vi } from 'vitest';
import { createServiceController } from './controller';
import { createAIServiceClient } from './client';
import { createNodePlatformTransport } from './nodePlatformTransport';
import { createBrowserPersonalTransport } from './personalTransport';
import { createMemoryServiceStorage } from './storage';
import { fixture, makeReceipt } from './testFixtures';
it('keeps credentials out of state, changes only new-conversation overrides, and makes no idle polls', async () => {
    vi.useFakeTimers();
    try {
        const f = fixture(), storage = createMemoryServiceStorage(), client = createAIServiceClient({ appId: 'advisor', transport: createNodePlatformTransport({ appId: 'advisor', serverUrl: 'https://paws.test', receipt: makeReceipt('platform-grant'), storage, fetch: f.fetcher }) }), controller = createServiceController(client, storage);
        const events: unknown[] = [];
        const unsubscribe = controller.subscribe(e => events.push(e));
        await controller.connect();
        expect(controller.getState().status).toBe('ready');
        controller.setOverrides({ modelId: null, reasoning: { mode: 'explicit', value: 'native' } });
        expect(JSON.stringify(events)).not.toContain('messageKey');
        expect(JSON.stringify(events)).not.toContain('paws_service');
        const count = f.requests.length;
        await vi.advanceTimersByTimeAsync(60000);
        expect(f.requests.length).toBe(count);
        await controller.disconnect('forget');
        expect(controller.getState().connection).toBeNull();
        unsubscribe();
        controller.dispose();
        expect(vi.getTimerCount()).toBe(0);
    }
    finally {
        vi.useRealTimers();
    }
});
it('cancels a pending personal authorization on disconnect and removes its local secret', async () => {
    const storage = createMemoryServiceStorage();
    let redeemed!: () => void;
    const submitted = new Promise<void>(resolve => redeemed = resolve);
    const fetcher: typeof fetch = async (url, init) => { if (String(url).endsWith('/pairings'))
        return Response.json({ id: 'pending', expiresAt: Date.now() + 60000, protocol: 'ai-services/1' }); redeemed(); await new Promise<void>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('abort')), { once: true })); throw new Error('unreachable'); };
    const client = createAIServiceClient({ appId: 'advisor', transport: createBrowserPersonalTransport({ appId: 'advisor', serverUrl: 'https://paws.test', webUrl: 'https://web.test', origin: 'https://app.test', storage, fetch: fetcher }) }), controller = createServiceController(client, storage);
    const attempt = controller.connect();
    await submitted;
    expect(controller.getState().status).toBe('authorizing');
    await controller.disconnect();
    await attempt;
    expect(await storage.get('pending-authorization')).toBeNull();
    expect(controller.getState().status).toBe('disconnected');
    controller.dispose();
});
