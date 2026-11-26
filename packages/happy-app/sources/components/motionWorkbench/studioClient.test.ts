import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MotionWorkbenchRequests, MotionWorkbenchResponses, type MotionStudioOpen } from '@slopus/happy-wire';
import type { motionWorkbenchRequest } from '@/sync/motionWorkbench.web';
import { createStudioClient, motionStudioFrameHtml, type StudioCacheScope } from './studioClient.web';
import { createStudioResourceCache } from './studioResourceCache.web';

type Method = keyof typeof MotionWorkbenchRequests;
function rpcFixture(handler: (method: Method, input: unknown) => Promise<unknown>): typeof motionWorkbenchRequest {
    return async function rpc<K extends Method>(_session: string, method: K, input: z.input<(typeof MotionWorkbenchRequests)[K]>): Promise<z.infer<(typeof MotionWorkbenchResponses)[K]>> {
        return await handler(method, input) as z.infer<(typeof MotionWorkbenchResponses)[K]>;
    };
}
const bundle = { script: 'globalThis.__pawsScriptExecuted=true;', css: 'body{}', licenseText: 'GNU GENERAL PUBLIC LICENSE', runtimeVersion: '0.1.8' };
const bytes = gzipSync(JSON.stringify(bundle));
const digest = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
const descriptor = (bindingId: string): MotionStudioOpen => ({ bindingId, projectId: digest(JSON.stringify(['motionharness', '/owned/project'])), projectPath: '/owned/project', runtimeVersion: '0.1.8',
    state: { document: { revision: 1 } }, assets: [], bundle: { bytes: bytes.length, encoding: 'gzip', sha256: createHash('sha256').update(bytes).digest('hex') } });
const part = (offset = 0, content = bytes) => ({ offset, totalBytes: content.length, dataBase64: content.toString('base64'), done: true });
afterEach(() => vi.restoreAllMocks());

function warmFixture() {
    const cache = createStudioResourceCache();
    const scope: StudioCacheScope = { serverUrl: 'https://paws.invalid', accountKey: 'account', accountScope: 'account-scope', accountGeneration: 'generation',
        machineId: 'machine', sessionRoot: '/owned', isCurrent: () => true };
    const image = Buffer.from('immutable picture bytes');
    const fixture = { revision: 1, buildId: 'initial-build', source: bytes, image, mime: 'image/png', projectPath: '/owned/project', denied: false,
        opens: [] as unknown[], resources: [] as string[], closes: [] as string[] };
    const rpc = rpcFixture(async (method, input) => {
        if (method === 'motionWorkbenchOpen') {
            fixture.opens.push(input); if (fixture.denied) throw new Error('Access denied');
            const opened = descriptor(MotionWorkbenchRequests.motionWorkbenchOpen.parse(input).bindingId!);
            return { ...opened, projectPath: fixture.projectPath, projectId: digest(JSON.stringify(['motionharness', fixture.projectPath])),
                state: { document: { revision: fixture.revision, statement: 'User edited this in Studio' }, buildId: fixture.buildId },
                bundle: { bytes: fixture.source.length, encoding: 'gzip', sha256: digest(fixture.source) },
                assets: [{ id: digest(fixture.image), mime: fixture.mime, bytes: fixture.image.length }] };
        }
        if (method === 'motionWorkbenchResource') {
            const request = MotionWorkbenchRequests.motionWorkbenchResource.parse(input);
            fixture.resources.push(request.resourceId);
            const content = request.resourceId === 'bundle' ? fixture.source : fixture.image;
            return { offset: request.offset, totalBytes: content.length, dataBase64: content.subarray(request.offset, request.offset + 256 * 1024).toString('base64'),
                done: request.offset + 256 * 1024 >= content.length };
        }
        if (method === 'motionWorkbenchState') return { document: { revision: fixture.revision }, buildId: fixture.buildId, assets: [] };
        if (method === 'motionWorkbenchClose') { fixture.closes.push(MotionWorkbenchRequests.motionWorkbenchClose.parse(input).bindingId); return { closed: true }; }
        throw new Error('Unexpected request');
    });
    const client = (overrides: Partial<StudioCacheScope> = {}, session = 'session', current = () => true, transport = rpc) =>
        createStudioClient(session, current, transport, { cacheScope: { ...scope, ...overrides }, resourceCache: cache });
    return { fixture, scope, cache, rpc, client };
}

