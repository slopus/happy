import { describe, it, expect, vi } from 'vitest';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from '../crypto/encryption';
import { createAIServiceClient } from './client';
import { createNodePlatformTransport } from './nodePlatformTransport';
import { createBrowserPersonalTransport } from './personalTransport';
import { createMemoryServiceStorage } from './storage';
import type { ExecutionBinding, GrantReceipt, TurnRecord } from '@slopus/happy-wire/ai-services';
import { binding, fixture, makeReceipt } from './testFixtures';
for (const source of ['platform', 'personal'] as const)
    describe(`${source} real scoped HTTP contract`, () => {
        it('recovers an accepted request after refresh without submitting a second native turn', async () => {
            const f = fixture(), storage = createMemoryServiceStorage(), receipt = makeReceipt(source === 'platform' ? 'platform-grant' : 'personal-grant');
            const make = () => source === 'platform' ? createNodePlatformTransport({ appId: 'advisor', serverUrl: 'https://paws.test', receipt, storage, fetch: f.fetcher }) : createBrowserPersonalTransport({ appId: 'advisor', serverUrl: 'https://paws.test', webUrl: 'https://paws-web.test', origin: 'https://app.test', storage, fetch: f.fetcher });
            const client = createAIServiceClient({ appId: 'advisor', transport: make() });
            await client.connections.authorize({ receipt });
            expect((await client.services.list()).services[0].id).toBe('service');
            const bound = await client.conversations.create();
            expect(bound.id).toBe('binding');
            await expect(client.turns.start({ binding: bound, requestId: 'request', messages: [{ role: 'user', text: 'hello' }] })).rejects.toMatchObject({ code: 'transport-error', requestId: 'request' });
            expect(await storage.get('outbox:binding:request')).toMatchObject({ requestId: 'request', ciphertext: f.ciphertext });
            client.dispose();
            const restored = createAIServiceClient({ appId: 'advisor', transport: make() });
            await restored.connections.authorize({ receipt });
            const recovered = await restored.turns.start({ binding: bound, requestId: 'request', messages: [{ role: 'user', text: 'hello' }] });
            expect(recovered.record.id).toBe('turn');
            expect(f.posts).toBe(1);
            const result = await restored.turns.read({ bindingId: 'binding', turnId: 'turn' });
            expect(result.text).toBe('answer');
            expect(result.record.actual).toEqual({ modelId: null, reasoning: null });
            expect(f.requests.every(r => r.headers.get('authorization') === receipt.credential.replace(/^/, 'Bearer '))).toBe(true);
            expect(f.requests.every(r => r.headers.get('origin') === (source === 'personal' ? 'https://app.test' : null))).toBe(true);
            f.corrupt();
            await expect(restored.turns.read({ bindingId: 'binding', turnId: 'turn' })).rejects.toMatchObject({ code: 'context-mismatch' });
            restored.dispose();
        });
        it('rejects cross-source credentials before any request', async () => {
            const f = fixture(), storage = createMemoryServiceStorage();
            if (source === 'platform')
                expect(() => createNodePlatformTransport({ appId: 'advisor', serverUrl: 'https://paws.test', receipt: makeReceipt('personal-grant'), storage, fetch: f.fetcher })).toThrow();
            else {
                const t = createBrowserPersonalTransport({ appId: 'advisor', serverUrl: 'https://paws.test', webUrl: 'https://web.test', origin: 'https://app.test', storage, fetch: f.fetcher });
                await expect(t.authorize({ receipt: makeReceipt('platform-grant') })).rejects.toMatchObject({ code: 'permission-denied' });
                t.dispose();
            }
            expect(f.requests).toHaveLength(0);
        });
    });
describe('bounded observation', () => {
    it('emits full snapshots only and stops timers on terminal output', async () => {
        vi.useFakeTimers();
        try {
            const f = fixture(), c = createAIServiceClient({ appId: 'advisor', transport: createNodePlatformTransport({ appId: 'advisor', serverUrl: 'https://paws.test', receipt: makeReceipt('platform-grant'), storage: createMemoryServiceStorage(), fetch: f.fetcher }) });
            await c.connections.authorize();
            await expect(c.turns.start({ binding, requestId: 'request', messages: [{ role: 'user', text: 'hello' }] })).rejects.toThrow();
            const events: unknown[] = [];
            const subscription = c.turns.observe({ bindingId: 'binding', turnId: 'turn' }, e => events.push(e));
            await subscription.done;
            expect(events).toMatchObject([{ type: 'snapshot', snapshot: { text: 'answer' } }]);
            const count = f.requests.length;
            await vi.advanceTimersByTimeAsync(60000);
            expect(f.requests.length).toBe(count);
            expect(vi.getTimerCount()).toBe(0);
            c.dispose();
        }
        finally {
            vi.useRealTimers();
        }
    });
});