describe('isolated motion resource client', () => {
    it('decodes verified content as data and releases the exact planned owner', async () => {
        const closed: unknown[] = [];
        const client = createStudioClient('session', () => true, rpcFixture(async (method, input) => {
            if (method === 'motionWorkbenchOpen') return descriptor(MotionWorkbenchRequests.motionWorkbenchOpen.parse(input).bindingId!);
            if (method === 'motionWorkbenchResource') return part();
            if (method === 'motionWorkbenchClose') { closed.push(input); return { closed: true }; }
            throw new Error('Unexpected request');
        }));
        const opened = await client.open('.');
        expect(opened.bundle).toEqual(bundle);
        expect((globalThis as Record<string, unknown>).__pawsScriptExecuted).toBeUndefined();
        await client.close(); expect(closed).toEqual([{ bindingId: client.getBindingId() }]);
    });
    it.each(['offset', 'integrity'])('rejects corrupt %s responses before parsing any editor script', async kind => {
        const client = createStudioClient('session', () => true, rpcFixture(async (method, input) => {
            if (method === 'motionWorkbenchOpen') return descriptor(MotionWorkbenchRequests.motionWorkbenchOpen.parse(input).bindingId!);
            if (method === 'motionWorkbenchResource') return kind === 'offset' ? part(1) : part(0, Buffer.alloc(bytes.length));
            return { closed: true };
        }));
        await expect(client.open('.')).rejects.toThrow(kind === 'offset' ? 'chunk' : 'integrity'); await client.close();
    });
    it('rejects and closes an opening owner after the account/session generation changes', async () => {
        let current = true;
        const closed: unknown[] = [];
        const client = createStudioClient('session', () => current, rpcFixture(async (method, input) => {
            if (method === 'motionWorkbenchOpen') { current = false; return descriptor(MotionWorkbenchRequests.motionWorkbenchOpen.parse(input).bindingId!); }
            if (method === 'motionWorkbenchClose') { closed.push(input); return { closed: true }; }
            throw new Error('Stale owner must not read resources');
        }));
        await expect(client.open('.')).rejects.toThrow('owner changed');
        expect(closed).toEqual([{ bindingId: client.getBindingId() }]);
    });
    it('rejects a response for a different owner and never closes that foreign owner', async () => {
        const closed: unknown[] = [];
        const foreign = '00000000-0000-4000-8000-000000000000';
        const client = createStudioClient('session', () => true, rpcFixture(async (method, input) => {
            if (method === 'motionWorkbenchOpen') return descriptor(foreign);
            if (method === 'motionWorkbenchClose') { closed.push(input); return { closed: true }; }
            throw new Error('Foreign resources must not load');
        }));
        await expect(client.open('.')).rejects.toThrow('does not match'); await client.close();
        expect(closed).toEqual([{ bindingId: client.getBindingId() }]); expect(client.getBindingId()).not.toBe(foreign);
    });
    it('binds the child handshake and protects HTML delimiters with a constrained CSP', () => {
        const nonce = '00000000-0000-4000-8000-000000000001';
        const html = motionStudioFrameHtml({ ...bundle, script: 'const content="</script><img src=x>";', css: 'a::before{content:"</style>"}' }, nonce);
        expect(html).toContain('name="paws-motion-channel" content="' + nonce + '"');
        expect(html.match(/<\/script>/gi)).toHaveLength(1); expect(html.match(/<\/style>/gi)).toHaveLength(1);
        expect(html).toContain("connect-src blob: data:"); expect(html).toContain("form-action 'none'");
        expect(() => motionStudioFrameHtml(bundle, 'untrusted" nonce')).toThrow();
    });
});

describe('warm studio reopen', () => {
    it('uses a new authoritative binding and current state while transferring no unchanged resources', async () => {
        const { fixture, client } = warmFixture();
        const first = client(), original = await first.open('/owned/project');
        expect(fixture.resources).toHaveLength(2); await first.close();
        // Consumers own the returned buffer; moving it into the iframe cannot detach the cached copy.
        structuredClone(original.assets[0].bytes, { transfer: [original.assets[0].bytes] });
        fixture.revision = 2; fixture.buildId = 'new-source-build';
        const second = client(), reopened = await second.open('/owned/project');
        expect(second.getBindingId()).not.toBe(first.getBindingId());
        expect(fixture.opens).toHaveLength(2); expect(fixture.resources).toHaveLength(2);
        expect(fixture.closes).toEqual([first.getBindingId()]);
        expect(reopened.descriptor.state).toEqual({ document: { revision: 2, statement: 'User edited this in Studio' }, buildId: 'new-source-build' });
        expect(Buffer.from(reopened.assets[0].bytes)).toEqual(fixture.image);
        fixture.revision = 3;
        expect((await second.state()).value).toMatchObject({ document: { revision: 3 } });
        await second.close();
    });
    it('fetches changed hashes and current bundle/license while reusing unchanged bytes', async () => {
        const { fixture, client } = warmFixture();
        const first = client(); await first.open('/owned/project'); await first.close();
        fixture.image = Buffer.from('new picture');
        const second = client(); await second.open('/owned/project'); await second.close();
        expect(fixture.resources).toEqual(['bundle', 'asset:' + digest(Buffer.from('immutable picture bytes')), 'asset:' + digest(fixture.image)]);
        fixture.source = gzipSync(JSON.stringify({ ...bundle, licenseText: 'Updated license', script: 'const newSource = true;' }));
        const third = client(), opened = await third.open('/owned/project');
        expect(fixture.resources.at(-1)).toBe('bundle'); expect(fixture.resources).toHaveLength(4);
        expect(opened.bundle.licenseText).toBe('Updated license'); await third.close();
    });
    it.each(['serverUrl', 'accountKey', 'accountScope', 'accountGeneration', 'machineId', 'sessionRoot'] as const)('does not share bytes across %s', async field => {
        const { fixture, client } = warmFixture();
        const first = client(); await first.open('/owned/project'); await first.close();
        const next = client({ [field]: 'different-owner' }); await next.open('/owned/project');
        expect(fixture.resources).toHaveLength(4); await next.close();
    });
    it.each(['session', 'request-path', 'canonical-project'] as const)('does not share bytes across another %s', async kind => {
        const { fixture, client } = warmFixture();
        const first = client(); await first.open('/owned/project'); await first.close();
        if (kind === 'canonical-project') fixture.projectPath = '/owned/other';
        const next = client({}, kind === 'session' ? 'another-session' : 'session');
        await next.open(kind === 'request-path' ? '/owned/alias' : '/owned/project');
        expect(fixture.resources).toHaveLength(4); await next.close();
    });
    it('does not enable shared caching without an explicit complete scope', async () => {
        const { fixture, rpc, cache, client } = warmFixture();
        const first = client(); await first.open('/owned/project'); await first.close();
        const unscoped = createStudioClient('session', () => true, rpc, { resourceCache: cache });
        await unscoped.open('/owned/project'); await unscoped.close();
        const incomplete = client({ accountGeneration: '' }); await incomplete.open('/owned/project'); await incomplete.close();
        expect(fixture.resources).toHaveLength(6);
    });
    it('treats a MIME change as a miss and rejects changed lengths before cached bytes can escape', async () => {
        const { fixture, client, rpc } = warmFixture();
        const first = client(); await first.open('/owned/project'); await first.close();
        fixture.mime = 'image/webp';
        const second = client(), changed = await second.open('/owned/project'); await second.close();
        expect(changed.assets[0].mime).toBe('image/webp'); expect(fixture.resources).toHaveLength(3);
        const altered = rpcFixture(async (method, input) => {
            const result = await rpc('session', method, input as never);
            if (method === 'motionWorkbenchOpen') {
                const opened = result as MotionStudioOpen; opened.assets[0].bytes++; return opened;
            }
            return result;
        });
        const third = client({}, 'session', () => true, altered);
        await expect(third.open('/owned/project')).rejects.toThrow('chunk');
        expect(fixture.resources).toHaveLength(4); await third.close();
    });
    it('never falls back to cached resources after fresh open is denied or a descriptor has a foreign binding/project identity', async () => {
        const { fixture, client, rpc } = warmFixture();
        const first = client(); await first.open('/owned/project'); await first.close();
        fixture.denied = true;
        const denied = client(); await expect(denied.open('/owned/project')).rejects.toThrow('Access denied'); await denied.close(); fixture.denied = false;
        for (const field of ['bindingId', 'projectId'] as const) {
            const altered = rpcFixture(async (method, input) => {
                const result = await rpc('session', method, input as never);
                return method === 'motionWorkbenchOpen' ? { ...result as MotionStudioOpen, [field]: field === 'bindingId' ? crypto.randomUUID() : 'b'.repeat(64) } : result;
            });
            const invalid = client({}, 'session', () => true, altered);
            await expect(invalid.open('/owned/project')).rejects.toThrow(field === 'bindingId' ? 'binding' : 'identity'); await invalid.close();
        }
        expect(fixture.resources).toHaveLength(2);
    });
    it('rehashes cache hits and refetches corrupt bytes through the current binding', async () => {
        const { fixture, client, cache } = warmFixture();
        const first = client(); await first.open('/owned/project'); await first.close();
        const acquire = cache.acquire.bind(cache); let corrupted = false;
        vi.spyOn(cache, 'acquire').mockImplementation((...args) => {
            const lease = acquire(...args), get = lease.get;
            return { ...lease, get: key => {
                const bytes = get(key);
                if (bytes && !corrupted) { bytes[0] ^= 255; corrupted = true; }
                return bytes;
            } };
        });
        const next = client(); expect((await next.open('/owned/project')).bundle).toEqual(bundle);
        expect(fixture.resources).toEqual(['bundle', 'asset:' + digest(fixture.image), 'bundle']); await next.close();
    });
    it.each(['close', 'clear', 'account'] as const)('does not populate the cache from a late resource after %s', async reason => {
        const { fixture, client, rpc, cache } = warmFixture();
        let release!: () => void, entered!: () => void, current = true, account = true;
        const waiting = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
        const delayed = rpcFixture(async (method, input) => {
            const response = await rpc('session', method, input as never);
            if (method === 'motionWorkbenchResource') { entered(); await blocked; }
            return response;
        });
        const first = client({ isCurrent: () => account }, 'session', () => current, delayed);
        const opening = first.open('/owned/project');
        await waiting;
        if (reason === 'close') { current = false; await first.close(); }
        else if (reason === 'clear') cache.clear();
        else account = false;
        release();
        if (reason === 'clear') await opening;
        else await expect(opening).rejects.toThrow('owner changed');
        await first.close();
        const before = fixture.resources.length;
        const next = client(); await next.open('/owned/project');
        expect(fixture.resources.length - before).toBe(2);
        await next.close();
    });
    it('keeps previously verified bytes when an old mounted owner closes with an asset transfer still in flight', async () => {
        const { fixture, client, rpc } = warmFixture();
        let release!: () => void, entered!: () => void, current = true;
        const waiting = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
        const delayed = rpcFixture(async (method, input) => {
            const response = await rpc('session', method, input as never);
            if (method === 'motionWorkbenchResource' && MotionWorkbenchRequests.motionWorkbenchResource.parse(input).resourceId.startsWith('asset:')) { entered(); await blocked; }
            return response;
        });
        const first = client({}, 'session', () => current, delayed), opening = first.open('/owned/project');
        await waiting; current = false; await first.close(); release();
        await expect(opening).rejects.toThrow('owner changed');
        const next = client(); await next.open('/owned/project');
        expect(fixture.resources).toEqual(['bundle', 'asset:' + digest(fixture.image), 'asset:' + digest(fixture.image)]);
        await next.close();
    });
    it.each([false, true])('rechecks the account after asynchronous SHA validation before retaining or returning bytes (warm=%s)', async warm => {
        const { fixture, client } = warmFixture();
        if (warm) { const previous = client(); await previous.open('/owned/project'); await previous.close(); }
        let account = true, calls = 0;
        const original = crypto.subtle.digest.bind(crypto.subtle);
        vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
            const output = await original(...args);
            if (++calls === 2) account = false; // Project identity hashes first; bundle hashes second.
            return output;
        });
        const first = client({ isCurrent: () => account });
        await expect(first.open('/owned/project')).rejects.toThrow('owner changed'); await first.close();
        vi.restoreAllMocks();
        const next = client(); await next.open('/owned/project');
        expect(fixture.resources).toHaveLength(warm ? 4 : 3); await next.close();
    });
});
